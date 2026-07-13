import { DEFAULT_CONFIG } from '../../config/index.ts';
import { getProviderIdFromModel } from '../../config/provider-model.ts';
import type { OnboardingSnapshotState } from '../../runtime/onboarding/index.ts';

/**
 * A complete, default-valued onboarding runtime snapshot for tests. Callers
 * override just the slice they exercise (e.g. providerAccounts).
 */
export function makeOnboardingSnapshot(
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
