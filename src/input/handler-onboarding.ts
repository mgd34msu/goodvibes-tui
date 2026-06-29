import { createOAuthLocalListener } from '@pellux/goodvibes-sdk/platform/config';
import { beginOpenAICodexLogin, exchangeOpenAICodexCode } from '@pellux/goodvibes-sdk/platform/config';
import { openExternalUrl, summarizeError } from '@pellux/goodvibes-sdk/platform/utils';
import { getProviderIdFromModel } from '../config/provider-model.ts';
import { buildProviderAccountSnapshot } from '@/runtime/index.ts';
import { OnboardingWizardController, type OnboardingWizardAction, type OnboardingWizardApplyFeedback } from './onboarding/onboarding-wizard.ts';
import { handleCloudflareOnboardingActionForHandler, maybeProvisionCloudflareOnFinalApplyForHandler } from './handler-onboarding-cloudflare.ts';
import { applyOnboardingRequest, collectOnboardingSnapshot, deleteWizardProgress, verifyOnboardingRequest, writeOnboardingCheckMarker, writeWizardProgress } from '../runtime/onboarding/index.ts';
import type { OnboardingApplyRequest, OnboardingVerificationItem } from '../runtime/onboarding/index.ts';
import {
  dedupeOnboardingVerificationItems,
  extractAuthorizationCode,
  formatOnboardingApplyCompletionMessage,
  isLoopbackHostValue,
} from './onboarding/onboarding-verification-helpers.ts';
import { focusFirstOffendingField, getStepValidationErrors } from './onboarding/onboarding-wizard-validation.ts';
import type { ModelPickerTarget } from './model-picker.ts';
import { captureOnboardingWizardSnapshot, restoreOnboardingWizardSnapshot } from './handler-ui-state.ts';
import type { InputHandlerLike as InputHandler, OnboardingRuntimePosture } from './handler-types.ts';
import {
  formatRuntimeActiveSuccessMessage,
  getRuntimeEndpointStatus,
  isRuntimeEndpointActive,
  isRuntimeEndpointOccupyingConfiguredPort,
  runtimePortDiagnostic,
  type OnboardingExternalServiceState,
  type OnboardingRuntimeEndpoint,
} from './onboarding/onboarding-runtime-status.ts';

function getRuntimeEndpointBinding(
  handler: InputHandler,
  request: OnboardingApplyRequest,
  endpoint: OnboardingRuntimeEndpoint,
): { readonly label: string; readonly host: string; readonly port: number } {
  const hostKey = endpoint === 'daemon' ? 'controlPlane.host' : 'httpListener.host';
  const portKey = endpoint === 'daemon' ? 'controlPlane.port' : 'httpListener.port';
  const fallbackHost = '127.0.0.1';
  const fallbackPort = endpoint === 'daemon' ? 3421 : 3422;
  const rawHost = handler.getOnboardingConfigValue(request, hostKey);
  const rawPort = handler.getOnboardingConfigValue(request, portKey);
  const parsedPort = typeof rawPort === 'number' ? rawPort : Number(rawPort);
  return {
    label: endpoint === 'daemon' ? 'GoodVibes daemon' : 'HTTP listener',
    host: String(rawHost ?? fallbackHost),
    port: Number.isFinite(parsedPort) ? parsedPort : fallbackPort,
  };
}

function formatRuntimeActiveFailureMessage(
  handler: InputHandler,
  request: OnboardingApplyRequest,
  endpoint: OnboardingRuntimeEndpoint,
  state: OnboardingExternalServiceState | undefined,
): string {
  const binding = getRuntimeEndpointBinding(handler, request, endpoint);
  const portInUse = endpoint === 'daemon' ? state?.daemonPortInUse : state?.httpListenerPortInUse;
  const status = getRuntimeEndpointStatus(state, endpoint);
  const impact = endpoint === 'daemon'
    ? 'browser, LAN, and service-backed GoodVibes surfaces may be unavailable until the daemon is running there.'
    : 'incoming webhooks and event surfaces will not receive traffic until the listener is running there.';
  return `${binding.label} is enabled for ${binding.host}:${binding.port}, but onboarding could not confirm an embedded or verified external service after restart. ${runtimePortDiagnostic(binding, portInUse, status)} Settings were saved; ${impact}`;
}

