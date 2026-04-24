import { createOAuthLocalListener } from '@pellux/goodvibes-sdk/platform/config/oauth-local-listener';
import { beginOpenAICodexLogin, exchangeOpenAICodexCode } from '@pellux/goodvibes-sdk/platform/config/openai-codex-auth';
import { openExternalUrl } from '@pellux/goodvibes-sdk/platform/utils/open-external';
import { buildProviderAccountSnapshot } from '@pellux/goodvibes-sdk/platform/runtime/provider-accounts/registry';
import { OnboardingWizardController, type OnboardingWizardAction } from './onboarding/onboarding-wizard.ts';
import { applyOnboardingRequest, collectOnboardingSnapshot, verifyOnboardingRequest } from '../runtime/onboarding/index.ts';
import type { OnboardingApplyRequest, OnboardingVerificationItem } from '../runtime/onboarding/index.ts';
import type { ModelPickerTarget } from './model-picker.ts';
import { captureOnboardingWizardSnapshot, restoreOnboardingWizardSnapshot } from './handler-ui-state.ts';
import type { InputHandler } from './handler.ts';

export interface OnboardingRuntimePosture {
  readonly serviceEnabled: boolean;
  readonly serviceAutostart: boolean;
  readonly restartOnFailure: boolean;
  readonly expectedDaemon: boolean;
  readonly expectedHttpListener: boolean;
  readonly serverBacked: boolean;
  readonly remoteExposure: boolean;
}

function extractAuthorizationCode(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  try {
    const url = new URL(trimmed);
    return url.searchParams.get('code');
  } catch {
    return trimmed;
  }
}

function isLoopbackHostValue(value: string | null | undefined): boolean {
  const normalized = (value ?? '').trim().toLowerCase();
  if (normalized.length === 0) return false;
  return normalized === 'localhost'
    || normalized === '::1'
    || normalized === '[::1]'
    || normalized === '0:0:0:0:0:0:0:1'
    || /^127(?:\.\d{1,3}){3}$/.test(normalized);
}

export function clearOnboardingPendingModelPickerTargetForHandler(handler: InputHandler): void {
    handler.onboardingWizard.clearPendingModelPickerTarget();
  }

export function clearOnboardingModelPickerCancelStateForHandler(handler: InputHandler): void {
    handler.onboardingModelPickerCancelSnapshot = null;
  }

export function restoreOnboardingModelPickerCancelStateForHandler(handler: InputHandler): void {
    if (!handler.onboardingModelPickerCancelSnapshot) return;
    restoreOnboardingWizardSnapshot(handler.onboardingWizard, handler.onboardingModelPickerCancelSnapshot, {
      active: true,
    });
    handler.onboardingModelPickerCancelSnapshot = null;
  }

export function openModelPickerWithTargetForHandler(
  handler: InputHandler,
    target: ModelPickerTarget,
    source: 'settings' | 'onboarding' = 'settings',
  ): boolean {
    const openModelPicker = handler.commandContext?.openModelPicker;
    if (!openModelPicker) return false;
    if (source === 'onboarding' && handler.onboardingWizard.active) {
      handler.onboardingModelPickerCancelSnapshot = captureOnboardingWizardSnapshot(handler.onboardingWizard);
    } else {
      handler.clearOnboardingModelPickerCancelState();
    }
    handler.clearOnboardingPendingModelPickerTarget();
    handler.modelPicker.target = target;
    openModelPicker();
    return true;
  }

export function handleModelPickerCommitForHandler(handler: InputHandler): boolean {
    if (handler.onboardingModelPickerCancelSnapshot && handler.onboardingWizard.active) {
      const selected = handler.modelPicker.mode === 'effort'
        ? handler.modelPicker.pendingModel
        : handler.modelPicker.mode === 'contextCap'
          ? handler.modelPicker.contextCapPendingModel
          : handler.modelPicker.getSelected();
      if (selected) {
        handler.onboardingWizard.applyModelSelection(handler.modelPicker.target, {
          providerId: selected.provider,
          modelId: selected.registryKey ?? selected.id,
          enabled: true,
        });
        if (handler.modelPicker.target === 'main' && handler.modelPicker.mode === 'effort') {
          const effort = handler.modelPicker.effortLevels[handler.modelPicker.selectedIndex];
          if (effort) handler.onboardingWizard.setFieldValue('default-model.reasoning', effort);
        }
      }
      handler.clearOnboardingPendingModelPickerTarget();
      handler.clearOnboardingModelPickerCancelState();
      return true;
    }
    handler.clearOnboardingPendingModelPickerTarget();
    handler.clearOnboardingModelPickerCancelState();
    return false;
  }

