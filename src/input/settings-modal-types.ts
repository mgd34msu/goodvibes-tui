import type { ConfigSetting } from '@pellux/goodvibes-sdk/platform/config/schema';
import type { ProviderAuthFreshness, ProviderAuthRoute } from '@pellux/goodvibes-sdk/platform/runtime/provider-accounts/registry';
import type { FeatureFlag, FlagState } from '@pellux/goodvibes-sdk/platform/runtime/feature-flags/types';

export type SettingsCategory =
  | 'display'
  | 'ui'
  | 'provider'
  | 'subscriptions'
  | 'behavior'
  | 'storage'
  | 'permissions'
  | 'orchestration'
  | 'wrfc'
  | 'tools'
  | 'helper'
  | 'tts'
  | 'service'
  | 'controlPlane'
  | 'httpListener'
  | 'web'
  | 'network'
  | 'surfaces'
  | 'cloudflare'
  | 'batch'
  | 'automation'
  | 'watchers'
  | 'runtime'
  | 'telemetry'
  | 'cache'
  | 'sandbox'
  | 'mcp'
  | 'flags'
  | 'release'
  | 'danger';

export type SettingsFocusPane = 'categories' | 'settings';

export const SETTINGS_CATEGORIES: SettingsCategory[] = [
  'display',
  'ui',
  'provider',
  'subscriptions',
  'behavior',
  'storage',
  'permissions',
  'orchestration',
  'wrfc',
  'tools',
  'helper',
  'tts',
  'service',
  'controlPlane',
  'httpListener',
  'web',
  'network',
  'mcp',
  'sandbox',
  'surfaces',
  'cloudflare',
  'batch',
  'automation',
  'watchers',
  'runtime',
  'telemetry',
  'cache',
  'danger',
  'flags',
  'release',
];

export interface SettingEntry {
  setting: ConfigSetting;
  currentValue: unknown;
  isDefault: boolean;
  effectiveSource?: 'default' | 'local' | 'synced' | 'managed';
  locked?: boolean;
  conflict?: boolean;
  sourceLabel?: string;
  lockReason?: string;
}

export interface FlagEntry {
  flag: FeatureFlag;
  state: FlagState;
}

export interface McpEntry {
  name: string;
  connected: boolean;
  role: 'general' | 'docs' | 'filesystem' | 'git' | 'database' | 'browser' | 'automation' | 'ops' | 'remote';
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
