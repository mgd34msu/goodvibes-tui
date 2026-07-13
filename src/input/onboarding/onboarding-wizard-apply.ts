import type { OnboardingAcknowledgementTarget, OnboardingApplyOperation, OnboardingApplyRequest } from '../../runtime/onboarding/index.ts';
import { formatProviderModel } from '../../config/provider-model.ts';
import { getServerSurfaceFeatureFlags } from '../../runtime/surface-feature-flags.ts';
import { featureEnablementWrite } from '../../runtime/feature-settings.ts';
import {
  buildCloudflareApiTokenRef,
  buildCloudflareOperationalTokenRef,
  getCloudflareBatchMode,
  getCloudflareComponentSelection,
  getCloudflareSetupSource,
  shouldShowCloudflareStep,
} from './onboarding-wizard-cloudflare.ts';
import {
  EXTERNAL_SURFACE_SPECS,
  getExternalSurfaceAutoStartDefaultValue,
  getExternalSurfaceAutoStartFieldId,
  isExternalSurfaceSelectedByDefault,
} from './onboarding-wizard-external-surfaces.ts';
import { applyFeatureUnitOperations } from './onboarding-feature-units.ts';
import { buildGoodVibesSecretKey, buildGoodVibesSecretRef, isLoopbackAddress, isSecretReferenceValue } from './onboarding-wizard-helpers.ts';
import { deriveProviderKeyCaptureTargets, providerKeyFieldId } from '../../runtime/onboarding/provider-key-capture.ts';
import type { OnboardingWizardControllerLike } from './onboarding-wizard-types.ts';