export async function handleOnboardingActionForHandler(handler: InputHandler, action: OnboardingWizardAction): Promise<void> {
    if (action === 'start-openai-subscription') {
      await handler.handleOpenAiSubscriptionStart();
      return;
    }
    if (action === 'finish-openai-subscription') {
      await handler.handleOpenAiSubscriptionFinish();
      return;
    }
    if (action !== 'apply') return;
    if (handler.onboardingApplyPending) return;
    const blockers = handler.onboardingWizard.getBlockingFieldLabels();
    if (blockers.length > 0) {
      handler.commandContext?.print?.([
        'Onboarding needs these fields before applying.',
        ...blockers.map((label) => `  ${label}`),
      ].join('\n'));
      handler.requestRender();
      return;
    }

    const request = handler.onboardingWizard.buildApplyRequest();
    const deps = {
      config: handler.uiServices.platform.configManager,
      secrets: handler.uiServices.platform.secretsManager,
      auth: handler.uiServices.platform.localUserAuthManager,
      shellPaths: handler.uiServices.environment.shellPaths,
      acknowledgementScope: 'project' as const,
    };
    let appliedErrors: string[] = [];
    let verificationItems: readonly OnboardingVerificationItem[] = [];
    handler.onboardingApplyPending = true;
    try {
      const applied = await applyOnboardingRequest(deps, request);
      const verification = await verifyOnboardingRequest(deps, request);
      verificationItems = verification.items;
      appliedErrors = [
        ...applied.errors.map((error) => `apply ${error.kind}: ${error.message}`),
        ...verification.items
          .filter((item) => item.status !== 'pass')
          .map((item) => `verify ${item.id}: ${item.message}`),
      ];

      if (appliedErrors.length === 0) {
        const activationVerification = await handler.restartOnboardingExternalServicesIfNeeded(request);
        const runtimeVerification = [...activationVerification, ...handler.verifyOnboardingRuntimePosture(request)];
        verificationItems = [...verification.items, ...runtimeVerification];
        appliedErrors = runtimeVerification
          .filter((item) => item.status === 'fail')
          .map((item) => `verify ${item.id}: ${item.message}`);
      }
    } catch (error) {
      handler.commandContext?.print?.([
        'Onboarding apply did not complete.',
        `  ${error instanceof Error ? error.message : String(error)}`,
      ].join('\n'));
      handler.requestRender();
      return;
    } finally {
      handler.onboardingApplyPending = false;
    }

    if (appliedErrors.length > 0) {
      handler.commandContext?.print?.([
        'Onboarding apply did not complete.',
        ...appliedErrors.map((error) => `  ${error}`),
      ].join('\n'));
      handler.requestRender();
      return;
    }

    handler.syncRuntimeFromOnboardingRequest(request);
    handler.onboardingWizard.markApplied();
    handler.onboardingWizard.close();
    for (let index = handler.modalStack.length - 1; index >= 0; index -= 1) {
      if (handler.modalStack[index] === 'onboarding') handler.modalStack.splice(index, 1);
    }
    if (handler.modalStack.length === 0) {
      const returnFocus = handler.modalReturnFocus;
      handler.panelFocused = returnFocus === 'panel';
      handler.indicatorFocused = returnFocus === 'indicator';
      handler.modalReturnFocus = 'prompt';
    }
    const warnings = verificationItems.filter((item) => item.status === 'warn');
    handler.commandContext?.print?.([
      `Onboarding applied and verified ${verificationItems.length} item(s).`,
      ...warnings.map((warning) => `  warning ${warning.id}: ${warning.message}`),
    ].join('\n'));
    handler.requestRender();
  }

