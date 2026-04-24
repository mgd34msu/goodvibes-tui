import { afterEach, describe, expect, test } from 'bun:test';
import { InfiniteBuffer } from '../../core/history.ts';
import { CommandRegistry, type CommandContext } from '../../input/command-registry.ts';
import { InputHandler } from '../../input/handler.ts';
import { OnboardingWizardController } from '../../input/onboarding/onboarding-wizard.ts';
import { EXTERNAL_SURFACE_SPECS, getExternalSurfaceAutoStartFieldId } from '../../input/onboarding/onboarding-wizard-external-surfaces.ts';
import { buildGoodVibesSecretKey, buildGoodVibesSecretRef } from '../../input/onboarding/onboarding-wizard-helpers.ts';
import { handleOnboardingWizardToken } from '../../input/onboarding/handler-onboarding-routes.ts';
import { SelectionManager } from '../../input/selection.ts';
import { DEFAULT_CONFIG } from '../../config/index.ts';
import { readOnboardingCheckMarker, type OnboardingSnapshotState } from '../../runtime/onboarding/index.ts';
import { createDefaultUiRuntimeServices } from '../helpers/ui-services.ts';
import { resetTestRuntimeServices } from '../helpers/runtime-services.ts';
import type { UiRuntimeServices } from '../../runtime/ui-services.ts';
import type { InputToken } from '@pellux/goodvibes-sdk/platform/core/tokenizer';

afterEach(() => {
  resetTestRuntimeServices();
});

function makeInput(uiServices = createDefaultUiRuntimeServices()): InputHandler {
  const history = new InfiniteBuffer();
  const input = new InputHandler(
    () => {},
    new SelectionManager(),
    () => 0,
    () => 20,
    () => history,
    () => {},
    () => {},
    uiServices,
  );
  input.setContentWidth(100);
  return input;
}

function installExternalServices(
  uiServices: UiRuntimeServices,
  controller: NonNullable<UiRuntimeServices['platform']['externalServices']>,
): void {
  (uiServices.platform as UiRuntimeServices['platform'] & {
    externalServices: NonNullable<UiRuntimeServices['platform']['externalServices']>;
  }).externalServices = controller;
}

function ensureLocalAdminAuth(uiServices: UiRuntimeServices): void {
  const auth = uiServices.platform.localUserAuthManager;
  if (!auth.getUser('admin')) auth.addUser('admin', 'admin-pass', ['admin']);
  if (auth.inspect().bootstrapCredentialPresent) auth.clearBootstrapCredentialFile();
}

function makeOnboardingSnapshot(
  overrides: Partial<OnboardingSnapshotState> = {},
): OnboardingSnapshotState {
  const config = {
    display: structuredClone(DEFAULT_CONFIG.display),
    provider: structuredClone(DEFAULT_CONFIG.provider),
    behavior: structuredClone(DEFAULT_CONFIG.behavior),
    storage: structuredClone(DEFAULT_CONFIG.storage),
    permissions: structuredClone(DEFAULT_CONFIG.permissions),
    helper: structuredClone(DEFAULT_CONFIG.helper),
    tools: {
      llmEnabled: DEFAULT_CONFIG.tools.llmEnabled,
      llmProvider: DEFAULT_CONFIG.tools.llmProvider,
      llmModel: DEFAULT_CONFIG.tools.llmModel,
    },
    danger: structuredClone(DEFAULT_CONFIG.danger),
    controlPlane: structuredClone(DEFAULT_CONFIG.controlPlane),
    httpListener: structuredClone(DEFAULT_CONFIG.httpListener),
    web: structuredClone(DEFAULT_CONFIG.web),
    network: structuredClone(DEFAULT_CONFIG.network),
    surfaces: structuredClone(DEFAULT_CONFIG.surfaces),
    service: structuredClone(DEFAULT_CONFIG.service),
    featureFlags: structuredClone(DEFAULT_CONFIG.featureFlags),
  };

  return {
    capturedAt: 1,
    config,
    providerRouting: {
      primaryProviderId: config.provider.provider,
      primaryModelId: config.provider.model,
      primaryReasoningEffort: config.provider.reasoningEffort,
      embeddingProviderId: config.provider.embeddingProvider,
      systemPromptFile: config.provider.systemPromptFile,
      helperEnabled: config.helper.enabled,
      helperProviderId: config.helper.globalProvider,
      helperModelId: config.helper.globalModel,
      toolLlmEnabled: config.tools.llmEnabled,
      toolProviderId: config.tools.llmProvider,
      toolModelId: config.tools.llmModel,
    },
    runtimeDefaults: {
      providerReasoningEffort: config.provider.reasoningEffort,
      permissionsMode: config.permissions.mode,
      behavior: config.behavior,
      display: config.display,
      secretStoragePolicy: config.storage.secretPolicy,
    },
    acknowledgements: {
      scope: 'project',
      exists: false,
      updatedAt: null,
      source: null,
      accepted: {},
    },
    services: {
      total: 0,
      oauthProviderIds: [],
      services: [],
    },
    subscriptions: {
      active: [],
      pending: [],
      activeProviderIds: [],
      pendingProviderIds: [],
    },
    secrets: {
      review: {
        policy: config.storage.secretPolicy,
        secureAvailable: false,
        storedKeys: 0,
        envBackedKeys: 0,
        secureKeys: 0,
        plaintextKeys: 0,
        warnings: [],
        locations: [],
      },
      records: [],
    },
    auth: {
      snapshot: {
        userStorePath: '',
        bootstrapCredentialPath: '',
        persisted: false,
        bootstrapCredentialPresent: false,
        userCount: 0,
        sessionCount: 0,
        users: [],
        sessions: [],
      },
    },
    bindSettings: {
      daemonEnabled: false,
      httpListenerEnabled: false,
      controlPlane: config.controlPlane,
      httpListener: config.httpListener,
      web: config.web,
    },
    surfaces: {
      configuredEnabledKinds: [],
      records: [],
    },
    providerAccounts: null,
    collectionIssues: [],
    ...overrides,
  };
}

