import { describe, test, expect, beforeEach } from 'bun:test';
import { ModeManager } from '../../state/mode-manager.ts';
import type { ModeDefinition } from '../../state/mode-manager.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Each test suite resets the singleton so tests are independent.
function freshManager(): ModeManager {
  ModeManager.resetInstance();
  return ModeManager.getInstance();
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('ModeManager', () => {
  let mgr: ModeManager;

  beforeEach(() => {
    mgr = freshManager();
  });

  // -------------------------------------------------------------------------
  // getMode / setMode
  // -------------------------------------------------------------------------

  describe('getMode', () => {
    test('default mode on startup is "default"', () => {
      expect(mgr.getMode()).toBe('default');
    });
  });

  describe('setMode', () => {
    test('switches to vibecoding', () => {
      mgr.setMode('vibecoding');
      expect(mgr.getMode()).toBe('vibecoding');
    });

    test('switches to justvibes', () => {
      mgr.setMode('justvibes');
      expect(mgr.getMode()).toBe('justvibes');
    });

    test('switches back to default', () => {
      mgr.setMode('vibecoding');
      mgr.setMode('default');
      expect(mgr.getMode()).toBe('default');
    });

    test('throws for unknown mode name', () => {
      expect(() => mgr.setMode('nonexistent')).toThrow('Unknown mode: "nonexistent"');
    });

    test('error message lists available modes', () => {
      expect(() => mgr.setMode('bad')).toThrow(/Available modes:/);
    });
  });

  // -------------------------------------------------------------------------
  // listModes
  // -------------------------------------------------------------------------

  describe('listModes', () => {
    test('returns exactly three built-in modes', () => {
      const modes = mgr.listModes();
      expect(modes).toHaveLength(3);
    });

    test('includes default, vibecoding, justvibes', () => {
      const names = mgr.listModes().map(m => m.name);
      expect(names).toContain('default');
      expect(names).toContain('vibecoding');
      expect(names).toContain('justvibes');
    });

    test('each mode has a non-empty description', () => {
      mgr.listModes().forEach(m => {
        expect(typeof m.description).toBe('string');
        expect(m.description.length).toBeGreaterThan(0);
      });
    });

    test('each mode has an enforcement field of strict or advisory', () => {
      mgr.listModes().forEach(m => {
        expect(['strict', 'advisory']).toContain(m.enforcement);
      });
    });

    test('listModes returns a copy — mutating it does not affect internal state', () => {
      const modes = mgr.listModes();
      modes.push({ name: 'injected', description: 'bad', verbosityDefaults: {}, enforcement: 'advisory' });
      expect(mgr.listModes()).toHaveLength(3);
    });
  });

  // -------------------------------------------------------------------------
  // getVerbosityDefaults
  // -------------------------------------------------------------------------

  describe('getVerbosityDefaults', () => {
    test('default mode has correct verbosity defaults', () => {
      const defaults = mgr.getVerbosityDefaults();
      expect(defaults.write).toBe('standard');
      expect(defaults.edit).toBe('with_diff');
      expect(defaults.read).toBe('standard');
      expect(defaults.grep).toBe('matches');
      expect(defaults.glob).toBe('paths_only');
      expect(defaults.exec).toBe('standard');
    });

    test('vibecoding mode has correct verbosity defaults', () => {
      mgr.setMode('vibecoding');
      const defaults = mgr.getVerbosityDefaults();
      expect(defaults.write).toBe('count_only');
      expect(defaults.edit).toBe('minimal');
      expect(defaults.read).toBe('standard');
      expect(defaults.grep).toBe('files_only');
      expect(defaults.glob).toBe('paths_only');
      expect(defaults.exec).toBe('minimal');
    });

    test('justvibes mode has correct verbosity defaults', () => {
      mgr.setMode('justvibes');
      const defaults = mgr.getVerbosityDefaults();
      expect(defaults.write).toBe('count_only');
      expect(defaults.edit).toBe('minimal');
      expect(defaults.read).toBe('standard');
      expect(defaults.grep).toBe('files_only');
      expect(defaults.glob).toBe('paths_only');
      expect(defaults.exec).toBe('minimal');
    });

    test('returns a copy — mutating it does not affect subsequent calls', () => {
      const d1 = mgr.getVerbosityDefaults();
      d1.write = 'verbose';
      const d2 = mgr.getVerbosityDefaults();
      expect(d2.write).toBe('standard');
    });
  });

  // -------------------------------------------------------------------------
  // registerMode
  // -------------------------------------------------------------------------

  describe('registerMode', () => {
    const customMode: ModeDefinition = {
      name: 'custom',
      description: 'My custom mode',
      verbosityDefaults: {
        write: 'verbose',
        edit: 'verbose',
        read: 'verbose',
        grep: 'context',
        glob: 'paths_only',
        exec: 'verbose',
      },
      enforcement: 'strict',
    };

    test('registers a custom mode that appears in listModes', () => {
      mgr.registerMode(customMode);
      const names = mgr.listModes().map(m => m.name);
      expect(names).toContain('custom');
    });

    test('can set mode to a registered custom mode', () => {
      mgr.registerMode(customMode);
      mgr.setMode('custom');
      expect(mgr.getMode()).toBe('custom');
    });

    test('custom mode verbosity defaults are returned correctly', () => {
      mgr.registerMode(customMode);
      mgr.setMode('custom');
      const defaults = mgr.getVerbosityDefaults();
      expect(defaults.write).toBe('verbose');
      expect(defaults.exec).toBe('verbose');
    });

    test('registering with same name overwrites the existing mode', () => {
      const updated: ModeDefinition = {
        ...customMode,
        name: 'default',
        description: 'Overwritten default',
      };
      mgr.registerMode(updated);
      const found = mgr.listModes().find(m => m.name === 'default');
      expect(found?.description).toBe('Overwritten default');
    });

    test('total mode count increases after registering new mode', () => {
      mgr.registerMode(customMode);
      expect(mgr.listModes()).toHaveLength(4);
    });
  });

  // -------------------------------------------------------------------------
  // Singleton
  // -------------------------------------------------------------------------

  describe('singleton', () => {
    test('getInstance returns the same instance', () => {
      ModeManager.resetInstance();
      const a = ModeManager.getInstance();
      const b = ModeManager.getInstance();
      expect(a).toBe(b);
    });

    test('resetInstance causes next getInstance to return a fresh instance', () => {
      const a = ModeManager.getInstance();
      a.setMode('vibecoding');
      ModeManager.resetInstance();
      const b = ModeManager.getInstance();
      expect(b.getMode()).toBe('default');
    });

    test('state changes are visible across getInstance calls without reset', () => {
      ModeManager.resetInstance();
      ModeManager.getInstance().setMode('justvibes');
      expect(ModeManager.getInstance().getMode()).toBe('justvibes');
    });
  });
});
