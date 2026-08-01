/**
 * Behavior verification for the flag-gated feature-knob settings.
 *
 * SDK commit f5c4af31 promoted 28 previously constructor/tool-call/command-only
 * knobs into live CONFIG_SCHEMA keys. That grew the settings inventory the
 * verification ledger counts (`total`) without adding matching local behavior
 * coverage, which pushed `localBehaviorPercent` below its floor.
 *
 * These tests supply that missing coverage: for every key in
 * FEATURE_KNOB_LOCAL_SETTINGS they exercise the real persistence behavior end to
 * end — schema default, `set()` write to disk, reload into a fresh
 * ConfigManager, read-back equality, and reset-to-default — through the actual
 * ConfigManager, not a mock. Passing here is what makes counting these keys as
 * behavior-verified in the ledger honest.
 */
import { describe, test, expect, beforeEach } from 'bun:test';
import { join } from 'node:path';
import { ConfigManager, CONFIG_SCHEMA } from '@pellux/goodvibes-sdk/platform/config';
import type { ConfigKey } from '@pellux/goodvibes-sdk/platform/config';
import { FEATURE_KNOB_LOCAL_SETTINGS } from '../../verification/verification-ledger.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

/**
 * A valid alternate value (distinct from the schema default) for each knob,
 * chosen to satisfy the key's validator. Enum keys pick a different allowed
 * member; numbers move to another in-range value; booleans flip; strings take a
 * concrete non-empty value.
 */
const ALTERNATE_VALUE: Record<string, unknown> = {
  'provider.optimizerMode': 'auto',
  'provider.optimizerPinnedModel': 'anthropic:claude-3-5-sonnet',
  'permissions.divergenceThreshold': 0.1,
  'permissions.maxDivergenceRecords': 1000,
  'tools.overflowSpillBackend': 'ledger',
  'notifications.burstWindowMs': 2000,
  'notifications.burstThreshold': 5,
  'notifications.burstCooldownMs': 5000,
  'fetch.sanitizeMode': 'strict',
  'fetch.trustedHosts': 'example.com',
  'fetch.blockedHosts': 'bad.example',
  'security.tokenAudit.rotationCadenceDays': 180,
  'security.tokenAudit.rotationWarningDays': 30,
  'security.tokenAudit.managed': true,
  'integrations.delivery.maxRetries': 5,
  'integrations.delivery.initialDelayMs': 2000,
  'integrations.delivery.maxDelayMs': 60000,
  'integrations.delivery.maxDlqSize': 1000,
  'integrations.delivery.sloEnforced': false, // default flipped to true with the enabled-by-default delivery SLO
  'policy.bundleSource': 'file',
  'policy.bundlePath': '/tmp/policy.bundle',
  'agents.passiveInjection.budgetTokens': 1200,
  'agents.passiveInjection.relevanceFloor': 90,
  'agents.passiveInjection.codeLimit': 5,
  'agents.contextCompactThreshold': 0.75,
  'runtime.toolBudget.maxMs': 60000,
  'runtime.toolBudget.maxTokens': 100000,
  'runtime.toolBudget.maxCostUsd': 5,
};

const schemaByKey = new Map(CONFIG_SCHEMA.map((s) => [s.key, s]));

function freshManager(): { manager: ConfigManager; root: string; configDir: string } {
  const root = makeProjectTempDir('goodvibes-feature-knob');
  const configDir = join(root, '.config-override');
  const manager = new ConfigManager({ surfaceRoot: 'tui', workingDir: root, configDir });
  return { manager, root, configDir };
}

describe('feature-knob settings — inventory integrity', () => {
  test('every ledger-counted feature-knob key exists in CONFIG_SCHEMA with a defined default', () => {
    for (const key of FEATURE_KNOB_LOCAL_SETTINGS) {
      const schema = schemaByKey.get(key);
      expect(schema, `${key} must be a live CONFIG_SCHEMA key`).toBeDefined();
      expect(schema!.default, `${key} must declare a default`).toBeDefined();
    }
  });

  test('an alternate test value is defined for every key', () => {
    for (const key of FEATURE_KNOB_LOCAL_SETTINGS) {
      expect(ALTERNATE_VALUE[key], `${key} needs an alternate value`).toBeDefined();
      // The alternate must genuinely differ from the default, or the round-trip
      // proves nothing.
      expect(ALTERNATE_VALUE[key]).not.toEqual(schemaByKey.get(key)!.default);
    }
  });
});

describe('feature-knob settings — default exposure', () => {
  let manager: ConfigManager;

  beforeEach(() => {
    manager = freshManager().manager;
  });

  test('a fresh ConfigManager returns each key at its schema default', () => {
    for (const key of FEATURE_KNOB_LOCAL_SETTINGS) {
      const expected = schemaByKey.get(key)!.default;
      expect(manager.get(key as ConfigKey), `${key} default`).toEqual(expected as never);
    }
  });
});

describe('feature-knob settings — write/reload persistence round-trip', () => {
  test('each key persists to disk and reloads into a fresh ConfigManager', () => {
    const { manager, root, configDir } = freshManager();

    // Write every alternate value through the real set() path (validates +
    // saves to disk).
    for (const key of FEATURE_KNOB_LOCAL_SETTINGS) {
      manager.set(key as ConfigKey, ALTERNATE_VALUE[key] as never);
      expect(manager.get(key as ConfigKey), `${key} in-memory after set`).toEqual(
        ALTERNATE_VALUE[key] as never,
      );
    }

    // A brand-new manager over the same on-disk config must read every value
    // back — proving the write actually reached durable storage.
    const reloaded = new ConfigManager({ surfaceRoot: 'tui', workingDir: root, configDir });
    reloaded.load();
    for (const key of FEATURE_KNOB_LOCAL_SETTINGS) {
      expect(reloaded.get(key as ConfigKey), `${key} after reload`).toEqual(
        ALTERNATE_VALUE[key] as never,
      );
    }
  });
});

describe('feature-knob settings — reset restores default', () => {
  test('reset returns each key to its schema default and persists that', () => {
    const { manager, root, configDir } = freshManager();

    for (const key of FEATURE_KNOB_LOCAL_SETTINGS) {
      manager.set(key as ConfigKey, ALTERNATE_VALUE[key] as never);
      manager.reset(key as ConfigKey);
      const expected = schemaByKey.get(key)!.default;
      expect(manager.get(key as ConfigKey), `${key} after reset`).toEqual(expected as never);
    }

    const reloaded = new ConfigManager({ surfaceRoot: 'tui', workingDir: root, configDir });
    reloaded.load();
    for (const key of FEATURE_KNOB_LOCAL_SETTINGS) {
      const expected = schemaByKey.get(key)!.default;
      expect(reloaded.get(key as ConfigKey), `${key} default after reload`).toEqual(
        expected as never,
      );
    }
  });
});
