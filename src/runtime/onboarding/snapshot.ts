import type { SecretStorageReview } from '../../config/secrets.ts';
import { getProviderIdFromModel } from '../../config/provider-model.ts';
import type { LocalAuthSnapshot } from '@pellux/goodvibes-sdk/platform/security';
import { readOnboardingRuntimeState } from './state.ts';
import type {
  OnboardingAcknowledgementSnapshot,
  OnboardingConfigSnapshot,
  OnboardingLegacyDaemonSnapshot,
  OnboardingProviderRoutingSnapshot,
  OnboardingRuntimeDefaultsSnapshot,
  OnboardingServiceState,
  OnboardingSnapshotCollectionIssue,
  OnboardingSnapshotCollectionIssueArea,
  OnboardingSnapshotDependencies,
  OnboardingSnapshotState,
  OnboardingSurfaceRecord,
} from './types.ts';
import { summarizeError } from '@pellux/goodvibes-sdk/platform/utils';

function sortUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function buildConfigSnapshot(
  config: OnboardingSnapshotDependencies['config'],
): OnboardingConfigSnapshot {
  return {
    display: config.getCategory('display'),
    provider: config.getCategory('provider'),
    behavior: config.getCategory('behavior'),
    storage: config.getCategory('storage'),
    permissions: config.getCategory('permissions'),
    helper: config.getCategory('helper'),
    tools: {
      llmEnabled: config.get('tools.llmEnabled'),
      llmProvider: config.get('tools.llmProvider'),
      llmModel: config.get('tools.llmModel'),
    },
    danger: config.getCategory('danger'),
    controlPlane: config.getCategory('controlPlane'),
    httpListener: config.getCategory('httpListener'),
    web: config.getCategory('web'),
    network: config.getCategory('network'),
    surfaces: config.getCategory('surfaces'),
    service: config.getCategory('service'),
    batch: config.getCategory('batch'),
    cloudflare: config.getCategory('cloudflare'),
  };
}

function buildProviderRoutingSnapshot(
  config: OnboardingConfigSnapshot,
): OnboardingProviderRoutingSnapshot {
  return {
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
  };
}

function buildRuntimeDefaultsSnapshot(
  config: OnboardingConfigSnapshot,
): OnboardingRuntimeDefaultsSnapshot {
  return {
    providerReasoningEffort: config.provider.reasoningEffort,
    permissionsMode: config.permissions.mode,
    behavior: config.behavior,
    display: config.display,
    secretStoragePolicy: config.storage.secretPolicy,
  };
}

async function buildServicesSnapshot(
  services: OnboardingSnapshotDependencies['services'],
): Promise<{
  snapshot: {
    total: number;
    oauthProviderIds: readonly string[];
    services: readonly OnboardingServiceState[];
  };
  issues: readonly OnboardingSnapshotCollectionIssue[];
}> {
  let configs: ReturnType<OnboardingSnapshotDependencies['services']['getAll']>;
  try {
    configs = services.getAll();
  } catch (error) {
    return {
      snapshot: {
        total: 0,
        oauthProviderIds: [],
        services: [],
      },
      issues: [
        {
          area: 'services',
          message: summarizeError(error),
        },
      ],
    };
  }

  const names = Object.keys(configs).sort((left, right) => left.localeCompare(right));
  const entryResults = await Promise.all(names.map(async (name) => {
    const config = configs[name]!;
    try {
      const inspection = await services.inspect(name);

      return {
        entry: {
          name,
          providerId: config.providerId ?? config.name,
          baseUrl: config.baseUrl ?? null,
          authType: config.authType,
          tokenKey: config.tokenKey,
          oauthConfigured: Boolean(config.oauth),
          hasPrimaryCredential: inspection?.hasPrimaryCredential ?? false,
          hasPasswordCredential: inspection?.hasPasswordCredential ?? false,
          hasWebhookUrl: inspection?.hasWebhookUrl ?? false,
          hasSigningSecret: inspection?.hasSigningSecret ?? false,
          hasPublicKey: inspection?.hasPublicKey ?? false,
          hasAppToken: inspection?.hasAppToken ?? false,
        } satisfies OnboardingServiceState,
        issue: null,
      };
    } catch (error) {
      return {
        entry: {
          name,
          providerId: config.providerId ?? config.name,
          baseUrl: config.baseUrl ?? null,
          authType: config.authType,
          tokenKey: config.tokenKey,
          oauthConfigured: Boolean(config.oauth),
          hasPrimaryCredential: false,
          hasPasswordCredential: false,
          hasWebhookUrl: false,
          hasSigningSecret: false,
          hasPublicKey: false,
          hasAppToken: false,
        } satisfies OnboardingServiceState,
        issue: {
          area: 'services',
          message: `${name}: ${summarizeError(error)}`,
        } satisfies OnboardingSnapshotCollectionIssue,
      };
    }
  }));

  const entries = entryResults.map((result) => result.entry);
  const issues: OnboardingSnapshotCollectionIssue[] = [];
  for (const result of entryResults) {
    if (result.issue) issues.push(result.issue);
  }

  return {
    snapshot: {
      total: entries.length,
      oauthProviderIds: sortUnique(entries.filter((entry) => entry.oauthConfigured).map((entry) => entry.providerId)),
      services: entries,
    },
    issues,
  };
}

