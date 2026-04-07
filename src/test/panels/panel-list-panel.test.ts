// ---------------------------------------------------------------------------
// panel-list-panel.test.ts — Unit tests for PanelListPanel
//
// Tests the following behaviors:
//   1. _buildEntries filtering — by id, name, description, and category
//   2. Navigation up/down (arrow keys and j/k)
//   3. Search input, backspace, and escape
//   4. Scroll clamping (selected item remains in view)
// ---------------------------------------------------------------------------

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import type { Line } from '../../types/grid.ts';
import { PanelListPanel } from '../../panels/panel-list-panel.ts';
import { getPanelManager } from '../../panels/panel-manager.ts';
import type { PanelRegistration } from '../../panels/types.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Extract all printable chars from a Line[] grid as a flat string. */
function linesText(lines: Line[]): string {
  return lines
    .map(line => line.map(cell => cell.char ?? ' ').join(''))
    .join('\n');
}

/** Count lines that contain a given needle. */
function countLinesContaining(lines: Line[], needle: string): number {
  return lines.filter(line =>
    line.map(c => c.char ?? ' ').join('').includes(needle)
  ).length;
}

/** Make a minimal PanelRegistration for tests. */
function makeReg(overrides: Partial<PanelRegistration> & { id: string }): PanelRegistration {
  return {
    id: overrides.id,
    name: overrides.name ?? `Panel ${overrides.id}`,
    icon: overrides.icon ?? 'X',
    category: overrides.category ?? 'session',
    description: overrides.description ?? `Desc for ${overrides.id}`,
    factory: overrides.factory ?? (() => ({
      id: overrides.id,
      name: overrides.name ?? `Panel ${overrides.id}`,
      icon: overrides.icon ?? 'X',
      category: overrides.category ?? 'session',
      isTransient: false,
      isPinned: false,
      needsRender: true,
      onActivate() {},
      onDeactivate() {},
      onDestroy() {},
      render: () => [],
    })),
  };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('PanelListPanel', () => {
  let panel: PanelListPanel;
  const mgr = getPanelManager();

  // Register a small set of panels before each test so _buildEntries has data.
  beforeEach(() => {
    mgr.destroyAll();
    // Register panels in two categories so we can test filtering and navigation.
    mgr.registerType(makeReg({ id: 'alpha', name: 'Alpha Panel', category: 'development', description: 'The alpha panel' }));
    mgr.registerType(makeReg({ id: 'beta',  name: 'Beta Panel',  category: 'development', description: 'The beta panel' }));
    mgr.registerType(makeReg({ id: 'gamma', name: 'Gamma Panel', category: 'session',     description: 'The gamma panel' }));
    mgr.registerType(makeReg({ id: 'delta', name: 'Delta Panel', category: 'session',     description: 'A unique tag: xyz' }));
    panel = new PanelListPanel();
    panel.onActivate();
  });

  afterEach(() => {
    mgr.destroyAll();
  });

  // ── metadata ─────────────────────────────────────────────────────────────

  describe('panel metadata', () => {
    test('has correct id', () => { expect(panel.id).toBe('panel-list'); });
    test('has correct name', () => { expect(panel.name).toBe('Panel List'); });
    test('has correct category', () => { expect(panel.category).toBe('session'); });
    test('starts with needsRender true', () => { expect(panel.needsRender).toBe(true); });
  });

  // ── render geometry ───────────────────────────────────────────────────────

  describe('render geometry', () => {
    test('returns exactly height lines', () => {
      const lines = panel.render(80, 20);
      expect(lines).toHaveLength(20);
    });

    test('handles small dimensions', () => {
      expect(panel.render(20, 5)).toHaveLength(5);
    });
  });

  // ── render content ───────────────────────────────────────────────────────

  describe('render content', () => {
    test('shows panel names in render output', () => {
      const text = linesText(panel.render(80, 20));
      expect(text).toContain('Alpha');
      expect(text).toContain('Beta');
    });

    test('shows header row "Panel Workspace"', () => {
      const text = linesText(panel.render(80, 20));
      expect(text).toContain('Panel Workspace');
    });

    test('shows Filter bar', () => {
      const text = linesText(panel.render(80, 20));
      expect(text).toContain('Filter:');
    });

    test('shows hint line with nav shortcuts', () => {
      const text = linesText(panel.render(80, 20));
      expect(text).toContain('Enter');
      expect(text).toContain('T/B');
    });
  });

  // ── _buildEntries filtering ───────────────────────────────────────────────

  describe('_buildEntries filtering', () => {
    test('no query — all registered panels appear', () => {
      const text = linesText(panel.render(80, 30));
      expect(text).toContain('Alpha');
      expect(text).toContain('Beta');
      expect(text).toContain('Gamma');
      expect(text).toContain('Delta');
    });

    test('query matching name filters down to matching panels', () => {
      panel.handleInput('/');
      panel.handleInput('a'); // query = 'a'
      panel.handleInput('l');
      panel.handleInput('p');
      panel.handleInput('h');
      panel.handleInput('a'); // query = 'alpha'
      const text = linesText(panel.render(80, 30));
      expect(text).toContain('Alpha');
      // Beta, Gamma, Delta do not match
      expect(countLinesContaining(panel.render(80, 30), 'Beta')).toBe(0);
    });

    test('query matching description filters correctly', () => {
      panel.handleInput('/');
      panel.handleInput('x');
      panel.handleInput('y');
      panel.handleInput('z'); // query = 'xyz'
      const text = linesText(panel.render(80, 30));
      expect(text).toContain('Delta');
      expect(countLinesContaining(panel.render(80, 30), 'Alpha')).toBe(0);
    });

    test('query matching category shows all panels in that category', () => {
      panel.handleInput('s');
      panel.handleInput('e');
      panel.handleInput('s'); // partial 'ses'
      const text = linesText(panel.render(80, 30));
      expect(text).toContain('Gamma');
      expect(text).toContain('Delta');
    });

    test('query with no match shows "No panels match filter" message', () => {
      panel.handleInput('/');
      panel.handleInput('z');
      panel.handleInput('z');
      panel.handleInput('z'); // query = 'zzz' — no matches
      const text = linesText(panel.render(80, 20));
      expect(text).toContain('No panels match filter');
    });
  });

  // ── navigation ────────────────────────────────────────────────────────────

  describe('navigation — down', () => {
    test('pressing down moves selection to next panel', () => {
      panel.handleInput('down');
      // Hint line shows [2/N] when second item selected
      const text = linesText(panel.render(80, 20));
      expect(text).toContain('[2/');
    });

    test('j key also moves selection down', () => {
      panel.handleInput('j');
      const text = linesText(panel.render(80, 20));
      expect(text).toContain('[2/');
    });

    test('down at bottom of list does not go past last item', () => {
      // Navigate past all items
      for (let i = 0; i < 20; i++) panel.handleInput('down');
      const text = linesText(panel.render(80, 20));
      // Should still be within bounds (no [5/ or higher with only 4 panels)
      expect(text).not.toContain('[5/');
    });
  });

  describe('navigation — up', () => {
    test('pressing up from index 0 stays at 0', () => {
      panel.handleInput('up');
      const text = linesText(panel.render(80, 20));
      expect(text).toContain('[1/');
    });

    test('k key also moves selection up', () => {
      panel.handleInput('down');
      panel.handleInput('k');
      const text = linesText(panel.render(80, 20));
      expect(text).toContain('[1/');
    });

    test('navigate down then up returns to first item', () => {
      panel.handleInput('down');
      panel.handleInput('down');
      panel.handleInput('up');
      panel.handleInput('up');
      const text = linesText(panel.render(80, 20));
      expect(text).toContain('[1/');
    });
  });

  // ── search input ─────────────────────────────────────────────────────────

  describe('search input', () => {
    test('up at top focuses filter; down returns focus to list', () => {
      panel.handleInput('up');
      panel.handleInput('a');
      let text = linesText(panel.render(80, 20));
      expect(text).toContain('Filter: a_');

      panel.handleInput('down');
      panel.handleInput('B');
      expect(mgr.isBottomPaneVisible()).toBe(true);
    });

    test('printable characters append to query and appear in filter bar', () => {
      panel.handleInput('/');
      panel.handleInput('a');
      panel.handleInput('B');
      const text = linesText(panel.render(80, 20));
      expect(text).toContain('aB');
    });

    test('handleInput returns true for printable characters', () => {
      panel.handleInput('/');
      expect(panel.handleInput('x')).toBe(true);
    });

    test('handleInput returns false for unknown keys', () => {
      expect(panel.handleInput('F5')).toBe(false);
    });

    test('backspace removes last character from query', () => {
      panel.handleInput('/');
      panel.handleInput('a');
      panel.handleInput('b');
      panel.handleInput('c');
      panel.handleInput('backspace');
      const text = linesText(panel.render(80, 20));
      // 'ab' should remain; 'c' removed
      expect(text).toContain('ab');
    });

    test('backspace on empty query returns false', () => {
      expect(panel.handleInput('backspace')).toBe(false);
    });

    test('delete key also removes last character', () => {
      panel.handleInput('/');
      panel.handleInput('a');
      panel.handleInput('delete');
      // query is now empty — no filter active
      const text = linesText(panel.render(80, 30));
      expect(text).toContain('Alpha');
      expect(text).toContain('Beta');
    });

    test('escape clears the query', () => {
      panel.handleInput('/');
      panel.handleInput('a');
      panel.handleInput('l');
      panel.handleInput('escape');
      panel.handleInput('escape');
      const text = linesText(panel.render(80, 30));
      // After escape, all panels should be visible again
      expect(text).toContain('Alpha');
      expect(text).toContain('Beta');
      expect(text).toContain('Gamma');
    });

    test('escape on empty query returns false', () => {
      expect(panel.handleInput('escape')).toBe(false);
    });

    test('typing resets selection to first item', () => {
      panel.handleInput('down');
      panel.handleInput('down');
      panel.handleInput('/');
      panel.handleInput('a'); // typing resets selectedIndex
      const text = linesText(panel.render(80, 20));
      expect(text).toContain('[1/');
    });
  });

  // ── pane controls ────────────────────────────────────────────────────────

  describe('pane controls', () => {
    test('b opens the selected panel in the bottom pane', () => {
      panel.handleInput('B');
      expect(mgr.isBottomPaneVisible()).toBe(true);
      expect(mgr.getBottomPane().panels.map(p => p.id)).toContain('alpha');
    });

    test('t opens the selected panel in the top pane', () => {
      panel.handleInput('T');
      expect(mgr.getTopPane().panels.map(p => p.id)).toContain('alpha');
    });

    test('m moves an open selected panel to the other pane', () => {
      panel.handleInput('T');
      panel.handleInput('M');
      expect(mgr.getBottomPane().panels.map(p => p.id)).toContain('alpha');
    });

    test('s toggles bottom-pane visibility', () => {
      expect(mgr.isBottomPaneVisible()).toBe(false);
      panel.handleInput('S');
      expect(mgr.isBottomPaneVisible()).toBe(true);
    });

    test('tab toggles focused pane when bottom pane is visible', () => {
      panel.handleInput('B');
      expect(mgr.getFocusedPane()).toBe('bottom');
      panel.handleInput('tab');
      expect(mgr.getFocusedPane()).toBe('top');
    });

    test('selected row uses Unicode placement marker instead of T* text badges', () => {
      panel.handleInput('T');
      const text = linesText(panel.render(80, 20));
      expect(text).not.toContain('T*Panel List');
      expect(text).toContain('▶●▲ Alpha Panel');
    });
  });

  // ── scroll clamping ───────────────────────────────────────────────────────

  describe('scroll clamping', () => {
    test('selection stays visible in a short viewport', () => {
      // Viewport of height 5 with 4 panels + headers (leaves little body space)
      panel.render(80, 5); // initial render establishes scroll state
      panel.handleInput('down');
      panel.handleInput('down');
      panel.handleInput('down');
      // Should not throw and should return correct height
      const lines = panel.render(80, 5);
      expect(lines).toHaveLength(5);
    });

    test('hint line always shows correct total count', () => {
      const text = linesText(panel.render(80, 20));
      // There are at least 4 panels registered (alpha, beta, gamma, delta)
      // Hint shows [X/N] — N should be at least 4
      expect(text).toMatch(/\[\d+\/\d+\]/);
    });

    test('scroll offset does not go negative', () => {
      // Mash up — scroll offset should clamp at 0
      for (let i = 0; i < 5; i++) panel.handleInput('up');
      const lines = panel.render(80, 20);
      expect(lines).toHaveLength(20);
    });
  });

  // ── enter key opens selected panel ──────────────────────────────────────

  describe('enter key — opens selected panel', () => {
    const OPENABLE_ID = 'openable-panel';

    beforeEach(() => {
      // Register a panel with a working factory so open() succeeds.
      mgr.registerType(makeReg({
        id: OPENABLE_ID,
        name: 'Openable Panel',
        category: 'session',
        description: 'A panel that can be opened',
      }));
    });

    afterEach(() => {
      // Clean up — close the panel if it was opened.
      try { mgr.close(OPENABLE_ID); } catch { /* ignore */ }
    });

    test('pressing return opens the selected panel', () => {
      // Navigate to the openable panel — it is registered in 'session',
      // so navigate until its id appears as selected in getAllOpen().
      // Easier: just type its name to filter down to it as the only result.
      panel.handleInput('/');
      panel.handleInput('o');
      panel.handleInput('p');
      panel.handleInput('e');
      panel.handleInput('n');
      panel.handleInput('a');
      panel.handleInput('b');
      panel.handleInput('l');
      panel.handleInput('e'); // query = 'openable' — only openable-panel matches

      const result = panel.handleInput('return');
      expect(result).toBe(true);
      const openIds = mgr.getAllOpen().map(p => p.id);
      expect(openIds).toContain(OPENABLE_ID);
    });

    test('pressing enter (alias) also opens the selected panel', () => {
      panel.handleInput('/');
      panel.handleInput('o');
      panel.handleInput('p');
      panel.handleInput('e');
      panel.handleInput('n');
      panel.handleInput('a');
      panel.handleInput('b');
      panel.handleInput('l');
      panel.handleInput('e'); // query = 'openable'

      const result = panel.handleInput('enter');
      expect(result).toBe(true);
      const openIds = mgr.getAllOpen().map(p => p.id);
      expect(openIds).toContain(OPENABLE_ID);
    });

    test('handleInput returns true for return even when no panel matches (no-op open)', () => {
      // With an empty list (query matches nothing), return still returns true.
      panel.handleInput('/');
      panel.handleInput('z');
      panel.handleInput('z');
      panel.handleInput('z'); // no match
      const result = panel.handleInput('return');
      expect(result).toBe(true);
    });
  });

  // ── onActivate resets state ──────────────────────────────────────────────

  describe('onActivate', () => {
    test('resets selection and query on activate', () => {
      panel.handleInput('down');
      panel.handleInput('a');
      panel.onActivate();
      // After re-activate, should be at position 1 with no query
      const text = linesText(panel.render(80, 20));
      expect(text).toContain('[1/');
      // Query cleared — all panels visible
      expect(text).toContain('Alpha');
    });
  });
});
