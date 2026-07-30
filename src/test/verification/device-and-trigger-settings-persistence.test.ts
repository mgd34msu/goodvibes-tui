/**
 * Behavior verification for the paired-device and trigger-family settings keys.
 *
 * SDK 1.14.0 added two new settings domains at once: `device.*` (11 keys beyond
 * the `device.capabilities.mode` enablement key) and `watchers.triggers.*` (18
 * keys beyond the `watchers.triggers.enabled` enablement key). Both grew the
 * settings inventory the verification ledger counts (`total`) without adding any
 * matching local behavior coverage, which pushed `localBehaviorPercent` below
 * its floor.
 *
 * These tests supply that coverage HONESTLY, to exactly the standard the ledger
 * already uses for a settings key (see feature-knob-settings-persistence.test.ts):
 * for every key in DEVICE_AND_TRIGGER_LOCAL_SETTINGS they exercise the real
 * persistence contract end to end — schema default exposure, `set()` write
 * through the validator to disk, reload into a fresh ConfigManager, read-back
 * equality, and reset-to-default — through the actual ConfigManager, not a mock.
 *
 * What this file covers is persistence and nothing else: that each key is
 * exposed at its schema default, survives `set()` through its own validator to
 * disk, reloads equal, and resets. It deliberately does NOT assert that a key
 * changes what the app does — a test like that belongs where the consuming code
 * is. For the `device.*` keys that is
 * `src/test/verification/device-posture-behavior.test.ts`, which drives this
 * app's composed device posture runtime per key at two values; the per-key
 * evidence list beside DEVICE_AND_TRIGGER_LOCAL_SETTINGS in
 * verification-ledger.ts records which coverage each key has.
 *
 * The `voice.wake.*` keys added in the same release are deliberately NOT covered
 * or counted here. That is now a scope statement, not a capability one: those rows
 * DO drive behaviour on this terminal (see src/test/audio/wake-capture.test.ts for
 * the frame path, the detection chain, the disabled-means-no-capture rule and the
 * supervisor), and their persistence round-trip is simply not what this file
 * exercises. Counting them in both places would double-count; see the note beside
 * DEVICE_AND_TRIGGER_LOCAL_SETTINGS in verification-ledger.ts.
 */
import { describe, test, expect, beforeEach } from 'bun:test';
import { join } from 'node:path';
import { ConfigManager, CONFIG_SCHEMA } from '../../config/index.ts';
import type { ConfigKey } from '../../config/index.ts';
import { FEATURE_SETTINGS } from '@pellux/goodvibes-sdk/platform/runtime/state';
import {
  DEVICE_AND_TRIGGER_LOCAL_SETTINGS,
  FEATURE_KNOB_LOCAL_SETTINGS,
} from '../../verification/verification-ledger.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

/**
 * A valid alternate value (distinct from the schema default) for each key,
 * chosen to satisfy that key's validator: enum keys pick a different allowed
 * member, numbers move to another in-range integer, the backoff ladder stays a
 * comma-separated list of in-range millisecond integers.
 */
const ALTERNATE_VALUE: Record<string, unknown> = {
  // device.* — paired-phone posture
  'device.capabilities.allowAlwaysOffer': 'standard-only',
  'device.capabilities.requestTimeoutSeconds': 120,
  'device.location.precision': 'ask-precise',
  'device.clipboard.readMode': 'ask-only',
  'device.capture.retentionHours': 72,
  'device.capture.maxArtifacts': 500,
  'device.capture.sweepIntervalMinutes': 60,
  'device.grants.expiryDays': 30,
  'device.grants.maxPerNode': 16,
  'device.grants.auditRetentionDays': 90,
  'device.nodes.maxPaired': 4,
  // watchers.triggers.* — trigger family supervision
  'watchers.triggers.backoffLadderMs': '10000,60000,600000',
  'watchers.triggers.breakerStrikes': 3,
  'watchers.triggers.defaultCheckIntervalMs': 30000,
  'watchers.triggers.probeTimeoutMs': 5000,
  'watchers.triggers.maxConcurrentChecks': 8,
  'watchers.triggers.observationRingSize': 500,
  'watchers.triggers.runHistoryLimit': 100,
  'watchers.triggers.runHistoryTtlHours': 72,
  'watchers.triggers.eventLogLimit': 1000,
  'watchers.triggers.eventLogTtlHours': 48,
  'watchers.triggers.sweepIntervalMs': 600000,
  'watchers.triggers.supervisionTickMs': 2000,
  'watchers.triggers.streamQueueLimit': 500,
  'watchers.triggers.streamBatchLines': 50,
  'watchers.triggers.streamBatchIntervalMs': 2000,
  'watchers.triggers.onExitMaxDurationMs': 3600000,
  'watchers.triggers.onExitStdin': 'empty',
  'watchers.triggers.outputTailBytes': 16384,
};

const schemaByKey = new Map(CONFIG_SCHEMA.map((s) => [s.key, s]));

function freshManager(): { manager: ConfigManager; root: string; configDir: string } {
  const root = makeProjectTempDir('goodvibes-device-trigger');
  const configDir = join(root, '.config-override');
  const manager = new ConfigManager({ surfaceRoot: 'tui', workingDir: root, configDir });
  return { manager, root, configDir };
}