export async function refreshOnboardingHydrationForHandler(handler: InputHandler, options: {
    readonly preserveValues?: boolean;
    readonly targetStepId?: string;
  } = {}): Promise<void> {
    const hydrationSerial = ++handler.onboardingHydrationSerial;
    handler.onboardingWizard.beginRuntimeHydration();
    handler.requestRender();
    try {
      const snapshot = await collectOnboardingSnapshot({
        config: handler.uiServices.platform.configManager,
        shellPaths: handler.uiServices.environment.shellPaths,
        acknowledgementScope: 'project',
        subscriptions: handler.uiServices.platform.subscriptionManager,
        secrets: handler.uiServices.platform.secretsManager,
        auth: handler.uiServices.platform.localUserAuthManager,
        services: handler.uiServices.platform.serviceRegistry,
        surfaces: {
          list: () => handler.uiServices.platform.surfaceRegistry.syncConfiguredSurfaces(),
        },
        providerAccounts: {
          loadSnapshot: () => buildProviderAccountSnapshot({
            providerRegistry: handler.uiServices.providers.providerRegistry,
            serviceRegistry: handler.uiServices.platform.serviceRegistry,
            subscriptionManager: handler.uiServices.platform.subscriptionManager,
            secretsManager: handler.uiServices.platform.secretsManager,
          }),
        },
      });
      if (!handler.onboardingWizard.active || hydrationSerial !== handler.onboardingHydrationSerial) return;
      handler.onboardingWizard.hydrateRuntimeState({ snapshot }, { resetValues: !(options.preserveValues ?? false) });
      if (options.targetStepId) {
        const targetIndex = handler.onboardingWizard.steps.findIndex((step) => step.id === options.targetStepId);
        if (targetIndex >= 0) handler.onboardingWizard.setStep(targetIndex);
      }
      handler.requestRender();
    } catch (error) {
      if (!handler.onboardingWizard.active || hydrationSerial !== handler.onboardingHydrationSerial) return;
      const message = error instanceof Error ? error.message : String(error);
      handler.onboardingWizard.failRuntimeHydration(message);
      handler.requestRender();
    }
  }

export async function handleOpenAiSubscriptionStartForHandler(handler: InputHandler): Promise<void> {
    if (handler.onboardingApplyPending) return;
    handler.onboardingApplyPending = true;
    let listener: Awaited<ReturnType<typeof createOAuthLocalListener>> | null = null;
    try {
      const started = await beginOpenAICodexLogin();
      handler.uiServices.platform.subscriptionManager.savePending({
        provider: 'openai',
        state: started.state,
        verifier: started.verifier,
        redirectUri: started.redirectUri,
        createdAt: Date.now(),
      });
      listener = await createOAuthLocalListener({
        expectedState: started.state,
        host: '127.0.0.1',
        port: 1455,
        path: '/auth/callback',
      }).catch(() => null);
      const browserOpened = await openExternalUrl(started.authorizationUrl);
      await handler.refreshOnboardingHydration({ preserveValues: true, targetStepId: 'provider-access' });
      handler.onboardingWizard.setFieldValue('providers.openai-authorization-url', started.authorizationUrl);
      const providerIndex = handler.onboardingWizard.steps.findIndex((step) => step.id === 'provider-access');
      if (providerIndex >= 0) handler.onboardingWizard.setStep(providerIndex);
      handler.requestRender();

      if (listener && browserOpened) {
        const serial = ++handler.onboardingOpenAiListenerSerial;
        handler.commandContext?.print?.([
          'OpenAI subscription sign-in started from onboarding.',
          '  callback listener: waiting on 127.0.0.1:1455',
          '  authorizationUrl: shown in the wizard provider step',
          'You can also paste the callback code or URL into the OpenAI callback field.',
        ].join('\n'));
        void handler.completeOpenAiSubscriptionFromListener(listener, started.verifier, serial);
        listener = null;
        handler.requestRender();
        return;
      }

      listener?.close();
      handler.commandContext?.print?.([
        'OpenAI subscription sign-in started from onboarding.',
        `  browser: ${browserOpened ? 'opened' : 'open failed'}`,
        `  callback listener: ${listener ? 'ready' : 'unavailable'}`,
        '  authorizationUrl: shown in the wizard provider step',
        'Paste the callback code or URL into the OpenAI callback field after sign-in.',
      ].join('\n'));
      handler.requestRender();
    } catch (error) {
      listener?.close();
      handler.commandContext?.print?.([
        'OpenAI subscription sign-in could not start.',
        `  ${error instanceof Error ? error.message : String(error)}`,
      ].join('\n'));
      handler.requestRender();
    } finally {
      handler.onboardingApplyPending = false;
    }
  }

