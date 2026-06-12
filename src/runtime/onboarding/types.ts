import type { ConfigManager, ConfigKey, GoodVibesConfig } from '../../config/index.ts';
import type { SecretsManager, SecretRecord, SecretStorageReview } from '../../config/secrets.ts';
import type { FeatureFlagConfigKey } from '../surface-feature-flags.ts';
import type { LocalAuthSnapshot, UserAuthManager } from '@pellux/goodvibes-sdk/platform/security';
import type { ShellPathService } from '@/runtime/index.ts';
import type {
  LocalAuthInspectionQuery,
  ServiceInspectionQuery,
  SubscriptionAccessQuery,
} from '../ui-service-queries.ts';

export type OnboardingMode = 'new' | 'edit' | 'reopen';

export type OnboardingNetworkMode = 'local-network-default' | 'custom';

export type OnboardingAcknowledgementTarget = 'providers' | 'subscriptions' | 'auth';

export type OnboardingAcknowledgementReason =
  | 'not-needed'
  | 'configured-routing'
  | 'customized-config'
  | 'subscription-state'
  | 'pending-login'
  | 'auth-state'
  | 'bootstrap-credential'
  | 'active-sessions';

export type OnboardingVerificationStatus = 'pass' | 'warn' | 'fail';

export type OnboardingStateScope = 'user' | 'project';

export type OnboardingCheckMarkerSource = 'wizard' | 'command' | 'import' | 'unknown';

export interface OnboardingConfigSnapshot {
  readonly display: GoodVibesConfig['display'];
  readonly provider: GoodVibesConfig['provider'];
  readonly behavior: GoodVibesConfig['behavior'];
  readonly storage: GoodVibesConfig['storage'];
  readonly permissions: GoodVibesConfig['permissions'];
  readonly helper: GoodVibesConfig['helper'];
  readonly tools: Pick<GoodVibesConfig['tools'], 'llmEnabled' | 'llmProvider' | 'llmModel'>;
  readonly danger: GoodVibesConfig['danger'];
  readonly controlPlane: GoodVibesConfig['controlPlane'];
  readonly httpListener: GoodVibesConfig['httpListener'];
  readonly web: GoodVibesConfig['web'];
  readonly network: GoodVibesConfig['network'];
  readonly surfaces: GoodVibesConfig['surfaces'];
  readonly service: GoodVibesConfig['service'];
  readonly featureFlags: GoodVibesConfig['featureFlags'];
  readonly batch: GoodVibesConfig['batch'];
  readonly cloudflare: GoodVibesConfig['cloudflare'];
}

export interface OnboardingProviderRoutingSnapshot {
  readonly primaryProviderId: string;
  readonly primaryModelId: string;
  readonly primaryReasoningEffort: GoodVibesConfig['provider']['reasoningEffort'];
  readonly embeddingProviderId: string;
  readonly systemPromptFile: string;
  readonly helperEnabled: boolean;
  readonly helperProviderId: string;
  readonly helperModelId: string;
  readonly toolLlmEnabled: boolean;
  readonly toolProviderId: string;
  readonly toolModelId: string;
}

export interface OnboardingServiceState {
  readonly name: string;
  readonly providerId: string;
  readonly baseUrl: string | null;
  readonly authType: 'bearer' | 'basic' | 'api-key' | 'oauth';
  readonly tokenKey: string;
  readonly oauthConfigured: boolean;
  readonly hasPrimaryCredential: boolean;
  readonly hasPasswordCredential: boolean;
  readonly hasWebhookUrl: boolean;
  readonly hasSigningSecret: boolean;
  readonly hasPublicKey: boolean;
  readonly hasAppToken: boolean;
}

export interface OnboardingServicesSnapshot {
  readonly total: number;
  readonly oauthProviderIds: readonly string[];
  readonly services: readonly OnboardingServiceState[];
}

