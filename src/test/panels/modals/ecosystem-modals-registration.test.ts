import { describe, test, expect } from 'bun:test';
import type { ConfigModalSurface } from '../../../input/config-modal-types.ts';
import { marketplaceModalGoldenSurface } from '../../../panels/modals/marketplace-modal.ts';
import { pluginsModalGoldenSurface } from '../../../panels/modals/plugins-modal.ts';
import { skillsModalGoldenSurface } from '../../../panels/modals/skills-modal.ts';
import { hooksModalGoldenSurface } from '../../../panels/modals/hooks-modal.ts';
import { securityModalGoldenSurface } from '../../../panels/modals/security-modal.ts';
import { policyModalGoldenSurface } from '../../../panels/modals/policy-modal.ts';
import { knowledgeModalGoldenSurface } from '../../../panels/modals/knowledge-modal.ts';
import { memoryModalGoldenSurface } from '../../../panels/modals/memory-modal.ts';
import { workPlanModalGoldenSurface } from '../../../panels/modals/work-plan-modal.ts';
import { keybindingsModalGoldenSurface } from '../../../panels/modals/keybindings-modal.ts';
import { pairingModalGoldenSurface } from '../../../panels/modals/pairing-modal.ts';
import { planningModalGoldenSurface } from '../../../panels/modals/planning-modal.ts';

// ---------------------------------------------------------------------------
// Group-B config-modal-surface registration completeness (W6.1 WO-P port).
// The 12 ported ConfigModalSurfaces must all exist under their '-modal' names
// with the required host contract. The panel→modal redirects (including the
// 'sessions' -> 'sessionPicker' fold) are asserted end-to-end against a live
// PanelManager in src/test/release-gates/operator-surfaces-gate.test.ts.
// ---------------------------------------------------------------------------

/** The 12 group-B surfaces this WO owns, by their canonical registered name. */
const EXPECTED_SURFACE_NAMES = [
  'marketplace-modal', 'plugins-modal', 'skills-modal', 'hooks-modal',
  'security-modal', 'policy-modal', 'knowledge-modal', 'memory-modal',
  'work-plan-modal', 'keybindings-modal', 'pairing-modal', 'planning-modal',
];

async function allSurfaces(): Promise<ConfigModalSurface[]> {
  return [
    marketplaceModalGoldenSurface(),
    pluginsModalGoldenSurface(),
    skillsModalGoldenSurface(),
    hooksModalGoldenSurface(),
    securityModalGoldenSurface(),
    policyModalGoldenSurface(),
    knowledgeModalGoldenSurface(),
    await memoryModalGoldenSurface(),
    workPlanModalGoldenSurface(),
    keybindingsModalGoldenSurface(),
    pairingModalGoldenSurface(),
    await planningModalGoldenSurface(),
  ];
}

describe('group-B config-modal surface registration', () => {
  test('all 12 surfaces exist under their canonical -modal names', async () => {
    const surfaces = await allSurfaces();
    expect(surfaces.map((s) => s.name)).toEqual(EXPECTED_SURFACE_NAMES);
  });

  test('every surface satisfies the ConfigModalSurface host contract', async () => {
    for (const surface of await allSurfaces()) {
      expect(typeof surface.buildView).toBe('function');
      const view = surface.buildView();
      expect(typeof view.title).toBe('string');
      expect(view.tabs.length).toBeGreaterThan(0);
      // Each tab has a stable id + label; every row carries a stable id.
      for (const tab of view.tabs) {
        expect(typeof tab.id).toBe('string');
        for (const row of tab.rows) expect(typeof row.id).toBe('string');
      }
    }
  });

  test('row ids are unique within each tab (the host keys its live overlay off them)', async () => {
    for (const surface of await allSurfaces()) {
      for (const tab of surface.buildView().tabs) {
        const ids = tab.rows.map((r) => r.id);
        expect(new Set(ids).size).toBe(ids.length);
      }
    }
  });
});