export async function completeOpenAiSubscriptionFromListenerForHandler(
  handler: InputHandler,
    listener: Awaited<ReturnType<typeof createOAuthLocalListener>>,
    verifier: string,
    serial: number,
  ): Promise<void> {
    try {
      const callback = await listener.waitForCode();
      const pending = handler.uiServices.platform.subscriptionManager.getPending('openai');
      if (!pending || pending.verifier !== verifier || serial !== handler.onboardingOpenAiListenerSerial) return;
      const token = await exchangeOpenAICodexCode(callback.code, verifier);
      const now = Date.now();
      const existing = handler.uiServices.platform.subscriptionManager.get('openai');
      handler.uiServices.platform.subscriptionManager.saveSubscription({
        provider: 'openai',
        accessToken: token.accessToken,
        refreshToken: token.refreshToken,
        tokenType: token.tokenType,
        expiresAt: token.expiresAt,
        ...(token.scopes ? { scopes: token.scopes } : {}),
        authMode: 'oauth',
        overrideAmbientApiKeys: false,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      });
      handler.uiServices.platform.subscriptionManager.clearPending('openai');
      handler.onboardingOpenAiListenerSerial += 1;
      handler.commandContext?.print?.([
        'OpenAI subscription sign-in completed from onboarding.',
        `  tokenType: ${token.tokenType}`,
        `  expiresAt: ${token.expiresAt ? new Date(token.expiresAt).toISOString() : 'n/a'}`,
      ].join('\n'));
      await handler.refreshOnboardingHydration({ preserveValues: true, targetStepId: 'provider-access' });
    } catch (error) {
      handler.commandContext?.print?.([
        'OpenAI subscription listener could not complete automatically.',
        `  listener: ${error instanceof Error ? error.message : String(error)}`,
        'Paste the callback code or URL into the OpenAI callback field to finish in onboarding.',
      ].join('\n'));
      handler.requestRender();
    } finally {
      listener.close();
    }
  }

export async function handleOpenAiSubscriptionFinishForHandler(handler: InputHandler): Promise<void> {
    if (handler.onboardingApplyPending) return;
    const code = extractAuthorizationCode(handler.onboardingWizard.getTextFieldValue('providers.openai-callback-code'));
    if (!code) {
      handler.commandContext?.print?.('OpenAI subscription sign-in needs a callback code or URL.');
      handler.requestRender();
      return;
    }

    handler.onboardingApplyPending = true;
    try {
      const pending = handler.uiServices.platform.subscriptionManager.getPending('openai');
      if (!pending) {
        handler.commandContext?.print?.('No pending OpenAI subscription sign-in exists in onboarding.');
        handler.requestRender();
        return;
      }

      const token = await exchangeOpenAICodexCode(code, pending.verifier);
      const now = Date.now();
      const existing = handler.uiServices.platform.subscriptionManager.get('openai');
      handler.uiServices.platform.subscriptionManager.saveSubscription({
        provider: 'openai',
        accessToken: token.accessToken,
        refreshToken: token.refreshToken,
        tokenType: token.tokenType,
        expiresAt: token.expiresAt,
        ...(token.scopes ? { scopes: token.scopes } : {}),
        authMode: 'oauth',
        overrideAmbientApiKeys: false,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      });
      handler.uiServices.platform.subscriptionManager.clearPending('openai');
      handler.commandContext?.print?.([
        'OpenAI subscription sign-in completed from onboarding.',
        `  tokenType: ${token.tokenType}`,
        `  expiresAt: ${token.expiresAt ? new Date(token.expiresAt).toISOString() : 'n/a'}`,
      ].join('\n'));
      await handler.refreshOnboardingHydration({ preserveValues: true, targetStepId: 'provider-access' });
    } catch (error) {
      handler.commandContext?.print?.([
        'OpenAI subscription sign-in could not finish.',
        `  ${error instanceof Error ? error.message : String(error)}`,
      ].join('\n'));
      handler.requestRender();
    } finally {
      handler.onboardingApplyPending = false;
    }
  }

export function syncRuntimeFromOnboardingRequestForHandler(handler: InputHandler, request: ReturnType<OnboardingWizardController['buildApplyRequest']>): void {
    const runtime = handler.commandContext?.session.runtime;
    if (!runtime) return;

    for (const operation of request.operations) {
      if (operation.kind !== 'set-config') continue;
      if (operation.key === 'provider.model' && typeof operation.value === 'string') runtime.model = operation.value;
      if (operation.key === 'provider.provider' && typeof operation.value === 'string') runtime.provider = operation.value;
      if (operation.key === 'provider.reasoningEffort' && typeof operation.value === 'string') runtime.reasoningEffort = operation.value;
    }
  }

export function getOnboardingConfigValueForHandler(handler: InputHandler, request: OnboardingApplyRequest, key: string): unknown {
    const config = handler.uiServices.platform.configManager;
    for (let index = request.operations.length - 1; index >= 0; index -= 1) {
      const operation = request.operations[index];
      if (operation?.kind === 'set-config' && operation.key === key) return operation.value;
    }
    return config.get(key as never);
  }