function buildFallbackSecretReview(
  config: OnboardingConfigSnapshot,
): SecretStorageReview {
  return {
    policy: config.storage.secretPolicy,
    secureAvailable: false,
    storedKeys: 0,
    envBackedKeys: 0,
    secureKeys: 0,
    plaintextKeys: 0,
    warnings: [],
    locations: [],
  };
}

function buildFallbackAuthSnapshot(): LocalAuthSnapshot {
  return {
    userStorePath: '',
    bootstrapCredentialPath: '',
    persisted: false,
    bootstrapCredentialPresent: false,
    userCount: 0,
    sessionCount: 0,
    users: [],
    sessions: [],
  };
}

function buildFallbackLegacyDaemonSnapshot(): OnboardingLegacyDaemonSnapshot {
  return { present: false, active: false, path: '' };
}

function buildConfiguredSurfaceKinds(
  surfaces: OnboardingConfigSnapshot['surfaces'],
): string[] {
  const enabledKinds: string[] = [];

  for (const [kind, value] of Object.entries(surfaces)) {
    if (!value || typeof value !== 'object') continue;
    if ('enabled' in value && value.enabled === true) enabledKinds.push(kind);
  }

  return enabledKinds.sort((left, right) => left.localeCompare(right));
}

function sortSurfaceRecords(
  records: readonly OnboardingSurfaceRecord[],
): OnboardingSurfaceRecord[] {
  return [...records].sort((left, right) => {
    const kindOrder = left.kind.localeCompare(right.kind);
    if (kindOrder !== 0) return kindOrder;

    const labelOrder = left.label.localeCompare(right.label);
    if (labelOrder !== 0) return labelOrder;

    return left.id.localeCompare(right.id);
  });
}

async function loadOptionalSnapshot<T>(
  area: OnboardingSnapshotCollectionIssueArea,
  loader: (() => Promise<T>) | undefined,
  fallback: T,
): Promise<{
  value: T;
  issue: OnboardingSnapshotCollectionIssue | null;
}> {
  if (!loader) return { value: fallback, issue: null };

  try {
    return {
      value: await loader(),
      issue: null,
    };
  } catch (error) {
    return {
      value: fallback,
      issue: {
        area,
        message: summarizeError(error),
      },
    };
  }
}

function buildAcknowledgementSnapshot(
  deps: OnboardingSnapshotDependencies,
): {
  snapshot: OnboardingAcknowledgementSnapshot;
  issue: OnboardingSnapshotCollectionIssue | null;
} {
  const scope = deps.acknowledgementScope ?? 'project';
  if (!deps.shellPaths) {
    return {
      snapshot: {
        scope,
        exists: false,
        updatedAt: null,
        source: null,
        accepted: {},
      },
      issue: null,
    };
  }

  const state = readOnboardingRuntimeState(deps.shellPaths, scope);
  if (state.parseError) {
    return {
      snapshot: {
        scope,
        exists: true,
        updatedAt: null,
        source: null,
        accepted: {},
      },
      issue: {
        area: 'acknowledgements',
        message: state.parseError,
      },
    };
  }

  return {
    snapshot: {
      scope,
      exists: state.exists,
      updatedAt: state.payload?.updatedAt ?? null,
      source: state.payload?.source ?? null,
      ...(state.payload?.mode ? { mode: state.payload.mode } : {}),
      ...(state.payload?.workspaceRoot ? { workspaceRoot: state.payload.workspaceRoot } : {}),
      accepted: state.payload?.acknowledgements ?? {},
    },
    issue: null,
  };
}

