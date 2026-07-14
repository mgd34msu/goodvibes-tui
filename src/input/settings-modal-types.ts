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
  | 'service'
  | 'daemon'
  | 'controlPlane'
  | 'httpListener'
  | 'web'
  | 'network'
  | 'relay'
  | 'surfaces'
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
  | 'policy'
  | 'notifications'
  | 'release'
  | 'update'
  | 'power'
  | 'memory'
  | 'danger';

export type SettingsFocusPane = 'categories' | 'settings';

export const SETTINGS_CATEGORY_GROUPS: ReadonlyArray<{
  readonly label: string;
  readonly categories: readonly SettingsCategory[];
}> = [
  { label: 'Interface', categories: ['display', 'ui', 'behavior', 'notifications', 'permissions', 'policy', 'security'] },
  { label: 'AI Routing', categories: ['provider', 'pricing', 'subscriptions', 'helper', 'tools', 'tts'] },
  { label: 'Service & Network', categories: ['service', 'daemon', 'network', 'controlPlane', 'httpListener', 'web', 'relay'] },
  { label: 'Surfaces & Cloud', categories: ['surfaces', 'integrations', 'mcp', 'cloudflare'] },
  { label: 'Automation', categories: ['batch', 'automation', 'checkin', 'watchers', 'orchestration', 'planner', 'wrfc'] },
  { label: 'Runtime & Data', categories: ['storage', 'atRest', 'sandbox', 'fetch', 'agents', 'runtime', 'power', 'memory', 'cache', 'telemetry', 'diagnostics', 'learning'] },
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
