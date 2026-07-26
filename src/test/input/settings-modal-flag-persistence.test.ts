/**
 * Feature enablement persistence against a REAL ConfigManager on disk.
 *
 * There is no separate enablement namespace: turning a feature on or off is a
 * plain write on its domain settings key (featureEnablementWrite computes the
 * exact write). This locks the round-trip for every enablement shape —
 * boolean, enum (stock active mode / stock off mode), and constant-on-boolean
 * — and that returning a key to its schema default reads back as the
 * feature's stock state after reload.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { ConfigManager } from '@pellux/goodvibes-sdk/platform/config';
import { FEATURE_SETTINGS } from '@pellux/goodvibes-sdk/platform/runtime/state';
import {
  featureEnablementWrite,
  isFeatureConfigEnabled,
} from '../../runtime/feature-settings.ts';

describe('feature enablement writes — domain-key persistence', () => {
  let tmpDir: string;
  let cm: ConfigManager;

  const newManager = () =>
    new ConfigManager({ surfaceRoot: 'tui', workingDir: tmpDir, homeDir: tmpDir, configDir: join(tmpDir, '.goodvibes', 'global-tui') });

  beforeEach(() => {
    tmpDir = join(tmpdir(), `gv-flag-persist-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tmpDir, { recursive: true });
    cm = newManager();
  });

  afterEach(() => {
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  });

  test('boolean feature: disable writes the key and survives reload', () => {
    expect(isFeatureConfigEnabled(cm, 'agent-passive-knowledge-injection')).toBe(true);

    const off = featureEnablementWrite('agent-passive-knowledge-injection', false)!;
    expect(off.key).toBe('agents.passiveInjection.knowledge');
    expect(off.value).toBe(false);
    cm.setDynamic(off.key, off.value);

    const reloaded = newManager();
    expect(reloaded.get('agents.passiveInjection.knowledge')).toBe(false);
    expect(isFeatureConfigEnabled(reloaded, 'agent-passive-knowledge-injection')).toBe(false);
  });

  test('enum feature: enable lands on the stock active mode, disable on the stock off mode', () => {
    const on = featureEnablementWrite('permissions-policy-engine', true)!;
    expect(on.key).toBe('permissions.engine');
    expect(on.value).toBe('policy-engine');
    cm.setDynamic(on.key, on.value);
    expect(isFeatureConfigEnabled(cm, 'permissions-policy-engine')).toBe(true);

    const off = featureEnablementWrite('permissions-policy-engine', false)!;
    expect(off.value).toBe('baseline'); // the schema default sits on the off side
    cm.setDynamic(off.key, off.value);

    const reloaded = newManager();
    expect(reloaded.get('permissions.engine')).toBe('baseline');
    expect(isFeatureConfigEnabled(reloaded, 'permissions-policy-engine')).toBe(false);
  });

  test('constant capability on a boolean key: the key is the honest switch', () => {
    const on = featureEnablementWrite('slack-surface', true)!;
    expect(on.key).toBe('surfaces.slack.enabled');
    expect(on.value).toBe(true);
    cm.setDynamic(on.key, on.value);

    const reloaded = newManager();
    expect(reloaded.get('surfaces.slack.enabled')).toBe(true);
    expect(isFeatureConfigEnabled(reloaded, 'slack-surface')).toBe(true);
  });

  test('constant capability on a non-boolean key has no off switch and no enablement write', () => {
    expect(featureEnablementWrite('fetch-sanitization', true)).toBeNull();
    expect(featureEnablementWrite('fetch-sanitization', false)).toBeNull();
    // It always reads as on — its domain keys tune it, nothing disables it.
    expect(isFeatureConfigEnabled(cm, 'fetch-sanitization')).toBe(true);
  });

  test('unknown feature ids produce no write and read as disabled', () => {
    expect(featureEnablementWrite('no-such-feature', true)).toBeNull();
    expect(isFeatureConfigEnabled(cm, 'no-such-feature')).toBe(false);
  });

  test('every feature with an off position round-trips both directions', () => {
    for (const feature of FEATURE_SETTINGS) {
      const on = featureEnablementWrite(feature.id, true);
      const off = featureEnablementWrite(feature.id, false);
      if (on === null || off === null) {
        // Only constant capabilities on non-boolean keys have no switch.
        expect(feature.enablement.kind).toBe('constant');
        continue;
      }
      if (feature.operable === false) continue; // covered below
      cm.setDynamic(on.key, on.value);
      expect(isFeatureConfigEnabled(cm, feature.id)).toBe(true);
      cm.setDynamic(off.key, off.value);
      expect(isFeatureConfigEnabled(cm, feature.id)).toBe(false);
    }
  });

  test('a capability declared not operable keeps the written value but never reads as on', () => {
    const inoperable = FEATURE_SETTINGS.filter((feature) => feature.operable === false);
    // The registry currently declares wake-word detection inoperable (no surface
    // captures audio yet). If that list ever empties, this test still holds; the
    // assertions below are what stops the marker being dropped silently.
    for (const feature of inoperable) {
      expect(feature.inoperableDetail, `${feature.id} must state WHY it is unavailable`).toBeTruthy();

      const on = featureEnablementWrite(feature.id, true);
      if (on === null) continue;
      cm.setDynamic(on.key, on.value);

      // The user's intent is remembered on disk exactly as written...
      const reloaded = newManager();
      expect(reloaded.get(on.key)).toEqual(on.value as never);
      // ...and the capability still reads as off everywhere, because nothing is
      // running. A surface that showed "on" here would be lying.
      expect(isFeatureConfigEnabled(reloaded, feature.id)).toBe(false);
    }
  });
});
