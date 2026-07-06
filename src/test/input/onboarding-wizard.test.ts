import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { InfiniteBuffer } from '../../core/history.ts';
import { CommandRegistry, type CommandContext } from '../../input/command-registry.ts';
import { InputHandler } from '../../input/handler.ts';
import { OnboardingWizardController } from '../../input/onboarding/onboarding-wizard.ts';
import { EXTERNAL_SURFACE_SPECS, getExternalSurfaceAutoStartFieldId } from '../../input/onboarding/onboarding-wizard-external-surfaces.ts';
import { buildGoodVibesSecretKey, buildGoodVibesSecretRef } from '../../input/onboarding/onboarding-wizard-helpers.ts';
import { handleOnboardingWizardToken } from '../../input/onboarding/handler-onboarding-routes.ts';
import { SelectionManager } from '../../input/selection.ts';
import { DEFAULT_CONFIG } from '../../config/index.ts';
import { getProviderIdFromModel } from '../../config/provider-model.ts';
import { readOnboardingCheckMarker, type OnboardingSnapshotState } from '../../runtime/onboarding/index.ts';
import { createDefaultUiRuntimeServices } from '../helpers/ui-services.ts';
import { resetTestRuntimeServices } from '../helpers/runtime-services.ts';
import type { UiRuntimeServices } from '../../runtime/ui-services.ts';
import type { InputToken } from '@pellux/goodvibes-sdk/platform/core';
import type { HostServiceStatus } from '@/runtime/index.ts';

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
    batch: structuredClone(DEFAULT_CONFIG.batch),
    cloudflare: structuredClone(DEFAULT_CONFIG.cloudflare),
  };

  return {
    capturedAt: 1,
    config,
    providerRouting: {
      primaryProviderId: getProviderIdFromModel(config.provider.model),
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
    legacyDaemon: {
      present: false,
      active: false,
      path: '',
    },
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
    expect(wizard.getSelectedFieldIndex()).toBe(8);
    expect(wizard.scrollOffsets[0]).toBe(7);

    wizard.setStep(2);
    wizard.moveSelection(1, 2);
    expect(wizard.getSelectedFieldIndex()).toBe(1);
    expect(wizard.scrollOffsets[2]).toBe(0);

    wizard.setStep(0);
    expect(wizard.getSelectedFieldIndex()).toBe(8);
    expect(wizard.scrollOffsets[0]).toBe(7);
  });

  test('adds a separated apply-and-continue action to every non-final editable step', () => {
    const wizard = new OnboardingWizardController();
    wizard.open('new');
    wizard.setFieldValue('capabilities.external-integrations', true);
    wizard.setFieldValue('external-services.ntfy', true);

    for (const step of wizard.steps) {
      const applyAndContinue = step.fields.find((field) => field.kind === 'action' && field.action === 'apply-and-continue');
      if (step.id === 'review') {
        expect(applyAndContinue).toBeUndefined();
        continue;
      }

      expect(applyAndContinue).toBeDefined();
      expect(applyAndContinue?.label).toBe('Next section');
      expect(applyAndContinue?.spacerBeforeRows).toBe(2);
      expect(step.fields.at(-1)).toBe(applyAndContinue);
    }
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

  test('maps Cloudflare onboarding fields to config and batch operations', () => {
    const wizard = new OnboardingWizardController();
    wizard.open('new');
    wizard.setFieldValue('capabilities.cloudflare-batch', true);
    wizard.setFieldValue('cloudflare.batch-mode', 'explicit');
    wizard.setFieldValue('cloudflare.setup-source', 'operational-env');
    wizard.setFieldValue('cloudflare.operational-env-name', 'MY_CF_TOKEN');
    wizard.setFieldValue('cloudflare.account-id', 'account-123');
    wizard.setFieldValue('cloudflare.queue-name', 'gv-queue');
    wizard.setFieldValue('cloudflare.dead-letter-queue-name', 'gv-dlq');

    const cloudflareStep = wizard.steps.find((step) => step.id === 'cloudflare');
    expect(cloudflareStep?.fields.map((field) => field.id)).toContain('cloudflare.component.workers');
    expect(cloudflareStep?.fields.map((field) => field.id)).toContain('cloudflare.requirements');

    const configValues = new Map<string, unknown>();
    for (const operation of wizard.buildApplyRequest().operations) {
      if (operation.kind === 'set-config') configValues.set(operation.key, operation.value);
    }

    expect(configValues.get('service.enabled')).toBe(true);
    expect(configValues.get('service.autostart')).toBe(true);
    expect(configValues.get('cloudflare.enabled')).toBe(true);
    expect(configValues.get('cloudflare.accountId')).toBe('account-123');
    expect(configValues.get('cloudflare.apiTokenRef')).toBe('goodvibes://secrets/env/MY_CF_TOKEN');
    expect(configValues.get('cloudflare.queueName')).toBe('gv-queue');
    expect(configValues.get('cloudflare.deadLetterQueueName')).toBe('gv-dlq');
    expect(configValues.get('batch.mode')).toBe('explicit');
    expect(configValues.get('batch.queueBackend')).toBe('cloudflare');
  });

  test('stores a pasted Cloudflare operational token as a GoodVibes secret ref', () => {
    const wizard = new OnboardingWizardController();
    wizard.open('new');
    wizard.setFieldValue('capabilities.cloudflare-batch', true);
    wizard.setFieldValue('cloudflare.setup-source', 'operational-token');
    wizard.setFieldValue('cloudflare.operational-token', 'cf-secret');

    const configValues = new Map<string, unknown>();
    const secretValues = new Map<string, string>();
    for (const operation of wizard.buildApplyRequest().operations) {
      if (operation.kind === 'set-config') configValues.set(operation.key, operation.value);
      if (operation.kind === 'set-secret') secretValues.set(operation.key, operation.value);
    }

    expect(secretValues.get('CLOUDFLARE_API_TOKEN')).toBe('cf-secret');
    expect(configValues.get('cloudflare.apiTokenRef')).toBe('goodvibes://secrets/goodvibes/CLOUDFLARE_API_TOKEN');
  });

  test('preserves an existing stored Cloudflare token ref when reopening onboarding', () => {
    const base = makeOnboardingSnapshot();
    const snapshot = makeOnboardingSnapshot({
      config: {
        ...base.config,
        cloudflare: {
          ...base.config.cloudflare,
          enabled: true,
          apiTokenRef: 'goodvibes://secrets/goodvibes/CLOUDFLARE_API_TOKEN',
        },
      },
    });
    const wizard = new OnboardingWizardController();
    wizard.open('edit');
    wizard.hydrateRuntimeState({ snapshot }, { resetValues: true });

    const cloudflareStep = wizard.steps.find((step) => step.id === 'cloudflare');
    const setupField = cloudflareStep?.fields.find((field) => field.id === 'cloudflare.setup-source');
    expect(setupField?.kind).toBe('radio');
    expect(setupField?.kind === 'radio' ? setupField.defaultValue : undefined).toBe('save-only');
    expect(cloudflareStep?.fields.map((field) => field.id)).not.toContain('cloudflare.operational-env-name');

    const configValues = new Map<string, unknown>();
    for (const operation of wizard.buildApplyRequest().operations) {
      if (operation.kind === 'set-config') configValues.set(operation.key, operation.value);
    }

    expect(configValues.get('cloudflare.apiTokenRef')).toBe('goodvibes://secrets/goodvibes/CLOUDFLARE_API_TOKEN');
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
    wizard.setFieldValue('external-services.homeassistant', true);
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
    expect(selectorFieldIds).toContain('external-services.homeassistant');
    expect(selectorFieldIds).not.toContain('external-services.google-chat.webhook-url');
    expect(wizard.steps.map((step) => step.id)).toContain('external-surface:homeassistant');
    expect(wizard.steps.map((step) => step.id)).toContain('external-surface:googleChat');
    expect(wizard.steps.map((step) => step.id)).toContain('external-surface:matrix');
    expect(wizard.steps.find((step) => step.id === 'external-surface:homeassistant')?.fields.map((field) => field.id))
      .toContain('external-services.homeassistant.access-token');
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

  test('detects configured Home Assistant values even when the surface is not enabled', () => {
    const base = makeOnboardingSnapshot();
    const snapshot = makeOnboardingSnapshot({
      config: {
        ...base.config,
        surfaces: {
          ...base.config.surfaces,
          homeassistant: {
            ...base.config.surfaces.homeassistant,
            enabled: false,
            instanceUrl: 'http://homeassistant.local:8123',
            accessToken: 'goodvibes://secrets/goodvibes/GOODVIBES_SURFACES_HOMEASSISTANT_ACCESS_TOKEN',
          },
        },
      },
    });
    const wizard = new OnboardingWizardController();
    wizard.open('edit');
    wizard.hydrateRuntimeState({ snapshot }, { resetValues: true });

    expect(wizard.getCapabilitySelectionState().find((item) => item.id === 'external-integrations')?.selected).toBe(true);
    expect(wizard.steps.map((step) => step.id)).toContain('external-services');
    expect(wizard.steps.map((step) => step.id)).toContain('external-surface:homeassistant');
    expect(wizard.getStringFieldValue('external-services.homeassistant.auto-start', 'yes')).toBe('no');
    expect(wizard.getStringFieldValue('external-services.homeassistant.access-token', '')).toBe(
      'goodvibes://secrets/goodvibes/GOODVIBES_SURFACES_HOMEASSISTANT_ACCESS_TOKEN',
    );
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
    // Daemon-by-default (docs/decisions/2026-07-05-daemon-by-default.md): onboarding
    // no longer writes daemon.enabled/danger.daemon at all — the loopback session
    // daemon is ambient infrastructure independent of these network-exposing
    // capabilities, so the SDK's own default (or an existing explicit override)
    // governs untouched.
    expect(configValues.has('danger.daemon')).toBe(false);
    expect(configValues.has('daemon.enabled')).toBe(false);
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
    expect(configValues.get('provider.model')).toBe('openai:gpt-5-test');
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
    // F1: field 1 in the Network step is now the 'network.daemon-source' radio
    // (start vs adopt an existing daemon) inserted ahead of the custom-mode
    // fields, so 'network.service-port' shifted from index 3 to index 4.
    wizard.moveSelection(4, 10);

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
    expect(wizard.getSelectedFieldIndex()).toBe(4);
    expect(wizard.getTextFieldValue('network.service-port')).toBe('jk');
  });

  test('printable key tokens edit selected onboarding inputs before shortcut handling', () => {
    const wizard = new OnboardingWizardController();
    wizard.open('new');
    wizard.setFieldValue('capabilities.browser-access', true);
    wizard.setFieldValue('network.mode', 'custom');
    wizard.setStep(1);
    // F1: see the note above — 'network.service-port' is now at index 4.
    wizard.moveSelection(4, 10);

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
    expect(wizard.getSelectedFieldIndex()).toBe(4);
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

  test('does not write the check marker when the wizard opens and the user escapes without applying', () => {
    const uiServices = createDefaultUiRuntimeServices();
    const input = makeInput(uiServices);

    input.openOnboardingWizard({ mode: 'new', preload: () => {} });
    input.feed('\x1b');

    const marker = readOnboardingCheckMarker(uiServices.environment.shellPaths, 'user');
    expect(marker.exists).toBe(false);
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

  test('apply-and-continue advances without persisting runtime settings', async () => {
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

    await (input as unknown as { handleOnboardingAction(action: 'apply-and-continue'): Promise<void> }).handleOnboardingAction('apply-and-continue');

    expect(input.onboardingWizard.active).toBe(true);
    expect(input.onboardingWizard.currentStep.id).toBe('network');
    expect(input.onboardingWizard.applyFeedback).toBeNull();
    expect(uiServices.platform.configManager.get('service.enabled')).toBe(false);
    expect(uiServices.platform.configManager.get('web.enabled')).toBe(false);
    expect(prints).toEqual([]);
  });

  test('apply-and-continue advances to the next section instead of review when later required fields are incomplete', async () => {
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

    await (input as unknown as { handleOnboardingAction(action: 'apply-and-continue'): Promise<void> }).handleOnboardingAction('apply-and-continue');

    expect(input.onboardingWizard.active).toBe(true);
    expect(input.onboardingWizard.currentStep.id).toBe('network');
    expect(input.onboardingWizard.applyFeedback).toBeNull();
    expect(uiServices.platform.configManager.get('service.enabled')).toBe(false);
    expect(prints).toEqual([]);
  });

  test('apply-and-continue blocks and shows error when required text field is empty', async () => {
    resetTestRuntimeServices();
    const uiServices = createDefaultUiRuntimeServices();
    const input = makeInput(uiServices);
    input.setCommandRegistry(new CommandRegistry(), {
      session: { runtime: {} },
      print: () => {},
    } as unknown as CommandContext);
    input.openOnboardingWizard({ mode: 'new', preload: () => {} });
    // Hydrate with bootstrap credential present so password is required on the Access step
    input.onboardingWizard.hydrateRuntimeState({
      snapshot: makeOnboardingSnapshot({
        auth: {
          snapshot: {
            userStorePath: '/tmp/auth-users.json',
            bootstrapCredentialPath: '/tmp/auth-bootstrap.txt',
            persisted: true,
            bootstrapCredentialPresent: true,
            userCount: 0,
            sessionCount: 0,
            users: [],
            sessions: [],
          },
        },
      }),
    }, { resetValues: true });
    // Enable server-backed capability so Access step appears
    input.onboardingWizard.setFieldValue('capabilities.browser-access', true);
    // Navigate to the Access step (step index 2 after capabilities + network)
    const accessStepIndex = input.onboardingWizard.steps.findIndex((s) => s.id === 'access');
    expect(accessStepIndex).toBeGreaterThan(0);
    input.onboardingWizard.setStep(accessStepIndex);
    // Leave password empty — it is required when bootstrap credential is present
    input.onboardingWizard.setFieldValue('accounts.admin-password', '');

    await (input as unknown as { handleOnboardingAction(action: 'apply-and-continue'): Promise<void> }).handleOnboardingAction('apply-and-continue');

    // Must NOT navigate away from Access step
    expect(input.onboardingWizard.currentStep.id).toBe('access');
    // Must set error feedback
    expect(input.onboardingWizard.applyFeedback?.severity).toBe('error');
    expect(input.onboardingWizard.applyFeedback?.title).toBe('Required fields missing');
    expect(input.onboardingWizard.applyFeedback?.messages.length).toBeGreaterThan(0);
    // Must focus the first offending field
    const selectedIndex = input.onboardingWizard.selectedFieldIndices[accessStepIndex];
    const selectedField = input.onboardingWizard.currentStep.fields[selectedIndex ?? 0];
    expect(selectedField?.id).toBeTruthy();
  });

  test('apply-and-continue advances when all required fields on the step are satisfied', async () => {
    resetTestRuntimeServices();
    const uiServices = createDefaultUiRuntimeServices();
    const input = makeInput(uiServices);
    input.setCommandRegistry(new CommandRegistry(), {
      session: { runtime: {} },
      print: () => {},
    } as unknown as CommandContext);
    input.openOnboardingWizard({ mode: 'new', preload: () => {} });
    // Hydrate with bootstrap credential present so password is required
    input.onboardingWizard.hydrateRuntimeState({
      snapshot: makeOnboardingSnapshot({
        auth: {
          snapshot: {
            userStorePath: '/tmp/auth-users.json',
            bootstrapCredentialPath: '/tmp/auth-bootstrap.txt',
            persisted: true,
            bootstrapCredentialPresent: true,
            userCount: 0,
            sessionCount: 0,
            users: [],
            sessions: [],
          },
        },
      }),
    }, { resetValues: true });
    input.onboardingWizard.setFieldValue('capabilities.browser-access', true);
    const accessStepIndex = input.onboardingWizard.steps.findIndex((s) => s.id === 'access');
    expect(accessStepIndex).toBeGreaterThan(0);
    input.onboardingWizard.setStep(accessStepIndex);
    // Provide required username and password
    input.onboardingWizard.setFieldValue('accounts.admin-username', 'admin');
    input.onboardingWizard.setFieldValue('accounts.admin-password', 'password123');

    await (input as unknown as { handleOnboardingAction(action: 'apply-and-continue'): Promise<void> }).handleOnboardingAction('apply-and-continue');

    // Must advance past Access step
    expect(input.onboardingWizard.currentStep.id).not.toBe('access');
    expect(input.onboardingWizard.applyFeedback).toBeNull();
  });

  test('apply-and-continue does not crash on a step with no required fields', async () => {
    resetTestRuntimeServices();
    const uiServices = createDefaultUiRuntimeServices();
    const input = makeInput(uiServices);
    input.setCommandRegistry(new CommandRegistry(), {
      session: { runtime: {} },
      print: () => {},
    } as unknown as CommandContext);
    input.openOnboardingWizard({ mode: 'new', preload: () => {} });
    input.onboardingWizard.hydrateRuntimeState({
      snapshot: makeOnboardingSnapshot(),
    }, { resetValues: true });
    // Capabilities step (index 0) has no required text/masked fields
    expect(input.onboardingWizard.currentStep.id).toBe('capabilities');

    await (input as unknown as { handleOnboardingAction(action: 'apply-and-continue'): Promise<void> }).handleOnboardingAction('apply-and-continue');

    // No crash, no error feedback, advanced past capabilities
    expect(input.onboardingWizard.applyFeedback).toBeNull();
    expect(input.onboardingWizard.currentStep.id).not.toBe('capabilities');
  });

  test('does not write the global onboarding check marker when the wizard is opened', async () => {
    resetTestRuntimeServices();
    const uiServices = createDefaultUiRuntimeServices();
    const input = makeInput(uiServices);
    input.openOnboardingWizard({ mode: 'new', preload: () => {} });

    const marker = readOnboardingCheckMarker(uiServices.environment.shellPaths, 'user');
    expect(marker.exists).toBe(false);
    expect(input.onboardingWizard.active).toBe(true);
  });

  test('writes the global onboarding check marker on successful apply', async () => {
    resetTestRuntimeServices();
    const uiServices = createDefaultUiRuntimeServices();
    ensureLocalAdminAuth(uiServices);
    const input = makeInput(uiServices);
    const prints: string[] = [];
    input.setCommandRegistry(new CommandRegistry(), {
      session: { runtime: {} },
      print: (text: string) => prints.push(text),
    } as unknown as CommandContext);
    input.openOnboardingWizard({ mode: 'new', preload: () => {} });

    const markerBefore = readOnboardingCheckMarker(uiServices.environment.shellPaths, 'user');
    expect(markerBefore.exists).toBe(false);

    await (input as unknown as { handleOnboardingAction(action: 'apply'): Promise<void> }).handleOnboardingAction('apply');

    const markerAfter = readOnboardingCheckMarker(uiServices.environment.shellPaths, 'user');
    expect(markerAfter.exists).toBe(true);
    expect(markerAfter.payload?.source).toBe('wizard');
    expect(markerAfter.payload?.mode).toBe('new');
  });

  test('does not write the global onboarding check marker when apply errors occur', async () => {
    resetTestRuntimeServices();
    const uiServices = createDefaultUiRuntimeServices();
    const input = makeInput(uiServices);
    input.setCommandRegistry(new CommandRegistry(), {
      session: { runtime: {} },
      print: () => {},
    } as unknown as CommandContext);
    input.openOnboardingWizard({ mode: 'new', preload: () => {} });
    input.onboardingWizard.hydrateRuntimeState({
      snapshot: makeOnboardingSnapshot({}),
    }, { resetValues: true });
    input.onboardingWizard.setFieldValue('capabilities.browser-access', true);

    await (input as unknown as { handleOnboardingAction(action: 'apply'): Promise<void> }).handleOnboardingAction('apply');

    const marker = readOnboardingCheckMarker(uiServices.environment.shellPaths, 'user');
    expect(marker.exists).toBe(false);
    expect(input.onboardingWizard.active).toBe(true);
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

  test('accepts a verified external daemon as active after onboarding restart', async () => {
    resetTestRuntimeServices();
    const uiServices = createDefaultUiRuntimeServices();
    ensureLocalAdminAuth(uiServices);
    const daemonStatus: HostServiceStatus = {
      mode: 'external',
      host: '127.0.0.1',
      port: 3421,
      baseUrl: 'http://127.0.0.1:3421',
      authenticated: true,
      status: 'running',
      version: '0.26.5',
      reason: 'Existing GoodVibes daemon verified on configured host/port',
    };
    const listenerStatus: HostServiceStatus = {
      mode: 'disabled',
      host: '127.0.0.1',
      port: 3422,
      baseUrl: 'http://127.0.0.1:3422',
      reason: 'danger.httpListener is disabled',
    };
    installExternalServices(uiServices, {
      inspect: () => ({
        daemonRunning: false,
        httpListenerRunning: false,
        daemonStatus,
        httpListenerStatus: listenerStatus,
      }),
      restart: async () => ({
        daemonRunning: false,
        httpListenerRunning: false,
        daemonStatus,
        httpListenerStatus: listenerStatus,
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

    const output = prints.join('\n');
    expect(output).toContain('Onboarding applied and verified');
    expect(output).not.toContain('runtime:daemon-active');
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

  test('reports blocked daemon status reason when an unverified process owns the configured port', async () => {
    resetTestRuntimeServices();
    const uiServices = createDefaultUiRuntimeServices();
    ensureLocalAdminAuth(uiServices);
    const daemonStatus: HostServiceStatus = {
      mode: 'blocked',
      host: '127.0.0.1',
      port: 3421,
      baseUrl: 'http://127.0.0.1:3421',
      authenticated: false,
      reason: 'GoodVibes daemon identity probe was rejected by the configured token',
    };
    installExternalServices(uiServices, {
      inspect: () => ({
        daemonRunning: false,
        httpListenerRunning: false,
        daemonStatus,
      }),
      restart: async () => ({
        daemonRunning: false,
        httpListenerRunning: false,
        daemonStatus,
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

    const output = prints.join('\n');
    expect(output).toContain('Onboarding settings applied.');
    expect(output).toContain('could not confirm an embedded or verified external service');
    expect(output).toContain('identity probe was rejected by the configured token');
    expect(output).toContain('runtime:daemon-active');
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

  test('stops the HTTP listener but keeps the cross-surface daemon running when completing Local TUI Only', async () => {
    resetTestRuntimeServices();
    const uiServices = createDefaultUiRuntimeServices();
    let daemonRunning = true;
    let httpListenerRunning = true;
    let restarted = false;
    installExternalServices(uiServices, {
      inspect: () => ({ daemonRunning, httpListenerRunning }),
      restart: async () => {
        restarted = true;
        // Daemon-by-default: onboarding no longer writes daemon.enabled/danger.daemon
        // at all, so the loopback session daemon keeps running (cross-surface
        // visibility) even for Local TUI Only. Only the HTTP listener — a real
        // network-facing surface — actually stops.
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

describe('daemon/auth security wizard hardening (TASK-035, TASK-036, TASK-037)', () => {
  // TASK-035: Zero Trust Tunnel trustProxy
  test('selecting Zero Trust Tunnel writes trustProxy for control plane and HTTP listener', () => {
    const wizard = new OnboardingWizardController();
    wizard.open('new');
    wizard.setFieldValue('capabilities.cloudflare-batch', true);
    wizard.setFieldValue('cloudflare.component.zeroTrustTunnel', true);

    const configValues = new Map<string, unknown>();
    for (const op of wizard.buildApplyRequest().operations) {
      if (op.kind === 'set-config') configValues.set(op.key, op.value);
    }

    expect(configValues.get('controlPlane.trustProxy')).toBe(true);
    expect(configValues.get('httpListener.trustProxy')).toBe(true);
  });

  test('not selecting Zero Trust Tunnel does NOT write trustProxy', () => {
    const wizard = new OnboardingWizardController();
    wizard.open('new');
    wizard.setFieldValue('capabilities.cloudflare-batch', true);

    const configValues = new Map<string, unknown>();
    for (const op of wizard.buildApplyRequest().operations) {
      if (op.kind === 'set-config') configValues.set(op.key, op.value);
    }

    expect(configValues.has('controlPlane.trustProxy')).toBe(false);
    expect(configValues.has('httpListener.trustProxy')).toBe(false);
  });

  test('cloudflare step shows trust-proxy-notice field when Tunnel is selected', () => {
    const wizard = new OnboardingWizardController();
    wizard.open('new');
    wizard.setFieldValue('capabilities.cloudflare-batch', true);
    wizard.setFieldValue('cloudflare.component.zeroTrustTunnel', true);

    const cloudflareStep = wizard.steps.find((s) => s.id === 'cloudflare');
    const noticeField = cloudflareStep?.fields.find((f) => f.id === 'cloudflare.trust-proxy-notice');
    expect(noticeField).toBeDefined();
  });

  test('cloudflare step does NOT show trust-proxy-notice when Tunnel is not selected', () => {
    const wizard = new OnboardingWizardController();
    wizard.open('new');
    wizard.setFieldValue('capabilities.cloudflare-batch', true);
    wizard.setFieldValue('cloudflare.component.zeroTrustTunnel', false);

    const cloudflareStep = wizard.steps.find((s) => s.id === 'cloudflare');
    const noticeField = cloudflareStep?.fields.find((f) => f.id === 'cloudflare.trust-proxy-notice');
    expect(noticeField).toBeUndefined();
  });

  test('cloudflare summaryLines includes trustProxy note when Tunnel is selected', () => {
    const wizard = new OnboardingWizardController();
    wizard.open('new');
    wizard.setFieldValue('capabilities.cloudflare-batch', true);
    wizard.setFieldValue('cloudflare.component.zeroTrustTunnel', true);

    const cloudflareStep = wizard.steps.find((s) => s.id === 'cloudflare');
    expect(cloudflareStep?.summaryLines.some((l) => l.includes('trustProxy'))).toBe(true);
  });

  // TASK-036: TLS hard-warn in network step
  test('network step shows tls-warn when network-facing service has tls.mode off', () => {
    const wizard = new OnboardingWizardController();
    wizard.open('new');
    wizard.setFieldValue('capabilities.network-access', true);

    const networkStep = wizard.steps.find((s) => s.id === 'network');
    const tlsWarnField = networkStep?.fields.find((f) => f.id === 'network.tls-warn');
    expect(tlsWarnField).toBeDefined();
    expect(tlsWarnField?.defaultValue).toBe('Warning');
  });

  test('network step does NOT show tls-warn when local-tui-only (no network-facing services)', () => {
    const wizard = new OnboardingWizardController();
    wizard.open('new');
    wizard.setFieldValue('capabilities.local-tui-only', true);

    const networkStep = wizard.steps.find((s) => s.id === 'network');
    expect(networkStep).toBeUndefined();
  });

  // TASK-037: CORS notice in network step
  test('network step shows cors-note when HTTP listener is enabled', () => {
    const wizard = new OnboardingWizardController();
    wizard.open('new');
    wizard.setFieldValue('capabilities.webhook-events', true);

    const networkStep = wizard.steps.find((s) => s.id === 'network');
    const corsNoteField = networkStep?.fields.find((f) => f.id === 'network.cors-note');
    expect(corsNoteField).toBeDefined();
    expect(corsNoteField?.defaultValue).toBe('Info');
  });

  test('cors-note hint references settings.json not goodvibes.json', () => {
    const wizard = new OnboardingWizardController();
    wizard.open('new');
    wizard.setFieldValue('capabilities.webhook-events', true);

    const networkStep = wizard.steps.find((s) => s.id === 'network');
    const corsNoteField = networkStep?.fields.find((f) => f.id === 'network.cors-note');
    expect(corsNoteField?.hint).toContain('settings.json');
    expect(corsNoteField?.hint).not.toContain('goodvibes.json');
  });

  test('trust-proxy-notice hint contains RESIDUAL RISK language', () => {
    const wizard = new OnboardingWizardController();
    wizard.open('new');
    wizard.setFieldValue('capabilities.cloudflare-batch', true);
    wizard.setFieldValue('cloudflare.component.zeroTrustTunnel', true);

    const cloudflareStep = wizard.steps.find((s) => s.id === 'cloudflare');
    const noticeField = cloudflareStep?.fields.find((f) => f.id === 'cloudflare.trust-proxy-notice');
    expect(noticeField?.hint).toContain('RESIDUAL RISK');
  });
});

// F1: onboarding recognizes an adoptable running daemon by offering a
// "connect to an existing daemon" choice with a token-paste field, instead of
// requiring the token file to be hand-seeded on disk before the TUI starts.
describe('network step: connect to an existing daemon (F1)', () => {
  test('defaults to "start a new daemon" and hides the adopt fields', () => {
    const wizard = new OnboardingWizardController();
    wizard.open('new');
    wizard.setFieldValue('capabilities.browser-access', true);

    const networkStep = wizard.steps.find((s) => s.id === 'network');
    expect(networkStep?.fields.find((f) => f.id === 'network.daemon-source')).toBeDefined();
    expect(wizard.getStringFieldValue('network.daemon-source', '')).toBe('start');
    expect(networkStep?.fields.find((f) => f.id === 'network.adopt-daemon-host')).toBeUndefined();
    expect(networkStep?.fields.find((f) => f.id === 'network.adopt-daemon-token')).toBeUndefined();
  });

  test('choosing "adopt" reveals host/port/token fields and a connect action', () => {
    const wizard = new OnboardingWizardController();
    wizard.open('new');
    wizard.setFieldValue('capabilities.browser-access', true);
    wizard.setFieldValue('network.daemon-source', 'adopt');

    const networkStep = wizard.steps.find((s) => s.id === 'network');
    const hostField = networkStep?.fields.find((f) => f.id === 'network.adopt-daemon-host');
    const portField = networkStep?.fields.find((f) => f.id === 'network.adopt-daemon-port');
    const tokenField = networkStep?.fields.find((f) => f.id === 'network.adopt-daemon-token');
    const connectAction = networkStep?.fields.find((f) => f.id === 'network.adopt-daemon-connect');
    expect(hostField?.kind).toBe('text');
    expect(portField?.kind).toBe('text');
    expect(tokenField?.kind).toBe('masked');
    expect(connectAction?.kind).toBe('action');
    expect(connectAction && connectAction.kind === 'action' ? connectAction.action : null).toBe('connect-existing-daemon');
    expect(networkStep?.summaryLines.some((line) => line.includes('connect to an existing running daemon'))).toBe(true);
  });

  test('connect-existing-daemon action refuses to proceed without a pasted token', async () => {
    resetTestRuntimeServices();
    const uiServices = createDefaultUiRuntimeServices();
    ensureLocalAdminAuth(uiServices);
    let restartCalled = false;
    installExternalServices(uiServices, {
      inspect: () => ({ daemonRunning: false, httpListenerRunning: false }),
      restart: async () => {
        restartCalled = true;
        return { daemonRunning: false, httpListenerRunning: false };
      },
    });
    const input = makeInput(uiServices);
    const prints: string[] = [];
    input.setCommandRegistry(new CommandRegistry(), {
      session: { runtime: {} },
      print: (text: string) => prints.push(text),
    } as unknown as CommandContext);
    input.openOnboardingWizard({ mode: 'new', preload: () => {} });
    input.onboardingWizard.setFieldValue('capabilities.browser-access', true);
    input.onboardingWizard.setFieldValue('network.daemon-source', 'adopt');

    await (input as unknown as { handleOnboardingAction(action: 'connect-existing-daemon'): Promise<void> })
      .handleOnboardingAction('connect-existing-daemon');

    expect(restartCalled).toBe(false);
    expect(prints.join('\n')).toContain('paste that daemon\'s token first');
  });

  test('connect-existing-daemon action installs the pasted token, applies host/port, and reports success on adoption', async () => {
    resetTestRuntimeServices();
    const uiServices = createDefaultUiRuntimeServices();
    ensureLocalAdminAuth(uiServices);
    const adoptedStatus: HostServiceStatus = {
      mode: 'external',
      host: '10.0.0.5',
      port: 4242,
      baseUrl: 'http://10.0.0.5:4242',
      authenticated: true,
      status: 'running',
      version: '0.38.0',
      reason: 'Existing GoodVibes daemon verified on configured host/port',
    };
    installExternalServices(uiServices, {
      inspect: () => ({ daemonRunning: false, httpListenerRunning: false }),
      restart: async () => ({
        daemonRunning: true,
        httpListenerRunning: false,
        daemonStatus: adoptedStatus,
      }),
    });
    const input = makeInput(uiServices);
    const prints: string[] = [];
    input.setCommandRegistry(new CommandRegistry(), {
      session: { runtime: {} },
      print: (text: string) => prints.push(text),
    } as unknown as CommandContext);
    input.openOnboardingWizard({ mode: 'new', preload: () => {} });
    input.onboardingWizard.setFieldValue('capabilities.browser-access', true);
    input.onboardingWizard.setFieldValue('network.daemon-source', 'adopt');
    input.onboardingWizard.setFieldValue('network.adopt-daemon-host', '10.0.0.5');
    input.onboardingWizard.setFieldValue('network.adopt-daemon-port', '4242');
    input.onboardingWizard.setFieldValue('network.adopt-daemon-token', 'gv_pasted_token');

    await (input as unknown as { handleOnboardingAction(action: 'connect-existing-daemon'): Promise<void> })
      .handleOnboardingAction('connect-existing-daemon');

    expect(prints.join('\n')).toContain('Connect to existing daemon: succeeded.');
    expect(uiServices.platform.configManager.get('controlPlane.host')).toBe('10.0.0.5');
    expect(uiServices.platform.configManager.get('controlPlane.port')).toBe(4242);
    const tokenPath = join(uiServices.environment.homeDirectory, '.goodvibes', 'daemon', 'operator-tokens.json');
    const onDisk = JSON.parse(readFileSync(tokenPath, 'utf-8')) as { token: string };
    expect(onDisk.token).toBe('gv_pasted_token');
  });

  test('connect-existing-daemon action reports an honest diagnostic when the daemon could not be verified', async () => {
    resetTestRuntimeServices();
    const uiServices = createDefaultUiRuntimeServices();
    ensureLocalAdminAuth(uiServices);
    installExternalServices(uiServices, {
      inspect: () => ({ daemonRunning: false, httpListenerRunning: false }),
      restart: async () => ({ daemonRunning: false, httpListenerRunning: false }),
    });
    const input = makeInput(uiServices);
    const prints: string[] = [];
    input.setCommandRegistry(new CommandRegistry(), {
      session: { runtime: {} },
      print: (text: string) => prints.push(text),
    } as unknown as CommandContext);
    input.openOnboardingWizard({ mode: 'new', preload: () => {} });
    input.onboardingWizard.setFieldValue('capabilities.browser-access', true);
    input.onboardingWizard.setFieldValue('network.daemon-source', 'adopt');
    input.onboardingWizard.setFieldValue('network.adopt-daemon-host', '10.0.0.9');
    input.onboardingWizard.setFieldValue('network.adopt-daemon-port', '9999');
    input.onboardingWizard.setFieldValue('network.adopt-daemon-token', 'gv_wrong_token');

    await (input as unknown as { handleOnboardingAction(action: 'connect-existing-daemon'): Promise<void> })
      .handleOnboardingAction('connect-existing-daemon');

    expect(prints.join('\n')).toContain('could not verify a connection');
  });
});

// W4-D1 wizard wiring: handleMigrateLegacyDaemonServiceForHandler shipped
// fully built (handler-onboarding-daemon-adopt.ts) but had no visible
// onboarding control. This closes that gap with a guided action in the
// Network step, visible only when the runtime snapshot's read-only
// legacyDaemon detection reports a unit present, confirm-gated by a checklist
// toggle on top of the engine's own consent requirement.
describe('network step: migrate legacy daemon service (W4-D1)', () => {
  test('hides the migration fields when no legacy unit is detected', () => {
    const snapshot = makeOnboardingSnapshot();
    const wizard = new OnboardingWizardController();
    wizard.open('new');
    wizard.hydrateRuntimeState({ snapshot }, { resetValues: true });
    wizard.setFieldValue('capabilities.browser-access', true);

    const networkStep = wizard.steps.find((step) => step.id === 'network');
    expect(networkStep?.fields.find((field) => field.id === 'network.migrate-legacy-daemon-detected')).toBeUndefined();
    expect(networkStep?.fields.find((field) => field.id === 'network.migrate-legacy-daemon-confirm')).toBeUndefined();
    expect(networkStep?.fields.find((field) => field.id === 'network.migrate-legacy-daemon')).toBeUndefined();
  });

  test('shows detection, a confirm checklist, and a preview-mode action when a legacy unit is present but not active', () => {
    const snapshot = makeOnboardingSnapshot({
      legacyDaemon: { present: true, active: false, path: '/home/test/.config/systemd/user/goodvibes-daemon.service' },
    });
    const wizard = new OnboardingWizardController();
    wizard.open('new');
    wizard.hydrateRuntimeState({ snapshot }, { resetValues: true });
    wizard.setFieldValue('capabilities.browser-access', true);

    const networkStep = wizard.steps.find((step) => step.id === 'network');
    const detected = networkStep?.fields.find((field) => field.id === 'network.migrate-legacy-daemon-detected');
    const confirmField = networkStep?.fields.find((field) => field.id === 'network.migrate-legacy-daemon-confirm');
    const actionField = networkStep?.fields.find((field) => field.id === 'network.migrate-legacy-daemon');
    expect(detected?.kind).toBe('status');
    expect(detected?.hint).toContain('installed (not currently active)');
    expect(detected?.hint).toContain('will not touch the legacy one automatically');
    expect(confirmField?.kind).toBe('checklist');
    expect(confirmField && confirmField.kind === 'checklist' ? confirmField.defaultValue : null).toBe(false);
    expect(actionField?.kind).toBe('action');
    expect(actionField?.label).toBe('Preview migration plan');
    expect(actionField && actionField.kind === 'action' ? actionField.action : null).toBe('migrate-legacy-daemon-service');
  });

  test('custom service.serviceName (snapshot trackedServiceName): the detection note names the custom unit, not the hardcoded default (F2 follow-up)', () => {
    const snapshot = makeOnboardingSnapshot({
      legacyDaemon: {
        present: true,
        active: false,
        path: '/home/test/.config/systemd/user/goodvibes-daemon.service',
        trackedServiceName: 'my-custom-unit',
      },
    });
    const wizard = new OnboardingWizardController();
    wizard.open('new');
    wizard.hydrateRuntimeState({ snapshot }, { resetValues: true });
    wizard.setFieldValue('capabilities.browser-access', true);

    const networkStep = wizard.steps.find((step) => step.id === 'network');
    const detected = networkStep?.fields.find((field) => field.id === 'network.migrate-legacy-daemon-detected');
    expect(detected?.hint).toContain('a different unit name (my-custom-unit.service)');
    expect(detected?.hint).not.toContain('a different unit name (goodvibes.service)');
  });

  test('snapshot without trackedServiceName (pre-feature fixture): the detection note falls back to the default unit name', () => {
    const snapshot = makeOnboardingSnapshot({
      legacyDaemon: { present: true, active: false, path: '/home/test/.config/systemd/user/goodvibes-daemon.service' },
    });
    const wizard = new OnboardingWizardController();
    wizard.open('new');
    wizard.hydrateRuntimeState({ snapshot }, { resetValues: true });
    wizard.setFieldValue('capabilities.browser-access', true);

    const networkStep = wizard.steps.find((step) => step.id === 'network');
    const detected = networkStep?.fields.find((field) => field.id === 'network.migrate-legacy-daemon-detected');
    expect(detected?.hint).toContain('a different unit name (goodvibes.service)');
  });

  test('reports the active-and-running wording when the legacy unit is currently active', () => {
    const snapshot = makeOnboardingSnapshot({
      legacyDaemon: { present: true, active: true, path: '/home/test/.config/systemd/user/goodvibes-daemon.service' },
    });
    const wizard = new OnboardingWizardController();
    wizard.open('new');
    wizard.hydrateRuntimeState({ snapshot }, { resetValues: true });
    wizard.setFieldValue('capabilities.browser-access', true);

    const networkStep = wizard.steps.find((step) => step.id === 'network');
    const detected = networkStep?.fields.find((field) => field.id === 'network.migrate-legacy-daemon-detected');
    expect(detected?.hint).toContain('installed and RUNNING');
  });

  test('checking the confirm checklist flips the action to migrate-now wording', () => {
    const snapshot = makeOnboardingSnapshot({
      legacyDaemon: { present: true, active: true, path: '/home/test/.config/systemd/user/goodvibes-daemon.service' },
    });
    const wizard = new OnboardingWizardController();
    wizard.open('new');
    wizard.hydrateRuntimeState({ snapshot }, { resetValues: true });
    wizard.setFieldValue('capabilities.browser-access', true);
    wizard.setFieldValue('network.migrate-legacy-daemon-confirm', true);

    const networkStep = wizard.steps.find((step) => step.id === 'network');
    const actionField = networkStep?.fields.find((field) => field.id === 'network.migrate-legacy-daemon');
    expect(actionField?.label).toBe('Migrate legacy daemon service now');
    expect(actionField?.hint).toContain('Executes the migration now');
  });

  test('migrate-legacy-daemon-service action reads the confirm checklist and dispatches to the handler (legacy absent, port free: safe, deterministic branch)', async () => {
    resetTestRuntimeServices();
    const uiServices = createDefaultUiRuntimeServices();
    ensureLocalAdminAuth(uiServices);
    // A distinctive, unlikely-to-be-bound high port — never 3421/4444 — so this
    // exercises the engine's real (uninjected) TCP port probe deterministically
    // without depending on, or risking interaction with, any real GoodVibes
    // daemon. The test's homeDirectory is an ephemeral per-test tempdir, so
    // detectLegacyUnit's unit-file check is guaranteed to report absent.
    uiServices.platform.configManager.setDynamic('controlPlane.host', '127.0.0.1');
    uiServices.platform.configManager.setDynamic('controlPlane.port', 58921);
    const input = makeInput(uiServices);
    const prints: string[] = [];
    input.setCommandRegistry(new CommandRegistry(), {
      session: { runtime: {} },
      print: (text: string) => prints.push(text),
    } as unknown as CommandContext);
    input.openOnboardingWizard({ mode: 'new', preload: () => {} });
    input.onboardingWizard.setFieldValue('capabilities.browser-access', true);

    await (input as unknown as { handleOnboardingAction(action: 'migrate-legacy-daemon-service'): Promise<void> })
      .handleOnboardingAction('migrate-legacy-daemon-service');

    const output = prints.join('\n');
    expect(output).toContain('Migrate legacy daemon service:');
    expect(output).toContain('no legacy goodvibes-daemon.service unit was found');
    expect(output).toContain('is free');
    expect(output).toContain('Run install-service');
  });
});