export function buildOnboardingApplyRequest(controller: OnboardingWizardControllerLike): OnboardingApplyRequest {
    const operations: OnboardingApplyOperation[] = [];
    // Accumulates feature-flag state that onboarding selections require, so the
    // written config actually takes effect (e.g. behavior.hitlMode is inert unless
    // hitl-ux-modes is on) and so a default-on feature the user turned OFF in a
    // feature step is persisted as a disabled override. Flushed once, after the
    // surface flags, at the end of the apply build so every gating flag is set in
    // one batch. A later write for the same flag id wins (surface enables are
    // authoritative for the network-exposing flags they own).
    const featureFlagOverrides = new Map<string, 'enabled' | 'disabled'>();
    const hasServers = controller.hasServerCapabilitiesSelected();
    const browserAccess = controller.shouldEnableBrowserSurface();
    const httpListener = controller.shouldEnableHttpListener();
    const httpListenerNetworkFields = controller.shouldExposeHttpListenerNetworkFields();
    const controlPlaneRemote = controller.shouldExposeControlPlaneNetwork();
    const networkMode = controller.getStringFieldValue('network.mode', controller.runtimeDerived.step1_5NetworkMode);
    const customNetwork = hasServers && networkMode === 'custom';

    const setConfig = (
      key: Extract<OnboardingApplyOperation, { kind: 'set-config' }>['key'],
      value: unknown,
    ): void => {
      operations.push({ kind: 'set-config', key, value });
    };
    const acknowledge = (target: OnboardingAcknowledgementTarget, fieldId: string): void => {
      operations.push({
        kind: 'acknowledge',
        target,
        acknowledged: controller.getBooleanFieldValue(fieldId, false),
      });
    };
    const setSecret = (key: string, value: string): void => {
      if (value.length === 0) return;
      const medium = controller.getSelectedSecretMedium();
      operations.push({
        kind: 'set-secret',
        key,
        value,
        scope: 'project',
        medium,
      });
    };
    const setMaskedConfig = (
      key: Extract<OnboardingApplyOperation, { kind: 'set-config' }>['key'],
      value: string,
    ): void => {
      if (value.length === 0 || isSecretReferenceValue(value)) {
        setConfig(key, value);
        return;
      }

      const secretKey = buildGoodVibesSecretKey(key);
      setSecret(secretKey, value);
      setConfig(key, buildGoodVibesSecretRef(secretKey));
    };

    const requestedAdminPassword = controller.getStringFieldValue('accounts.admin-password', '');
    const shouldEnsureAuthUser = controller.requiresAuthBootstrap() || requestedAdminPassword.length > 0;
    if (shouldEnsureAuthUser) {
      operations.push({
        kind: 'ensure-auth-user',
        username: controller.getStringFieldValue('accounts.admin-username', controller.getDefaultAdminUsername()),
        password: requestedAdminPassword,
        roles: ['admin'],
        createSession: true,
        retireBootstrapCredential: controller.hasBootstrapCredentialPresent(),
      });
    }

    setConfig('service.enabled', hasServers);
    setConfig('service.autostart', hasServers);
    setConfig('service.restartOnFailure', true);
    // One-Platform daemon-by-default (SDK docs/decisions/2026-07-05-daemon-by-default.md):
    // the loopback-only cross-surface session daemon is safe-by-design
    // (loopback bind, auth-gated, rate-limited) and runs regardless of whether
    // browser/LAN/webhook/external-app capabilities are selected here — it is no
    // longer bundled with those network-exposing surfaces, so onboarding leaves
    // daemon.enabled untouched and lets the SDK's own default-true (or an existing
    // explicit user override) govern. (The deprecated danger.daemon alias this
    // comment used to also name was later removed.)
    setConfig('controlPlane.enabled', hasServers);
    setConfig('danger.httpListener', httpListener);
    setConfig('web.enabled', browserAccess);

    if (hasServers) {
      addNetworkOperations(controller, operations, customNetwork, {
        controlPlane: hasServers,
        controlPlaneRemote,
        httpListener: httpListenerNetworkFields,
        web: browserAccess,
      });
    } else {
      setConfig('controlPlane.hostMode', 'local');
      setConfig('controlPlane.host', controller.runtimeSnapshot?.bindSettings.controlPlane.host || '127.0.0.1');
      setConfig('controlPlane.allowRemote', false);
      setConfig('httpListener.hostMode', 'local');
      setConfig('httpListener.host', controller.runtimeSnapshot?.bindSettings.httpListener.host || '127.0.0.1');
      setConfig('web.hostMode', 'local');
      setConfig('web.host', controller.runtimeSnapshot?.bindSettings.web.host || '127.0.0.1');
    }

    const defaultModel = controller.modelSelectionState.get('main');
    if (defaultModel && defaultModel.enabled !== false && defaultModel.providerId.length > 0 && defaultModel.modelId.length > 0) {
      setConfig('provider.model', formatProviderModel(defaultModel.providerId, defaultModel.modelId));
    }
    setConfig('provider.reasoningEffort', controller.getStringFieldValue('default-model.reasoning', controller.runtimeSnapshot?.providerRouting.primaryReasoningEffort ?? 'medium'));
    const hitlMode = controller.getStringFieldValue('experience.hitl', controller.runtimeSnapshot?.runtimeDefaults.behavior.hitlMode ?? 'balanced');
    setConfig('behavior.hitlMode', hitlMode);
    // behavior.hitlMode IS the enablement key of the hitl-ux-modes capability
    // (active for quiet/balanced/operator, off only at 'off'), so the write
    // above already carries the enablement — no separate gating write exists,
    // and adding one here would clobber a non-default choice with the stock
    // mode when the batch flushes.
    setConfig('behavior.guidanceMode', controller.getStringFieldValue('experience.guidance', controller.runtimeSnapshot?.runtimeDefaults.behavior.guidanceMode ?? 'minimal'));
    setConfig('permissions.mode', controller.getStringFieldValue('experience.permissions', controller.runtimeSnapshot?.runtimeDefaults.permissionsMode ?? 'prompt'));
    setConfig('storage.secretPolicy', controller.getStringFieldValue('external-services.secret-policy', controller.runtimeSnapshot?.runtimeDefaults.secretStoragePolicy ?? 'preferred_secure'));

    // Provider-agnostic key capture: store each entered key under the provider's
    // own declared secret key. Empty fields are skipped (setSecret no-ops), so
    // a blank field keeps any existing key untouched.
    for (const target of deriveProviderKeyCaptureTargets(controller.runtimeSnapshot?.providerAccounts?.providers)) {
      setSecret(target.apiKeyEnvVar, controller.getStringFieldValue(providerKeyFieldId(target.providerId), ''));
    }

    if (shouldShowCloudflareStep(controller)) {
      addCloudflareOperations(controller, operations, setSecret);
    }

    const externalIntegrations = controller.isCapabilitySelected('external-integrations');
    const enabledExternalSurfaceIds: string[] = [];
    for (const surface of EXTERNAL_SURFACE_SPECS) {
      const selected = externalIntegrations
        && controller.getBooleanFieldValue(
          surface.enabledFieldId,
          isExternalSurfaceSelectedByDefault(surface, controller.runtimeSnapshot),
        );
      const autoStart = selected
        && controller.getStringFieldValue(
          getExternalSurfaceAutoStartFieldId(surface),
          getExternalSurfaceAutoStartDefaultValue(surface, controller.runtimeSnapshot),
        ) === 'yes';
      setConfig(surface.enabledConfigKey, autoStart);
      if (!selected) continue;
      enabledExternalSurfaceIds.push(surface.id);

      for (const setupField of surface.fields) {
        const fallback = setupField.defaultValue(controller.runtimeSnapshot);
        if (setupField.valueType === 'number') {
          setConfig(
            setupField.configKey,
            controller.getNumberFieldValue(
              setupField.id,
              setupField.defaultNumber ?? (Number.parseInt(fallback, 10) || 0),
              setupField.min,
              setupField.max,
            ),
          );
          continue;
        }

        const value = controller.getStringFieldValue(setupField.id, fallback);
        if (setupField.kind === 'masked') setMaskedConfig(setupField.configKey, value);
        else setConfig(setupField.configKey, value);
      }
    }
    // Feature units from the guided feature steps (safety, memory & context,
    // telemetry, automation, provider, advanced): enable/disable each feature
    // the user changed from its default and write its chosen sub-options.
    applyFeatureUnitOperations(controller, setConfig, featureFlagOverrides);

    // Surface/server capabilities are authoritative for the network-exposing
    // features they own — apply them last so they win over any feature-step
    // override.
    for (const surfaceFlag of getServerSurfaceFeatureFlags({
      serverBacked: hasServers,
      web: browserAccess,
      externalSurfaces: enabledExternalSurfaceIds,
    })) {
      featureFlagOverrides.set(surfaceFlag, 'enabled');
    }
    // Each selection lands as a plain domain-settings write on the feature's
    // real enablement key (e.g. sandbox.enabled, controlPlane.gateway).
    for (const flagId of [...featureFlagOverrides.keys()].sort((left, right) => left.localeCompare(right))) {
      const write = featureEnablementWrite(flagId, featureFlagOverrides.get(flagId)! === 'enabled');
      if (write) setConfig(write.key, write.value);
    }

    acknowledge('providers', 'providers.reviewed');
    acknowledge('subscriptions', 'accounts.subscriptions');
    acknowledge('auth', 'accounts.auth');

    return {
      mode: controller.mode,
      source: 'wizard',
      operations,
    };
  }

