import type { ConfigSetting } from '@pellux/goodvibes-sdk/platform/config';
import type { ProviderAuthFreshness, ProviderAuthRoute } from '@/runtime/index.ts';
import type { FeatureFlag, FeatureSetting, FlagState } from '@/runtime/index.ts';

export type SettingsCategory =
  | 'display'
  | 'ui'
  | 'provider'
  | 'pricing'
  | 'subscriptions'
  | 'behavior'
  | 'storage'
  | 'atRest'
  | 'permissions'
  | 'orchestration'
  | 'planner'
  | 'wrfc'
  | 'tools'
  | 'helper'
  | 'tts'
  | 'voice'
  | 'service'
  | 'daemon'
  | 'controlPlane'
  | 'httpListener'
  | 'web'
  | 'network'
  | 'relay'
  | 'surfaces'
  | 'device'
  | 'conversationGate'
  | 'cloudflare'
  | 'batch'
  | 'automation'
  | 'checkin'
  | 'watchers'
  | 'runtime'
  | 'telemetry'
  | 'cache'
  | 'diagnostics'
  | 'sandbox'
  | 'mcp'
  | 'learning'
  | 'fetch'
  | 'agents'
  | 'security'
  | 'integrations'
  | 'connections'
  | 'policy'
  | 'notifications'
  | 'release'
  | 'update'
  | 'power'
  | 'memory'
  // payments.* — the card on file for daemon-initiated purchases. Like
  // 'profile' below, this entry and its SETTINGS_CATEGORY_GROUPS membership are
  // both mandatory or the whole prefix is dropped from the workspace.
  | 'payments'
  // profile.* — the owner profile (docs/owner-profile.md §12.1). This entry and
  // its SETTINGS_CATEGORY_GROUPS membership below are both mandatory:
  // buildSettingGroups guards every push with `if (groups.has(cat))`, so a
  // config prefix with no category here is dropped from the workspace entirely
  // and reachable only by hand-editing a settings file — see the push.* and
  // cluster.* comments in settings-modal-data.ts for the two times that happened.
  | 'profile'
  // occasions.* — the proactive occasions/plans loop (docs/occasions.md §8):
  // lead time, active hours, nudge channel and cadence, away-date adjustment,
  // calendar mirroring, interview length, gift-history retention, and the
  // sweep interval. Same mandatory-dual-membership rule as profile above, or
  // all twelve keys are dropped from the workspace and reachable only by
  // hand-editing a settings file — a third occurrence of the push.*/cluster.*
  // class the profile comment already names two of.
  | 'occasions'
  | 'danger';

export type SettingsFocusPane = 'categories' | 'settings';

export const SETTINGS_CATEGORY_GROUPS: ReadonlyArray<{
  readonly label: string;
  readonly categories: readonly SettingsCategory[];
}> = [
  { label: 'Interface', categories: ['display', 'ui', 'behavior', 'notifications', 'permissions', 'policy', 'security'] },
  { label: 'AI Routing', categories: ['provider', 'pricing', 'subscriptions', 'helper', 'tools', 'tts', 'voice'] },
  { label: 'Service & Network', categories: ['service', 'daemon', 'network', 'controlPlane', 'httpListener', 'web', 'relay'] },
  { label: 'Surfaces & Cloud', categories: ['surfaces', 'device', 'conversationGate', 'integrations', 'connections', 'mcp', 'cloudflare'] },
  // 'occasions' sits beside 'checkin': both are proactive background loops
  // (a cadence, a judgment pass, a conditional channel delivery) rather than
  // facts held about the owner — the data occasions/plans declare lives in
  // the owner profile file itself (docs/occasions.md §3), but these SETTINGS
  // rows tune the loop, exactly like checkin's.
  { label: 'Automation', categories: ['batch', 'automation', 'checkin', 'occasions', 'watchers', 'orchestration', 'planner', 'wrfc', 'payments'] },
  // 'profile' sits beside 'memory' and 'learning': all three are what the
  // platform retains about the person using it, and this is the group a reader
  // looking for "what does it know about me" already scans — Interface is
  // presentation and permission posture, and nothing there is a store of facts.
  { label: 'Runtime & Data', categories: ['storage', 'atRest', 'sandbox', 'fetch', 'agents', 'runtime', 'power', 'profile', 'memory', 'cache', 'telemetry', 'diagnostics', 'learning'] },
  { label: 'Advanced', categories: ['release', 'update', 'danger'] },
];

export const SETTINGS_CATEGORIES: SettingsCategory[] = SETTINGS_CATEGORY_GROUPS.flatMap(group => group.categories);

export interface SettingEntry {
  setting: ConfigSetting;
  currentValue: unknown;
  isDefault: boolean;
  effectiveSource?: 'default' | 'local' | 'synced' | 'managed';
  locked?: boolean;
  conflict?: boolean;
  sourceLabel?: string;
  lockReason?: string;
  /**
   * Present when this row is a feature-unit header (a platform capability
   * rendered as one unit with the settings that tune it beneath). The row IS
   * the real config row for the feature's enablement key — boolean headers
   * toggle and enum headers cycle their mode choices through the ordinary
   * settings write path (a plain config write; the settings bridge keeps the
   * runtime gate in sync).
   */
  flag?: FlagEntry;
  /**
   * Present when this row is a settings sub-option OWNED by a feature unit —
   * the id of the owning feature. Drives the indented rendering beneath its
   * header and marks the row as claimed so it does not double-list as an
   * orphan.
   */
  ownerFlagId?: string;
}

export interface FlagEntry {
  /** The per-feature settings metadata (domain, enablement shape, settings keys, real description). */
  feature: FeatureSetting;
  /** The internal gate declaration (kill state/reason live here). */
  flag: FeatureFlag;
  /** Live effective state as the runtime currently sees it. */
  state: FlagState;
  /**
   * Last known config-layer (persisted) value. Equals `state` unless a
   * startup-gated feature was changed this session — then it holds the value
   * that will take effect on the next launch.
   */
  persistedState: FlagState;
  /**
   * True when a startup-gated feature's persisted value differs from its
   * effective state, i.e. a restart is required before the change takes
   * effect. Sourced from FeatureFlagManager.getAll(), never guessed.
   */
  pendingRestart: boolean;
}

export interface McpEntry {
  name: string;
  connected: boolean;
  role: string;
  trustMode: 'constrained' | 'ask-on-risk' | 'allow-all' | 'blocked';
  allowedPaths: string[];
  allowedHosts: string[];
}

export interface SubscriptionEntry {
  provider: string;
  state: 'active' | 'pending' | 'available';
  tokenType?: string;
  expiresAt?: number;
  oauthConfigured: boolean;
  activeRoute?: ProviderAuthRoute;
  preferredRoute?: ProviderAuthRoute;
  authFreshness?: ProviderAuthFreshness;
  routeReason?: string;
  issues?: string[];
  nextActions?: string[];
}
