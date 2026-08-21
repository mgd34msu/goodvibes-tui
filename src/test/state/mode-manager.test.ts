import { describe, test, expect, beforeEach } from 'bun:test';
import { ModeManager } from '@pellux/goodvibes-sdk/platform/state';
import type { ModeDefinition } from '@pellux/goodvibes-sdk/platform/state';
import { getTestModeManager, resetTestRuntimeServices, disposeTestRuntimeServicesAfterAll } from '../helpers/runtime-services.ts';

// Stop the shared test runtime graph when this file ends. Called here, not
// registered inside the helper, for the reason its doc comment gives.
disposeTestRuntimeServicesAfterAll();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Each suite resets shared helper state so tests are independent.
function freshManager(): ModeManager {
  resetTestRuntimeServices();
  return getTestModeManager();
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

    test('listModes returns a copy: mutating it does not affect internal state', () => {
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

    test('returns a copy: mutating it does not affect subsequent calls', () => {
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

  describe('runtime ownership', () => {
    test('test runtime exposes one mode manager per runtime graph', () => {
      resetTestRuntimeServices();
      const a = getTestModeManager();
      const b = getTestModeManager();
      expect(a).toBe(b);
    });

    test('resetting the test runtime yields a fresh mode manager', () => {
      const a = getTestModeManager();
      a.setMode('vibecoding');
      resetTestRuntimeServices();
      const b = getTestModeManager();
      expect(b.getMode()).toBe('default');
    });

    test('state changes remain visible through the same runtime graph', () => {
      resetTestRuntimeServices();
      getTestModeManager().setMode('justvibes');
      expect(getTestModeManager().getMode()).toBe('justvibes');
    });
  });
});
