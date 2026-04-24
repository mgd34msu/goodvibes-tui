import { describe, expect, test } from 'bun:test';
import { DEFAULT_CONFIG } from '../../../config/index.ts';
import type { OnboardingSnapshotState } from '../../../runtime/onboarding/index.ts';
import {
  deriveReopenEditAcknowledgementState,
  deriveStep1_5NetworkMode,
  deriveStep1Capabilities,
  deriveStep1CapabilityFlags,
} from '../../../runtime/onboarding/index.ts';

function buildBaseSnapshot(): OnboardingSnapshotState {
  const controlPlane = structuredClone(DEFAULT_CONFIG.controlPlane);
  const httpListener = structuredClone(DEFAULT_CONFIG.httpListener);
  const web = structuredClone(DEFAULT_CONFIG.web);

  return {
    capturedAt: 0,
    config: {
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
      controlPlane,
      httpListener,
      web,
      network: structuredClone(DEFAULT_CONFIG.network),
      surfaces: structuredClone(DEFAULT_CONFIG.surfaces),
      service: structuredClone(DEFAULT_CONFIG.service),
    },
    providerRouting: {
      primaryProviderId: DEFAULT_CONFIG.provider.provider,
      primaryModelId: DEFAULT_CONFIG.provider.model,
      primaryReasoningEffort: DEFAULT_CONFIG.provider.reasoningEffort,
      embeddingProviderId: DEFAULT_CONFIG.provider.embeddingProvider,
      systemPromptFile: DEFAULT_CONFIG.provider.systemPromptFile,
      helperEnabled: DEFAULT_CONFIG.helper.enabled,
      helperProviderId: DEFAULT_CONFIG.helper.globalProvider,
      helperModelId: DEFAULT_CONFIG.helper.globalModel,
      toolLlmEnabled: DEFAULT_CONFIG.tools.llmEnabled,
      toolProviderId: DEFAULT_CONFIG.tools.llmProvider,
      toolModelId: DEFAULT_CONFIG.tools.llmModel,
    },
    runtimeDefaults: {
      providerReasoningEffort: DEFAULT_CONFIG.provider.reasoningEffort,
      permissionsMode: DEFAULT_CONFIG.permissions.mode,
      behavior: structuredClone(DEFAULT_CONFIG.behavior),
      display: structuredClone(DEFAULT_CONFIG.display),
      secretStoragePolicy: DEFAULT_CONFIG.storage.secretPolicy,
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
        policy: 'preferred_secure',
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
        userStorePath: '/tmp/auth-users.json',
        bootstrapCredentialPath: '/tmp/auth-bootstrap.txt',
        persisted: true,
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
      controlPlane,
      httpListener,
      web,
    },
    surfaces: {
      configuredEnabledKinds: [],
      records: [],
    },
    providerAccounts: null,
    collectionIssues: [],
  };
}

