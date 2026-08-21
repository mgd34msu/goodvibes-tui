/**
 * Integration: Config persistence, set → get roundtrip.
 *
 * Tests the ConfigManager's read/write lifecycle using the typed ConfigKey API.
 * Config keys follow the format 'section.field' or 'section.subsection.field'.
 */
import { describe, test, expect, beforeEach } from 'bun:test';
import { join } from 'path';
import { ConfigManager } from '@pellux/goodvibes-sdk/platform/config';
import type { ConfigKey } from '@pellux/goodvibes-sdk/platform/config';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

// NOTE: 'provider.provider' is not a real schema leaf, GoodVibesConfig's
// 'provider' section only has model/reasoningEffort/embeddingProvider/etc
// (getConfiguredProviderId derives the provider by parsing the
// "provider:model" prefix out of provider.model instead; see
// the SDK's platform/config + platform/providers provider-model). ConfigManager's get/set are
// permissive about unknown dot-paths at runtime (no schema entry ⇒ no
// validation, plain property read/write on the section object), so this
// still round-trips, it's legacy/orphaned coverage for a key nothing else
// in the app reads or writes. Left in place per policy (no test deletions);
// the key is cast through ConfigKey the same way
// src/input/sandbox-exec-config.ts already does for its own synthetic,
// not-in-the-real-union keys.
const PROVIDER_PROVIDER_KEY = 'provider.provider' as ConfigKey;

// ---------------------------------------------------------------------------
// ConfigManager set/get roundtrip
// ---------------------------------------------------------------------------

describe('Config persistence: set/get roundtrip', () => {
  let configManager: ConfigManager;

  beforeEach(() => {
    const tempRoot = makeProjectTempDir('goodvibes-config-persistence');
    configManager = new ConfigManager({ surfaceRoot: 'tui',
      workingDir: tempRoot,
      configDir: join(tempRoot, '.config-override'),
    });
  });

  test('set + get roundtrip for boolean values', () => {
    configManager.set('behavior.autoApprove', true);
    expect(configManager.get('behavior.autoApprove')).toBe(true);
    configManager.set('behavior.autoApprove', false);
    expect(configManager.get('behavior.autoApprove')).toBe(false);
  });

  test('set + get roundtrip for permissions.mode', () => {
    configManager.set('permissions.mode', 'allow-all');
    expect(configManager.get('permissions.mode')).toBe('allow-all');
    configManager.set('permissions.mode', 'prompt');
    expect(configManager.get('permissions.mode')).toBe('prompt');
  });

  test('set + get roundtrip for custom permissions.mode', () => {
    configManager.set('permissions.mode', 'custom');
    expect(configManager.get('permissions.mode')).toBe('custom');
  });

  test('config.autoApprove reflects set() immediately', () => {
    configManager.set('behavior.autoApprove', true);
    const snapshot = configManager.get('behavior.autoApprove');
    expect(snapshot).toBe(true);
  });

  test('multiple set() calls accumulate correctly', () => {
    configManager.set('behavior.autoApprove', false);
    configManager.set('permissions.mode', 'allow-all');
    expect(configManager.get('behavior.autoApprove')).toBe(false);
    expect(configManager.get('permissions.mode')).toBe('allow-all');
  });

  test('set() is idempotent when called with same value', () => {
    configManager.set('permissions.mode', 'prompt');
    configManager.set('permissions.mode', 'prompt');
    expect(configManager.get('permissions.mode')).toBe('prompt');
  });
});

// ---------------------------------------------------------------------------
// ConfigManager get() with typed paths
// ---------------------------------------------------------------------------