function addCloudflareOperations(
  controller: OnboardingWizardControllerLike,
  operations: OnboardingApplyOperation[],
  setSecret: (key: string, value: string) => void,
): void {
    const setConfig = (
      key: Extract<OnboardingApplyOperation, { kind: 'set-config' }>['key'],
      value: unknown,
    ): void => {
      operations.push({ kind: 'set-config', key, value });
    };

    const config = controller.runtimeSnapshot?.config.cloudflare;
    const enabledDefault = controller.isCapabilitySelected('cloudflare-batch') || config?.enabled === true;
    const enabled = controller.getBooleanFieldValue('cloudflare.enabled', enabledDefault);
    const components = getCloudflareComponentSelection(controller);
    const batchMode = enabled ? getCloudflareBatchMode(controller) : 'off';
    const setupSource = getCloudflareSetupSource(controller);
    const existingApiTokenRef = config?.apiTokenRef ?? '';
    let apiTokenRef = existingApiTokenRef;

    if (!enabled) {
      setConfig('cloudflare.enabled', false);
      setConfig('batch.mode', 'off');
      setConfig('batch.queueBackend', 'local');
      return;
    }

    if (setupSource === 'operational-env') {
      apiTokenRef = buildCloudflareApiTokenRef(
        controller.getStringFieldValue('cloudflare.operational-env-name', 'CLOUDFLARE_API_TOKEN'),
      );
    } else if (setupSource === 'operational-token') {
      const token = controller.getStringFieldValue('cloudflare.operational-token', '');
      if (token.length > 0) {
        setSecret('CLOUDFLARE_API_TOKEN', token);
        apiTokenRef = buildCloudflareOperationalTokenRef();
      }
    }

    setConfig('cloudflare.enabled', true);
    setConfig('cloudflare.freeTierMode', controller.getStringFieldValue('cloudflare.free-tier-mode', config?.freeTierMode === false ? 'no' : 'yes') === 'yes');
    setConfig('cloudflare.accountId', controller.getStringFieldValue('cloudflare.account-id', config?.accountId ?? ''));
    setConfig('cloudflare.apiTokenRef', apiTokenRef);
    setConfig('cloudflare.zoneId', controller.getStringFieldValue('cloudflare.zone-id', config?.zoneId ?? ''));
    setConfig('cloudflare.zoneName', controller.getStringFieldValue('cloudflare.zone-name', config?.zoneName ?? ''));
    setConfig('cloudflare.workerName', controller.getStringFieldValue('cloudflare.worker-name', config?.workerName ?? 'goodvibes-batch-worker'));
    setConfig('cloudflare.workerSubdomain', controller.getStringFieldValue('cloudflare.worker-subdomain', config?.workerSubdomain ?? ''));
    setConfig('cloudflare.workerHostname', controller.getStringFieldValue('cloudflare.worker-hostname', config?.workerHostname ?? ''));
    setConfig('cloudflare.workerBaseUrl', controller.getStringFieldValue('cloudflare.worker-base-url', config?.workerBaseUrl ?? ''));
    setConfig('cloudflare.daemonBaseUrl', controller.getStringFieldValue('cloudflare.daemon-base-url', config?.daemonBaseUrl ?? ''));
    setConfig('cloudflare.daemonHostname', controller.getStringFieldValue('cloudflare.daemon-hostname', config?.daemonHostname ?? ''));
    setConfig('cloudflare.workerCron', controller.getStringFieldValue('cloudflare.worker-cron', config?.workerCron ?? '*/5 * * * *'));
    setConfig('cloudflare.queueName', controller.getStringFieldValue('cloudflare.queue-name', config?.queueName ?? 'goodvibes-batch'));
    setConfig('cloudflare.deadLetterQueueName', controller.getStringFieldValue('cloudflare.dead-letter-queue-name', config?.deadLetterQueueName ?? 'goodvibes-batch-dlq'));
    setConfig('cloudflare.tunnelName', controller.getStringFieldValue('cloudflare.tunnel-name', config?.tunnelName ?? 'goodvibes-daemon'));
    setConfig('cloudflare.tunnelId', controller.getStringFieldValue('cloudflare.tunnel-id', config?.tunnelId ?? ''));
    setConfig('cloudflare.tunnelTokenRef', controller.getStringFieldValue('cloudflare.tunnel-token-ref', config?.tunnelTokenRef ?? ''));
    setConfig('cloudflare.accessAppId', controller.getStringFieldValue('cloudflare.access-app-id', config?.accessAppId ?? ''));
    setConfig('cloudflare.accessServiceTokenId', controller.getStringFieldValue('cloudflare.access-service-token-id', config?.accessServiceTokenId ?? ''));
    setConfig('cloudflare.accessServiceTokenRef', controller.getStringFieldValue('cloudflare.access-service-token-ref', config?.accessServiceTokenRef ?? ''));
    setConfig('cloudflare.kvNamespaceName', controller.getStringFieldValue('cloudflare.kv-namespace-name', config?.kvNamespaceName ?? 'goodvibes-runtime'));
    setConfig('cloudflare.kvNamespaceId', controller.getStringFieldValue('cloudflare.kv-namespace-id', config?.kvNamespaceId ?? ''));
    setConfig('cloudflare.durableObjectNamespaceName', controller.getStringFieldValue('cloudflare.do-namespace-name', config?.durableObjectNamespaceName ?? 'GoodVibesCoordinator'));
    setConfig('cloudflare.durableObjectNamespaceId', controller.getStringFieldValue('cloudflare.do-namespace-id', config?.durableObjectNamespaceId ?? ''));
    setConfig('cloudflare.r2BucketName', controller.getStringFieldValue('cloudflare.r2-bucket-name', config?.r2BucketName ?? 'goodvibes-artifacts'));
    setConfig('cloudflare.secretsStoreName', controller.getStringFieldValue('cloudflare.secrets-store-name', config?.secretsStoreName ?? 'goodvibes'));
    setConfig('cloudflare.secretsStoreId', controller.getStringFieldValue('cloudflare.secrets-store-id', config?.secretsStoreId ?? ''));
    setConfig('cloudflare.maxQueueOpsPerDay', controller.getNumberFieldValue('cloudflare.max-queue-ops-per-day', config?.maxQueueOpsPerDay ?? 10000, 1));
    setConfig('batch.mode', batchMode);
    setConfig('batch.queueBackend', batchMode !== 'off' && components.queues ? 'cloudflare' : 'local');
    // Zero Trust Tunnel auto-enables trustProxy on both services so the
    // login-rate-limiter keys on the real CF-Connecting-IP rather than the tunnel
    // egress address. RESIDUAL RISK: until the SDK validates CF-Connecting-IP
    // against Cloudflare's published IP ranges (SDK handoff Item 5), a client
    // that reaches the listener directly can spoof the header to bypass the
    // per-IP limiter. The wizard surfaces this in the cloudflare step notice.
    if (components.zeroTrustTunnel) {
      setConfig('controlPlane.trustProxy', true);
      setConfig('httpListener.trustProxy', true);
    }
  }