function formatRuntimeStoppedFailureMessage(
  handler: InputHandler,
  request: OnboardingApplyRequest,
  endpoint: OnboardingRuntimeEndpoint,
  state?: OnboardingExternalServiceState,
): string {
  const binding = getRuntimeEndpointBinding(handler, request, endpoint);
  const status = getRuntimeEndpointStatus(state, endpoint);
  const disabledSurface = endpoint === 'daemon' ? 'server-backed surfaces' : 'incoming event surfaces';
  const statusDetail = status ? ` ${runtimePortDiagnostic(binding, undefined, status)}` : '';
  return `${binding.label} was disabled for ${disabledSurface}, but ${binding.host}:${binding.port} is still occupied. Settings were saved; another GoodVibes process or external service may still be running on that port.${statusDetail}`;
}

function showOnboardingApplyFeedbackForHandler(handler: InputHandler, feedback: OnboardingWizardApplyFeedback): void {
    handler.onboardingWizard.setApplyFeedback(feedback);
    const reviewIndex = handler.onboardingWizard.steps.findIndex((step) => step.id === 'review');
    if (reviewIndex >= 0) handler.onboardingWizard.setStep(reviewIndex);
    handler.requestRender();
  }

function continueOnboardingSection(handler: InputHandler): void {
    handler.onboardingWizard.commitEdit();

    const step = handler.onboardingWizard.currentStep;
    const { errors, firstOffendingFieldId } = getStepValidationErrors(handler.onboardingWizard, step);
    if (errors.length > 0) {
      handler.onboardingWizard.setApplyFeedback({
        severity: 'error',
        title: 'Required fields missing',
        summary: 'Fill in the required fields below before continuing.',
        messages: errors,
      });
      if (firstOffendingFieldId !== null) {
        focusFirstOffendingField(handler.onboardingWizard, firstOffendingFieldId);
      }
      handler.requestRender();
      return;
    }

    handler.onboardingWizard.clearApplyFeedback();
    handler.onboardingWizard.nextStep();
    handler.requestRender();
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

export function openProviderModelPickerWithTargetForHandler(
  handler: InputHandler,
    target: ModelPickerTarget,
    source: 'settings' | 'onboarding' = 'settings',
  ): boolean {
    const openProviderPicker = handler.commandContext?.openProviderPicker;
    if (!openProviderPicker) return false;
    if (source === 'onboarding' && handler.onboardingWizard.active) {
      handler.onboardingModelPickerCancelSnapshot = captureOnboardingWizardSnapshot(handler.onboardingWizard);
    } else {
      handler.clearOnboardingModelPickerCancelState();
    }
    handler.clearOnboardingPendingModelPickerTarget();
    handler.modelPicker.target = target;
    openProviderPicker();
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
    if (action === 'apply-and-continue') {
      if (handler.onboardingApplyPending) return;
      continueOnboardingSection(handler);
      return;
    }
    if (action.startsWith('cloudflare-')) {
      await handleCloudflareOnboardingActionForHandler(handler, action as Extract<OnboardingWizardAction,
        | 'cloudflare-token-requirements'
        | 'cloudflare-create-operational-token'
        | 'cloudflare-discover'
        | 'cloudflare-validate'
        | 'cloudflare-provision'
        | 'cloudflare-verify'
        | 'cloudflare-disable'
      >);
      return;
    }
    if (action !== 'apply') return;
    if (handler.onboardingApplyPending) return;
    const blockers = handler.onboardingWizard.getBlockingFieldLabels();
    if (blockers.length > 0) {
      showOnboardingApplyFeedbackForHandler(handler, {
        severity: 'error',
        title: 'Cannot apply yet',
        summary: 'Fix these required or invalid fields, then apply again.',
        messages: blockers,
      });
      return;
    }

    const request = handler.onboardingWizard.buildApplyRequest();
    handler.onboardingWizard.clearApplyFeedback();
    const deps = {
      config: handler.uiServices.platform.configManager,
      secrets: handler.uiServices.platform.secretsManager,
      auth: handler.uiServices.platform.localUserAuthManager,
      shellPaths: handler.uiServices.environment.shellPaths,
      acknowledgementScope: 'project' as const,
    };
    let appliedErrors: string[] = [];
    let verificationItems: readonly OnboardingVerificationItem[] = [];
    let runtimeWarnings: readonly OnboardingVerificationItem[] = [];
    handler.onboardingApplyPending = true;
    try {
      const applied = await applyOnboardingRequest(deps, request);
      if (applied.errors.length > 0) {
        appliedErrors = applied.errors.map((error) => `apply ${error.kind}: ${error.message}`);
      } else {
        const verification = await verifyOnboardingRequest(deps, request);
        verificationItems = verification.items;
        appliedErrors = verification.items
          .filter((item) => item.status === 'fail')
          .map((item) => `verify ${item.id}: ${item.message}`);
      }

      if (appliedErrors.length === 0) {
        try {
          writeOnboardingCheckMarker(handler.uiServices.environment.shellPaths, {
            scope: 'user',
            source: 'wizard',
            mode: request.mode,
          });
          deleteWizardProgress(handler.uiServices.environment.shellPaths);
        } catch (markerError) {
          handler.commandContext?.print?.(
            `Onboarding check marker could not be written: ${summarizeError(markerError)}`,
          );
        }
        const activationVerification = await handler.restartOnboardingExternalServicesIfNeeded(request);
        runtimeWarnings = dedupeOnboardingVerificationItems([...activationVerification, ...handler.verifyOnboardingRuntimePosture(request)]
          .map((item): OnboardingVerificationItem => item.status === 'fail'
            ? { ...item, status: 'warn' }
            : item));
        verificationItems = dedupeOnboardingVerificationItems([...verificationItems, ...runtimeWarnings]);
        const cloudflareItems = await maybeProvisionCloudflareOnFinalApplyForHandler(handler);
        verificationItems = dedupeOnboardingVerificationItems([...verificationItems, ...cloudflareItems]);
      }
    } catch (error) {
      showOnboardingApplyFeedbackForHandler(handler, {
        severity: 'error',
        title: 'Apply failed',
        summary: 'The wizard could not persist these settings. No service restart was attempted.',
        messages: [error instanceof Error ? error.message : String(error)],
      });
      return;
    } finally {
      handler.onboardingApplyPending = false;
      handler.requestRender();
    }

    if (appliedErrors.length > 0) {
      showOnboardingApplyFeedbackForHandler(handler, {
        severity: 'error',
        title: 'Apply did not complete',
        summary: 'The settings were not fully applied. Review the messages below and try again.',
        messages: appliedErrors,
      });
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
    handler.commandContext?.print?.(formatOnboardingApplyCompletionMessage(verificationItems));
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

/**
 * Persist the current wizard field state to onboarding-progress.json.
 *
 * Called after each step navigation so the user can resume a partially
 * completed wizard after a restart. Masked fields (kind === 'masked') are
 * excluded from the persisted textState to avoid writing secrets to disk.
 *
 * This is a best-effort write: if it fails the wizard continues normally.
 */
export function saveWizardProgressForHandler(handler: InputHandler): void {
  const wizard = handler.onboardingWizard;
  if (!wizard.active) return;
  try {
    // Exclude masked fields to avoid persisting secrets.
    const maskedFieldIds = new Set<string>();
    for (const step of wizard.steps) {
      for (const field of step.fields) {
        if (field.kind === 'masked') maskedFieldIds.add(field.id);
      }
    }
    const safeTextState = [...wizard.textState.entries()]
      .filter(([id]) => !maskedFieldIds.has(id)) as Array<[string, string]>;

    writeWizardProgress(handler.uiServices.environment.shellPaths, {
      mode: wizard.mode,
      stepIndex: wizard.stepIndex,
      toggleState: [...wizard.toggleState.entries()],
      radioState: [...wizard.radioState.entries()],
      textState: safeTextState,
    });
  } catch {
    // Best-effort: never block wizard interaction on a progress write failure.
  }
}

export function syncRuntimeFromOnboardingRequestForHandler(handler: InputHandler, request: ReturnType<OnboardingWizardController['buildApplyRequest']>): void {
    const runtime = handler.commandContext?.session.runtime;
    if (!runtime) return;

    for (const operation of request.operations) {
      if (operation.kind !== 'set-config') continue;
      if (operation.key === 'provider.model' && typeof operation.value === 'string') {
        runtime.model = operation.value;
        runtime.provider = getProviderIdFromModel(operation.value);
      }
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
    const hasLiveExternalServices = isRuntimeEndpointOccupyingConfiguredPort(currentState, 'daemon')
      || isRuntimeEndpointOccupyingConfiguredPort(currentState, 'httpListener');
    if (!posture.serverBacked && !hasLiveExternalServices) return [];

    try {
      const state = await externalServices.restart();
      const failures: OnboardingVerificationItem[] = [];
      if (posture.expectedDaemon && !isRuntimeEndpointActive(state, 'daemon')) {
        failures.push({
          id: 'runtime:daemon-active',
          status: 'fail',
          message: formatRuntimeActiveFailureMessage(handler, request, 'daemon', state),
          target: 'service',
        });
      }
      if (!posture.expectedDaemon && isRuntimeEndpointOccupyingConfiguredPort(state, 'daemon')) {
        failures.push({
          id: 'runtime:daemon-stopped',
          status: 'fail',
          message: formatRuntimeStoppedFailureMessage(handler, request, 'daemon', state),
          target: 'service',
        });
      }
      if (posture.expectedHttpListener && !isRuntimeEndpointActive(state, 'httpListener')) {
        failures.push({
          id: 'runtime:http-listener-active',
          status: 'fail',
          message: formatRuntimeActiveFailureMessage(handler, request, 'httpListener', state),
          target: 'service',
        });
      }
      if (!posture.expectedHttpListener && isRuntimeEndpointOccupyingConfiguredPort(state, 'httpListener')) {
        failures.push({
          id: 'runtime:http-listener-stopped',
          status: 'fail',
          message: formatRuntimeStoppedFailureMessage(handler, request, 'httpListener', state),
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
      if (isRuntimeEndpointOccupyingConfiguredPort(externalState, 'daemon')) {
        stoppedItems.push({
          id: 'runtime:daemon-stopped',
          status: 'fail',
          message: formatRuntimeStoppedFailureMessage(handler, request, 'daemon', externalState),
          target: 'service',
        });
      }
      if (isRuntimeEndpointOccupyingConfiguredPort(externalState, 'httpListener')) {
        stoppedItems.push({
          id: 'runtime:http-listener-stopped',
          status: 'fail',
          message: formatRuntimeStoppedFailureMessage(handler, request, 'httpListener', externalState),
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
      const daemonActive = isRuntimeEndpointActive(externalState, 'daemon');
      items.push({
        id: 'runtime:daemon-active',
        status: daemonActive ? 'pass' : 'fail',
        message: daemonActive
          ? formatRuntimeActiveSuccessMessage('daemon', externalState)
          : formatRuntimeActiveFailureMessage(handler, request, 'daemon', externalState),
        target: 'service',
      });
    }
    if (!posture.expectedDaemon && isRuntimeEndpointOccupyingConfiguredPort(externalState, 'daemon')) {
      items.push({
        id: 'runtime:daemon-stopped',
        status: 'fail',
        message: formatRuntimeStoppedFailureMessage(handler, request, 'daemon', externalState),
        target: 'service',
      });
    }
    if (posture.expectedHttpListener) {
      const httpListenerActive = isRuntimeEndpointActive(externalState, 'httpListener');
      items.push({
        id: 'runtime:http-listener-active',
        status: httpListenerActive ? 'pass' : 'fail',
        message: httpListenerActive
          ? formatRuntimeActiveSuccessMessage('httpListener', externalState)
          : formatRuntimeActiveFailureMessage(handler, request, 'httpListener', externalState),
        target: 'service',
      });
    }
    if (!posture.expectedHttpListener && isRuntimeEndpointOccupyingConfiguredPort(externalState, 'httpListener')) {
      items.push({
        id: 'runtime:http-listener-stopped',
        status: 'fail',
        message: formatRuntimeStoppedFailureMessage(handler, request, 'httpListener', externalState),
        target: 'service',
      });
    }

    return items;
  }
