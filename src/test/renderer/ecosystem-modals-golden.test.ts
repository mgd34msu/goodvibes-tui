// ---------------------------------------------------------------------------
// ecosystem-modals-golden.test.ts, golden frames for the group-B
// (ecosystem & governance) modal surfaces, RE-BASELINED through the canonical
// config-modal host (group-B port).
//
// Each surface is opened in a real ConfigModal and rendered via
// renderConfigModal on the modal surface kit (the exact production render
// path); the layer is composed over a blank dimmed screen with frameFromLayer,
// as the compositor stamps it. Each surface gets a normal (100 wide) and
// hostile (28 wide) pair.
//
// Update path: GOODVIBES_UPDATE_GOLDENS=1 bun test <this file>.
// ---------------------------------------------------------------------------

import { describe, test, expect } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ConfigModal } from '../../input/config-modal.ts';
import { renderConfigModal } from '../../renderer/config-modal.ts';
import type { ConfigModalSurface } from '../../input/config-modal-types.ts';
import { marketplaceModalGoldenSurface } from '../../views/modals/marketplace-modal.ts';
import { pluginsModalGoldenSurface } from '../../views/modals/plugins-modal.ts';
import { skillsModalGoldenSurface } from '../../views/modals/skills-modal.ts';
import { hooksModalGoldenSurface } from '../../views/modals/hooks-modal.ts';
import { securityModalGoldenSurface } from '../../views/modals/security-modal.ts';
import { policyModalGoldenSurface } from '../../views/modals/policy-modal.ts';
import { knowledgeModalGoldenSurface } from '../../views/modals/knowledge-modal.ts';
import { memoryModalGoldenSurface } from '../../views/modals/memory-modal.ts';
import { workPlanModalGoldenSurface } from '../../views/modals/work-plan-modal.ts';
import { keybindingsModalGoldenSurface } from '../../views/modals/keybindings-modal.ts';
import { pairingModalGoldenSurface } from '../../views/modals/pairing-modal.ts';
import { planningModalGoldenSurface } from '../../views/modals/planning-modal.ts';
import type { Cell, Line } from '@pellux/goodvibes-sdk/platform/types';
import { frameFromLayer } from '../helpers/surface-frame.ts';

const GOLDENS_DIR = new URL('./golden-frames/', import.meta.url).pathname;
const UPDATE = process.env['GOODVIBES_UPDATE_GOLDENS'] === '1';
const HEIGHT = 40;

function snapshotEncode(surface: string, lines: Line[]): string {
  const height = lines.length;
  const width = lines[0]?.length ?? 0;
  const textBlock: string[] = [];
  const styleBlock: string[] = [];
  for (let row = 0; row < height; row++) {
    const line = lines[row]!;
    textBlock.push(`|${line.map((c) => (c.char === '' ? ' ' : c.char)).join('')}|`);
    for (let col = 0; col < line.length; col++) {
      const c = line[col] as Cell;
      if (c.fg) styleBlock.push(`${row} ${col} fg=${c.fg}`);
      if (c.bg) styleBlock.push(`${row} ${col} bg=${c.bg}`);
      if (c.bold) styleBlock.push(`${row} ${col} bold=1`);
      if (c.dim) styleBlock.push(`${row} ${col} dim=1`);
      if (c.underline) styleBlock.push(`${row} ${col} underline=1`);
      if (c.italic) styleBlock.push(`${row} ${col} italic=1`);
      if (c.strikethrough) styleBlock.push(`${row} ${col} strikethrough=1`);
    }
  }
  return [`# GV_GOLDEN surface=${surface} width=${width} height=${height}`, ...textBlock, '@STYLES', ...styleBlock, ''].join('\n');
}

function assertGolden(surface: string, lines: Line[]): void {
  const actual = snapshotEncode(surface, lines);
  const path = join(GOLDENS_DIR, `${surface}.txt`);
  if (UPDATE) {
    mkdirSync(GOLDENS_DIR, { recursive: true });
    writeFileSync(path, actual, 'utf-8');
    return;
  }
  if (!existsSync(path)) throw new Error(`[${surface}] golden file missing. Run with GOODVIBES_UPDATE_GOLDENS=1 to generate.`);
  const expected = readFileSync(path, 'utf-8');
  if (expected !== actual) throw new Error(`[${surface}] golden-frame mismatch. Run with GOODVIBES_UPDATE_GOLDENS=1 to regenerate.`);
}

/**
 * Open a surface in the real host and render it, the production render path.
 *
 * Note (c) harness fix: ConfigModal.open() freezes the tab structure from
 * buildView() BEFORE surface.onOpen()'s refresh() loads its rows, and
 * getRenderModel() only overlays live values onto the FROZEN row ids, so a
 * naive render immediately after open() locks the pre-refresh chrome (empty
 * rows), not real content. We flush a microtask turn (settles any async
 * onOpen; the Promise-backed surfaces also pre-await inside their factory)
 * then syncStructure() to re-freeze from the post-refresh buildView(), so the
 * committed golden locks content, not chrome.
 */
async function renderSurface(surface: ConfigModalSurface, width: number): Promise<Line[]> {
  const modal = new ConfigModal();
  modal.open(surface, () => {});
  await Promise.resolve();
  modal.syncStructure();
  const lines = frameFromLayer(renderConfigModal(modal, width, HEIGHT), width, HEIGHT);
  modal.close();
  return lines;
}

interface GoldenModalEntry {
  readonly name: string;
  readonly factory: () => ConfigModalSurface | Promise<ConfigModalSurface>;
}

const GOLDEN_MODALS: readonly GoldenModalEntry[] = [
  // marketplace: locks the honest empty-state copy byte-for-byte INSIDE the host render.
  { name: 'marketplace-modal', factory: marketplaceModalGoldenSurface },
  { name: 'plugins-modal', factory: pluginsModalGoldenSurface },
  { name: 'skills-modal', factory: skillsModalGoldenSurface },
  { name: 'hooks-modal', factory: hooksModalGoldenSurface },
  { name: 'security-modal', factory: securityModalGoldenSurface },
  { name: 'policy-modal', factory: policyModalGoldenSurface },
  { name: 'knowledge-modal', factory: knowledgeModalGoldenSurface },
  { name: 'memory-modal', factory: memoryModalGoldenSurface },
  { name: 'work-plan-modal', factory: workPlanModalGoldenSurface },
  { name: 'keybindings-modal', factory: keybindingsModalGoldenSurface },
  { name: 'pairing-modal', factory: pairingModalGoldenSurface },
  // planning: Promise-backed surface (awaits its initial async load in the fixture).
  { name: 'planning-modal', factory: planningModalGoldenSurface },
];

const SIZES = [
  { label: 'normal', width: 100 },
  { label: 'hostile', width: 28 },
] as const;

for (const entry of GOLDEN_MODALS) {
  describe(`group-B modal golden (host-rendered): ${entry.name}`, () => {
    for (const size of SIZES) {
      const surfaceName = `${entry.name}-${size.label}`;
      test(`${size.label} width matches committed golden`, async () => {
        const lines = await renderSurface(await entry.factory(), size.width);
        expect(lines.length).toBeGreaterThan(0);
        assertGolden(surfaceName, lines);
      });
      test(`${size.label} width render is deterministic`, async () => {
        const a = snapshotEncode(surfaceName, await renderSurface(await entry.factory(), size.width));
        const b = snapshotEncode(surfaceName, await renderSurface(await entry.factory(), size.width));
        expect(a).toBe(b);
      });
    }
  });
}
