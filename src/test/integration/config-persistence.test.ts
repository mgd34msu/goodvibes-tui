/**
 * Integration: Config persistence — set → get roundtrip.
 *
 * Tests the ConfigManager's read/write lifecycle using the typed ConfigKey API.
 * Config keys follow the format 'section.field' or 'section.subsection.field'.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { configManager, config } from '../../config/index.ts';

// ---------------------------------------------------------------------------
// ConfigManager set/get roundtrip
// ---------------------------------------------------------------------------

describe('Config persistence — set/get roundtrip', () => {
  let savedAutoApprove: boolean;
  let savedPermissionsMode: string;

  beforeEach(() => {
    savedAutoApprove = config.autoApprove ?? false;
    savedPermissionsMode = config.permissions?.mode ?? 'prompt';
  });

  afterEach(() => {
    configManager.set('behavior.autoApprove', savedAutoApprove);
    configManager.set('permissions.mode', savedPermissionsMode as 'prompt' | 'allow-all' | 'custom');
  });

  test('set + get roundtrip for boolean values', () => {
    configManager.set('behavior.autoApprove', true);
    expect(config.autoApprove).toBe(true);
    configManager.set('behavior.autoApprove', false);
    expect(config.autoApprove).toBe(false);
  });

  test('set + get roundtrip for permissions.mode', () => {
    configManager.set('permissions.mode', 'allow-all');
    expect(config.permissions?.mode).toBe('allow-all');
    configManager.set('permissions.mode', 'prompt');
    expect(config.permissions?.mode).toBe('prompt');
  });

  test('set + get roundtrip for custom permissions.mode', () => {
    configManager.set('permissions.mode', 'custom');
    expect(config.permissions?.mode).toBe('custom');
  });

  test('config.autoApprove reflects set() immediately', () => {
    configManager.set('behavior.autoApprove', true);
    const snapshot = config.autoApprove;
    expect(snapshot).toBe(true);
  });

  test('multiple set() calls accumulate correctly', () => {
    configManager.set('behavior.autoApprove', false);
    configManager.set('permissions.mode', 'allow-all');
    expect(config.autoApprove).toBe(false);
    expect(config.permissions?.mode).toBe('allow-all');
  });

  test('set() is idempotent when called with same value', () => {
    configManager.set('permissions.mode', 'prompt');
    configManager.set('permissions.mode', 'prompt');
    expect(config.permissions?.mode).toBe('prompt');
  });
});

// ---------------------------------------------------------------------------
// ConfigManager get() with typed paths
// ---------------------------------------------------------------------------

describe('Config persistence — typed path access', () => {
  let savedAutoApprove: boolean;

  beforeEach(() => {
    savedAutoApprove = config.autoApprove ?? false;
  });

  afterEach(() => {
    configManager.set('behavior.autoApprove', savedAutoApprove);
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

describe('Config persistence — provider fields', () => {
  let savedProvider: unknown;
  let savedModel: unknown;

  beforeEach(() => {
    savedProvider = configManager.get('provider.provider');
    savedModel = configManager.get('provider.model');
  });

  afterEach(() => {
    if (savedProvider !== undefined) {
      configManager.set('provider.provider', savedProvider as string);
    }
    if (savedModel !== undefined) {
      configManager.set('provider.model', savedModel as string);
    }
  });

  test('provider.provider can be set and retrieved', () => {
    configManager.set('provider.provider', 'openai');
    expect(configManager.get('provider.provider')).toBe('openai');
  });

  test('provider.model can be set and retrieved', () => {
    configManager.set('provider.model', 'gpt-4o-mini');
    expect(configManager.get('provider.model')).toBe('gpt-4o-mini');
  });

  test('provider.provider + provider.model can be set together', () => {
    configManager.set('provider.provider', 'anthropic');
    configManager.set('provider.model', 'claude-3-5-sonnet');
    expect(configManager.get('provider.provider')).toBe('anthropic');
    expect(configManager.get('provider.model')).toBe('claude-3-5-sonnet');
  });
});

// ---------------------------------------------------------------------------
// Config display fields
// ---------------------------------------------------------------------------

describe('Config persistence — display fields', () => {
  let savedStream: unknown;
  let savedLineNumbers: unknown;

  beforeEach(() => {
    savedStream = configManager.get('display.stream');
    savedLineNumbers = configManager.get('display.lineNumbers');
  });

  afterEach(() => {
    if (savedStream !== undefined) configManager.set('display.stream', savedStream as boolean);
    if (savedLineNumbers !== undefined) configManager.set('display.lineNumbers', savedLineNumbers as boolean);
  });

  test('display.stream can be set and retrieved', () => {
    configManager.set('display.stream', false);
    expect(configManager.get('display.stream')).toBe(false);
    configManager.set('display.stream', true);
    expect(configManager.get('display.stream')).toBe(true);
  });

  test('display.lineNumbers can be set and retrieved', () => {
    configManager.set('display.lineNumbers', true);
    expect(configManager.get('display.lineNumbers')).toBe(true);
    configManager.set('display.lineNumbers', false);
    expect(configManager.get('display.lineNumbers')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Config state isolation
// ---------------------------------------------------------------------------

describe('Config persistence — isolation between tests', () => {
  const ORIGINAL_MODE = 'prompt';

  test('changes in one test do not bleed into the next', () => {
    configManager.set('permissions.mode', 'allow-all');
    expect(config.permissions?.mode).toBe('allow-all');
    // Reset
    configManager.set('permissions.mode', ORIGINAL_MODE);
  });

  test('value is back to default after previous test reset', () => {
    expect(config.permissions?.mode).toBe('prompt');
  });

  test('sequential modifications to the same key work correctly', () => {
    const values = ['prompt', 'allow-all', 'custom', 'prompt'] as const;
    for (const v of values) {
      configManager.set('permissions.mode', v);
      expect(config.permissions?.mode).toBe(v);
    }
  });

  test('behavior.saveHistory can be toggled', () => {
    const saved = configManager.get('behavior.saveHistory');
    configManager.set('behavior.saveHistory', true);
    expect(configManager.get('behavior.saveHistory')).toBe(true);
    configManager.set('behavior.saveHistory', false);
    expect(configManager.get('behavior.saveHistory')).toBe(false);
    if (saved !== undefined) configManager.set('behavior.saveHistory', saved as boolean);
  });
});