describe('device/trigger settings — inventory integrity', () => {
  test('every ledger-counted key exists in CONFIG_SCHEMA with a defined default', () => {
    for (const key of DEVICE_AND_TRIGGER_LOCAL_SETTINGS) {
      const schema = schemaByKey.get(key);
      expect(schema, `${key} must be a live CONFIG_SCHEMA key`).toBeDefined();
      expect(schema!.default, `${key} must declare a default`).toBeDefined();
    }
  });

  test('the ledger counts each key exactly once — no overlap with the other counted sets', () => {
    // Double-counting a key would inflate localBehaviorPercent without anyone
    // writing a line of coverage, which is the failure mode the ledger exists
    // to prevent.
    expect(new Set(DEVICE_AND_TRIGGER_LOCAL_SETTINGS).size).toBe(DEVICE_AND_TRIGGER_LOCAL_SETTINGS.length);

    const knobs = new Set<string>(FEATURE_KNOB_LOCAL_SETTINGS);
    const enablementKeys = new Set(FEATURE_SETTINGS.map((feature) => feature.enablement.key));
    for (const key of DEVICE_AND_TRIGGER_LOCAL_SETTINGS) {
      expect(knobs.has(key), `${key} is already counted as a feature-knob key`).toBe(false);
      expect(enablementKeys.has(key), `${key} is already counted as an enablement key`).toBe(false);
    }
  });

  test('the list covers every non-enablement key of both new domains', () => {
    const enablementKeys = new Set(FEATURE_SETTINGS.map((feature) => feature.enablement.key));
    const expected = CONFIG_SCHEMA
      .map((setting) => setting.key)
      .filter((key) => key.startsWith('device.') || key.startsWith('watchers.triggers.'))
      .filter((key) => !enablementKeys.has(key));
    expect([...DEVICE_AND_TRIGGER_LOCAL_SETTINGS].sort() as string[]).toEqual((expected as string[]).sort());
  });

  test('an alternate test value is defined for every key and genuinely differs from the default', () => {
    for (const key of DEVICE_AND_TRIGGER_LOCAL_SETTINGS) {
      expect(ALTERNATE_VALUE[key], `${key} needs an alternate value`).toBeDefined();
      expect(ALTERNATE_VALUE[key]).not.toEqual(schemaByKey.get(key)!.default);
    }
  });
});

describe('device/trigger settings — default exposure', () => {
  let manager: ConfigManager;

  beforeEach(() => {
    manager = freshManager().manager;
  });

  test('a fresh ConfigManager returns each key at its schema default', () => {
    for (const key of DEVICE_AND_TRIGGER_LOCAL_SETTINGS) {
      const expected = schemaByKey.get(key)!.default;
      expect(manager.get(key as ConfigKey), `${key} default`).toEqual(expected as never);
    }
  });
});

describe('device/trigger settings — write/reload persistence round-trip', () => {
  test('each key persists to disk and reloads into a fresh ConfigManager', () => {
    const { manager, root, configDir } = freshManager();

    for (const key of DEVICE_AND_TRIGGER_LOCAL_SETTINGS) {
      manager.set(key as ConfigKey, ALTERNATE_VALUE[key] as never);
      expect(manager.get(key as ConfigKey), `${key} in-memory after set`).toEqual(
        ALTERNATE_VALUE[key] as never,
      );
    }

    const reloaded = new ConfigManager({ surfaceRoot: 'tui', workingDir: root, configDir });
    reloaded.load();
    for (const key of DEVICE_AND_TRIGGER_LOCAL_SETTINGS) {
      expect(reloaded.get(key as ConfigKey), `${key} after reload`).toEqual(
        ALTERNATE_VALUE[key] as never,
      );
    }
  });

  test('an out-of-range value is rejected by the key\'s own validator', () => {
    const { manager } = freshManager();
    // Range enforcement is part of the persistence contract being counted:
    // a key that accepted anything would not be verified by a round-trip.
    expect(() => manager.set('device.nodes.maxPaired' as ConfigKey, 0 as never)).toThrow();
    expect(() => manager.set('watchers.triggers.breakerStrikes' as ConfigKey, 999 as never)).toThrow();
    expect(() => manager.set('device.clipboard.readMode' as ConfigKey, 'sometimes' as never)).toThrow();
  });
});

describe('device/trigger settings — reset restores default', () => {
  test('reset returns each key to its schema default and persists that', () => {
    const { manager, root, configDir } = freshManager();

    for (const key of DEVICE_AND_TRIGGER_LOCAL_SETTINGS) {
      manager.set(key as ConfigKey, ALTERNATE_VALUE[key] as never);
      manager.reset(key as ConfigKey);
      const expected = schemaByKey.get(key)!.default;
      expect(manager.get(key as ConfigKey), `${key} after reset`).toEqual(expected as never);
    }

    const reloaded = new ConfigManager({ surfaceRoot: 'tui', workingDir: root, configDir });
    reloaded.load();
    for (const key of DEVICE_AND_TRIGGER_LOCAL_SETTINGS) {
      const expected = schemaByKey.get(key)!.default;
      expect(reloaded.get(key as ConfigKey), `${key} default after reload`).toEqual(
        expected as never,
      );
    }
  });
});