export interface OnboardingSubscriptionsSnapshot {
  readonly active: ReturnType<SubscriptionAccessQuery['list']>;
  readonly pending: ReturnType<SubscriptionAccessQuery['listPending']>;
  readonly activeProviderIds: readonly string[];
  readonly pendingProviderIds: readonly string[];
}

export interface OnboardingSecretsSnapshot {
  readonly review: SecretStorageReview;
  readonly records: readonly SecretRecord[];
}

export interface OnboardingAuthSnapshot {
  readonly snapshot: LocalAuthSnapshot;
}

export interface OnboardingBindSettingsSnapshot {
  readonly daemonEnabled: boolean;
  readonly httpListenerEnabled: boolean;
  readonly controlPlane: GoodVibesConfig['controlPlane'];
  readonly httpListener: GoodVibesConfig['httpListener'];
  readonly web: GoodVibesConfig['web'];
}

export interface OnboardingSurfaceRecord {
  readonly id: string;
  readonly kind: string;
  readonly label: string;
  readonly enabled: boolean;
  readonly state: string;
  readonly capabilities: readonly string[];
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface OnboardingSurfacesSnapshot {
  readonly configuredEnabledKinds: readonly string[];
  readonly records: readonly OnboardingSurfaceRecord[];
}

export interface OnboardingProviderAccountRecord {
  readonly providerId: string;
  readonly configured: boolean;
  readonly active: boolean;
  readonly oauthReady: boolean;
  readonly pendingLogin: boolean;
  readonly availableRoutes: readonly string[];
  readonly activeRoute: string;
  readonly authFreshness: string;
}

export interface OnboardingProviderAccountsSnapshot {
  readonly capturedAt: number;
  readonly configuredCount: number;
  readonly issueCount: number;
  readonly providers: readonly OnboardingProviderAccountRecord[];
}

export interface OnboardingRuntimeDefaultsSnapshot {
  readonly providerReasoningEffort: GoodVibesConfig['provider']['reasoningEffort'];
  readonly permissionsMode: GoodVibesConfig['permissions']['mode'];
  readonly behavior: GoodVibesConfig['behavior'];
  readonly display: GoodVibesConfig['display'];
  readonly secretStoragePolicy: GoodVibesConfig['storage']['secretPolicy'];
}

export interface OnboardingAcknowledgementSnapshot {
  readonly scope: OnboardingStateScope;
  readonly exists: boolean;
  readonly updatedAt: number | null;
  readonly source: string | null;
  readonly mode?: OnboardingMode;
  readonly workspaceRoot?: string;
  readonly accepted: Partial<Record<OnboardingAcknowledgementTarget, boolean>>;
}

export type OnboardingSnapshotCollectionIssueArea =
  | 'services'
  | 'subscriptions-active'
  | 'subscriptions-pending'
  | 'auth'
  | 'secrets-review'
  | 'secrets-records'
  | 'surfaces'
  | 'provider-accounts'
  | 'acknowledgements';

export interface OnboardingSnapshotCollectionIssue {
  readonly area: OnboardingSnapshotCollectionIssueArea;
  readonly message: string;
}

export interface OnboardingSnapshotState {
  readonly capturedAt: number;
  readonly config: OnboardingConfigSnapshot;
  readonly providerRouting: OnboardingProviderRoutingSnapshot;
  readonly runtimeDefaults: OnboardingRuntimeDefaultsSnapshot;
  readonly acknowledgements: OnboardingAcknowledgementSnapshot;
  readonly services: OnboardingServicesSnapshot;
  readonly subscriptions: OnboardingSubscriptionsSnapshot;
  readonly secrets: OnboardingSecretsSnapshot;
  readonly auth: OnboardingAuthSnapshot;
  readonly bindSettings: OnboardingBindSettingsSnapshot;
  readonly surfaces: OnboardingSurfacesSnapshot;
  readonly providerAccounts: OnboardingProviderAccountsSnapshot | null;
  readonly collectionIssues: readonly OnboardingSnapshotCollectionIssue[];
}

export type OnboardingStep1CapabilityId =
  | 'local-tui-only'
  | 'browser-access'
  | 'network-access'
  | 'webhook-events'
  | 'external-integrations'
  | 'cloudflare-batch';

export interface OnboardingStep1CapabilityItem {
  readonly id: OnboardingStep1CapabilityId;
  readonly label: string;
  readonly selected: boolean;
  readonly detail: string;
}

export interface OnboardingStep1CapabilityFlags {
  readonly providers: boolean;
  readonly services: boolean;
  readonly subscriptions: boolean;
  readonly auth: boolean;
  readonly controlPlane: boolean;
  readonly httpListener: boolean;
  readonly web: boolean;
  readonly surfaces: boolean;
  readonly cloudflare: boolean;
}

export interface OnboardingAcknowledgementState {
  readonly required: boolean;
  readonly accepted: boolean;
  readonly reason: OnboardingAcknowledgementReason;
  readonly detail: string;
}

export interface OnboardingReopenEditAcknowledgementState {
  readonly providers: OnboardingAcknowledgementState;
  readonly subscriptions: OnboardingAcknowledgementState;
  readonly auth: OnboardingAcknowledgementState;
}

export interface OnboardingStepDerivationState {
  readonly step1Capabilities: readonly OnboardingStep1CapabilityItem[];
  readonly step1_5NetworkMode: OnboardingNetworkMode;
  readonly reopenEditAcknowledgements: OnboardingReopenEditAcknowledgementState;
}

export type OnboardingApplyOperation =
  | {
      readonly kind: 'set-config';
      readonly key: ConfigKey | FeatureFlagConfigKey;
      readonly value: unknown;
      readonly scope?: 'global' | 'project';
    }
  | {
      readonly kind: 'set-secret';
      readonly key: string;
      readonly value: string;
      readonly scope?: 'project' | 'user';
      readonly medium: 'secure' | 'plaintext';
    }
  | {
      readonly kind: 'ensure-auth-user';
      readonly username: string;
      readonly password: string;
      readonly roles?: readonly string[];
      readonly createSession?: boolean;
      readonly retireBootstrapCredential?: boolean;
    }
  | {
      readonly kind: 'acknowledge';
      readonly target: OnboardingAcknowledgementTarget;
      readonly acknowledged: boolean;
    };

export interface OnboardingApplyRequest {
  readonly mode: OnboardingMode;
  readonly source: string;
  readonly operations: readonly OnboardingApplyOperation[];
}

export interface OnboardingAppliedOperation {
  readonly kind: OnboardingApplyOperation['kind'];
  readonly summary: string;
}

export interface OnboardingSkippedOperation {
  readonly kind: OnboardingApplyOperation['kind'];
  readonly reason: string;
}

export interface OnboardingApplyError {
  readonly kind: OnboardingApplyOperation['kind'];
  readonly message: string;
}

export interface OnboardingApplyResult {
  readonly ok: boolean;
  readonly applied: readonly OnboardingAppliedOperation[];
  readonly skipped: readonly OnboardingSkippedOperation[];
  readonly errors: readonly OnboardingApplyError[];
}

export interface OnboardingVerificationItem {
  readonly id: string;
  readonly status: OnboardingVerificationStatus;
  readonly message: string;
  readonly target?: string;
}

export interface OnboardingVerificationResult {
  readonly verifiedAt: number;
  readonly ok: boolean;
  readonly items: readonly OnboardingVerificationItem[];
}

export interface OnboardingAcknowledgementRuntimeState {
  readonly version: 1;
  readonly updatedAt: number;
  readonly source: string;
  readonly mode?: OnboardingMode;
  readonly workspaceRoot?: string;
  readonly acknowledgements: Partial<Record<OnboardingAcknowledgementTarget, boolean>>;
}

export interface OnboardingCheckMarkerPayload {
  readonly version: 1;
  readonly checkedAt: number;
  readonly updatedAt: number;
  readonly source: OnboardingCheckMarkerSource;
  readonly mode?: OnboardingMode;
  readonly workspaceRoot?: string;
}

export interface OnboardingCheckMarkerState {
  readonly scope: OnboardingStateScope;
  readonly path: string;
  readonly exists: boolean;
  readonly payload: OnboardingCheckMarkerPayload | null;
  readonly parseError?: string;
}

export interface OnboardingCheckMarkersState {
  readonly user: OnboardingCheckMarkerState;
  readonly project: OnboardingCheckMarkerState;
  readonly effective: OnboardingCheckMarkerState | null;
}

export interface WizardProgressPayload {
  readonly version: 1;
  readonly savedAt: number;
  readonly mode: OnboardingMode;
  readonly stepIndex: number;
  /** Serialised Map<fieldId, boolean> entries */
  readonly toggleState: ReadonlyArray<readonly [string, boolean]>;
  /** Serialised Map<fieldId, string> entries */
  readonly radioState: ReadonlyArray<readonly [string, string]>;
  /** Serialised Map<fieldId, string> entries */
  readonly textState: ReadonlyArray<readonly [string, string]>;
}

export interface WizardProgressState {
  readonly path: string;
  readonly exists: boolean;
  readonly payload: WizardProgressPayload | null;
  readonly parseError?: string;
}

export interface WriteOnboardingCheckMarkerOptions {
  readonly scope?: OnboardingStateScope;
  readonly checkedAt?: number;
  readonly updatedAt?: number;
  readonly source?: OnboardingCheckMarkerSource;
  readonly mode?: OnboardingMode;
  readonly workspaceRoot?: string;
}

export interface OnboardingSurfaceReadHelper {
  list(): readonly OnboardingSurfaceRecord[] | Promise<readonly OnboardingSurfaceRecord[]>;
}

export interface OnboardingProviderAccountReadHelper {
  loadSnapshot(): Promise<OnboardingProviderAccountsSnapshot>;
}

export type OnboardingShellPaths = Pick<
  ShellPathService,
  'workingDirectory' | 'resolveProjectPath' | 'resolveUserPath'
>;

export interface OnboardingSnapshotDependencies {
  readonly clock?: () => number;
  readonly config: Pick<ConfigManager, 'get' | 'getCategory'>;
  readonly subscriptions: Pick<SubscriptionAccessQuery, 'list' | 'listPending' | 'get' | 'getPending'>;
  readonly secrets: Pick<SecretsManager, 'inspect' | 'listDetailed'>;
  readonly auth: Pick<LocalAuthInspectionQuery, 'inspect'>;
  readonly services: Pick<ServiceInspectionQuery, 'getAll' | 'inspect'>;
  readonly surfaces?: OnboardingSurfaceReadHelper;
  readonly providerAccounts?: OnboardingProviderAccountReadHelper;
  readonly shellPaths?: OnboardingShellPaths;
  readonly acknowledgementScope?: OnboardingStateScope;
}

export interface OnboardingApplyDependencies {
  readonly clock?: () => number;
  readonly config: Pick<ConfigManager, 'get' | 'getRaw' | 'load' | 'setDynamic'>;
  readonly secrets?: Pick<SecretsManager, 'delete' | 'get' | 'inspect' | 'set'>;
  readonly auth?: Pick<
    UserAuthManager,
    'addUser'
    | 'clearBootstrapCredentialFile'
    | 'createSession'
    | 'deleteUser'
    | 'getUser'
    | 'inspect'
    | 'revokeSession'
    | 'rotatePassword'
  >;
  readonly shellPaths: OnboardingShellPaths;
  readonly acknowledgementScope?: OnboardingStateScope;
}

export interface OnboardingVerificationDependencies {
  readonly clock?: () => number;
  readonly config: Pick<ConfigManager, 'get'>;
  readonly secrets?: Pick<SecretsManager, 'get'>;
  readonly auth?: Pick<UserAuthManager, 'inspect'>;
  readonly shellPaths: OnboardingShellPaths;
  readonly acknowledgementScope?: OnboardingStateScope;
}
