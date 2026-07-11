import type { ConfigSetting } from '@pellux/goodvibes-sdk/platform/config';
import type { ProviderAuthFreshness, ProviderAuthRoute } from '@/runtime/index.ts';
import type { FeatureFlag, FlagState } from '@/runtime/index.ts';

export type SettingsCategory =
  | 'display'
  | 'ui'
  | 'provider'
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
  | 'flags'
  | 'release'
  | 'danger';

export type SettingsFocusPane = 'categories' | 'settings';

export const SETTINGS_CATEGORY_GROUPS: ReadonlyArray<{
  readonly label: string;
  readonly categories: readonly SettingsCategory[];
}> = [
  { label: 'Interface', categories: ['display', 'ui', 'behavior', 'notifications', 'permissions', 'policy', 'security'] },
  { label: 'AI Routing', categories: ['provider', 'subscriptions', 'helper', 'tools', 'tts'] },
  { label: 'Service & Network', categories: ['service', 'daemon', 'network', 'controlPlane', 'httpListener', 'web', 'relay'] },
  { label: 'Surfaces & Cloud', categories: ['surfaces', 'integrations', 'mcp', 'cloudflare'] },
  { label: 'Automation', categories: ['batch', 'automation', 'checkin', 'watchers', 'orchestration', 'planner', 'wrfc'] },
  { label: 'Runtime & Data', categories: ['storage', 'atRest', 'sandbox', 'fetch', 'agents', 'runtime', 'cache', 'telemetry', 'diagnostics', 'learning'] },
  { label: 'Advanced', categories: ['flags', 'release', 'danger'] },
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
   * Present when this row is a feature-unit toggle header (a feature flag
   * rendered as one unit with its config keys beneath it). The row's
   * setting.key is `featureFlags.<id>` and setting.type is 'boolean'; toggling
   * routes to the feature-flag manager, not a plain config write.
   */
  flag?: FlagEntry;
  /**
   * Present when this row is a config sub-option OWNED by a feature unit — the
   * id of the owning flag. Drives the indented rendering beneath its header and
   * marks the row as claimed so it does not double-list as an orphan.
   */
  ownerFlagId?: string;
}

export interface FlagEntry {
  flag: FeatureFlag;
  state: FlagState;
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
