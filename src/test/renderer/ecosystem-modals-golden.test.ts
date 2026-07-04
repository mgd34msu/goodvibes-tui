// ---------------------------------------------------------------------------
// ecosystem-modals-golden.test.ts — golden frames for the W6.1 group-B
// (ecosystem & governance) modal surfaces migrated off retired panels.
//
// Self-contained harness (a minimal copy of golden-frames.test.ts's encoder)
// so this suite is fully decoupled from golden-frames.test.ts — it is edited
// concurrently by WO-A, and keeping my additions in their own file avoids a
// merge hotspot. Goldens land in the shared golden-frames/ dir. Existing
// goldens (splash, fleet, settings, …) are never read or written here.
//
// Each NEW modal surface gets a normal (100 wide) and hostile (28 wide) pair,
// rendered from a frozen deterministic fixture via ModalFactory.createModal.
// Update path: GOODVIBES_UPDATE_GOLDENS=1 bun test <this file>.
// ---------------------------------------------------------------------------

import { describe, test, expect } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ModalFactory } from '../../renderer/modal-factory.ts';
import { EMPTY_VIEW, type BoundModalSurface } from '../../panels/modals/modal-surface.ts';
import { marketplaceModalGoldenSurface } from '../../panels/modals/marketplace-modal.ts';
import { pluginsModalGoldenSurface } from '../../panels/modals/plugins-modal.ts';
import { skillsModalGoldenSurface } from '../../panels/modals/skills-modal.ts';
import { hooksModalGoldenSurface } from '../../panels/modals/hooks-modal.ts';
import { securityModalGoldenSurface } from '../../panels/modals/security-modal.ts';
import { policyModalGoldenSurface } from '../../panels/modals/policy-modal.ts';
import { knowledgeModalGoldenSurface } from '../../panels/modals/knowledge-modal.ts';
import { memoryModalGoldenSurface } from '../../panels/modals/memory-modal.ts';
import { workPlanModalGoldenSurface } from '../../panels/modals/work-plan-modal.ts';
import { keybindingsModalGoldenSurface } from '../../panels/modals/keybindings-modal.ts';
import { pairingModalGoldenSurface } from '../../panels/modals/pairing-modal.ts';
import { planningModalGoldenSurface } from '../../panels/modals/planning-modal.ts';
import type { Cell, Line } from '../../types/grid.ts';

const GOLDENS_DIR = new URL('./golden-frames/', import.meta.url).pathname;
const UPDATE = process.env['GOODVIBES_UPDATE_GOLDENS'] === '1';

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
  if (!existsSync(path)) {
    throw new Error(`[${surface}] golden file missing. Run with GOODVIBES_UPDATE_GOLDENS=1 to generate.`);
  }
  const expected = readFileSync(path, 'utf-8');
  if (expected !== actual) {
    throw new Error(`[${surface}] golden-frame mismatch. Run with GOODVIBES_UPDATE_GOLDENS=1 to regenerate.`);
  }
}

function renderSurface(surface: BoundModalSurface, width: number): Line[] {
  return ModalFactory.createModal(surface.buildConfig(EMPTY_VIEW), width);
}

/**
 * Registry of migrated group-B modal surfaces. Each entry is individually
 * justified in the WO-B report. `factory` must return a surface whose render
 * is deterministic (no wall-clock, no live disk after refresh()).
 */
interface GoldenModalEntry {
  readonly name: string;
  // Async allowed: Promise-backed surfaces (planning) await their initial load
  // in the fixture so the render is deterministic without a test-only hook.
  readonly factory: () => BoundModalSurface | Promise<BoundModalSurface>;
}

const GOLDEN_MODALS: readonly GoldenModalEntry[] = [
  // Each entry is a NEW modal surface migrated from a retired group-B panel;
  // normal (100w) + hostile (28w) pair, individually justified below.

  // marketplace: locks the B30 honest empty-state copy (local publish/import
  // catalog, not a remote store) byte-for-byte — migrated from panel `marketplace`.
  { name: 'marketplace-modal', factory: marketplaceModalGoldenSurface },
  // plugins: trust/quarantine/capability roster view — migrated from panel `plugins`.
  { name: 'plugins-modal', factory: pluginsModalGoldenSurface },
  // skills: project-local/global skill discovery view — migrated from panel `skills`.
  { name: 'skills-modal', factory: skillsModalGoldenSurface },
  // hooks: registered hooks/chains/contracts view — migrated from panel `hooks`.
  { name: 'hooks-modal', factory: hooksModalGoldenSurface },
  // security: token-audit/policy-posture/MCP-quarantine review — migrated from panel `security`.
  { name: 'security-modal', factory: securityModalGoldenSurface },
  // policy: governance bundles/gate/rollout-history view — migrated from panel `policy`.
  { name: 'policy-modal', factory: policyModalGoldenSurface },
  // knowledge: SDK knowledge-graph nodes/sources/issue-queue — migrated from panel `knowledge`.
  { name: 'knowledge-modal', factory: knowledgeModalGoldenSurface },
  // memory: project memory decisions/constraints/patterns — migrated from panel `memory`.
  { name: 'memory-modal', factory: memoryModalGoldenSurface },
  // work-plan: persistent workspace checklist — migrated from panel `work-plan`.
  { name: 'work-plan-modal', factory: workPlanModalGoldenSurface },
  // keybindings: docs (tools/models) + shortcuts-overlay reference merged into
  // one modal — migrated from panel `docs` (merges shortcuts-overlay content).
  { name: 'keybindings-modal', factory: keybindingsModalGoldenSurface },
  // pairing: companion-app pairing (QR + connection info) — migrated from panel `qr-code`.
  { name: 'pairing-modal', factory: pairingModalGoldenSurface },
  // planning: passive project-planning artifacts — migrated from panel `project-planning`.
  { name: 'planning-modal', factory: planningModalGoldenSurface },
];

const SIZES = [
  { label: 'normal', width: 100 },
  { label: 'hostile', width: 28 },
] as const;

for (const entry of GOLDEN_MODALS) {
  describe(`ecosystem-modal golden — ${entry.name}`, () => {
    for (const size of SIZES) {
      const surfaceName = `${entry.name}-${size.label}`;
      test(`${size.label} width matches committed golden`, async () => {
        const lines = renderSurface(await entry.factory(), size.width);
        expect(lines.length).toBeGreaterThan(0);
        assertGolden(surfaceName, lines);
      });
      test(`${size.label} width render is deterministic`, async () => {
        const a = snapshotEncode(surfaceName, renderSurface(await entry.factory(), size.width));
        const b = snapshotEncode(surfaceName, renderSurface(await entry.factory(), size.width));
        expect(a).toBe(b);
      });
    }
  });
}