describe('OnboardingWizardController', () => {
  test('preserves per-step selection and scroll state while tracking dirty steps', () => {
    const wizard = new OnboardingWizardController();
    wizard.open('edit');

    wizard.moveSelection(1, 2);
    wizard.activateSelected();

    expect(wizard.mode).toBe('edit');
    expect(wizard.getSelectedFieldIndex()).toBe(1);
    expect(wizard.scrollOffsets[0]).toBe(0);
    expect(wizard.dirty).toBe(true);
    expect(wizard.isStepDirty(0)).toBe(true);
    wizard.selectLast(2);
    expect(wizard.getSelectedFieldIndex()).toBe(6);
    expect(wizard.scrollOffsets[0]).toBe(5);

    wizard.setStep(2);
    wizard.moveSelection(1, 2);
    expect(wizard.getSelectedFieldIndex()).toBe(1);
    expect(wizard.scrollOffsets[2]).toBe(0);

    wizard.setStep(0);
    expect(wizard.getSelectedFieldIndex()).toBe(6);
    expect(wizard.scrollOffsets[0]).toBe(5);
  });

  test('derives service/autostart and LAN defaults from non-TUI capabilities', () => {
    const wizard = new OnboardingWizardController();
    wizard.open('new');
    wizard.setFieldValue('capabilities.browser-access', true);

    const request = wizard.buildApplyRequest();

    expect(request.operations).toContainEqual({
      kind: 'set-config',
      key: 'service.enabled',
      value: true,
    });
    expect(request.operations).toContainEqual({
      kind: 'set-config',
      key: 'service.autostart',
      value: true,
    });
    expect(request.operations).toContainEqual({
      kind: 'set-config',
      key: 'service.restartOnFailure',
      value: true,
    });
    expect(request.operations).toContainEqual({
      kind: 'set-config',
      key: 'web.hostMode',
      value: 'network',
    });
  });

  test('blocks invalid custom network ports instead of silently falling back', () => {
    const wizard = new OnboardingWizardController();
    wizard.open('new');
    wizard.setFieldValue('capabilities.browser-access', true);
    wizard.setFieldValue('network.mode', 'custom');
    wizard.setFieldValue('network.service-port', 'not-a-port');

    expect(wizard.getBlockingFieldLabels()).toContain('Network: GoodVibes service port must be a port number from 1 to 65535.');
  });

  test('blocks custom network host fields that include URL or port syntax', () => {
    const wizard = new OnboardingWizardController();
    wizard.open('new');
    wizard.setFieldValue('capabilities.browser-access', true);
    wizard.setFieldValue('network.mode', 'custom');
    wizard.setFieldValue('network.shared-ip-address', '0.0.0.0:3421');

    expect(wizard.getBlockingFieldLabels()).toContain('Network: Shared IP address must be a host or IP address, not a URL.');
  });

  test('shows listener network fields when external integrations may need inbound events', () => {
    const wizard = new OnboardingWizardController();
    wizard.open('new');
    wizard.setFieldValue('capabilities.external-integrations', true);
    wizard.setFieldValue('network.mode', 'custom');

    const networkStep = wizard.steps.find((step) => step.id === 'network');
    expect(networkStep?.fields.map((field) => field.id)).toContain('network.webhook-port');
    expect(networkStep?.fields.map((field) => field.id)).not.toContain('network.service-ip');
  });

  test('keeps the control plane local for webhook-only onboarding', () => {
    const wizard = new OnboardingWizardController();
    wizard.open('new');
    wizard.setFieldValue('capabilities.webhook-events', true);

    const request = wizard.buildApplyRequest();
    expect(request.operations).toContainEqual({ kind: 'set-config', key: 'controlPlane.enabled', value: true });
    expect(request.operations).toContainEqual({ kind: 'set-config', key: 'controlPlane.hostMode', value: 'local' });
    expect(request.operations).toContainEqual({ kind: 'set-config', key: 'controlPlane.host', value: '127.0.0.1' });
    expect(request.operations).toContainEqual({ kind: 'set-config', key: 'controlPlane.allowRemote', value: false });
    expect(request.operations).toContainEqual({ kind: 'set-config', key: 'httpListener.hostMode', value: 'network' });
  });

  test('reopening a webhook-only LAN listener keeps the control plane local', () => {
    const snapshot = makeOnboardingSnapshot({
      bindSettings: {
        daemonEnabled: true,
        httpListenerEnabled: true,
        controlPlane: {
          ...DEFAULT_CONFIG.controlPlane,
          enabled: true,
          hostMode: 'local',
          host: '127.0.0.1',
          allowRemote: false,
        },
        httpListener: {
          ...DEFAULT_CONFIG.httpListener,
          hostMode: 'network',
          host: '0.0.0.0',
        },
        web: DEFAULT_CONFIG.web,
      },
    });
    const wizard = new OnboardingWizardController();
    wizard.open('edit');
    wizard.hydrateRuntimeState({ snapshot }, { resetValues: true });

    const request = wizard.buildApplyRequest();
    expect(request.operations).toContainEqual({ kind: 'set-config', key: 'controlPlane.hostMode', value: 'local' });
    expect(request.operations).toContainEqual({ kind: 'set-config', key: 'controlPlane.host', value: '127.0.0.1' });
    expect(request.operations).toContainEqual({ kind: 'set-config', key: 'controlPlane.allowRemote', value: false });
    expect(request.operations).toContainEqual({ kind: 'set-config', key: 'httpListener.hostMode', value: 'network' });
  });

  test('derives per-service custom network hosts when existing enabled hosts differ', () => {
    const snapshot = makeOnboardingSnapshot({
      bindSettings: {
        daemonEnabled: true,
        httpListenerEnabled: true,
        controlPlane: {
          ...DEFAULT_CONFIG.controlPlane,
          enabled: true,
          hostMode: 'custom',
          host: '10.0.0.10',
          port: 3421,
        },
        httpListener: {
          ...DEFAULT_CONFIG.httpListener,
          hostMode: 'custom',
          host: '10.0.0.20',
          port: 3422,
        },
        web: {
          ...DEFAULT_CONFIG.web,
          enabled: true,
          hostMode: 'custom',
          host: '10.0.0.30',
          port: 3423,
        },
      },
    });
    const wizard = new OnboardingWizardController();
    wizard.open('edit');
    wizard.hydrateRuntimeState({ snapshot }, { resetValues: true });

    const networkStep = wizard.steps.find((step) => step.id === 'network');
    expect(networkStep?.fields.map((field) => field.id)).toContain('network.service-ip');
    expect(networkStep?.fields.map((field) => field.id)).toContain('network.browser-ip');
    expect(networkStep?.fields.map((field) => field.id)).toContain('network.webhook-ip');
    expect(networkStep?.fields.map((field) => field.id)).not.toContain('network.shared-ip-address');
  });

  test('external services exposes selected surfaces as separate setup screens', () => {
    const wizard = new OnboardingWizardController();
    wizard.open('new');
    wizard.setFieldValue('capabilities.external-integrations', true);
    wizard.setFieldValue('external-services.google-chat', true);
    wizard.setFieldValue('external-services.signal', true);
    wizard.setFieldValue('external-services.whatsapp', true);
    wizard.setFieldValue('external-services.imessage', true);
    wizard.setFieldValue('external-services.msteams', true);
    wizard.setFieldValue('external-services.bluebubbles', true);
    wizard.setFieldValue('external-services.mattermost', true);
    wizard.setFieldValue('external-services.matrix', true);

    const serviceStep = wizard.steps.find((step) => step.id === 'external-services');
    const selectorFieldIds = serviceStep?.fields.map((field) => field.id) ?? [];

    expect(selectorFieldIds).toContain('external-services.ntfy');
    expect(selectorFieldIds).not.toContain('external-services.google-chat.webhook-url');
    expect(wizard.steps.map((step) => step.id)).toContain('external-surface:googleChat');
    expect(wizard.steps.map((step) => step.id)).toContain('external-surface:matrix');
    expect(wizard.steps.find((step) => step.id === 'external-surface:googleChat')?.fields.map((field) => field.id))
      .toContain('external-services.google-chat.webhook-url');
    expect(wizard.steps.find((step) => step.id === 'external-surface:signal')?.fields.map((field) => field.id))
      .toContain('external-services.signal.token');
    expect(wizard.steps.find((step) => step.id === 'external-surface:whatsapp')?.fields.map((field) => field.id))
      .toContain('external-services.whatsapp.access-token');
    expect(wizard.steps.find((step) => step.id === 'external-surface:imessage')?.fields.map((field) => field.id))
      .toContain('external-services.imessage.token');
    expect(wizard.steps.find((step) => step.id === 'external-surface:msteams')?.fields.map((field) => field.id))
      .toContain('external-services.msteams.app-password');
    expect(wizard.steps.find((step) => step.id === 'external-surface:bluebubbles')?.fields.map((field) => field.id))
      .toContain('external-services.bluebubbles.password');
    expect(wizard.steps.find((step) => step.id === 'external-surface:mattermost')?.fields.map((field) => field.id))
      .toContain('external-services.mattermost.bot-token');
    expect(wizard.steps.find((step) => step.id === 'external-surface:matrix')?.fields.map((field) => field.id))
      .toContain('external-services.matrix.access-token');
  });

  test('enabling an inbound external surface turns on the HTTP listener', () => {
    const wizard = new OnboardingWizardController();
    wizard.open('new');
    wizard.setFieldValue('capabilities.external-integrations', true);
    wizard.setFieldValue('external-services.slack', true);
    wizard.setFieldValue('external-services.slack.auto-start', 'yes');

    const request = wizard.buildApplyRequest();

    expect(request.operations).toContainEqual({
      kind: 'set-config',
      key: 'danger.httpListener',
      value: true,
    });
    expect(request.operations).toContainEqual({
      kind: 'set-config',
      key: 'httpListener.hostMode',
      value: 'network',
    });
  });

  test('every external surface enables listener posture when selected', () => {
    const surfaceFieldIds = [
      'external-services.ntfy',
      'external-services.webhook',
      'external-services.signal',
      'external-services.imessage',
      'external-services.bluebubbles',
      'external-services.matrix',
    ];

    for (const surfaceFieldId of surfaceFieldIds) {
      const wizard = new OnboardingWizardController();
      wizard.open('new');
      wizard.setFieldValue('capabilities.external-integrations', true);
      wizard.setFieldValue(surfaceFieldId, true);
      wizard.setFieldValue(`${surfaceFieldId}.auto-start`, 'yes');

      expect(wizard.buildApplyRequest().operations).toContainEqual({
        kind: 'set-config',
        key: 'danger.httpListener',
        value: true,
      });
    }
  });

  test('stores masked surface setup values as GoodVibes secret refs', () => {
    const wizard = new OnboardingWizardController();
    wizard.open('new');
    wizard.setFieldValue('capabilities.external-integrations', true);
    wizard.setFieldValue('external-services.slack', true);
    wizard.setFieldValue('external-services.slack.bot-token', 'xoxb-secret');
    wizard.setFieldValue('external-services.slack.signing-secret', 'signing-secret');

    const request = wizard.buildApplyRequest();

    expect(request.operations).toContainEqual(expect.objectContaining({
      kind: 'set-secret',
      key: 'GOODVIBES_SURFACES_SLACK_BOT_TOKEN',
      value: 'xoxb-secret',
      scope: 'project',
    }));
    expect(request.operations).toContainEqual({
      kind: 'set-config',
      key: 'surfaces.slack.botToken',
      value: 'goodvibes://secrets/goodvibes/GOODVIBES_SURFACES_SLACK_BOT_TOKEN',
    });
  });

  test('maps editable wizard settings to apply operations', () => {
    const wizard = new OnboardingWizardController();
    wizard.open('new');
    wizard.setFieldValue('capabilities.browser-access', true);
    wizard.setFieldValue('capabilities.network-access', true);
    wizard.setFieldValue('capabilities.webhook-events', true);
    wizard.setFieldValue('capabilities.external-integrations', true);
    wizard.setFieldValue('network.mode', 'custom');
    wizard.setFieldValue('network.shared-ip', false);
    wizard.setFieldValue('network.service-ip', '10.0.0.10');
    wizard.setFieldValue('network.service-port', '4551');
    wizard.setFieldValue('network.browser-ip', '10.0.0.11');
    wizard.setFieldValue('network.browser-port', '4552');
    wizard.setFieldValue('network.webhook-ip', '10.0.0.12');
    wizard.setFieldValue('network.webhook-port', '4553');
    wizard.setFieldValue('accounts.admin-username', 'admin');
    wizard.setFieldValue('accounts.admin-password', 'admin-pass');
    wizard.setFieldValue('accounts.subscriptions', true);
    wizard.setFieldValue('accounts.auth', true);
    wizard.setFieldValue('providers.openai-api-key', 'sk-test-openai');
    wizard.setFieldValue('providers.reviewed', true);
    wizard.applyModelSelection('main', { providerId: 'openai', modelId: 'gpt-5-test', enabled: true });
    wizard.setFieldValue('default-model.reasoning', 'high');
    wizard.setFieldValue('external-services.secret-policy', 'plaintext_allowed');
    wizard.setFieldValue('experience.hitl', 'operator');
    wizard.setFieldValue('experience.guidance', 'guided');
    wizard.setFieldValue('experience.permissions', 'allow-all');

    const setupValues = new Map<string, string>();
    for (const surface of EXTERNAL_SURFACE_SPECS) {
      wizard.setFieldValue(surface.enabledFieldId, true);
      wizard.setFieldValue(getExternalSurfaceAutoStartFieldId(surface), 'yes');
    }
    for (const surface of EXTERNAL_SURFACE_SPECS) {
      for (const setupField of surface.fields) {
        const value = setupField.kind === 'radio'
          ? setupField.options?.at(-1)?.id ?? setupField.defaultValue(null)
          : setupField.valueType === 'number'
            ? String(setupField.defaultNumber ?? setupField.min ?? 1)
            : `value-${surface.id}-${setupField.id.split('.').at(-1)}`;
        wizard.setFieldValue(setupField.id, value);
        setupValues.set(setupField.id, value);
      }
    }

    const request = wizard.buildApplyRequest();
    const configValues = new Map<string, unknown>();
    const secretValues = new Map<string, string>();
    for (const operation of request.operations) {
      if (operation.kind === 'set-config') configValues.set(operation.key, operation.value);
      if (operation.kind === 'set-secret') secretValues.set(operation.key, operation.value);
    }

    expect(request.operations).toContainEqual({
      kind: 'ensure-auth-user',
      username: 'admin',
      password: 'admin-pass',
      roles: ['admin'],
      createSession: true,
      retireBootstrapCredential: false,
    });
    expect(secretValues.get('OPENAI_API_KEY')).toBe('sk-test-openai');
    expect(configValues.get('service.enabled')).toBe(true);
    expect(configValues.get('service.autostart')).toBe(true);
    expect(configValues.get('service.restartOnFailure')).toBe(true);
    expect(configValues.get('danger.daemon')).toBe(true);
    expect(configValues.get('controlPlane.enabled')).toBe(true);
    expect(configValues.get('danger.httpListener')).toBe(true);
    expect(configValues.get('web.enabled')).toBe(true);
    expect(configValues.get('controlPlane.hostMode')).toBe('custom');
    expect(configValues.get('controlPlane.host')).toBe('10.0.0.10');
    expect(configValues.get('controlPlane.port')).toBe(4551);
    expect(configValues.get('controlPlane.allowRemote')).toBe(true);
    expect(configValues.get('web.hostMode')).toBe('custom');
    expect(configValues.get('web.host')).toBe('10.0.0.11');
    expect(configValues.get('web.port')).toBe(4552);
    expect(configValues.get('httpListener.hostMode')).toBe('custom');
    expect(configValues.get('httpListener.host')).toBe('10.0.0.12');
    expect(configValues.get('httpListener.port')).toBe(4553);
    expect(configValues.get('featureFlags.control-plane-gateway')).toBe('enabled');
    expect(configValues.get('featureFlags.service-management')).toBe('enabled');
    expect(configValues.get('featureFlags.web-surface')).toBe('enabled');
    expect(configValues.get('featureFlags.route-binding')).toBe('enabled');
    expect(configValues.get('featureFlags.delivery-engine')).toBe('enabled');
    expect(configValues.get('featureFlags.omnichannel-surface-adapters')).toBe('enabled');
    expect(configValues.get('provider.provider')).toBe('openai');
    expect(configValues.get('provider.model')).toBe('gpt-5-test');
    expect(configValues.get('provider.reasoningEffort')).toBe('high');
    expect(configValues.get('storage.secretPolicy')).toBe('plaintext_allowed');
    expect(configValues.get('behavior.hitlMode')).toBe('operator');
    expect(configValues.get('behavior.guidanceMode')).toBe('guided');
    expect(configValues.get('permissions.mode')).toBe('allow-all');
    expect(request.operations).toContainEqual({ kind: 'acknowledge', target: 'providers', acknowledged: true });
    expect(request.operations).toContainEqual({ kind: 'acknowledge', target: 'subscriptions', acknowledged: true });
    expect(request.operations).toContainEqual({ kind: 'acknowledge', target: 'auth', acknowledged: true });

    for (const surface of EXTERNAL_SURFACE_SPECS) {
      expect(configValues.get(surface.enabledConfigKey)).toBe(true);
      for (const setupField of surface.fields) {
        const value = setupValues.get(setupField.id);
        expect(value).toBeDefined();
        if (setupField.valueType === 'number') {
          expect(configValues.get(setupField.configKey)).toBe(Number(value));
          continue;
        }

        if (setupField.kind === 'masked') {
          const secretKey = buildGoodVibesSecretKey(setupField.configKey);
          expect(secretValues.get(secretKey)).toBe(value);
          expect(configValues.get(setupField.configKey)).toBe(buildGoodVibesSecretRef(secretKey));
          continue;
        }

        expect(configValues.get(setupField.configKey)).toBe(value);
      }
    }
    expect(configValues.get('featureFlags.slack-surface')).toBe('enabled');
    expect(configValues.get('featureFlags.discord-surface')).toBe('enabled');
    expect(configValues.get('featureFlags.ntfy-surface')).toBe('enabled');
    expect(configValues.get('featureFlags.webhook-surface')).toBe('enabled');
  });

  test('does not block selected external surfaces when setup values are blank', () => {
    const wizard = new OnboardingWizardController();
    wizard.open('new');
    wizard.setFieldValue('capabilities.external-integrations', true);
    wizard.setFieldValue('external-services.matrix', true);

    expect(wizard.getBlockingFieldLabels()).not.toContain('Matrix: Matrix access token is required.');
    const matrixStep = wizard.steps.find((step) => step.id === 'external-surface:matrix');
    const tokenField = matrixStep?.fields.find((field) => field.id === 'external-services.matrix.access-token');
    expect(tokenField ? wizard.getFieldValueLabel(tokenField) : null).toBe('Not set');
  });

  test('does not block saving when selected external surfaces have blank setup values', () => {
    const wizard = new OnboardingWizardController();
    wizard.open('new');
    wizard.setFieldValue('capabilities.external-integrations', true);

    expect(wizard.getBlockingFieldLabels()).not.toContain('ntfy: ntfy default delivery topic is required.');
    wizard.setFieldValue('external-services.ntfy', true);
    expect(wizard.getBlockingFieldLabels()).not.toContain('ntfy: ntfy default delivery topic is required.');
    wizard.setFieldValue('external-services.ntfy', false);
    expect(wizard.getBlockingFieldLabels()).not.toContain('ntfy: ntfy default delivery topic is required.');
  });

  test('clears selected onboarding text fields with Delete', () => {
    const wizard = new OnboardingWizardController();
    wizard.open('new');
    wizard.setFieldValue('capabilities.external-integrations', true);
    wizard.setFieldValue('external-services.ntfy', true);
    wizard.setFieldValue('external-services.ntfy.token', 'old-token');

    const ntfyStepIndex = wizard.steps.findIndex((step) => step.id === 'external-surface:ntfy');
    wizard.setStep(ntfyStepIndex);
    wizard.moveSelection(6, 10);

    const routeState = {
      onboardingWizard: wizard,
      getViewportHeight: () => 20,
      requestRender: () => {},
      handleEscape: () => {},
    };

    handleOnboardingWizardToken(routeState, { type: 'key', logicalName: 'delete', ctrl: false, shift: false, meta: false } as InputToken);

    expect(wizard.getSelectedField()?.id).toBe('external-services.ntfy.token');
    expect(wizard.getTextFieldValue('external-services.ntfy.token')).toBe('');
  });

  test('clears edited onboarding text fields with Ctrl+U and persists empty masked values', () => {
    const snapshot = makeOnboardingSnapshot({
      config: {
        ...makeOnboardingSnapshot().config,
        surfaces: {
          ...makeOnboardingSnapshot().config.surfaces,
          ntfy: {
            ...makeOnboardingSnapshot().config.surfaces.ntfy,
            enabled: true,
            baseUrl: 'https://ntfy.buzznet.dev',
            topic: 'your-topic',
            token: 'old-token',
          },
        },
      },
    });
    const wizard = new OnboardingWizardController();
    wizard.open('edit');
    wizard.hydrateRuntimeState({ snapshot }, { resetValues: true });
    wizard.setFieldValue('capabilities.external-integrations', true);
    wizard.setFieldValue('external-services.ntfy', true);

    const ntfyStepIndex = wizard.steps.findIndex((step) => step.id === 'external-surface:ntfy');
    wizard.setStep(ntfyStepIndex);
    wizard.moveSelection(6, 10);

    const routeState = {
      onboardingWizard: wizard,
      getViewportHeight: () => 20,
      requestRender: () => {},
      handleEscape: () => {},
    };

    handleOnboardingWizardToken(routeState, { type: 'key', logicalName: 'return' } as InputToken);
    handleOnboardingWizardToken(routeState, { type: 'key', logicalName: 'u', ctrl: true, shift: false, meta: false } as InputToken);
    handleOnboardingWizardToken(routeState, { type: 'key', logicalName: 'return' } as InputToken);

    expect(wizard.getTextFieldValue('external-services.ntfy.token')).toBe('');
    expect(wizard.buildApplyRequest().operations).toContainEqual({
      kind: 'set-config',
      key: 'surfaces.ntfy.token',
      value: '',
    });
  });

  test('blocks malformed GoodVibes secret refs in masked fields', () => {
    const wizard = new OnboardingWizardController();
    wizard.open('new');
    wizard.setFieldValue('capabilities.external-integrations', true);
    wizard.setFieldValue('external-services.slack', true);
    wizard.setFieldValue('external-services.slack.bot-token', 'goodvibes://secrets/');

    expect(wizard.getBlockingFieldLabels()).toContain('Slack: Slack bot token must be a secret value or a goodvibes://secrets/... reference.');
  });

  test('uses mode-aware required fields for Telegram and WhatsApp', () => {
    const wizard = new OnboardingWizardController();
    wizard.open('new');
    wizard.setFieldValue('capabilities.external-integrations', true);
    wizard.setFieldValue('external-services.telegram', true);
    wizard.setFieldValue('external-services.telegram.mode', 'polling');
    wizard.setFieldValue('external-services.telegram.bot-token', 'bot-token');
    wizard.setFieldValue('external-services.whatsapp', true);
    wizard.setFieldValue('external-services.whatsapp.provider', 'bridge');
    wizard.setFieldValue('external-services.whatsapp.access-token', 'bridge-token');

    const blockers = wizard.getBlockingFieldLabels();
    expect(blockers).not.toContain('Telegram: Telegram webhook secret is required.');
    expect(blockers).not.toContain('WhatsApp: WhatsApp verify token is required.');
    expect(blockers).not.toContain('WhatsApp: WhatsApp phone number ID is required.');
  });

  test('shows optional local admin credential fields without requiring a replacement password', () => {
    const snapshot = makeOnboardingSnapshot({
      auth: {
        snapshot: {
          userStorePath: '/tmp/auth-users.json',
          bootstrapCredentialPath: '/tmp/auth-bootstrap.txt',
          persisted: true,
          bootstrapCredentialPresent: false,
          userCount: 1,
          sessionCount: 0,
          users: [{ username: 'operator', roles: ['operator'] }],
          sessions: [],
        },
      },
    });
    const wizard = new OnboardingWizardController();
    wizard.open('new');
    wizard.hydrateRuntimeState({ snapshot }, { resetValues: true });
    wizard.setFieldValue('capabilities.browser-access', true);

    expect(wizard.steps.find((step) => step.id === 'access')?.fields.map((field) => field.id)).toContain('accounts.admin-username');
    expect(wizard.steps.find((step) => step.id === 'access')?.fields.map((field) => field.id)).toContain('accounts.admin-password');
    expect(wizard.getBlockingFieldLabels()).not.toContain('Access: Local auth admin password is required.');
    expect(wizard.buildApplyRequest().operations).not.toContainEqual(expect.objectContaining({ kind: 'ensure-auth-user' }));

    wizard.setFieldValue('accounts.admin-password', 'wizard-pass');

    expect(wizard.buildApplyRequest().operations).toContainEqual({
      kind: 'ensure-auth-user',
      username: 'admin',
      password: 'wizard-pass',
      roles: ['admin'],
      createSession: true,
      retireBootstrapCredential: false,
    });
  });

  test('treats return key tokens as Enter in the onboarding route', () => {
    const wizard = new OnboardingWizardController();
    wizard.open('new');
    wizard.moveSelection(1, 10);

    handleOnboardingWizardToken({
      onboardingWizard: wizard,
      getViewportHeight: () => 20,
      requestRender: () => {},
      handleEscape: () => {},
    }, { type: 'key', logicalName: 'return' } as InputToken);

    expect(wizard.getBooleanFieldValue('capabilities.browser-access', false)).toBe(true);
    expect(wizard.getBooleanFieldValue('capabilities.local-tui-only', true)).toBe(false);
  });

  test('typing j and k into selected onboarding inputs edits text instead of moving selection', () => {
    const wizard = new OnboardingWizardController();
    wizard.open('new');
    wizard.setFieldValue('capabilities.browser-access', true);
    wizard.setFieldValue('network.mode', 'custom');
    wizard.setStep(1);
    wizard.moveSelection(3, 10);

    const routeState = {
      onboardingWizard: wizard,
      getViewportHeight: () => 20,
      requestRender: () => {},
      handleEscape: () => {},
    };

    handleOnboardingWizardToken(routeState, { type: 'text', value: 'j' });
    handleOnboardingWizardToken(routeState, { type: 'text', value: 'k' });
    handleOnboardingWizardToken(routeState, { type: 'key', logicalName: 'return' } as InputToken);

    expect(wizard.getSelectedField()?.id).toBe('network.service-port');
    expect(wizard.getSelectedFieldIndex()).toBe(3);
    expect(wizard.getTextFieldValue('network.service-port')).toBe('jk');
  });

  test('printable key tokens edit selected onboarding inputs before shortcut handling', () => {
    const wizard = new OnboardingWizardController();
    wizard.open('new');
    wizard.setFieldValue('capabilities.browser-access', true);
    wizard.setFieldValue('network.mode', 'custom');
    wizard.setStep(1);
    wizard.moveSelection(3, 10);

    const routeState = {
      onboardingWizard: wizard,
      getViewportHeight: () => 20,
      requestRender: () => {},
      handleEscape: () => {},
    };

    handleOnboardingWizardToken(routeState, { type: 'key', logicalName: 'j', ctrl: false, shift: false, meta: false } as InputToken);
    handleOnboardingWizardToken(routeState, { type: 'key', logicalName: 'k', ctrl: false, shift: false, meta: false } as InputToken);
    handleOnboardingWizardToken(routeState, { type: 'key', logicalName: '1', ctrl: false, shift: false, meta: false } as InputToken);
    handleOnboardingWizardToken(routeState, { type: 'key', logicalName: 'return' } as InputToken);

    expect(wizard.getSelectedField()?.id).toBe('network.service-port');
    expect(wizard.getSelectedFieldIndex()).toBe(3);
    expect(wizard.getTextFieldValue('network.service-port')).toBe('jk1');
  });

  test('allows bootstrap auth replacement to reuse an existing admin username', () => {
    const snapshot = makeOnboardingSnapshot({
      auth: {
        snapshot: {
          userStorePath: '/tmp/auth-users.json',
          bootstrapCredentialPath: '/tmp/auth-bootstrap.txt',
          persisted: true,
          bootstrapCredentialPresent: true,
          userCount: 1,
          sessionCount: 0,
          users: [{ username: 'admin', roles: ['admin'] }],
          sessions: [],
        },
      },
    });
    const wizard = new OnboardingWizardController();
    wizard.open('new');
    wizard.hydrateRuntimeState({ snapshot }, { resetValues: true });
    wizard.setFieldValue('capabilities.browser-access', true);

    const accessFields = wizard.steps.find((step) => step.id === 'access')?.fields;
    expect(accessFields?.map((field) => field.id)).toContain('accounts.admin-password');
    expect(wizard.getTextFieldValue('accounts.admin-username')).toBe('admin');
    expect(wizard.getBlockingFieldLabels()).toContain('Access: Local auth admin password is required.');
    wizard.setFieldValue('accounts.admin-password', 'wizard-pass');
    expect(wizard.getBlockingFieldLabels()).not.toContain('Access: Local auth admin username must be a new username so the wizard can replace bootstrap credentials.');
    const request = wizard.buildApplyRequest();
    expect(request.operations).toContainEqual({
      kind: 'ensure-auth-user',
      username: 'admin',
      password: 'wizard-pass',
      roles: ['admin'],
      createSession: true,
      retireBootstrapCredential: true,
    });
  });

  test('local TUI only disables existing external surfaces', () => {
    const base = makeOnboardingSnapshot();
    const snapshot = makeOnboardingSnapshot({
      config: {
        ...base.config,
        surfaces: {
          ...base.config.surfaces,
          slack: {
            ...base.config.surfaces.slack,
            enabled: true,
          },
        },
      },
      surfaces: {
        configuredEnabledKinds: ['slack'],
        records: [],
      },
    });
    const wizard = new OnboardingWizardController();
    wizard.open('edit');
    wizard.hydrateRuntimeState({ snapshot }, { resetValues: true });
    wizard.setFieldValue('capabilities.local-tui-only', true);

    const request = wizard.buildApplyRequest();

    expect(request.operations).toContainEqual({
      kind: 'set-config',
      key: 'surfaces.slack.enabled',
      value: false,
    });
  });

  test('shows OpenAI subscription start and finish actions inside the wizard', () => {
    const snapshot = makeOnboardingSnapshot({
      subscriptions: {
        active: [],
        pending: [
          {
            provider: 'openai',
            state: 'state',
            verifier: 'verifier',
            redirectUri: 'http://127.0.0.1/callback',
            createdAt: 1,
          },
        ],
        activeProviderIds: [],
        pendingProviderIds: ['openai'],
      },
    });
    const wizard = new OnboardingWizardController();
    wizard.open('edit');
    wizard.hydrateRuntimeState({ snapshot }, { resetValues: true });

    const providerStep = wizard.steps.find((step) => step.id === 'provider-access');
    const fieldIds = providerStep?.fields.map((field) => field.id) ?? [];
    expect(fieldIds).toContain('providers.openai-subscription-start');
    expect(fieldIds).toContain('providers.openai-callback-code');
    expect(fieldIds).toContain('providers.openai-subscription-finish');
  });
});

