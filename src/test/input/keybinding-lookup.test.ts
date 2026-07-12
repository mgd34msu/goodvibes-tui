/**
 * O(1) keybinding lookup via KeybindingsManager.lookup().
 *
 * Verifies that lookup() returns the correct KeyAction for all default bindings
 * and returns null for tokens that match no binding.
 */
import { describe, it, expect } from 'bun:test';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  KeybindingsManager,
  DEFAULT_KEYBINDINGS,
  type KeyAction,
} from '../../input/keybindings.ts';

function makeKm(): KeybindingsManager {
  return new KeybindingsManager({ configPath: '/nonexistent/keybindings.json' });
}

describe('KeybindingsManager.lookup()', () => {
  it('returns the correct action for every default combo', () => {
    const km = makeKm();
    for (const [action, combos] of Object.entries(DEFAULT_KEYBINDINGS) as [KeyAction, typeof DEFAULT_KEYBINDINGS[KeyAction]][]) {
      for (const combo of combos) {
        const result = km.lookup({
          logicalName: combo.key,
          ctrl: combo.ctrl ?? false,
          shift: combo.shift ?? false,
          alt: combo.alt ?? false,
        });
        expect(result).toBe(action);
      }
    }
  });

  it('returns null for a token that matches no binding', () => {
    const km = makeKm();
    // 'q' with no modifiers is not bound to any default action.
    expect(km.lookup({ logicalName: 'q' })).toBeNull();
  });

  it('returns null for undefined logicalName', () => {
    const km = makeKm();
    expect(km.lookup({})).toBeNull();
  });

  it('b: panel-tab-prev is Ctrl+PageUp and Ctrl+[ (the ESC-byte split-brain) no longer binds it', () => {
    const km = makeKm();
    expect(km.lookup({ logicalName: 'pageup', ctrl: true })).toBe('panel-tab-prev');
    // Ctrl+[ is byte 0x1B (ESC); it must no longer resolve to panel-tab-prev.
    expect(km.lookup({ logicalName: '[', ctrl: true })).toBeNull();
  });

  it('b: panel-tab-next keeps Ctrl+] and gains Ctrl+PageDown', () => {
    const km = makeKm();
    expect(km.lookup({ logicalName: ']', ctrl: true })).toBe('panel-tab-next');
    expect(km.lookup({ logicalName: 'pagedown', ctrl: true })).toBe('panel-tab-next');
  });

  it('returns null when modifier mismatch (ctrl required but absent)', () => {
    const km = makeKm();
    // search = Ctrl+F; without ctrl must not match.
    expect(km.lookup({ logicalName: 'f', ctrl: false })).toBeNull();
  });

  it('returns null when modifier mismatch (extra alt)', () => {
    const km = makeKm();
    // search = Ctrl+F (no alt); with extra alt must not match.
    expect(km.lookup({ logicalName: 'f', ctrl: true, alt: true })).toBeNull();
  });

  it('rebuilds map correctly after loadFromDisk() real override', () => {
    // Create a temp config that remaps 'search' from Ctrl+F to Ctrl+G
    const dir = join(tmpdir(), `gv-kb-test-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    const configPath = join(dir, 'keybindings.json');
    writeFileSync(configPath, JSON.stringify({ search: { key: 'g', ctrl: true } }), 'utf-8');
    try {
      const km = new KeybindingsManager({ configPath });
      km.loadFromDisk();
      // After override: Ctrl+G => search, Ctrl+F => null
      expect(km.lookup({ logicalName: 'g', ctrl: true })).toBe('search');
      expect(km.lookup({ logicalName: 'f', ctrl: true })).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('conflicting bindings: last-writer-wins (deterministic)', () => {
    // Map both 'search' and 'clear-cancel' to Ctrl+X in the config.
    // buildLookupMap iterates Object.entries(this.bindings) in DEFAULT_KEYBINDINGS
    // declaration order — NOT config file order. 'clear-cancel' appears at key
    // position 2 in DEFAULT_KEYBINDINGS; 'search' appears at position 10.
    // Therefore 'search' is the last writer for Ctrl+X and wins.
    // Contract: last-writer-wins is the documented conflict resolution policy.
    const dir = join(tmpdir(), `gv-kb-conflict-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    const configPath = join(dir, 'keybindings.json');
    // Both search and clear-cancel mapped to Ctrl+X; search is last (DEFAULT_KEYBINDINGS order)
    writeFileSync(configPath, JSON.stringify({
      search: { key: 'x', ctrl: true },
      'clear-cancel': { key: 'x', ctrl: true },
    }), 'utf-8');
    try {
      const km = new KeybindingsManager({ configPath });
      km.loadFromDisk();
      const result = km.lookup({ logicalName: 'x', ctrl: true });
      // 'search' is the last writer (DEFAULT_KEYBINDINGS order: search after clear-cancel).
      expect(result).toBe('search');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
