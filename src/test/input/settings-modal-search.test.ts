/**
 * Tests for settings-modal search (TASK-049) and isDefault deep equality (TASK-051).
 */
import { describe, test, expect } from 'bun:test';
import {
  deepEqual,
  fuzzyScoreSettingEntry,
  searchSettingEntries,
} from '../../input/settings-modal-data.ts';
import type { SettingEntry } from '../../input/settings-modal-types.ts';
import type { ConfigSetting } from '@pellux/goodvibes-sdk/platform/config';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// `ConfigSetting` carries no `label` field (labels are looked up separately
// in production via `getSettingLabel`, keyed off the real, finite `ConfigKey`
// union — see src/renderer/settings-modal-helpers.ts). These tests exercise
// the generic scoring/search algorithms with synthetic keys that are not
// part of that union, so the fixture's display label is tracked here instead
// of on the (fake) ConfigSetting object.
const labelByKey = new Map<string, string>();

function makeEntry(
  key: string,
  label: string,
  description: string,
  defaultValue: unknown = '',
  currentValue: unknown = defaultValue,
): SettingEntry {
  labelByKey.set(key, label);
  return {
    setting: {
      key,
      description,
      type: 'string',
      default: defaultValue,
    } as ConfigSetting,
    currentValue,
    isDefault: currentValue === defaultValue,
  };
}

function identity(e: SettingEntry): string {
  return labelByKey.get(e.setting.key) ?? e.setting.key;
}

// ---------------------------------------------------------------------------
// TASK-051: deepEqual
// ---------------------------------------------------------------------------

describe('deepEqual — scalar types', () => {
  test('identical strings', () => expect(deepEqual('hello', 'hello')).toBe(true));
  test('different strings', () => expect(deepEqual('hello', 'world')).toBe(false));
  test('identical numbers', () => expect(deepEqual(42, 42)).toBe(true));
  test('different numbers', () => expect(deepEqual(1, 2)).toBe(false));
  test('identical booleans', () => expect(deepEqual(true, true)).toBe(true));
  test('different booleans', () => expect(deepEqual(true, false)).toBe(false));
  test('null === null', () => expect(deepEqual(null, null)).toBe(true));
  test('undefined === undefined', () => expect(deepEqual(undefined, undefined)).toBe(true));
  test('null !== undefined', () => expect(deepEqual(null, undefined)).toBe(false));
  test('string !== number same value', () => expect(deepEqual('42', 42)).toBe(false));
});

describe('deepEqual — arrays', () => {
  test('identical empty arrays', () => expect(deepEqual([], [])).toBe(true));
  test('identical arrays', () => expect(deepEqual([1, 2, 3], [1, 2, 3])).toBe(true));
  test('different element', () => expect(deepEqual([1, 2, 3], [1, 2, 4])).toBe(false));
  test('different length', () => expect(deepEqual([1, 2], [1, 2, 3])).toBe(false));
  test('nested arrays', () => expect(deepEqual([[1, 2], [3]], [[1, 2], [3]])).toBe(true));
  test('nested array mismatch', () => expect(deepEqual([[1, 2], [3]], [[1, 2], [4]])).toBe(false));
  test('array vs non-array', () => expect(deepEqual([], {})).toBe(false));
});

describe('deepEqual — plain objects', () => {
  test('identical empty objects', () => expect(deepEqual({}, {})).toBe(true));
  test('identical objects', () => expect(deepEqual({ a: 1 }, { a: 1 })).toBe(true));
  test('different value', () => expect(deepEqual({ a: 1 }, { a: 2 })).toBe(false));
  test('missing key', () => expect(deepEqual({ a: 1 }, {})).toBe(false));
  test('extra key', () => expect(deepEqual({}, { a: 1 })).toBe(false));
  test('nested objects equal', () => expect(deepEqual({ a: { b: 2 } }, { a: { b: 2 } })).toBe(true));
  test('nested objects differ', () => expect(deepEqual({ a: { b: 2 } }, { a: { b: 3 } })).toBe(false));
  test('object with array value equal', () =>
    expect(deepEqual({ ids: [1, 2] }, { ids: [1, 2] })).toBe(true));
  test('object with array value differ', () =>
    expect(deepEqual({ ids: [1, 2] }, { ids: [1, 3] })).toBe(false));
});

