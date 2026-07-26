/**
 * feature-settings — TUI-side helpers over the SDK's FEATURE_SETTINGS surface.
 *
 * Every platform capability is configured through a first-class settings key
 * in its natural domain (behavior.compactionStrategy, sandbox.enabled,
 * surfaces.slack.enabled, ...). There is no separate enablement namespace.
 * These helpers answer the recurring TUI questions:
 *   - which feature a given id names, and whether a stock config has it on,
 *   - whether a raw config value means the feature is currently on,
 *   - which single settings write turns a feature on or off.
 *
 * Enablement kinds (from the SDK binding layer):
 *   - boolean : the key's boolean value is the enablement.
 *   - enum    : active while the key's value is in enabledValues (several
 *               features can share one key, e.g. behavior.compactionStrategy).
 *   - constant: the capability has no separate off switch. When its key is a
 *               boolean (the surface enabled keys) that value is the honest
 *               user-facing switch; a non-boolean constant key (e.g.
 *               fetch.sanitizeMode) has no off position at all.
 */

import { CONFIG_SCHEMA, type ConfigKey, type ConfigManager, type ConfigSetting } from '@pellux/goodvibes-sdk/platform/config';
import {
  FEATURE_SETTINGS,
  deriveFeatureState,
  type FeatureSetting,
} from '@pellux/goodvibes-sdk/platform/runtime/state';

export type { FeatureSetting } from '@pellux/goodvibes-sdk/platform/runtime/state';

// ---------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------

/** Every capability by id, in SDK declaration order. */
export const FEATURE_SETTINGS_BY_ID: ReadonlyMap<string, FeatureSetting> = new Map(
  FEATURE_SETTINGS.map((feature) => [feature.id, feature]),
);

const SCHEMA_BY_KEY: ReadonlyMap<string, ConfigSetting> = new Map(
  CONFIG_SCHEMA.map((setting) => [setting.key, setting]),
);

export function getFeatureSetting(featureId: string): FeatureSetting | null {
  return FEATURE_SETTINGS_BY_ID.get(featureId) ?? null;
}

/** The CONFIG_SCHEMA descriptor for a settings key, or null for TUI-local synthetics. */
export function getConfigSchemaSetting(key: string): ConfigSetting | null {
  return SCHEMA_BY_KEY.get(key) ?? null;
}

/** Whether a stock configuration has the feature active. */
export function isFeatureDefaultEnabled(featureId: string): boolean {
  return getFeatureSetting(featureId)?.defaultEnabled === true;
}

/** All features whose enablement key is `key` (several features can share one). */
export function featuresForEnablementKey(key: string): readonly FeatureSetting[] {
  return FEATURE_SETTINGS.filter((feature) => feature.enablement.key === key);
}

// ---------------------------------------------------------------------------
// Enablement derivation
// ---------------------------------------------------------------------------

/**
 * Whether a raw config value means the feature is on, as a settings surface
 * should display it. Boolean/enum kinds derive exactly as the runtime gate
 * does; constant kinds fall back to the boolean key value when there is one
 * (the honest user-facing switch for the surface adapters) and read as always
 * on otherwise.
 */
export function isFeatureValueEnabled(feature: FeatureSetting, value: unknown): boolean {
  const { key, kind, enabledValues } = feature.enablement;
  // A capability declared not operable in this build never reads as on, whatever
  // its settings key says. deriveFeatureState already enforces this for the
  // boolean and enum kinds; stating it once here covers the constant kind too,
  // so no surface can show "on" for something that is doing nothing. The user's
  // value is untouched — it is kept for the release that wires the capability up
  // — and `feature.inoperableDetail` is the written reason a surface renders.
  if (feature.operable === false) return false;
  if (kind === 'constant') {
    const schema = getConfigSchemaSetting(key);
    if (schema?.type === 'boolean') return value === true;
    return true;
  }
  return deriveFeatureState(
    {
      featureId: feature.id,
      key,
      kind,
      ...(enabledValues !== undefined ? { enabledValues } : {}),
    },
    value,
  ) === 'enabled';
}

/** Whether the live config currently has the feature on (see isFeatureValueEnabled). */
export function isFeatureConfigEnabled(
  configManager: Pick<ConfigManager, 'get'>,
  featureId: string,
): boolean {
  const feature = getFeatureSetting(featureId);
  if (!feature) return false;
  return isFeatureValueEnabled(feature, configManager.get(feature.enablement.key));
}

// ---------------------------------------------------------------------------
// Enablement writes
// ---------------------------------------------------------------------------

export interface FeatureEnablementWrite {
  readonly key: ConfigKey;
  readonly value: boolean | string;
}

/**
 * The single settings write that turns a feature on or off, or null when the
 * feature has no off position (a constant-kind capability on a non-boolean
 * key). For enum kinds the schema default is preferred whenever it sits on
 * the requested side, so "enable" lands on the feature's stock mode and
 * "disable" lands on the stock off mode rather than an arbitrary value.
 */
export function featureEnablementWrite(
  featureId: string,
  enabled: boolean,
): FeatureEnablementWrite | null {
  const feature = getFeatureSetting(featureId);
  if (!feature) return null;
  const { key, kind, enabledValues } = feature.enablement;

  if (kind === 'boolean') return { key, value: enabled };

  const schema = getConfigSchemaSetting(key);
  if (kind === 'constant') {
    return schema?.type === 'boolean' ? { key, value: enabled } : null;
  }

  // enum
  const active = enabledValues ?? [];
  const allValues = schema?.enumValues ?? [];
  const schemaDefault = typeof schema?.default === 'string' ? schema.default : undefined;
  if (enabled) {
    const target = schemaDefault !== undefined && active.includes(schemaDefault)
      ? schemaDefault
      : active[0];
    return target !== undefined ? { key, value: target } : null;
  }
  const offTarget = schemaDefault !== undefined && !active.includes(schemaDefault)
    ? schemaDefault
    : allValues.find((value) => !active.includes(value));
  return offTarget !== undefined ? { key, value: offTarget } : null;
}