describe('Config persistence: typed path access', () => {
  let configManager: ConfigManager;

  beforeEach(() => {
    const tempRoot = makeProjectTempDir('goodvibes-config-persistence');
    configManager = new ConfigManager({ surfaceRoot: 'tui',
      workingDir: tempRoot,
      configDir: join(tempRoot, '.config-override'),
    });
  });

  test('get() returns value at behavior.autoApprove path', () => {
    configManager.set('behavior.autoApprove', true);
    const val = configManager.get('behavior.autoApprove');
    expect(val).toBe(true);
  });

  test('get() returns value at permissions.mode path', () => {
    configManager.set('permissions.mode', 'allow-all');
    const val = configManager.get('permissions.mode');
    expect(val).toBe('allow-all');
    configManager.set('permissions.mode', 'prompt');
  });

  test('get() returns string value correctly', () => {
    configManager.set('permissions.mode', 'custom');
    const val = configManager.get('permissions.mode');
    expect(typeof val).toBe('string');
    expect(val).toBe('custom');
    configManager.set('permissions.mode', 'prompt');
  });

  test('get() returns boolean value correctly', () => {
    configManager.set('behavior.autoApprove', false);
    const val = configManager.get('behavior.autoApprove');
    expect(typeof val).toBe('boolean');
    expect(val).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Config provider.model / provider.provider fields
// ---------------------------------------------------------------------------

describe('Config persistence: provider fields', () => {
  let configManager: ConfigManager;

  beforeEach(() => {
    const tempRoot = makeProjectTempDir('goodvibes-config-persistence');
    configManager = new ConfigManager({ surfaceRoot: 'tui',
      workingDir: tempRoot,
      configDir: join(tempRoot, '.config-override'),
    });
  });

  test('provider.provider can be set and retrieved', () => {
    configManager.set(PROVIDER_PROVIDER_KEY, 'openai');
    expect(configManager.get(PROVIDER_PROVIDER_KEY)).toBe('openai');
  });

  test('provider.model can be set and retrieved', () => {
    configManager.set('provider.model', 'openai:gpt-4o-mini');
    expect(configManager.get('provider.model')).toBe('openai:gpt-4o-mini');
  });

  test('provider.provider + provider.model can be set together', () => {
    configManager.set(PROVIDER_PROVIDER_KEY, 'anthropic');
    configManager.set('provider.model', 'anthropic:claude-3-5-sonnet');
    expect(configManager.get(PROVIDER_PROVIDER_KEY)).toBe('anthropic');
    expect(configManager.get('provider.model')).toBe('anthropic:claude-3-5-sonnet');
  });
});

// ---------------------------------------------------------------------------
// Config display fields
// ---------------------------------------------------------------------------

describe('Config persistence: display fields', () => {
  let configManager: ConfigManager;

  beforeEach(() => {
    const tempRoot = makeProjectTempDir('goodvibes-config-persistence');
    configManager = new ConfigManager({ surfaceRoot: 'tui',
      workingDir: tempRoot,
      configDir: join(tempRoot, '.config-override'),
    });
  });

  test('display.stream can be set and retrieved', () => {
    configManager.set('display.stream', false);
    expect(configManager.get('display.stream')).toBe(false);
    configManager.set('display.stream', true);
    expect(configManager.get('display.stream')).toBe(true);
  });

  test('display.lineNumbers can be set and retrieved', () => {
    configManager.set('display.lineNumbers', 'all');
    expect(configManager.get('display.lineNumbers')).toBe('all');
    configManager.set('display.lineNumbers', 'code');
    expect(configManager.get('display.lineNumbers')).toBe('code');
    configManager.set('display.lineNumbers', 'off');
    expect(configManager.get('display.lineNumbers')).toBe('off');
  });
});

// ---------------------------------------------------------------------------
// Config state isolation
// ---------------------------------------------------------------------------

describe('Config persistence: isolation between tests', () => {
  let configManager: ConfigManager;

  beforeEach(() => {
    const tempRoot = makeProjectTempDir('goodvibes-config-persistence');
    configManager = new ConfigManager({ surfaceRoot: 'tui',
      workingDir: tempRoot,
      configDir: join(tempRoot, '.config-override'),
    });
  });

  test('changes in one test do not bleed into the next', () => {
    configManager.set('permissions.mode', 'allow-all');
    expect(configManager.get('permissions.mode')).toBe('allow-all');
  });

  test('value is back to default after previous test reset', () => {
    expect(configManager.get('permissions.mode')).toBe('prompt');
  });

  test('sequential modifications to the same key work correctly', () => {
    const values = ['prompt', 'allow-all', 'custom', 'prompt'] as const;
    for (const v of values) {
      configManager.set('permissions.mode', v);
      expect(configManager.get('permissions.mode')).toBe(v);
    }
  });

  test('behavior.saveHistory can be toggled', () => {
    configManager.set('behavior.saveHistory', true);
    expect(configManager.get('behavior.saveHistory')).toBe(true);
    configManager.set('behavior.saveHistory', false);
    expect(configManager.get('behavior.saveHistory')).toBe(false);
  });
});
