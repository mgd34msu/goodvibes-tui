import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, rmSync, existsSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { ConfigManager } from '../../config/manager.ts';
import { DEFAULT_CONFIG } from '../../config/schema.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
  const dir = join(tmpdir(), `gv-cfg-ext-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('Config schema extensions: danger + tools categories', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // Default values
  // Note: global ~/.goodvibes/tui/settings.json may exist on dev machines and
  // can override some defaults. We verify structure and types, not exact values,
  // except for keys that project config explicitly controls (see 'get/set' tests).
  // -------------------------------------------------------------------------

  describe('defaults: danger category', () => {
    test('danger category fields have correct types when no project config exists', () => {
      const mgr = new ConfigManager({ workingDir: tmpDir });
      expect(typeof mgr.get('danger.agentRecursion')).toBe('boolean');
      expect(typeof mgr.get('danger.maxGlobalAgents')).toBe('number');
      expect(typeof mgr.get('danger.maxRecursionDepth')).toBe('number');
      expect(typeof mgr.get('danger.daemon')).toBe('boolean');
      expect(typeof mgr.get('danger.httpListener')).toBe('boolean');
    });

    test('DEFAULT_CONFIG.danger has correct default values', () => {
      // These verify what the defaults ARE — not what a running instance may have
      // after global config merging
      expect(DEFAULT_CONFIG.danger.agentRecursion).toBe(false);
      expect(DEFAULT_CONFIG.danger.maxGlobalAgents).toBe(8);
      expect(DEFAULT_CONFIG.danger.maxRecursionDepth).toBe(0);
      expect(DEFAULT_CONFIG.danger.daemon).toBe(false);
      expect(DEFAULT_CONFIG.danger.httpListener).toBe(false);
    });

    test('project config overrides win for danger fields', () => {
      const projectSettingsDir = join(tmpDir, '.goodvibes', 'tui');
      mkdirSync(projectSettingsDir, { recursive: true });
      writeFileSync(
        join(projectSettingsDir, 'settings.json'),
        JSON.stringify({ danger: { maxGlobalAgents: 4 } }, null, 2),
        'utf-8'
      );
      const mgr = new ConfigManager({ workingDir: tmpDir });
      expect(mgr.get('danger.maxGlobalAgents')).toBe(4);
    });
  });

  describe('defaults: tools category', () => {
    test('tools category fields have correct types when no project config exists', () => {
      const mgr = new ConfigManager({ workingDir: tmpDir });
      expect(typeof mgr.get('tools.llmProvider')).toBe('string');
      expect(typeof mgr.get('tools.llmModel')).toBe('string');
      expect(typeof mgr.get('tools.autoHeal')).toBe('boolean');
      expect(typeof mgr.get('tools.defaultTokenBudget')).toBe('number');
      expect(typeof mgr.get('tools.hooksFile')).toBe('string');
    });

    test('DEFAULT_CONFIG.tools has correct default values', () => {
      expect(DEFAULT_CONFIG.tools.llmProvider).toBe('');
      expect(DEFAULT_CONFIG.tools.llmModel).toBe('');
      expect(DEFAULT_CONFIG.tools.autoHeal).toBe(false);
      expect(DEFAULT_CONFIG.tools.defaultTokenBudget).toBe(5000);
      expect(DEFAULT_CONFIG.tools.hooksFile).toBe('hooks.json');
    });

    test('project config overrides win for tools fields', () => {
      const projectSettingsDir = join(tmpDir, '.goodvibes', 'tui');
      mkdirSync(projectSettingsDir, { recursive: true });
      writeFileSync(
        join(projectSettingsDir, 'settings.json'),
        JSON.stringify({ tools: { defaultTokenBudget: 3000 } }, null, 2),
        'utf-8'
      );
      const mgr = new ConfigManager({ workingDir: tmpDir });
      expect(mgr.get('tools.defaultTokenBudget')).toBe(3000);
    });
  });

  // -------------------------------------------------------------------------
  // get / set round-trips
  // -------------------------------------------------------------------------

  describe('get/set: danger category', () => {
    test('set and get danger.agentRecursion', () => {
      const mgr = new ConfigManager({ workingDir: tmpDir });
      mgr.set('danger.agentRecursion', true);
      expect(mgr.get('danger.agentRecursion')).toBe(true);
    });

    test('set and get danger.maxGlobalAgents with valid value', () => {
      const mgr = new ConfigManager({ workingDir: tmpDir });
      mgr.set('danger.maxGlobalAgents', 12);
      expect(mgr.get('danger.maxGlobalAgents')).toBe(12);
    });

    test('set and get danger.maxRecursionDepth to 1', () => {
      const mgr = new ConfigManager({ workingDir: tmpDir });
      mgr.set('danger.maxRecursionDepth', 1);
      expect(mgr.get('danger.maxRecursionDepth')).toBe(1);
    });

    test('set and get danger.maxRecursionDepth back to 0', () => {
      const mgr = new ConfigManager({ workingDir: tmpDir });
      mgr.set('danger.maxRecursionDepth', 1);
      mgr.set('danger.maxRecursionDepth', 0);
      expect(mgr.get('danger.maxRecursionDepth')).toBe(0);
    });

    test('set and get danger.daemon', () => {
      const mgr = new ConfigManager({ workingDir: tmpDir });
      mgr.set('danger.daemon', true);
      expect(mgr.get('danger.daemon')).toBe(true);
    });

    test('set and get danger.httpListener', () => {
      const mgr = new ConfigManager({ workingDir: tmpDir });
      mgr.set('danger.httpListener', true);
      expect(mgr.get('danger.httpListener')).toBe(true);
    });
  });

  describe('get/set: tools category', () => {
    test('set and get tools.llmProvider', () => {
      const mgr = new ConfigManager({ workingDir: tmpDir });
      mgr.set('tools.llmProvider', 'anthropic');
      expect(mgr.get('tools.llmProvider')).toBe('anthropic');
    });

    test('set and get tools.llmModel', () => {
      const mgr = new ConfigManager({ workingDir: tmpDir });
      mgr.set('tools.llmModel', 'claude-sonnet-4-6');
      expect(mgr.get('tools.llmModel')).toBe('claude-sonnet-4-6');
    });

    test('set and get tools.autoHeal', () => {
      const mgr = new ConfigManager({ workingDir: tmpDir });
      mgr.set('tools.autoHeal', true);
      expect(mgr.get('tools.autoHeal')).toBe(true);
    });

    test('set and get tools.defaultTokenBudget with valid value', () => {
      const mgr = new ConfigManager({ workingDir: tmpDir });
      mgr.set('tools.defaultTokenBudget', 8000);
      expect(mgr.get('tools.defaultTokenBudget')).toBe(8000);
    });

    test('set and get tools.hooksFile', () => {
      const mgr = new ConfigManager({ workingDir: tmpDir });
      mgr.set('tools.hooksFile', 'custom-hooks.json');
      expect(mgr.get('tools.hooksFile')).toBe('custom-hooks.json');
    });
  });

  // -------------------------------------------------------------------------
  // Validation: invalid values must throw
  // -------------------------------------------------------------------------

  describe('validation: danger category', () => {
    test('danger.maxRecursionDepth rejects value 2', () => {
      const mgr = new ConfigManager({ workingDir: tmpDir });
      expect(() => mgr.set('danger.maxRecursionDepth', 2 as never)).toThrow();
    });

    test('danger.maxRecursionDepth rejects negative value', () => {
      const mgr = new ConfigManager({ workingDir: tmpDir });
      expect(() => mgr.set('danger.maxRecursionDepth', -1 as never)).toThrow();
    });

    test('danger.maxRecursionDepth rejects value 3', () => {
      const mgr = new ConfigManager({ workingDir: tmpDir });
      expect(() => mgr.set('danger.maxRecursionDepth', 3 as never)).toThrow();
    });

    test('danger.maxGlobalAgents rejects 0 (below minimum)', () => {
      const mgr = new ConfigManager({ workingDir: tmpDir });
      expect(() => mgr.set('danger.maxGlobalAgents', 0 as never)).toThrow();
    });

    test('danger.maxGlobalAgents rejects 21 (above maximum)', () => {
      const mgr = new ConfigManager({ workingDir: tmpDir });
      expect(() => mgr.set('danger.maxGlobalAgents', 21 as never)).toThrow();
    });

    test('danger.maxGlobalAgents accepts boundary value 1', () => {
      const mgr = new ConfigManager({ workingDir: tmpDir });
      mgr.set('danger.maxGlobalAgents', 1);
      expect(mgr.get('danger.maxGlobalAgents')).toBe(1);
    });

    test('danger.maxGlobalAgents accepts boundary value 20', () => {
      const mgr = new ConfigManager({ workingDir: tmpDir });
      mgr.set('danger.maxGlobalAgents', 20);
      expect(mgr.get('danger.maxGlobalAgents')).toBe(20);
    });
  });

  describe('validation: tools category', () => {
    test('tools.defaultTokenBudget rejects value below 100', () => {
      const mgr = new ConfigManager({ workingDir: tmpDir });
      expect(() => mgr.set('tools.defaultTokenBudget', 99 as never)).toThrow();
    });

    test('tools.defaultTokenBudget rejects value above 100000', () => {
      const mgr = new ConfigManager({ workingDir: tmpDir });
      expect(() => mgr.set('tools.defaultTokenBudget', 100001 as never)).toThrow();
    });

    test('tools.defaultTokenBudget accepts boundary value 100', () => {
      const mgr = new ConfigManager({ workingDir: tmpDir });
      mgr.set('tools.defaultTokenBudget', 100);
      expect(mgr.get('tools.defaultTokenBudget')).toBe(100);
    });

    test('tools.defaultTokenBudget accepts boundary value 100000', () => {
      const mgr = new ConfigManager({ workingDir: tmpDir });
      mgr.set('tools.defaultTokenBudget', 100000);
      expect(mgr.get('tools.defaultTokenBudget')).toBe(100000);
    });
  });

  // -------------------------------------------------------------------------
  // getAll() includes new categories
  // -------------------------------------------------------------------------

  describe('getAll includes new categories', () => {
    test('getAll returns danger category with correct field types', () => {
      const mgr = new ConfigManager({ workingDir: tmpDir });
      const all = mgr.getAll();
      expect(typeof all.danger.agentRecursion).toBe('boolean');
      expect(typeof all.danger.maxGlobalAgents).toBe('number');
      expect(typeof all.danger.maxRecursionDepth).toBe('number');
      expect(typeof all.danger.daemon).toBe('boolean');
      expect(typeof all.danger.httpListener).toBe('boolean');
    });

    test('getAll returns tools category with correct field types', () => {
      const mgr = new ConfigManager({ workingDir: tmpDir });
      const all = mgr.getAll();
      expect(typeof all.tools.llmProvider).toBe('string');
      expect(typeof all.tools.llmModel).toBe('string');
      expect(typeof all.tools.autoHeal).toBe('boolean');
      expect(typeof all.tools.defaultTokenBudget).toBe('number');
      expect(typeof all.tools.hooksFile).toBe('string');
    });

    test('getAll snapshot does not reflect subsequent mutations (deep clone)', () => {
      const mgr = new ConfigManager({ workingDir: tmpDir });
      const valueBefore = mgr.get('danger.maxGlobalAgents');
      const snapshot = mgr.getAll();
      // Set to a value that differs from whatever was loaded (pick 1 if current is > 1, else pick 2)
      const newValue = valueBefore !== 1 ? 1 : 2;
      mgr.set('danger.maxGlobalAgents', newValue);
      // Snapshot must not reflect the mutation
      expect(snapshot.danger.maxGlobalAgents).toBe(valueBefore);
      expect(mgr.get('danger.maxGlobalAgents')).toBe(newValue);
    });
  });

  // -------------------------------------------------------------------------
  // DEFAULT_CONFIG shape
  // -------------------------------------------------------------------------

  describe('DEFAULT_CONFIG shape', () => {
    test('DEFAULT_CONFIG.danger has all required keys', () => {
      expect(DEFAULT_CONFIG.danger).toBeDefined();
      expect(typeof DEFAULT_CONFIG.danger.agentRecursion).toBe('boolean');
      expect(typeof DEFAULT_CONFIG.danger.maxGlobalAgents).toBe('number');
      expect(typeof DEFAULT_CONFIG.danger.maxRecursionDepth).toBe('number');
      expect(typeof DEFAULT_CONFIG.danger.daemon).toBe('boolean');
      expect(typeof DEFAULT_CONFIG.danger.httpListener).toBe('boolean');
    });

    test('DEFAULT_CONFIG.tools has all required keys', () => {
      expect(DEFAULT_CONFIG.tools).toBeDefined();
      expect(typeof DEFAULT_CONFIG.tools.llmProvider).toBe('string');
      expect(typeof DEFAULT_CONFIG.tools.llmModel).toBe('string');
      expect(typeof DEFAULT_CONFIG.tools.autoHeal).toBe('boolean');
      expect(typeof DEFAULT_CONFIG.tools.defaultTokenBudget).toBe('number');
      expect(typeof DEFAULT_CONFIG.tools.hooksFile).toBe('string');
    });

    test('DEFAULT_CONFIG is not mutated by ConfigManager instantiation', () => {
      const before = JSON.stringify(DEFAULT_CONFIG);
      new ConfigManager({ workingDir: tmpDir });
      expect(JSON.stringify(DEFAULT_CONFIG)).toBe(before);
    });
  });
});
