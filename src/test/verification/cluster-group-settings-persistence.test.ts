/**
 * Behavior verification for the LAN group settings keys.
 *
 * The group-key layer added four `cluster.*` settings — the automatic group-key
 * rotation interval, the dual-generation acceptance window around a rotation,
 * the discovery beacon interval and the roster gossip interval. Like every
 * previous batch of new schema keys, they grew the settings inventory the
 * verification ledger counts (`total`) with no matching behavior coverage,
 * pushing `localBehaviorPercent` below its floor.
 *
 * This supplies that coverage HONESTLY, to exactly the standard the ledger
 * already uses for a settings key (see feature-knob-settings-persistence.test.ts
 * and device-and-trigger-settings-persistence.test.ts): for every key in
 * CLUSTER_GROUP_LOCAL_SETTINGS it exercises the real persistence contract end to
 * end — schema default exposure, `set()` write through the key's own validator
 * to disk, reload into a fresh ConfigManager with read-back equality, and
 * reset-to-default that also survives reload — through the actual
 * ConfigManager, not a mock.
 *
 * All four keys have a LIVE consumer in this build, which is more than
 * persistence alone: `resolveClusterGroupSettings` reads them, the rotation
 * interval and grace window drive `rotateIfDue` and the keyring's accepted
 * generations, and the beacon and gossip intervals drive the runtime's timers.
 * Those behaviors are verified separately in the SDK's cluster-group tests; what
 * is verified HERE, and what is counted in the ledger, is persistence.
 *
 * `cluster.enabled` is deliberately not counted here: it is a feature enablement
 * key and the ledger already counts those in its own set.
 */
import { describe, test, expect, beforeEach } from 'bun:test';
import { join } from 'node:path';
import { ConfigManager, CONFIG_SCHEMA } from '@pellux/goodvibes-sdk/platform/config';
import type { ConfigKey } from '@pellux/goodvibes-sdk/platform/config';
import { FEATURE_SETTINGS } from '@pellux/goodvibes-sdk/platform/runtime/state';
import {
  CLUSTER_GROUP_LOCAL_SETTINGS,
  DEVICE_AND_TRIGGER_LOCAL_SETTINGS,
  FEATURE_KNOB_LOCAL_SETTINGS,
} from '../../verification/verification-ledger.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

/** A valid alternate value, distinct from the default and inside each validator's range. */
const ALTERNATE_VALUE: Record<string, unknown> = {
  'cluster.keyRotationHours': 12,
  'cluster.keyRotationGraceMinutes': 10,
  'cluster.beaconSeconds': 30,
  'cluster.rosterGossipSeconds': 120,
};

const schemaByKey = new Map(CONFIG_SCHEMA.map((setting) => [setting.key, setting]));

function freshManager(): { manager: ConfigManager; root: string; configDir: string } {
  const root = makeProjectTempDir('goodvibes-cluster-group');
  const configDir = join(root, '.config-override');
  return { manager: new ConfigManager({ surfaceRoot: 'tui', workingDir: root, configDir }), root, configDir };
}