describe('deepEqual — isDefault correctness for non-scalar defaults', () => {
  // Simulate the bug: same-shape array default created twice → isDefault was false
  test('array default same shape: was false with ===, is true with deepEqual', () => {
    const defaultVal = ['a', 'b'];
    const currentVal = ['a', 'b']; // different reference
    // Old behaviour:
    expect(defaultVal === currentVal).toBe(false); // proves the bug existed
    // New behaviour:
    expect(deepEqual(currentVal, defaultVal)).toBe(true);
  });

  test('object default same shape: was false with ===, is true with deepEqual', () => {
    const defaultVal = { mode: 'strict', level: 3 };
    const currentVal = { mode: 'strict', level: 3 }; // different reference
    expect(defaultVal === currentVal).toBe(false);
    expect(deepEqual(currentVal, defaultVal)).toBe(true);
  });

  test('modified array: deepEqual correctly returns false', () => {
    const defaultVal = ['a', 'b'];
    const modified = ['a', 'c'];
    expect(deepEqual(modified, defaultVal)).toBe(false);
  });

  test('modified object: deepEqual correctly returns false', () => {
    const defaultVal = { mode: 'strict', level: 3 };
    const modified = { mode: 'strict', level: 4 };
    expect(deepEqual(modified, defaultVal)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// TASK-049: fuzzyScoreSettingEntry
// ---------------------------------------------------------------------------

describe('fuzzyScoreSettingEntry — tier ordering', () => {
  test('empty query returns 0 (match)', () => {
    const entry = makeEntry('display.stream', 'Stream', 'enable streaming');
    expect(fuzzyScoreSettingEntry('', entry, identity)).toBe(0);
  });

  test('key hit scores highest tier (>=3000)', () => {
    // 'stream' is a substring of key 'display.stream'
    const entry = makeEntry('display.stream', 'Stream', 'control the output display');
    const score = fuzzyScoreSettingEntry('stream', entry, identity);
    expect(score).not.toBeNull();
    expect(score!).toBeGreaterThanOrEqual(3000);
  });

  test('label-only hit scores second tier (2000–2999)', () => {
    // key 'ui.voiceenabled' does NOT contain 'speak'; label 'Always Speak' does
    const entry = makeEntry('ui.voiceEnabled', 'Always Speak', 'toggle TTS voice output');
    const score = fuzzyScoreSettingEntry('speak', entry, identity);
    expect(score).not.toBeNull();
    expect(score!).toBeGreaterThanOrEqual(2000);
    expect(score!).toBeLessThan(3000);
  });

  test('description-only hit scores third tier (1000–1999)', () => {
    // key: 'ui.wrfcMessages', label: 'WRFC Messages' — neither contains 'routing'
    // description 'controls message routing for wrfc flow' does
    const entry = makeEntry(
      'ui.wrfcmessages',
      'WRFC Messages',
      'controls message routing for wrfc flow',
    );
    const score = fuzzyScoreSettingEntry('routing', entry, identity);
    expect(score).not.toBeNull();
    expect(score!).toBeGreaterThanOrEqual(1000);
    expect(score!).toBeLessThan(2000);
  });

  test('subsequence-only hit scores 1–99', () => {
    // 'bht' is not a substring of key 'behavior.timeout', label 'Timeout', or desc 'ms value'
    // but it IS a subsequence: b…h…t appear in 'behavior.timeout'
    const entry = makeEntry('behavior.timeout', 'Timeout', 'ms value');
    const scoreBht = fuzzyScoreSettingEntry('bht', entry, identity);
    expect(scoreBht).not.toBeNull();
    // Must be in subsequence tier (below tier 3)
    expect(scoreBht!).toBeLessThan(1000);
    expect(scoreBht!).toBeGreaterThan(0);
  });

  test('no match returns null', () => {
    const entry = makeEntry('display.stream', 'Stream', 'streaming output');
    expect(fuzzyScoreSettingEntry('zzznomatch', entry, identity)).toBeNull();
  });

  test('case insensitive matching', () => {
    const entry = makeEntry('display.stream', 'Stream', 'streaming');
    expect(fuzzyScoreSettingEntry('STREAM', entry, identity)).not.toBeNull();
  });
});

describe('fuzzyScoreSettingEntry — rank ordering within tier', () => {
  test('earlier key position scores higher within key tier', () => {
    // 'stream' at position 0 of key scores higher than at position 4
    const entryA = makeEntry('stream.enabled', 'Enable', 'desc');
    const entryB = makeEntry('x.y.stream', 'Enable', 'desc');
    const scoreA = fuzzyScoreSettingEntry('stream', entryA, identity);
    const scoreB = fuzzyScoreSettingEntry('stream', entryB, identity);
    expect(scoreA).not.toBeNull();
    expect(scoreB).not.toBeNull();
    // Both in tier 1 (>=3000), but earlier position gets higher bonus
    expect(scoreA!).toBeGreaterThan(scoreB!);
    expect(scoreB!).toBeGreaterThanOrEqual(3000); // still in tier 1
  });
});

// ---------------------------------------------------------------------------
// TASK-049: searchSettingEntries
// ---------------------------------------------------------------------------

describe('searchSettingEntries', () => {
  function makeGroups(): Map<string, SettingEntry[]> {
    const groups = new Map<string, SettingEntry[]>();
    groups.set('display', [
      makeEntry('display.stream', 'Stream', 'enable token streaming'),
      makeEntry('display.theme', 'Theme', 'UI colour theme'),
    ]);
    groups.set('ui', [
      makeEntry('ui.voiceEnabled', 'Always Speak', 'toggle TTS'),
      makeEntry('ui.systemMessages', 'System Message Target', 'where system messages go'),
    ]);
    groups.set('behavior', [
      makeEntry('behavior.timeout', 'Timeout', 'request timeout in ms'),
    ]);
    return groups as Map<string, SettingEntry[]>;
  }

  test('empty query returns []', () => {
    const results = searchSettingEntries('', makeGroups() as never, identity);
    expect(results).toEqual([]);
  });

  test('whitespace-only query returns []', () => {
    const results = searchSettingEntries('   ', makeGroups() as never, identity);
    expect(results).toEqual([]);
  });

  test('finds entry by key substring', () => {
    const results = searchSettingEntries('stream', makeGroups() as never, identity);
    expect(results.map(e => e.setting.key)).toContain('display.stream');
  });

  test('finds entry by label substring', () => {
    const results = searchSettingEntries('speak', makeGroups() as never, identity);
    expect(results.map(e => e.setting.key)).toContain('ui.voiceEnabled');
  });

  test('finds entry by description substring', () => {
    const results = searchSettingEntries('colour theme', makeGroups() as never, identity);
    expect(results.map(e => e.setting.key)).toContain('display.theme');
  });

  test('results are ranked: key hit before label hit before description hit', () => {
    // Controlled entries where 'zap' appears in different tiers:
    //   key tier:   'zap.enabled' (key contains 'zap' at position 0)
    //   label tier: 'x.y'         (label 'Zap Setting' contains 'zap' at position 0)
    //   desc tier:  'q.r'         (desc 'enables zap behaviour' contains 'zap' at position 8)
    // None of the non-target fields contain 'zap', ensuring clean tier separation.
    const groups = new Map<string, SettingEntry[]>();
    groups.set('cat', [
      makeEntry('q.r', 'Config Option', 'enables zap behaviour'), // desc hit
      makeEntry('zap.enabled', 'Enabled', 'turn on'),             // key hit
      makeEntry('x.y', 'Zap Setting', 'none'),                    // label hit
    ]);
    const results = searchSettingEntries('zap', groups as never, identity);
    // Widened to `string[]`: these are synthetic test keys, not members of
    // the real (finite) `ConfigKey` union, so `.toBe()` needs the wider type.
    const keys: string[] = results.map(e => e.setting.key);
    // key hit must come first
    expect(keys[0]).toBe('zap.enabled');
    // label hit before desc hit
    expect(keys[1]).toBe('x.y');
    expect(keys[2]).toBe('q.r');
  });

  test('deduplicates cross-listed keys', () => {
    // Simulate network tab cross-listing a controlPlane key
    const groups = new Map<string, SettingEntry[]>();
    const sharedEntry = makeEntry('controlPlane.port', 'CP Port', 'control plane port');
    groups.set('controlPlane', [sharedEntry]);
    groups.set('network', [sharedEntry]); // same reference
    const results = searchSettingEntries('port', groups as never, identity);
    const portKeys = results.filter(e => e.setting.key === 'controlPlane.port');
    expect(portKeys.length).toBe(1);
  });

  test('no match returns []', () => {
    const results = searchSettingEntries('zzznomatch', makeGroups() as never, identity);
    expect(results).toEqual([]);
  });

  test('case insensitive search', () => {
    const results = searchSettingEntries('THEME', makeGroups() as never, identity);
    expect(results.map(e => e.setting.key)).toContain('display.theme');
  });
});

// ---------------------------------------------------------------------------
// TASK-049: SettingsModal.setSearchQuery / clearSearch integration
// ---------------------------------------------------------------------------

import { describe as d2, test as t2, expect as e2, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { SettingsModal } from '../../input/settings-modal.ts';
import { ConfigManager } from '@pellux/goodvibes-sdk/platform/config';
import { ServiceRegistry } from '@pellux/goodvibes-sdk/platform/config';
import { SubscriptionManager } from '@pellux/goodvibes-sdk/platform/config';
import { createFeatureFlagManager } from '@/runtime/index.ts';
import type { McpRegistry } from '@pellux/goodvibes-sdk/platform/mcp';
import { SecretsManager } from '../../config/secrets.ts';

d2('SettingsModal search integration', () => {
  const originalCwd = process.cwd();
  const originalHome = process.env.HOME;
  let tmpDir: string;
  let cm: ConfigManager;
  let modal: SettingsModal;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `gv-settings-search-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tmpDir, { recursive: true });
    process.env.HOME = tmpDir;
    process.chdir(tmpDir);
    cm = new ConfigManager({ surfaceRoot: 'tui', workingDir: tmpDir, homeDir: tmpDir, configDir: join(tmpDir, '.goodvibes', 'global-tui') });
    modal = new SettingsModal();
    const ffm = createFeatureFlagManager();
    const sm = new SubscriptionManager(join(tmpDir, '.goodvibes', 'tui', 'subscriptions.json'));
    const secrets = new SecretsManager({ projectRoot: tmpDir, globalHome: tmpDir, configManager: cm });
    const sr = new ServiceRegistry(join(tmpDir, '.goodvibes', 'tui', 'services.json'), { secretsManager: secrets, subscriptionManager: sm });
    mkdirSync(join(tmpDir, '.goodvibes', 'tui'), { recursive: true });
    const mcpRegistry = {
      listServerSecurity: () => [],
      setServerTrustMode: () => {},
    } as unknown as McpRegistry;
    modal.open(cm, ffm, sm, sr, mcpRegistry);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  });

  t2('searchQuery starts empty, searchResults empty', () => {
    e2(modal.searchQuery).toBe('');
    e2(modal.searchResults).toEqual([]);
  });

  t2('setSearchQuery populates searchResults for a matching query', () => {
    modal.setSearchQuery('stream');
    e2(modal.searchQuery).toBe('stream');
    e2(modal.searchResults.length).toBeGreaterThan(0);
    e2(modal.searchResults.some(e => e.setting.key === 'display.stream')).toBe(true);
  });

  t2('setSearchQuery with empty string clears results', () => {
    modal.setSearchQuery('stream');
    modal.setSearchQuery('');
    e2(modal.searchQuery).toBe('');
    e2(modal.searchResults).toEqual([]);
  });

  t2('clearSearch clears query and results', () => {
    modal.setSearchQuery('theme');
    modal.clearSearch();
    e2(modal.searchQuery).toBe('');
    e2(modal.searchResults).toEqual([]);
  });

  t2('search results are ranked: key hit before label hit', () => {
    // 'voice' appears in key 'ui.voiceEnabled' and label 'Always Speak' but NOT label of voiceEnabled
    // 'theme' appears in key 'display.theme'
    modal.setSearchQuery('theme');
    const keys = modal.searchResults.map(e => e.setting.key);
    e2(keys[0]).toBe('display.theme'); // key hit first
  });

  t2('open() resets searchQuery and searchResults', () => {
    modal.setSearchQuery('stream');
    const ffm2 = createFeatureFlagManager();
    const sm2 = new SubscriptionManager(join(tmpDir, '.goodvibes', 'tui', 'subscriptions.json'));
    const secrets2 = new SecretsManager({ projectRoot: tmpDir, globalHome: tmpDir, configManager: cm });
    const sr2 = new ServiceRegistry(join(tmpDir, '.goodvibes', 'tui', 'services.json'), { secretsManager: secrets2, subscriptionManager: sm2 });
    const mcpRegistry2 = { listServerSecurity: () => [], setServerTrustMode: () => {} } as unknown as McpRegistry;
    modal.open(cm, ffm2, sm2, sr2, mcpRegistry2);
    e2(modal.searchQuery).toBe('');
    e2(modal.searchResults).toEqual([]);
  });

  t2('close() resets searchQuery and searchResults', () => {
    modal.setSearchQuery('stream');
    modal.close();
    e2(modal.searchQuery).toBe('');
    e2(modal.searchResults).toEqual([]);
  });
});