describe('onboarding derivation helpers', () => {
  test('derives the agreed first-screen capability model from configured onboarding state', () => {
    let snapshot = buildBaseSnapshot();

    snapshot = {
      ...snapshot,
      services: {
        total: 1,
        oauthProviderIds: ['openai'],
        services: [
          {
            name: 'openai',
            providerId: 'openai',
            baseUrl: 'https://api.openai.com',
            authType: 'oauth',
            tokenKey: 'OPENAI_API_KEY',
            oauthConfigured: true,
            hasPrimaryCredential: true,
            hasPasswordCredential: false,
            hasWebhookUrl: false,
            hasSigningSecret: false,
            hasPublicKey: false,
          },
        ],
      },
    };
    snapshot = {
      ...snapshot,
      subscriptions: {
        active: [
          {
            provider: 'openai',
            accessToken: 'token',
            tokenType: 'Bearer',
            authMode: 'oauth',
            overrideAmbientApiKeys: true,
            createdAt: 1,
            updatedAt: 2,
          },
        ],
        pending: [],
        activeProviderIds: ['openai'],
        pendingProviderIds: [],
      },
      auth: {
        snapshot: {
          ...snapshot.auth.snapshot,
          userCount: 1,
        },
      },
      bindSettings: {
        ...snapshot.bindSettings,
        daemonEnabled: true,
        httpListenerEnabled: true,
        controlPlane: {
          ...snapshot.bindSettings.controlPlane,
          hostMode: 'network',
        },
        httpListener: {
          ...snapshot.bindSettings.httpListener,
          hostMode: 'network',
        },
        web: {
          ...snapshot.bindSettings.web,
          enabled: true,
          hostMode: 'network',
        },
      },
      surfaces: {
        configuredEnabledKinds: ['slack'],
        records: [
          {
            id: 'surface:slack',
            kind: 'slack',
            label: 'Slack',
            enabled: true,
            state: 'healthy',
            capabilities: ['send'],
            metadata: {},
          },
        ],
      },
      providerAccounts: {
        capturedAt: 1,
        configuredCount: 1,
        issueCount: 0,
        providers: [
          {
            providerId: 'openai',
            configured: true,
            active: true,
            oauthReady: true,
            pendingLogin: false,
            availableRoutes: ['subscription'],
            activeRoute: 'subscription',
            authFreshness: 'healthy',
          },
        ],
      },
    };

    expect(deriveStep1Capabilities(snapshot)).toEqual([
      {
        id: 'local-tui-only',
        label: 'Local TUI Only (No Servers)',
        selected: false,
        detail: 'Switching to this disables browser access, background services, network listeners, and external surfaces.',
      },
      {
        id: 'browser-access',
        label: 'Open GoodVibes in a Browser',
        selected: true,
        detail: 'Keep the background service and web UI enabled, reachable according to the network step.',
      },
      {
        id: 'network-access',
        label: 'Let other devices use GoodVibes',
        selected: true,
        detail: 'Keep enabled GoodVibes services reachable from other devices on your LAN. Local auth is required.',
      },
      {
        id: 'webhook-events',
        label: 'Receive webhooks or events from other tools',
        selected: true,
        detail: 'Keep the HTTP listener available for incoming webhooks, callbacks, and automation events.',
      },
      {
        id: 'external-integrations',
        label: 'Connect GoodVibes to external apps and services',
        selected: true,
        detail: 'Review and configure 1 detected external app, service, or surface integration signal(s).',
      },
    ]);

    expect(deriveStep1CapabilityFlags(snapshot)).toEqual({
      providers: true,
      services: true,
      subscriptions: true,
      auth: true,
      controlPlane: true,
      httpListener: true,
      web: true,
      surfaces: true,
    });
  });

  test('treats only enabled bind targets as part of network-mode derivation', () => {
    let snapshot = buildBaseSnapshot();
    snapshot = {
      ...snapshot,
      bindSettings: {
        ...snapshot.bindSettings,
        web: {
          ...snapshot.bindSettings.web,
          hostMode: 'custom',
        },
      },
    };

    expect(deriveStep1_5NetworkMode(snapshot.bindSettings)).toBe('local-network-default');

    snapshot = {
      ...snapshot,
      bindSettings: {
        ...snapshot.bindSettings,
        web: {
          ...snapshot.bindSettings.web,
          enabled: true,
        },
      },
    };

    expect(deriveStep1_5NetworkMode(snapshot.bindSettings)).toBe('custom');

    snapshot = {
      ...buildBaseSnapshot(),
      bindSettings: {
        ...buildBaseSnapshot().bindSettings,
        web: {
          ...buildBaseSnapshot().bindSettings.web,
          enabled: true,
        },
      },
    };

    expect(deriveStep1_5NetworkMode(snapshot.bindSettings)).toBe('custom');

    snapshot = {
      ...snapshot,
      bindSettings: {
        ...snapshot.bindSettings,
        web: {
          ...snapshot.bindSettings.web,
          hostMode: 'network',
        },
      },
    };

    expect(deriveStep1_5NetworkMode(snapshot.bindSettings)).toBe('local-network-default');
  });

  test('does not treat a local control plane as custom when listener is LAN-facing', () => {
    const snapshot: OnboardingSnapshotState = {
      ...buildBaseSnapshot(),
      bindSettings: {
        ...buildBaseSnapshot().bindSettings,
        daemonEnabled: true,
        httpListenerEnabled: true,
        controlPlane: {
          ...buildBaseSnapshot().bindSettings.controlPlane,
          enabled: true,
          hostMode: 'local',
          host: '127.0.0.1',
          allowRemote: false,
        },
        httpListener: {
          ...buildBaseSnapshot().bindSettings.httpListener,
          hostMode: 'network',
          host: '0.0.0.0',
        },
      },
    };

    expect(deriveStep1_5NetworkMode(snapshot.bindSettings)).toBe('local-network-default');
  });

  test('does not treat a LAN-facing HTTP listener as other-device GoodVibes access', () => {
    const snapshot: OnboardingSnapshotState = {
      ...buildBaseSnapshot(),
      bindSettings: {
        ...buildBaseSnapshot().bindSettings,
        daemonEnabled: true,
        httpListenerEnabled: true,
        controlPlane: {
          ...buildBaseSnapshot().bindSettings.controlPlane,
          enabled: true,
          hostMode: 'local',
          host: '127.0.0.1',
          allowRemote: false,
        },
        httpListener: {
          ...buildBaseSnapshot().bindSettings.httpListener,
          hostMode: 'network',
          host: '0.0.0.0',
        },
      },
    };
    const capabilities = deriveStep1Capabilities(snapshot);

    expect(capabilities.find((capability) => capability.id === 'network-access')?.selected).toBe(false);
    expect(capabilities.find((capability) => capability.id === 'webhook-events')?.selected).toBe(true);
  });

  test('does not treat custom loopback binds as other-device access', () => {
    const snapshot: OnboardingSnapshotState = {
      ...buildBaseSnapshot(),
      bindSettings: {
        ...buildBaseSnapshot().bindSettings,
        daemonEnabled: true,
        controlPlane: {
          ...buildBaseSnapshot().bindSettings.controlPlane,
          enabled: true,
          hostMode: 'custom',
          host: '127.0.0.1',
        },
        web: {
          ...buildBaseSnapshot().bindSettings.web,
          enabled: true,
          hostMode: 'custom',
          host: 'localhost',
        },
      },
    };

    expect(deriveStep1Capabilities(snapshot).find((capability) => capability.id === 'network-access')?.selected).toBe(false);
  });

  test('derives webhook-events for every inbound external surface kind', () => {
    const inboundKinds = [
      'bluebubbles',
      'discord',
      'google-chat',
      'googleChat',
      'imessage',
      'mattermost',
      'matrix',
      'msteams',
      'ntfy',
      'signal',
      'slack',
      'telegram',
      'webhook',
      'whatsapp',
    ];

    for (const kind of inboundKinds) {
      const snapshot: OnboardingSnapshotState = {
        ...buildBaseSnapshot(),
        surfaces: {
          configuredEnabledKinds: [kind],
          records: [
            {
              id: `surface:${kind}`,
              kind,
              label: kind,
              enabled: true,
              state: 'healthy',
              capabilities: ['receive'],
              metadata: {},
            },
          ],
        },
      };

      expect(deriveStep1Capabilities(snapshot).find((capability) => capability.id === 'webhook-events')?.selected).toBe(true);
    }
  });

  test('does not treat provider setup alone as the external integrations capability', () => {
    const snapshot: OnboardingSnapshotState = {
      ...buildBaseSnapshot(),
      services: {
        total: 1,
        oauthProviderIds: ['openai'],
        services: [
          {
            name: 'openai',
            providerId: 'openai',
            baseUrl: 'https://api.openai.com',
            authType: 'oauth',
            tokenKey: 'OPENAI_API_KEY',
            oauthConfigured: true,
            hasPrimaryCredential: true,
            hasPasswordCredential: false,
            hasWebhookUrl: false,
            hasSigningSecret: false,
            hasPublicKey: false,
          },
        ],
      },
      subscriptions: {
        active: [
          {
            provider: 'openai',
            accessToken: 'token',
            tokenType: 'Bearer',
            authMode: 'oauth',
            overrideAmbientApiKeys: true,
            createdAt: 1,
            updatedAt: 2,
          },
        ],
        pending: [],
        activeProviderIds: ['openai'],
        pendingProviderIds: [],
      },
      providerAccounts: {
        capturedAt: 1,
        configuredCount: 1,
        issueCount: 0,
        providers: [
          {
            providerId: 'openai',
            configured: true,
            active: true,
            oauthReady: true,
            pendingLogin: false,
            availableRoutes: ['subscription'],
            activeRoute: 'subscription',
            authFreshness: 'healthy',
          },
        ],
      },
    };

    expect(deriveStep1Capabilities(snapshot)).toEqual([
      {
        id: 'local-tui-only',
        label: 'Local TUI Only (No Servers)',
        selected: true,
        detail: 'Keep GoodVibes in this terminal and disable browser access, background services, network listeners, and external surfaces.',
      },
      {
        id: 'browser-access',
        label: 'Open GoodVibes in a Browser',
        selected: false,
        detail: 'Enable the background service and web UI, reachable on the local network by default unless customized.',
      },
      {
        id: 'network-access',
        label: 'Let other devices use GoodVibes',
        selected: false,
        detail: 'Expose enabled GoodVibes services on your LAN so other devices can reach them. Local auth is required.',
      },
      {
        id: 'webhook-events',
        label: 'Receive webhooks or events from other tools',
        selected: false,
        detail: 'Turn on the HTTP listener for incoming webhooks, callbacks, and automation events.',
      },
      {
        id: 'external-integrations',
        label: 'Connect GoodVibes to external apps and services',
        selected: false,
        detail: 'Show Slack, Discord, Telegram, Teams, Matrix, and other app surfaces so they can be enabled and configured here.',
      },
    ]);
  });

  test('derives reopen acknowledgement state for provider, subscription, and auth posture', () => {
    let snapshot = buildBaseSnapshot();
    snapshot = {
      ...snapshot,
      providerRouting: {
        ...snapshot.providerRouting,
        helperEnabled: true,
      },
      subscriptions: {
        active: [],
        pending: [
          {
            provider: 'openai',
            state: 'pending',
            verifier: 'verifier',
            redirectUri: 'http://127.0.0.1/callback',
            createdAt: 1,
          },
        ],
        activeProviderIds: [],
        pendingProviderIds: ['openai'],
      },
      auth: {
        snapshot: {
          ...snapshot.auth.snapshot,
          bootstrapCredentialPresent: true,
        },
      },
    };

    const acknowledgement = deriveReopenEditAcknowledgementState(snapshot);

    expect(acknowledgement.providers).toEqual({
      required: true,
      accepted: false,
      reason: 'configured-routing',
      detail: '1 provider auth path(s) are already configured.',
    });
    expect(acknowledgement.subscriptions).toEqual({
      required: true,
      accepted: false,
      reason: 'pending-login',
      detail: '1 subscription login(s) are pending completion.',
    });
    expect(acknowledgement.auth).toEqual({
      required: true,
      accepted: false,
      reason: 'bootstrap-credential',
      detail: 'The local auth bootstrap credential file is still present.',
    });
  });

  test('requires provider acknowledgement when API-key-backed provider state exists without provider accounts', () => {
    const acknowledgement = deriveReopenEditAcknowledgementState({
      ...buildBaseSnapshot(),
      providerRouting: {
        ...buildBaseSnapshot().providerRouting,
        primaryProviderId: 'openai',
        primaryModelId: 'gpt-5.4',
      },
      secrets: {
        ...buildBaseSnapshot().secrets,
        review: {
          ...buildBaseSnapshot().secrets.review,
          storedKeys: 1,
          envBackedKeys: 1,
        },
        records: [
          {
            key: 'OPENAI_API_KEY',
            source: 'env',
            scope: 'env',
            secure: false,
            overriddenByEnv: false,
          },
        ],
      },
    });

    expect(acknowledgement.providers).toEqual({
      required: true,
      accepted: false,
      reason: 'configured-routing',
      detail: '1 provider auth path(s) are already configured.',
    });
  });
});