export function getOnboardingRuntimePostureForHandler(handler: InputHandler, request: OnboardingApplyRequest): OnboardingRuntimePosture {
    const getConfigValue = (key: string): unknown => handler.getOnboardingConfigValue(request, key);
    const serviceEnabled = getConfigValue('service.enabled') === true;
    const serviceAutostart = getConfigValue('service.autostart') === true;
    const restartOnFailure = getConfigValue('service.restartOnFailure') === true;
    const daemonEnabled = getConfigValue('danger.daemon') === true || getConfigValue('controlPlane.enabled') === true;
    const listenerEnabled = getConfigValue('danger.httpListener') === true;
    const webEnabled = getConfigValue('web.enabled') === true;
    const controlPlaneRemote = getConfigValue('controlPlane.hostMode') === 'network'
      || (getConfigValue('controlPlane.hostMode') === 'custom'
        && !isLoopbackHostValue(String(getConfigValue('controlPlane.host') ?? '')))
      || getConfigValue('controlPlane.allowRemote') === true;
    const listenerRemote = getConfigValue('httpListener.hostMode') === 'network'
      || (getConfigValue('httpListener.hostMode') === 'custom'
        && !isLoopbackHostValue(String(getConfigValue('httpListener.host') ?? '')));
    const webRemote = getConfigValue('web.hostMode') === 'network'
      || (getConfigValue('web.hostMode') === 'custom'
        && !isLoopbackHostValue(String(getConfigValue('web.host') ?? '')));
    const remoteExposure = controlPlaneRemote || listenerRemote || webRemote;

    return {
      serviceEnabled,
      serviceAutostart,
      restartOnFailure,
      expectedDaemon: daemonEnabled || webEnabled,
      expectedHttpListener: listenerEnabled,
      serverBacked: serviceEnabled || daemonEnabled || listenerEnabled || webEnabled,
      remoteExposure,
    };
  }

export async function restartOnboardingExternalServicesIfNeededForHandler(handler: InputHandler, request: OnboardingApplyRequest): Promise<OnboardingVerificationItem[]> {
    const posture = handler.getOnboardingRuntimePosture(request);
    const externalServices = handler.uiServices.platform.externalServices;

    if (!externalServices) {
      return [{
        id: 'runtime:activation-restart',
        status: 'fail',
        message: 'Background service controller is unavailable, so onboarding cannot verify active daemon/listener state.',
        target: 'service',
      }];
    }

    const currentState = externalServices.inspect();
    const hasLiveExternalServices = currentState.daemonRunning === true
      || currentState.daemonPortInUse === true
      || currentState.httpListenerRunning === true
      || currentState.httpListenerPortInUse === true;
    if (!posture.serverBacked && !hasLiveExternalServices) return [];

    try {
      const state = await externalServices.restart();
      const failures: OnboardingVerificationItem[] = [];
      if (posture.expectedDaemon && !state.daemonRunning) {
        failures.push({
          id: 'runtime:daemon-active',
          status: 'fail',
          message: 'The GoodVibes daemon did not start after applying onboarding settings.',
          target: 'service',
        });
      }
      if (!posture.expectedDaemon && (state.daemonRunning || state.daemonPortInUse)) {
        failures.push({
          id: 'runtime:daemon-stopped',
          status: 'fail',
          message: 'The GoodVibes daemon port is still occupied after onboarding disabled server-backed surfaces.',
          target: 'service',
        });
      }
      if (posture.expectedHttpListener && !state.httpListenerRunning) {
        failures.push({
          id: 'runtime:http-listener-active',
          status: 'fail',
          message: 'The HTTP listener did not start after applying onboarding settings.',
          target: 'service',
        });
      }
      if (!posture.expectedHttpListener && (state.httpListenerRunning || state.httpListenerPortInUse)) {
        failures.push({
          id: 'runtime:http-listener-stopped',
          status: 'fail',
          message: 'The HTTP listener port is still occupied after onboarding disabled incoming event surfaces.',
          target: 'service',
        });
      }
      if (failures.length > 0) return failures;

      return [{
        id: 'runtime:activation-restart',
        status: 'pass',
        message: 'Background services restarted with the applied onboarding settings.',
        target: 'service',
      }];
    } catch (error) {
      return [{
        id: 'runtime:activation-restart',
        status: 'fail',
        message: `Background services could not restart: ${error instanceof Error ? error.message : String(error)}`,
        target: 'service',
      }];
    }
  }

