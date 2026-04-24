import { afterEach, describe, expect, test } from 'bun:test';
import { InfiniteBuffer } from '../../core/history.ts';
import { CommandRegistry, type CommandContext } from '../../input/command-registry.ts';
import { InputHandler } from '../../input/handler.ts';
import { OnboardingWizardController } from '../../input/onboarding/onboarding-wizard.ts';
import { SelectionManager } from '../../input/selection.ts';
import { DEFAULT_CONFIG } from '../../config/index.ts';
import { readOnboardingCompletionMarker, type OnboardingSnapshotState } from '../../runtime/onboarding/index.ts';
import { createDefaultUiRuntimeServices } from '../helpers/ui-services.ts';
import { resetTestRuntimeServices } from '../helpers/runtime-services.ts';
import type { UiRuntimeServices } from '../../runtime/ui-services.ts';

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

  test('defaults first-launch completion to user and project markers', () => {
    const wizard = new OnboardingWizardController();
    wizard.open('new');

    const markerOps = wizard.buildApplyRequest().operations.filter((operation) => operation.kind === 'set-completion-marker');

    expect(markerOps).toContainEqual(expect.objectContaining({ kind: 'set-completion-marker', scope: 'project', completed: true }));
    expect(markerOps).toContainEqual(expect.objectContaining({ kind: 'set-completion-marker', scope: 'user', completed: true }));
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

  test('external services exposes schema-backed surface setup fields', () => {
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
    const fieldIds = serviceStep?.fields.map((field) => field.id) ?? [];

    expect(fieldIds).toContain('external-services.ntfy');
    expect(fieldIds).toContain('external-services.google-chat.webhook-url');
    expect(fieldIds).toContain('external-services.signal.token');
    expect(fieldIds).toContain('external-services.whatsapp.access-token');
    expect(fieldIds).toContain('external-services.imessage.token');
    expect(fieldIds).toContain('external-services.msteams.app-password');
    expect(fieldIds).toContain('external-services.bluebubbles.password');
    expect(fieldIds).toContain('external-services.mattermost.bot-token');
    expect(fieldIds).toContain('external-services.matrix.access-token');
  });

  test('enabling an inbound external surface turns on the HTTP listener', () => {
    const wizard = new OnboardingWizardController();
    wizard.open('new');
    wizard.setFieldValue('capabilities.external-integrations', true);
    wizard.setFieldValue('external-services.slack', true);

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

  test('blocks enabled external surfaces until required setup values are entered', () => {
    const wizard = new OnboardingWizardController();
    wizard.open('new');
    wizard.setFieldValue('capabilities.external-integrations', true);
    wizard.setFieldValue('external-services.matrix', true);

    expect(wizard.getBlockingFieldLabels()).toContain('Services: Matrix access token is required.');
  });

  test('blocks malformed GoodVibes secret refs in masked fields', () => {
    const wizard = new OnboardingWizardController();
    wizard.open('new');
    wizard.setFieldValue('capabilities.external-integrations', true);
    wizard.setFieldValue('external-services.slack', true);
    wizard.setFieldValue('external-services.slack.bot-token', 'goodvibes://secrets/');

    expect(wizard.getBlockingFieldLabels()).toContain('Services: Slack bot token must be a secret value or a goodvibes://secrets/... reference.');
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
    expect(blockers).not.toContain('Services: Telegram webhook secret is required.');
    expect(blockers).not.toContain('Services: WhatsApp verify token is required.');
    expect(blockers).not.toContain('Services: WhatsApp phone number ID is required.');
  });

  test('requires an admin auth user before server-backed settings can apply', () => {
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

    expect(wizard.steps.find((step) => step.id === 'access')?.fields.map((field) => field.id)).toContain('accounts.admin-password');
  });

  test('requires bootstrap auth replacement before server-backed settings can apply', () => {
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
    expect(wizard.getTextFieldValue('accounts.admin-username')).toBe('goodvibes-admin');
    expect(wizard.getBlockingFieldLabels()).toContain('Access: Local auth admin password is required.');
    wizard.setFieldValue('accounts.admin-password', 'wizard-pass');
    const request = wizard.buildApplyRequest();
    expect(request.operations).toContainEqual({
      kind: 'ensure-auth-user',
      username: 'goodvibes-admin',
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

  test('routes text navigation into the onboarding shell instead of the prompt', () => {
    const input = makeInput();
    input.openOnboardingWizard({ mode: 'new', preload: () => {} });

    input.feed('j');

    expect(input.prompt).toBe('');
    expect(input.onboardingWizard.getSelectedFieldIndex()).toBe(1);
    expect(input.onboardingWizard.active).toBe(true);
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

  test('does not write completion markers when post-apply verification fails', async () => {
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

    const marker = readOnboardingCompletionMarker(uiServices.environment.shellPaths, 'project');
    expect(marker.exists).toBe(false);
    expect(prints.join('\n')).toContain('Network-capable surfaces require local admin auth with no bootstrap credential file.');
  });

  test('restarts and verifies background services before writing completion markers', async () => {
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

    const marker = readOnboardingCompletionMarker(uiServices.environment.shellPaths, 'project');
    expect(restarted).toBe(true);
    expect(marker.exists).toBe(true);
    expect(prints.join('\n')).toContain('Onboarding applied and verified');
  });

  test('does not write completion markers when background service activation fails', async () => {
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

    const marker = readOnboardingCompletionMarker(uiServices.environment.shellPaths, 'project');
    expect(marker.exists).toBe(false);
    expect(prints.join('\n')).toContain('The GoodVibes daemon did not start after applying onboarding settings.');
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

    const marker = readOnboardingCompletionMarker(uiServices.environment.shellPaths, 'project');
    expect(restarted).toBe(true);
    expect(marker.exists).toBe(true);
    expect(prints.join('\n')).toContain('Onboarding applied and verified');
  });

  test('does not write completion markers for Local TUI Only when background service controller is unavailable', async () => {
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

    const marker = readOnboardingCompletionMarker(uiServices.environment.shellPaths, 'project');
    expect(marker.exists).toBe(false);
    expect(prints.join('\n')).toContain('Background service controller is unavailable');
  });

  test('does not write completion markers when Local TUI Only cannot stop a running service', async () => {
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

    const marker = readOnboardingCompletionMarker(uiServices.environment.shellPaths, 'project');
    expect(marker.exists).toBe(false);
    expect(prints.join('\n')).toContain('The HTTP listener port is still occupied after onboarding disabled incoming event surfaces.');
  });

  test('does not write completion markers when Local TUI Only leaves an external listener port occupied', async () => {
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

    const marker = readOnboardingCompletionMarker(uiServices.environment.shellPaths, 'project');
    expect(marker.exists).toBe(false);
    expect(prints.join('\n')).toContain('The HTTP listener port is still occupied after onboarding disabled incoming event surfaces.');
  });
});