export function addNetworkOperations(
  controller: OnboardingWizardControllerLike,
    operations: OnboardingApplyOperation[],
    customNetwork: boolean,
    enabled: {
      readonly controlPlane: boolean;
      readonly controlPlaneRemote: boolean;
      readonly httpListener: boolean;
      readonly web: boolean;
    },
  ): void {
    const setConfig = (
      key: Extract<OnboardingApplyOperation, { kind: 'set-config' }>['key'],
      value: unknown,
    ): void => {
      operations.push({ kind: 'set-config', key, value });
    };
    const networkFacingEnabled = {
      controlPlane: enabled.controlPlaneRemote,
      httpListener: enabled.httpListener,
      web: enabled.web,
    };
    const sharedIpDefault = controller.getSharedIpDefault(networkFacingEnabled);
    const sharedIp = controller.getBooleanFieldValue('network.shared-ip', sharedIpDefault);
    const sharedHost = controller.getStringFieldValue('network.shared-ip-address', controller.getSharedIpHostDefault(networkFacingEnabled)) || '0.0.0.0';
    const controlPlaneHost = sharedIp
      ? sharedHost
      : controller.getStringFieldValue('network.service-ip', controller.runtimeSnapshot?.bindSettings.controlPlane.host ?? '0.0.0.0');
    const httpListenerHost = sharedIp
      ? sharedHost
      : controller.getStringFieldValue('network.webhook-ip', controller.runtimeSnapshot?.bindSettings.httpListener.host ?? '0.0.0.0');
    const webHost = sharedIp
      ? sharedHost
      : controller.getStringFieldValue('network.browser-ip', controller.runtimeSnapshot?.bindSettings.web.host ?? '0.0.0.0');

    if (enabled.controlPlane) {
      setConfig('controlPlane.hostMode', enabled.controlPlaneRemote ? (customNetwork ? 'custom' : 'network') : 'local');
      setConfig('controlPlane.host', enabled.controlPlaneRemote ? (customNetwork ? controlPlaneHost : '0.0.0.0') : '127.0.0.1');
      setConfig('controlPlane.port', controller.getPortFieldValue('network.service-port', controller.runtimeSnapshot?.bindSettings.controlPlane.port ?? 3421));
      setConfig('controlPlane.allowRemote', enabled.controlPlaneRemote && (customNetwork ? !isLoopbackAddress(controlPlaneHost) : true));
    }

    if (enabled.httpListener) {
      setConfig('httpListener.hostMode', customNetwork ? 'custom' : 'network');
      setConfig('httpListener.host', customNetwork ? httpListenerHost : '0.0.0.0');
      setConfig('httpListener.port', controller.getPortFieldValue('network.webhook-port', controller.runtimeSnapshot?.bindSettings.httpListener.port ?? 3422));
    }

    if (enabled.web) {
      setConfig('web.hostMode', customNetwork ? 'custom' : 'network');
      setConfig('web.host', customNetwork ? webHost : '0.0.0.0');
      setConfig('web.port', controller.getPortFieldValue('network.browser-port', controller.runtimeSnapshot?.bindSettings.web.port ?? 3423));
    }
  }
