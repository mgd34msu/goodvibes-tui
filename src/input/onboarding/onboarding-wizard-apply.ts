import type { OnboardingAcknowledgementTarget, OnboardingApplyOperation, OnboardingApplyRequest } from '../../runtime/onboarding/index.ts';
import { getServerSurfaceFeatureFlags } from '../../runtime/surface-feature-flags.ts';
import {
  EXTERNAL_SURFACE_SPECS,
  getExternalSurfaceAutoStartDefaultValue,
  getExternalSurfaceAutoStartFieldId,
  isExternalSurfaceSelectedByDefault,
} from './onboarding-wizard-external-surfaces.ts';
import { buildGoodVibesSecretKey, buildGoodVibesSecretRef, isLoopbackAddress, isSecretReferenceValue } from './onboarding-wizard-helpers.ts';
import type { OnboardingWizardController } from './onboarding-wizard.ts';

export function buildOnboardingApplyRequest(controller: OnboardingWizardController): OnboardingApplyRequest {
    const operations: OnboardingApplyOperation[] = [];
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
    const enableFeatureFlags = (flagIds: readonly string[]): void => {
      for (const flagId of flagIds) setConfig(`featureFlags.${flagId}`, 'enabled');
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
    setConfig('danger.daemon', hasServers);
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
      setConfig('provider.provider', defaultModel.providerId);
      setConfig('provider.model', defaultModel.modelId);
    }
    setConfig('provider.reasoningEffort', controller.getStringFieldValue('default-model.reasoning', controller.runtimeSnapshot?.providerRouting.primaryReasoningEffort ?? 'medium'));
    setConfig('behavior.hitlMode', controller.getStringFieldValue('experience.hitl', controller.runtimeSnapshot?.runtimeDefaults.behavior.hitlMode ?? 'balanced'));
    setConfig('behavior.guidanceMode', controller.getStringFieldValue('experience.guidance', controller.runtimeSnapshot?.runtimeDefaults.behavior.guidanceMode ?? 'minimal'));
    setConfig('permissions.mode', controller.getStringFieldValue('experience.permissions', controller.runtimeSnapshot?.runtimeDefaults.permissionsMode ?? 'prompt'));
    setConfig('storage.secretPolicy', controller.getStringFieldValue('external-services.secret-policy', controller.runtimeSnapshot?.runtimeDefaults.secretStoragePolicy ?? 'preferred_secure'));

    setSecret('OPENAI_API_KEY', controller.getStringFieldValue('providers.openai-api-key', ''));

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
    enableFeatureFlags(getServerSurfaceFeatureFlags({
      serverBacked: hasServers,
      web: browserAccess,
      externalSurfaces: enabledExternalSurfaceIds,
    }));

    acknowledge('providers', 'providers.reviewed');
    acknowledge('subscriptions', 'accounts.subscriptions');
    acknowledge('auth', 'accounts.auth');

    return {
      mode: controller.mode,
      source: 'wizard',
      operations,
    };
  }

export function addNetworkOperations(
  controller: OnboardingWizardController,
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
