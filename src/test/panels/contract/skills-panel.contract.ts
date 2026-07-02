import { describe, test, expect } from 'bun:test';
import { SkillsPanel } from '../../../panels/skills-panel.ts';
import { runBasePanelContractSuite, W, H } from './_shared.ts';

runBasePanelContractSuite({
  label: 'SkillsPanel',
  factory: () => new SkillsPanel({ shellPaths: { workingDirectory: '/tmp', homeDirectory: '/tmp' } }),
  hasSelectionGutter: true, // I5: non-color selection affordance
});

// ---------------------------------------------------------------------------
// SkillsPanel — ScrollableListPanel modal filter contract (WO-153)
// ---------------------------------------------------------------------------

describe('SkillsPanel — ScrollableListPanel modal filter contract', () => {
  const makePanel = () => new SkillsPanel({ shellPaths: { workingDirectory: '/tmp', homeDirectory: '/tmp' } });

  test('initial filterQuery is empty string', () => {
    const panel = makePanel();
    expect((panel as unknown as { filterQuery: string }).filterQuery).toBe('');
  });

  test('"/" activates the filter and marks dirty', () => {
    const panel = makePanel();
    panel.needsRender = false;
    panel.handleInput('/');
    expect((panel as unknown as { filterActive: boolean }).filterActive).toBe(true);
    expect(panel.needsRender).toBe(true);
  });

  test('render with filter query does not throw and returns H lines', () => {
    const panel = makePanel();
    (panel as unknown as { filterQuery: string }).filterQuery = 'gather-plan';
    const lines = panel.render(W, H);
    expect(lines).toHaveLength(H);
  });
});