export async function collectOnboardingSnapshot(
  deps: OnboardingSnapshotDependencies,
): Promise<OnboardingSnapshotState> {
  const capturedAt = deps.clock?.() ?? Date.now();
  const config = buildConfigSnapshot(deps.config);
  const providerRouting = buildProviderRoutingSnapshot(config);
  const runtimeDefaults = buildRuntimeDefaultsSnapshot(config);
  const acknowledgementResult = buildAcknowledgementSnapshot(deps);

  const [
    subscriptionsActiveResult,
    subscriptionsPendingResult,
    authSnapshotResult,
    servicesResult,
    secretReviewResult,
    secretRecordsResult,
    surfaceResult,
    providerAccountsResult,
    legacyDaemonResult,
  ] = await Promise.all([
    loadOptionalSnapshot(
      'subscriptions-active',
      () => Promise.resolve(deps.subscriptions.list()),
      [] as ReturnType<OnboardingSnapshotDependencies['subscriptions']['list']>,
    ),
    loadOptionalSnapshot(
      'subscriptions-pending',
      () => Promise.resolve(deps.subscriptions.listPending()),
      [] as ReturnType<OnboardingSnapshotDependencies['subscriptions']['listPending']>,
    ),
    loadOptionalSnapshot(
      'auth',
      () => Promise.resolve(deps.auth.inspect()),
      buildFallbackAuthSnapshot(),
    ),
    buildServicesSnapshot(deps.services),
    loadOptionalSnapshot(
      'secrets-review',
      () => deps.secrets.inspect(),
      buildFallbackSecretReview(config),
    ),
    loadOptionalSnapshot(
      'secrets-records',
      () => deps.secrets.listDetailed(),
      [] as const,
    ),
    loadOptionalSnapshot(
      'surfaces',
      deps.surfaces ? () => Promise.resolve(deps.surfaces!.list()) : undefined,
      [] as readonly OnboardingSurfaceRecord[],
    ),
    loadOptionalSnapshot(
      'provider-accounts',
      deps.providerAccounts ? () => deps.providerAccounts!.loadSnapshot() : undefined,
      null,
    ),
    loadOptionalSnapshot(
      'legacy-daemon',
      deps.legacyDaemon ? () => Promise.resolve(deps.legacyDaemon!.detect()) : undefined,
      buildFallbackLegacyDaemonSnapshot(),
    ),
  ]);

  const collectionIssues: OnboardingSnapshotCollectionIssue[] = [];
  if (acknowledgementResult.issue) collectionIssues.push(acknowledgementResult.issue);
  collectionIssues.push(...servicesResult.issues);
  if (subscriptionsActiveResult.issue) collectionIssues.push(subscriptionsActiveResult.issue);
  if (subscriptionsPendingResult.issue) collectionIssues.push(subscriptionsPendingResult.issue);
  if (authSnapshotResult.issue) collectionIssues.push(authSnapshotResult.issue);
  if (secretReviewResult.issue) collectionIssues.push(secretReviewResult.issue);
  if (secretRecordsResult.issue) collectionIssues.push(secretRecordsResult.issue);
  if (surfaceResult.issue) collectionIssues.push(surfaceResult.issue);
  if (providerAccountsResult.issue) collectionIssues.push(providerAccountsResult.issue);
  if (legacyDaemonResult.issue) collectionIssues.push(legacyDaemonResult.issue);

  return {
    capturedAt,
    config,
    providerRouting,
    runtimeDefaults,
    acknowledgements: acknowledgementResult.snapshot,
    services: servicesResult.snapshot,
    subscriptions: {
      active: subscriptionsActiveResult.value,
      pending: subscriptionsPendingResult.value,
      activeProviderIds: sortUnique(subscriptionsActiveResult.value.map((entry) => entry.provider)),
      pendingProviderIds: sortUnique(subscriptionsPendingResult.value.map((entry) => entry.provider)),
    },
    secrets: {
      review: secretReviewResult.value,
      records: secretRecordsResult.value,
    },
    auth: {
      snapshot: authSnapshotResult.value,
    },
    bindSettings: {
      // danger.daemon (since removed — see docs/decisions/2026-07-05-daemon-by-default.md)
      // used to gate the earlier opt-in daemon posture; this site read it RAW
      // (not through resolveDaemonEnabled) so the wizard's network-mode
      // classification tracked "did the user explicitly request the legacy
      // dangerous posture" rather than "does the daemon run" (which has defaulted
      // true unconditionally since daemon-by-default landed, and would misclassify every default,
      // local-only install as server-mode if read here). Every realistic config
      // already evaluated this to `false` (unset, or an explicit `danger.daemon:
      // false` both did); the alias's removal migration preserves the one case
      // that changes real daemon behavior (explicit `false` -> `daemon.enabled:
      // false`) but does not resurrect a signal for "explicitly true" — that path
      // was always a no-op for actual daemon operation. With the alias gone there
      // is no signal left to read, so this is pinned at its steady-state value.
      daemonEnabled: false,
      httpListenerEnabled: Boolean(config.danger.httpListener),
      controlPlane: config.controlPlane,
      httpListener: config.httpListener,
      web: config.web,
    },
    surfaces: {
      configuredEnabledKinds: buildConfiguredSurfaceKinds(config.surfaces),
      records: sortSurfaceRecords(surfaceResult.value),
    },
    providerAccounts: providerAccountsResult.value,
    legacyDaemon: legacyDaemonResult.value,
    collectionIssues,
  };
}