describe('InputHandler onboarding integration', () => {
  test('keeps onboarding locked while runtime settings are hydrating', () => {
    const input = makeInput();
    input.openOnboardingWizard();

    input.feed('j');

    expect(input.prompt).toBe('');
    expect(input.onboardingWizard.hydrationPending).toBe(true);
    expect(input.onboardingWizard.getSelectedFieldIndex()).toBe(0);
    expect(input.onboardingWizard.currentStep.id).toBe('loading');
  });

  test('routes arrow navigation into the onboarding shell instead of the prompt', () => {
    const input = makeInput();
    input.openOnboardingWizard({ mode: 'new', preload: () => {} });

    input.feed('\x1b[B');

    expect(input.prompt).toBe('');
    expect(input.onboardingWizard.getSelectedFieldIndex()).toBe(1);
    expect(input.onboardingWizard.active).toBe(true);
  });

  test('marks onboarding checked as soon as the wizard opens', () => {
    const uiServices = createDefaultUiRuntimeServices();
    const input = makeInput(uiServices);

    input.openOnboardingWizard({ mode: 'new', preload: () => {} });
    input.feed('\x1b');

    const marker = readOnboardingCheckMarker(uiServices.environment.shellPaths, 'user');
    expect(marker.exists).toBe(true);
    expect(marker.payload?.mode).toBe('new');
    expect(input.onboardingWizard.active).toBe(false);
  });

  test('opens nested model picker from onboarding and unwinds back to the shell on escape', () => {
    const input = makeInput();
    input.openOnboardingWizard({ mode: 'edit', preload: () => {} });
    input.onboardingWizard.setStep(3);

    const registry = new CommandRegistry();
    input.setCommandRegistry(registry, {
      openModelPicker: () => {
        input.modalOpened('modelPicker');
        input.modelPicker.openProviders(['openai', 'anthropic'], 'openai');
      },
    } as unknown as CommandContext);

    input.feed('\r');

    expect(input.onboardingWizard.active).toBe(true);
    expect(input.modelPicker.active).toBe(true);
    expect(input.modelPicker.target).toBe('main');
    expect(input.modalStack).toEqual(['onboarding', 'modelPicker']);

    input.feed('\x1b');

    expect(input.modelPicker.active).toBe(false);
    expect(input.onboardingWizard.active).toBe(true);
    expect(input.modalStack).toEqual(['onboarding']);

    input.feed('\x1b');

    expect(input.onboardingWizard.active).toBe(false);
    expect(input.modalStack).toEqual([]);
  });

  test('shows apply blockers inside the wizard instead of printing behind the overlay', async () => {
    const input = makeInput();
    const prints: string[] = [];
    input.setCommandRegistry(new CommandRegistry(), {
      session: { runtime: {} },
      print: (text: string) => prints.push(text),
    } as unknown as CommandContext);
    input.openOnboardingWizard({ mode: 'new', preload: () => {} });
    input.onboardingWizard.hydrateRuntimeState({
      snapshot: makeOnboardingSnapshot({
        auth: {
          snapshot: {
            userStorePath: '/tmp/auth-users.json',
            bootstrapCredentialPath: '/tmp/auth-bootstrap.txt',
            persisted: true,
            bootstrapCredentialPresent: true,
            userCount: 1,
            sessionCount: 0,
            users: [{ username: 'admin', roles: ['admin'] }],
            sessions: [],
          },
        },
      }),
    }, { resetValues: true });
    input.onboardingWizard.setFieldValue('capabilities.browser-access', true);

    await (input as unknown as { handleOnboardingAction(action: 'apply'): Promise<void> }).handleOnboardingAction('apply');

    expect(input.onboardingWizard.active).toBe(true);
    expect(input.onboardingWizard.currentStep.id).toBe('review');
    expect(input.onboardingWizard.applyFeedback?.title).toBe('Cannot apply yet');
    expect(input.onboardingWizard.applyFeedback?.messages).toContain('Access: Local auth admin password is required.');
    expect(prints).toEqual([]);
  });

  test('keeps the global onboarding check marker when post-apply verification fails', async () => {
    resetTestRuntimeServices();
    const uiServices = createDefaultUiRuntimeServices();
    const input = makeInput(uiServices);
    const prints: string[] = [];
    input.setCommandRegistry(new CommandRegistry(), {
      session: { runtime: {} },
      print: (text: string) => prints.push(text),
    } as unknown as CommandContext);
    input.openOnboardingWizard({ mode: 'new', preload: () => {} });
    input.onboardingWizard.hydrateRuntimeState({
      snapshot: makeOnboardingSnapshot({
        auth: {
          snapshot: {
            userStorePath: '/tmp/auth-users.json',
            bootstrapCredentialPath: '/tmp/auth-bootstrap.txt',
            persisted: true,
            bootstrapCredentialPresent: false,
            userCount: 1,
            sessionCount: 0,
            users: [{ username: 'admin', roles: ['admin'] }],
            sessions: [],
          },
        },
      }),
    }, { resetValues: true });
    input.onboardingWizard.setFieldValue('capabilities.browser-access', true);
    input.onboardingWizard.setFieldValue('accounts.auth', true);

    await (input as unknown as { handleOnboardingAction(action: 'apply'): Promise<void> }).handleOnboardingAction('apply');

    const marker = readOnboardingCheckMarker(uiServices.environment.shellPaths, 'user');
    expect(marker.exists).toBe(true);
    expect(prints.join('\n')).toContain('Network-capable surfaces require local auth with no bootstrap credential file.');
  });

  test('restarts and verifies background services after the wizard has been checked', async () => {
    resetTestRuntimeServices();
    const uiServices = createDefaultUiRuntimeServices();
    ensureLocalAdminAuth(uiServices);
    let restarted = false;
    installExternalServices(uiServices, {
      inspect: () => ({
        daemonRunning: restarted,
        httpListenerRunning: false,
      }),
      restart: async () => {
        restarted = true;
        return {
          daemonRunning: true,
          httpListenerRunning: false,
        };
      },
    });
    const input = makeInput(uiServices);
    const prints: string[] = [];
    input.setCommandRegistry(new CommandRegistry(), {
      session: { runtime: {} },
      print: (text: string) => prints.push(text),
    } as unknown as CommandContext);
    input.openOnboardingWizard({ mode: 'new', preload: () => {} });
    input.onboardingWizard.hydrateRuntimeState({
      snapshot: makeOnboardingSnapshot({
        auth: {
          snapshot: {
            userStorePath: '/tmp/auth-users.json',
            bootstrapCredentialPath: '/tmp/auth-bootstrap.txt',
            persisted: true,
            bootstrapCredentialPresent: false,
            userCount: 1,
            sessionCount: 0,
            users: [{ username: 'admin', roles: ['admin'] }],
            sessions: [],
          },
        },
      }),
    }, { resetValues: true });
    input.onboardingWizard.setFieldValue('capabilities.browser-access', true);
    input.onboardingWizard.setFieldValue('accounts.auth', true);

    await (input as unknown as { handleOnboardingAction(action: 'apply'): Promise<void> }).handleOnboardingAction('apply');

    const marker = readOnboardingCheckMarker(uiServices.environment.shellPaths, 'user');
    expect(restarted).toBe(true);
    expect(marker.exists).toBe(true);
    expect(prints.join('\n')).toContain('Onboarding applied and verified');
  });

  test('keeps the global onboarding check marker when background service activation fails', async () => {
    resetTestRuntimeServices();
    const uiServices = createDefaultUiRuntimeServices();
    ensureLocalAdminAuth(uiServices);
    installExternalServices(uiServices, {
      inspect: () => ({
        daemonRunning: false,
        httpListenerRunning: false,
      }),
      restart: async () => ({
        daemonRunning: false,
        httpListenerRunning: false,
      }),
    });
    const input = makeInput(uiServices);
    const prints: string[] = [];
    input.setCommandRegistry(new CommandRegistry(), {
      session: { runtime: {} },
      print: (text: string) => prints.push(text),
    } as unknown as CommandContext);
    input.openOnboardingWizard({ mode: 'new', preload: () => {} });
    input.onboardingWizard.hydrateRuntimeState({
      snapshot: makeOnboardingSnapshot({
        auth: {
          snapshot: {
            userStorePath: '/tmp/auth-users.json',
            bootstrapCredentialPath: '/tmp/auth-bootstrap.txt',
            persisted: true,
            bootstrapCredentialPresent: false,
            userCount: 1,
            sessionCount: 0,
            users: [{ username: 'admin', roles: ['admin'] }],
            sessions: [],
          },
        },
      }),
    }, { resetValues: true });
    input.onboardingWizard.setFieldValue('capabilities.browser-access', true);
    input.onboardingWizard.setFieldValue('accounts.auth', true);

    await (input as unknown as { handleOnboardingAction(action: 'apply'): Promise<void> }).handleOnboardingAction('apply');

    const marker = readOnboardingCheckMarker(uiServices.environment.shellPaths, 'user');
    expect(marker.exists).toBe(true);
    expect(prints.join('\n')).toContain('Onboarding settings applied.');
    expect(prints.join('\n')).not.toContain('Onboarding applied and verified');
    expect(prints.join('\n')).toContain('GoodVibes daemon is enabled for');
    expect(prints.join('\n')).toContain('No process is listening');
  });

  test('deduplicates runtime activation warnings in completion output', async () => {
    resetTestRuntimeServices();
    const uiServices = createDefaultUiRuntimeServices();
    ensureLocalAdminAuth(uiServices);
    installExternalServices(uiServices, {
      inspect: () => ({
        daemonRunning: true,
        httpListenerRunning: false,
        httpListenerPortInUse: true,
      }),
      restart: async () => ({
        daemonRunning: true,
        httpListenerRunning: false,
        httpListenerPortInUse: true,
      }),
    });
    const input = makeInput(uiServices);
    const prints: string[] = [];
    input.setCommandRegistry(new CommandRegistry(), {
      session: { runtime: {} },
      print: (text: string) => prints.push(text),
    } as unknown as CommandContext);
    input.openOnboardingWizard({ mode: 'new', preload: () => {} });
    input.onboardingWizard.hydrateRuntimeState({
      snapshot: makeOnboardingSnapshot({
        auth: {
          snapshot: {
            userStorePath: '/tmp/auth-users.json',
            bootstrapCredentialPath: '/tmp/auth-bootstrap.txt',
            persisted: true,
            bootstrapCredentialPresent: false,
            userCount: 1,
            sessionCount: 0,
            users: [{ username: 'admin', roles: ['admin'] }],
            sessions: [],
          },
        },
      }),
    }, { resetValues: true });
    input.onboardingWizard.setFieldValue('capabilities.webhook-events', true);
    input.onboardingWizard.setFieldValue('accounts.auth', true);

    await (input as unknown as { handleOnboardingAction(action: 'apply'): Promise<void> }).handleOnboardingAction('apply');

    const output = prints.join('\n');
    expect(output).toContain('Onboarding settings applied.');
    expect(output).not.toContain('Onboarding applied and verified');
    expect(output).toContain('HTTP listener is enabled for');
    expect(output).toContain('The configured port');
    expect(output).toContain('is occupied after restart');
    expect((output.match(/runtime:http-listener-active/g) ?? []).length).toBe(1);
    expect(output).not.toContain('not running after onboarding apply');
  });

  test('stops running background services before completing Local TUI Only', async () => {
    resetTestRuntimeServices();
    const uiServices = createDefaultUiRuntimeServices();
    let daemonRunning = true;
    let httpListenerRunning = true;
    let restarted = false;
    installExternalServices(uiServices, {
      inspect: () => ({ daemonRunning, httpListenerRunning }),
      restart: async () => {
        restarted = true;
        daemonRunning = false;
        httpListenerRunning = false;
        return { daemonRunning, httpListenerRunning };
      },
    });
    const input = makeInput(uiServices);
    const prints: string[] = [];
    input.setCommandRegistry(new CommandRegistry(), {
      session: { runtime: {} },
      print: (text: string) => prints.push(text),
    } as unknown as CommandContext);
    input.openOnboardingWizard({ mode: 'edit', preload: () => {} });
    input.onboardingWizard.hydrateRuntimeState({
      snapshot: makeOnboardingSnapshot({
        bindSettings: {
          daemonEnabled: true,
          httpListenerEnabled: true,
          controlPlane: {
            ...DEFAULT_CONFIG.controlPlane,
            enabled: true,
            hostMode: 'network',
            host: '0.0.0.0',
            allowRemote: true,
          },
          httpListener: {
            ...DEFAULT_CONFIG.httpListener,
            hostMode: 'network',
            host: '0.0.0.0',
          },
          web: {
            ...DEFAULT_CONFIG.web,
            enabled: true,
            hostMode: 'network',
            host: '0.0.0.0',
          },
        },
      }),
    }, { resetValues: true });
    input.onboardingWizard.setFieldValue('capabilities.local-tui-only', true);

    await (input as unknown as { handleOnboardingAction(action: 'apply'): Promise<void> }).handleOnboardingAction('apply');

    const marker = readOnboardingCheckMarker(uiServices.environment.shellPaths, 'user');
    expect(restarted).toBe(true);
    expect(marker.exists).toBe(true);
    expect(prints.join('\n')).toContain('Onboarding applied and verified');
  });

  test('keeps the global onboarding check marker when Local TUI Only cannot inspect services', async () => {
    resetTestRuntimeServices();
    const uiServices = createDefaultUiRuntimeServices();
    const input = makeInput(uiServices);
    const prints: string[] = [];
    input.setCommandRegistry(new CommandRegistry(), {
      session: { runtime: {} },
      print: (text: string) => prints.push(text),
    } as unknown as CommandContext);
    input.openOnboardingWizard({ mode: 'edit', preload: () => {} });
    input.onboardingWizard.hydrateRuntimeState({
      snapshot: makeOnboardingSnapshot({
        bindSettings: {
          daemonEnabled: true,
          httpListenerEnabled: true,
          controlPlane: {
            ...DEFAULT_CONFIG.controlPlane,
            enabled: true,
            hostMode: 'network',
            host: '0.0.0.0',
            allowRemote: true,
          },
          httpListener: {
            ...DEFAULT_CONFIG.httpListener,
            hostMode: 'network',
            host: '0.0.0.0',
          },
          web: DEFAULT_CONFIG.web,
        },
      }),
    }, { resetValues: true });
    input.onboardingWizard.setFieldValue('capabilities.local-tui-only', true);

    await (input as unknown as { handleOnboardingAction(action: 'apply'): Promise<void> }).handleOnboardingAction('apply');

    const marker = readOnboardingCheckMarker(uiServices.environment.shellPaths, 'user');
    expect(marker.exists).toBe(true);
    expect(prints.join('\n')).toContain('Background service controller is unavailable');
  });

  test('keeps the global onboarding check marker when Local TUI Only cannot stop a running service', async () => {
    resetTestRuntimeServices();
    const uiServices = createDefaultUiRuntimeServices();
    installExternalServices(uiServices, {
      inspect: () => ({
        daemonRunning: false,
        httpListenerRunning: true,
      }),
      restart: async () => ({
        daemonRunning: false,
        httpListenerRunning: true,
      }),
    });
    const input = makeInput(uiServices);
    const prints: string[] = [];
    input.setCommandRegistry(new CommandRegistry(), {
      session: { runtime: {} },
      print: (text: string) => prints.push(text),
    } as unknown as CommandContext);
    input.openOnboardingWizard({ mode: 'edit', preload: () => {} });
    input.onboardingWizard.hydrateRuntimeState({
      snapshot: makeOnboardingSnapshot({
        bindSettings: {
          daemonEnabled: true,
          httpListenerEnabled: true,
          controlPlane: {
            ...DEFAULT_CONFIG.controlPlane,
            enabled: true,
            hostMode: 'local',
            host: '127.0.0.1',
          },
          httpListener: {
            ...DEFAULT_CONFIG.httpListener,
            hostMode: 'network',
            host: '0.0.0.0',
          },
          web: DEFAULT_CONFIG.web,
        },
      }),
    }, { resetValues: true });
    input.onboardingWizard.setFieldValue('capabilities.local-tui-only', true);

    await (input as unknown as { handleOnboardingAction(action: 'apply'): Promise<void> }).handleOnboardingAction('apply');

    const marker = readOnboardingCheckMarker(uiServices.environment.shellPaths, 'user');
    expect(marker.exists).toBe(true);
    expect(prints.join('\n')).toContain('HTTP listener was disabled for incoming event surfaces');
    expect(prints.join('\n')).toContain('is still occupied');
  });

  test('keeps the global onboarding check marker when Local TUI Only leaves an external listener port occupied', async () => {
    resetTestRuntimeServices();
    const uiServices = createDefaultUiRuntimeServices();
    installExternalServices(uiServices, {
      inspect: () => ({
        daemonRunning: false,
        daemonPortInUse: false,
        httpListenerRunning: false,
        httpListenerPortInUse: true,
      }),
      restart: async () => ({
        daemonRunning: false,
        daemonPortInUse: false,
        httpListenerRunning: false,
        httpListenerPortInUse: true,
      }),
    });
    const input = makeInput(uiServices);
    const prints: string[] = [];
    input.setCommandRegistry(new CommandRegistry(), {
      session: { runtime: {} },
      print: (text: string) => prints.push(text),
    } as unknown as CommandContext);
    input.openOnboardingWizard({ mode: 'edit', preload: () => {} });
    input.onboardingWizard.hydrateRuntimeState({
      snapshot: makeOnboardingSnapshot({
        bindSettings: {
          daemonEnabled: true,
          httpListenerEnabled: true,
          controlPlane: {
            ...DEFAULT_CONFIG.controlPlane,
            enabled: true,
            hostMode: 'local',
            host: '127.0.0.1',
          },
          httpListener: {
            ...DEFAULT_CONFIG.httpListener,
            hostMode: 'network',
            host: '0.0.0.0',
          },
          web: DEFAULT_CONFIG.web,
        },
      }),
    }, { resetValues: true });
    input.onboardingWizard.setFieldValue('capabilities.local-tui-only', true);

    await (input as unknown as { handleOnboardingAction(action: 'apply'): Promise<void> }).handleOnboardingAction('apply');

    const marker = readOnboardingCheckMarker(uiServices.environment.shellPaths, 'user');
    expect(marker.exists).toBe(true);
    expect(prints.join('\n')).toContain('HTTP listener was disabled for incoming event surfaces');
    expect(prints.join('\n')).toContain('is still occupied');
  });
});
