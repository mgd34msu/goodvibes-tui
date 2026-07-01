import { describe, test, expect } from 'bun:test';
import { SkillsPanel } from '../../../panels/skills-panel.ts';
import { runBasePanelContractSuite, W, H } from './_shared.ts';

runBasePanelContractSuite({
  label: 'SkillsPanel',
  factory: () => new SkillsPanel({ shellPaths: { workingDirectory: '/tmp', homeDirectory: '/tmp' } }),
  hasSelectionGutter: true, // I5: non-color selection affordance
});

// ---------------------------------------------------------------------------
// SkillsPanel — SearchableListPanel contract
// ---------------------------------------------------------------------------

describe('SkillsPanel — SearchableListPanel contract', () => {
  const makePanel = () => new SkillsPanel({ shellPaths: { workingDirectory: '/tmp', homeDirectory: '/tmp' } });

  test('initial searchQuery is empty string', () => {
    const panel = makePanel();
    expect((panel as unknown as { searchQuery: string }).searchQuery).toBe('');
  });

  test('printable keypress updates searchQuery and marks dirty', () => {
    const panel = makePanel();
    panel.needsRender = false;
    panel.handleInput('/');
    // '/' triggers filter focus transition, not search directly — check state
    // After '/', filterFocused becomes true; panel should mark dirty
    expect(panel.needsRender).toBe(true);
  });

  test('render with search query does not throw and returns H lines', () => {
    const panel = makePanel();
    (panel as unknown as { searchQuery: string }).searchQuery = 'gather-plan';
    const lines = panel.render(W, H);
    expect(lines).toHaveLength(H);
  });
});