export function verifyOnboardingRuntimePostureForHandler(handler: InputHandler, request: OnboardingApplyRequest): OnboardingVerificationItem[] {
    const posture = handler.getOnboardingRuntimePosture(request);
    const externalServices = handler.uiServices.platform.externalServices;
    const externalState = externalServices?.inspect();
    if (!posture.serverBacked) {
      if (!externalServices) {
        return [{
          id: 'runtime:external-services-controller',
          status: 'fail',
          message: 'Background service controller is unavailable, so onboarding cannot verify daemon/listener shutdown state.',
          target: 'service',
        }];
      }

      const stoppedItems: OnboardingVerificationItem[] = [];
      if (externalState?.daemonRunning || externalState?.daemonPortInUse) {
        stoppedItems.push({
          id: 'runtime:daemon-stopped',
          status: 'fail',
          message: 'The GoodVibes daemon port is still occupied after onboarding disabled server-backed surfaces.',
          target: 'service',
        });
      }
      if (externalState?.httpListenerRunning || externalState?.httpListenerPortInUse) {
        stoppedItems.push({
          id: 'runtime:http-listener-stopped',
          status: 'fail',
          message: 'The HTTP listener port is still occupied after onboarding disabled incoming event surfaces.',
          target: 'service',
        });
      }
      if (externalState && stoppedItems.length === 0) {
        stoppedItems.push({
          id: 'runtime:external-services-stopped',
          status: 'pass',
          message: 'Background daemon and HTTP listener are stopped for Local TUI Only.',
          target: 'service',
        });
      }
      return stoppedItems;
    }

    const auth = handler.uiServices.platform.localUserAuthManager.inspect();
    const hasLocalAuth = auth.users.length > 0;
    const items: OnboardingVerificationItem[] = [];

    items.push({
      id: 'runtime:service-mode',
      status: posture.serviceEnabled && posture.serviceAutostart && posture.restartOnFailure ? 'pass' : 'fail',
      message: posture.serviceEnabled && posture.serviceAutostart && posture.restartOnFailure
        ? 'Service mode, autostart, and restart-on-failure are enabled for server-backed onboarding.'
        : 'Server-backed onboarding requires service mode, autostart, and restart-on-failure.',
      target: 'service',
    });
    items.push({
      id: 'runtime:auth-posture',
      status: hasLocalAuth && !auth.bootstrapCredentialPresent ? 'pass' : 'fail',
      message: hasLocalAuth && !auth.bootstrapCredentialPresent
        ? 'Local auth is configured and bootstrap credentials are not present.'
        : 'Network-capable surfaces require local auth with no bootstrap credential file.',
      target: 'auth',
    });
    if (posture.remoteExposure) {
      items.push({
        id: 'runtime:remote-auth-gate',
        status: hasLocalAuth ? 'pass' : 'fail',
        message: hasLocalAuth
          ? 'Remote-capable bind settings have local auth available.'
          : 'Remote-capable bind settings cannot be applied without local auth.',
        target: 'auth',
      });
    }

    if (posture.expectedDaemon) {
      items.push({
        id: 'runtime:daemon-active',
        status: externalState?.daemonRunning ? 'pass' : 'fail',
        message: externalState?.daemonRunning
          ? 'The GoodVibes daemon is running with the applied onboarding settings.'
          : 'The GoodVibes daemon is not running after onboarding apply.',
        target: 'service',
      });
    }
    if (!posture.expectedDaemon && (externalState?.daemonRunning || externalState?.daemonPortInUse)) {
      items.push({
        id: 'runtime:daemon-stopped',
        status: 'fail',
        message: 'The GoodVibes daemon port is still occupied after onboarding disabled server-backed surfaces.',
        target: 'service',
      });
    }
    if (posture.expectedHttpListener) {
      items.push({
        id: 'runtime:http-listener-active',
        status: externalState?.httpListenerRunning ? 'pass' : 'fail',
        message: externalState?.httpListenerRunning
          ? 'The HTTP listener is running with the applied onboarding settings.'
          : 'The HTTP listener is not running after onboarding apply.',
        target: 'service',
      });
    }
    if (!posture.expectedHttpListener && (externalState?.httpListenerRunning || externalState?.httpListenerPortInUse)) {
      items.push({
        id: 'runtime:http-listener-stopped',
        status: 'fail',
        message: 'The HTTP listener port is still occupied after onboarding disabled incoming event surfaces.',
        target: 'service',
      });
    }

    return items;
  }