describe('cluster group settings — inventory integrity', () => {
  test('every ledger-counted key exists in CONFIG_SCHEMA with a defined default', () => {
    for (const key of CLUSTER_GROUP_LOCAL_SETTINGS) {
      const schema = schemaByKey.get(key);
      expect(schema, `${key} must be a live CONFIG_SCHEMA key`).toBeDefined();
      expect(schema?.default, `${key} must declare a default`).toBeDefined();
    }
  });

  test('the ledger counts each key exactly once — no overlap with the other counted sets', () => {
    expect(new Set(CLUSTER_GROUP_LOCAL_SETTINGS).size).toBe(CLUSTER_GROUP_LOCAL_SETTINGS.length);
    const knobs = new Set<string>(FEATURE_KNOB_LOCAL_SETTINGS);
    const deviceAndTrigger = new Set<string>(DEVICE_AND_TRIGGER_LOCAL_SETTINGS);
    const enablementKeys = new Set(FEATURE_SETTINGS.map((feature) => feature.enablement.key));
    for (const key of CLUSTER_GROUP_LOCAL_SETTINGS) {
      expect(knobs.has(key), `${key} is already counted as a feature-knob key`).toBe(false);
      expect(deviceAndTrigger.has(key), `${key} is already counted as a device/trigger key`).toBe(false);
      expect(enablementKeys.has(key), `${key} is already counted as an enablement key`).toBe(false);
    }
  });

  test('an alternate test value is defined for every key and genuinely differs from the default', () => {
    for (const key of CLUSTER_GROUP_LOCAL_SETTINGS) {
      expect(ALTERNATE_VALUE[key], `${key} needs an alternate value`).toBeDefined();
      expect(ALTERNATE_VALUE[key]).not.toEqual(schemaByKey.get(key)?.default);
    }
  });
});

describe('cluster group settings — default exposure', () => {
  let manager: ConfigManager;

  beforeEach(() => {
    manager = freshManager().manager;
  });

  test('a fresh ConfigManager returns each key at its schema default', () => {
    for (const key of CLUSTER_GROUP_LOCAL_SETTINGS) {
      expect(manager.get(key as ConfigKey), `${key} default`).toEqual(
        schemaByKey.get(key)?.default as never,
      );
    }
  });
});

describe('cluster group settings — write/reload persistence round-trip', () => {
  test('each key persists to disk and reloads into a fresh ConfigManager', () => {
    const { manager, root, configDir } = freshManager();
    for (const key of CLUSTER_GROUP_LOCAL_SETTINGS) {
      manager.set(key as ConfigKey, ALTERNATE_VALUE[key] as never);
      expect(manager.get(key as ConfigKey), `${key} in-memory after set`).toEqual(
        ALTERNATE_VALUE[key] as never,
      );
    }

    const reloaded = new ConfigManager({ surfaceRoot: 'tui', workingDir: root, configDir });
    reloaded.load();
    for (const key of CLUSTER_GROUP_LOCAL_SETTINGS) {
      expect(reloaded.get(key as ConfigKey), `${key} after reload`).toEqual(
        ALTERNATE_VALUE[key] as never,
      );
    }
  });

  test("an out-of-range value is rejected by the key's own validator", () => {
    const { manager } = freshManager();
    // Range enforcement is part of the persistence contract being counted: a
    // key that accepted anything would not be verified by a round-trip. The
    // floors matter here — rotating faster than the acceptance window is wide
    // would leave every node permanently mid-cutover.
    expect(() => manager.set('cluster.keyRotationHours' as ConfigKey, 0 as never)).toThrow();
    expect(() => manager.set('cluster.keyRotationGraceMinutes' as ConfigKey, 0 as never)).toThrow();
    expect(() => manager.set('cluster.beaconSeconds' as ConfigKey, 1 as never)).toThrow();
    expect(() => manager.set('cluster.rosterGossipSeconds' as ConfigKey, 100_000 as never)).toThrow();
  });
});

describe('cluster group settings — reset restores default', () => {
  test('reset returns each key to its schema default and persists that', () => {
    const { manager, root, configDir } = freshManager();
    for (const key of CLUSTER_GROUP_LOCAL_SETTINGS) {
      manager.set(key as ConfigKey, ALTERNATE_VALUE[key] as never);
      manager.reset(key as ConfigKey);
      expect(manager.get(key as ConfigKey), `${key} after reset`).toEqual(
        schemaByKey.get(key)?.default as never,
      );
    }

    const reloaded = new ConfigManager({ surfaceRoot: 'tui', workingDir: root, configDir });
    reloaded.load();
    for (const key of CLUSTER_GROUP_LOCAL_SETTINGS) {
      expect(reloaded.get(key as ConfigKey), `${key} default after reload`).toEqual(
        schemaByKey.get(key)?.default as never,
      );
    }
  });
});
