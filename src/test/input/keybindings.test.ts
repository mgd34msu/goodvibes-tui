import { describe, it, expect, beforeEach } from 'bun:test';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  KeybindingsManager,
  DEFAULT_KEYBINDINGS,
  resetKeybindingsManager,
  getKeybindingsManager,
  type KeyAction,
  type KeyCombo,
} from '../../input/keybindings.ts';

type KeybindingsManagerTestAccess = {
  bindings: Record<string, KeyCombo[]>;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

function makeTmpDir(): string {
  const dir = join(tmpdir(), `gv-kb-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function makeConfigPath(): string {
  return join(tmpDir, 'keybindings.json');
}

function writeConfig(obj: unknown): string {
  const path = makeConfigPath();
  writeFileSync(path, JSON.stringify(obj), 'utf-8');
  return path;
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  tmpDir = makeTmpDir();
  resetKeybindingsManager();
});

// ---------------------------------------------------------------------------
// Default bindings
// ---------------------------------------------------------------------------

describe('default bindings', () => {
  it('loads all default actions with at least one combo each', () => {
    const km = new KeybindingsManager('/nonexistent/path/keybindings.json');
    const all = km.getAll();
    expect(all.length).toBe(Object.keys(DEFAULT_KEYBINDINGS).length);
    for (const entry of all) {
      expect(entry.combos.length).toBeGreaterThanOrEqual(1);
    }
  });

  it('default bindings match the exported DEFAULT_KEYBINDINGS constant', () => {
    const km = new KeybindingsManager('/nonexistent/path/keybindings.json');
    const all = km.getAll();
    for (const entry of all) {
      const expected = DEFAULT_KEYBINDINGS[entry.action as KeyAction];
      expect(entry.combos).toEqual(expected);
    }
  });
});

// ---------------------------------------------------------------------------
// matches()
// ---------------------------------------------------------------------------

describe('matches()', () => {
  it('returns true for a token that matches the default combo', () => {
    const km = new KeybindingsManager('/nonexistent/path/keybindings.json');
    // search = Ctrl+F
    expect(km.matches('search', { logicalName: 'f', ctrl: true })).toBe(true);
  });

  it('returns true for matching action with shift modifier', () => {
    const km = new KeybindingsManager('/nonexistent/path/keybindings.json');
    // copy-selection = Ctrl+Shift+C
    expect(km.matches('copy-selection', { logicalName: 'c', ctrl: true, shift: true })).toBe(true);
  });

  it('returns false when key does not match', () => {
    const km = new KeybindingsManager('/nonexistent/path/keybindings.json');
    expect(km.matches('search', { logicalName: 'g', ctrl: true })).toBe(false);
  });

  it('returns false when ctrl modifier differs', () => {
    const km = new KeybindingsManager('/nonexistent/path/keybindings.json');
    // search requires ctrl; token has no ctrl
    expect(km.matches('search', { logicalName: 'f' })).toBe(false);
  });

  it('returns false when shift modifier differs', () => {
    const km = new KeybindingsManager('/nonexistent/path/keybindings.json');
    // copy-selection requires shift; omitting it must fail
    expect(km.matches('copy-selection', { logicalName: 'c', ctrl: true })).toBe(false);
  });

  it('returns false when alt modifier is unexpected', () => {
    const km = new KeybindingsManager('/nonexistent/path/keybindings.json');
    // search has no alt; token has alt
    expect(km.matches('search', { logicalName: 'f', ctrl: true, alt: true })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// loadFromDisk() — override merging
// ---------------------------------------------------------------------------

describe('loadFromDisk()', () => {
  it('merges user overrides correctly (single combo)', () => {
    const configPath = writeConfig({ search: { key: 'g', ctrl: true } });
    const km = new KeybindingsManager(configPath);
    km.loadFromDisk();
    // overridden: now Ctrl+G
    expect(km.matches('search', { logicalName: 'g', ctrl: true })).toBe(true);
    // old default Ctrl+F must no longer match
    expect(km.matches('search', { logicalName: 'f', ctrl: true })).toBe(false);
  });

  it('merges user overrides correctly (array of combos)', () => {
    const configPath = writeConfig({
      search: [{ key: 'f', ctrl: true }, { key: 'g', ctrl: true }],
    });
    const km = new KeybindingsManager(configPath);
    km.loadFromDisk();
    expect(km.matches('search', { logicalName: 'f', ctrl: true })).toBe(true);
    expect(km.matches('search', { logicalName: 'g', ctrl: true })).toBe(true);
  });

  it('does not throw when config file is missing', () => {
    const km = new KeybindingsManager(makeConfigPath());
    expect(() => km.loadFromDisk()).not.toThrow();
  });

  it('retains defaults when config file is missing', () => {
    const km = new KeybindingsManager(makeConfigPath());
    km.loadFromDisk();
    expect(km.matches('search', { logicalName: 'f', ctrl: true })).toBe(true);
  });

  it('handles malformed JSON gracefully (no throw)', () => {
    const path = makeConfigPath();
    writeFileSync(path, '{ invalid json !!', 'utf-8');
    const km = new KeybindingsManager(path);
    expect(() => km.loadFromDisk()).not.toThrow();
  });

  it('retains defaults when JSON is malformed', () => {
    const path = makeConfigPath();
    writeFileSync(path, '{ invalid json !!', 'utf-8');
    const km = new KeybindingsManager(path);
    km.loadFromDisk();
    expect(km.matches('search', { logicalName: 'f', ctrl: true })).toBe(true);
  });

  it('rejects unknown actions with a debug log (no throw, no binding change)', () => {
    const configPath = writeConfig({ 'totally-unknown-action': { key: 'x', ctrl: true } });
    const km = new KeybindingsManager(configPath);
    expect(() => km.loadFromDisk()).not.toThrow();
    // The real actions must still be intact
    expect(km.matches('search', { logicalName: 'f', ctrl: true })).toBe(true);
  });

  it('rejects invalid combos missing the key field', () => {
    const configPath = writeConfig({ search: { ctrl: true } }); // no key
    const km = new KeybindingsManager(configPath);
    km.loadFromDisk();
    // search must fall back to default Ctrl+F
    expect(km.matches('search', { logicalName: 'f', ctrl: true })).toBe(true);
  });

  it('rejects invalid combos that are non-objects', () => {
    const configPath = writeConfig({ search: 'invalid-string-combo' });
    const km = new KeybindingsManager(configPath);
    km.loadFromDisk();
    // search must fall back to default Ctrl+F
    expect(km.matches('search', { logicalName: 'f', ctrl: true })).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// formatCombo()
// ---------------------------------------------------------------------------

describe('formatCombo()', () => {
  it('formats Ctrl+F correctly', () => {
    const km = new KeybindingsManager('/nonexistent/path/keybindings.json');
    expect(km.formatCombo({ key: 'f', ctrl: true })).toBe('Ctrl+F');
  });

  it('formats Ctrl+Shift+Z correctly', () => {
    const km = new KeybindingsManager('/nonexistent/path/keybindings.json');
    expect(km.formatCombo({ key: 'z', ctrl: true, shift: true })).toBe('Ctrl+Shift+Z');
  });

  it('formats Alt+X correctly', () => {
    const km = new KeybindingsManager('/nonexistent/path/keybindings.json');
    expect(km.formatCombo({ key: 'x', alt: true })).toBe('Alt+X');
  });

  it('formats a named key (no modifier) correctly', () => {
    const km = new KeybindingsManager('/nonexistent/path/keybindings.json');
    expect(km.formatCombo({ key: 'return' })).toBe('return');
  });

  it('uppercases single-char keys', () => {
    const km = new KeybindingsManager('/nonexistent/path/keybindings.json');
    expect(km.formatCombo({ key: 'a' })).toBe('A');
  });
});

// ---------------------------------------------------------------------------
// getComboLabel()
// ---------------------------------------------------------------------------

describe('getComboLabel()', () => {
  it('returns the formatted label for a bound action', () => {
    const km = new KeybindingsManager('/nonexistent/path/keybindings.json');
    expect(km.getComboLabel('search')).toBe('Ctrl+F');
  });

  it('returns "(unbound)" for an action with no combos', () => {
    const mgr = new KeybindingsManager('/nonexistent/path/keybindings.json');
    // Bypass validateCombos by injecting an empty array directly into the bindings map
    (mgr as unknown as KeybindingsManagerTestAccess).bindings['copy-selection'] = [];
    expect(mgr.getComboLabel('copy-selection')).toBe('(unbound)');
  });
});

// ---------------------------------------------------------------------------
// resetKeybindingsManager() / singleton
// ---------------------------------------------------------------------------

describe('resetKeybindingsManager()', () => {
  it('clears the singleton so getKeybindingsManager() returns a fresh instance', () => {
    const first = getKeybindingsManager();
    resetKeybindingsManager();
    const second = getKeybindingsManager();
    expect(first).not.toBe(second);
  });

  it('fresh singleton after reset retains default bindings', () => {
    resetKeybindingsManager();
    const km = getKeybindingsManager();
    expect(km.matches('search', { logicalName: 'f', ctrl: true })).toBe(true);
  });
});
