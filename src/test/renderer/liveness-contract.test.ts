/**
 * c, liveness contract harness, seeded against the settings modal.
 *
 * The reusable assertions live in ../helpers/liveness.ts so the integrator can
 * point them at the provider/MCP modals. Here they are exercised
 * against a real render surface: a settings modal backed by a frozen-but-
 * updatable ConfigManager (deterministic tmp dir, golden-frames excludes the
 * live-config modal for exactly this reason; we inject one). A values-only
 * update (mutating one visible entry's currentValue, which renderSettingsModal
 * reads via formatValue) must not reflow the table or move the cursor.
 */
import { describe, test, expect } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Line } from '@pellux/goodvibes-sdk/platform/types';
import { createStyledCell } from '@pellux/goodvibes-sdk/platform/types';
import { renderSettingsModal } from '../../renderer/settings-modal.ts';
import { SettingsModal } from '../../input/settings-modal.ts';
import { ConfigManager, ServiceRegistry, SubscriptionManager } from '@pellux/goodvibes-sdk/platform/config';
import { SecretsManager } from '../../config/secrets.ts';
import { createFeatureFlagManager, type FeatureFlagManager } from '@/runtime/index.ts';
import type { McpRegistry } from '@pellux/goodvibes-sdk/platform/mcp';
import {
  assertFrameLiveness,
  differingCells,
  selectionRow,
  DEFAULT_STRUCTURAL_GLYPHS,
} from '../helpers/liveness.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

const W = 120;
const H = 28;

/** Build an open SettingsModal over a deterministic tmp ConfigManager, run `body`, then restore cwd/HOME and clean up. */
function withSettingsModal<T>(body: (modal: SettingsModal, cm: ConfigManager) => T): T {
  const originalCwd = process.cwd();
  const originalHome = process.env.HOME;
  const tmpDir = makeProjectTempDir('gv-liveness-settings');
  try {
    process.env.HOME = tmpDir;
    process.chdir(tmpDir);
    const cm = new ConfigManager({
      surfaceRoot: 'tui',
      workingDir: tmpDir,
      homeDir: tmpDir,
      configDir: join(tmpDir, '.goodvibes', 'global-tui'),
    });
    const ffm: FeatureFlagManager = createFeatureFlagManager();
    const modal = new SettingsModal();
    const subscriptionManager = new SubscriptionManager(join(tmpDir, '.goodvibes', 'tui', 'subscriptions.json'));
    const serviceRegistry = new ServiceRegistry(join(tmpDir, '.goodvibes', 'tui', 'services.json'), {
      secretsManager: new SecretsManager({ projectRoot: tmpDir, globalHome: tmpDir, configManager: cm }),
      subscriptionManager,
    });
    const mcpRegistry = { listServerSecurity: () => [], setServerTrustMode: () => {} } as unknown as McpRegistry;
    mkdirSync(join(tmpDir, '.goodvibes', 'tui'), { recursive: true });
    modal.open(cm, ffm, subscriptionManager, serviceRegistry, mcpRegistry);
    return body(modal, cm);
  } finally {
    process.chdir(originalCwd);
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

/** A different value of a shape that fits the fixed-width Value column (never a reflow). */
function bumpValue(v: unknown): unknown {
  if (typeof v === 'boolean') return !v;
  if (typeof v === 'number') return v + 1;
  if (typeof v === 'string') return v === 'liveness~' ? 'liveness~2' : 'liveness~';
  return 'liveness~';
}

/** Build a Line from a plain string (one cell per char) for the synthetic negative frames. */
function line(text: string): Line {
  return [...text].map((ch) => createStyledCell(ch));
}

describe('liveness contract: settings modal (values-only update)', () => {
  test('a value update on a NON-selected visible row updates in place: no reflow, cursor unchanged, exactly one row differs', () => {
    withSettingsModal((modal) => {
      const items = modal.currentItems;
      // The settings modal's default category lists many settings; entry 1 is a
      // non-selected row rendered below the cursor (selectedIndex starts at 0).
      expect(items.length).toBeGreaterThanOrEqual(2);

      const frameA = renderSettingsModal(modal, W, H);
      const cursorRowA = selectionRow(frameA);
      expect(cursorRowA).toBeGreaterThanOrEqual(0);

      // Values-only update: mutating a NON-selected entry avoids the selected
      // entry's detail-panel echo, so exactly one rendered row changes.
      // renderSettingsModal reads entry.currentValue via formatValue, the same
      // shape as a live config tick.
      items[1]!.currentValue = bumpValue(items[1]!.currentValue);
      const frameB = renderSettingsModal(modal, W, H);

      // Core contract: identical skeleton + width, cursor on the same row.
      assertFrameLiveness(frameA, frameB);
      expect(selectionRow(frameB)).toBe(cursorRowA);

      // Non-vacuous + confined: the value changed on screen, on exactly one row,
      // and no structural glyph was touched.
      const diffs = differingCells(frameA, frameB);
      expect(diffs.length).toBeGreaterThan(0);
      expect(new Set(diffs.map((d) => d.row)).size).toBe(1);
      expect(diffs.some((d) => DEFAULT_STRUCTURAL_GLYPHS.has(d.from) || DEFAULT_STRUCTURAL_GLYPHS.has(d.to))).toBe(false);
    });
  });

  test('an identical re-render trivially satisfies the contract (no diffs)', () => {
    withSettingsModal((modal) => {
      const frameA = renderSettingsModal(modal, W, H);
      const frameB = renderSettingsModal(modal, W, H);
      assertFrameLiveness(frameA, frameB);
      expect(differingCells(frameA, frameB)).toEqual([]);
    });
  });
});

describe('liveness contract: harness is non-vacuous (catches violations)', () => {
  test('a moved structural border FAILS the contract', () => {
    const a = [line('┌────────┐'), line('│ ok     │'), line('└────────┘')];
    // Frame B shifts the left border of the middle row right by one column, a reflow.
    const b = [line('┌────────┐'), line(' │ok     │'), line('└────────┘')];
    expect(() => assertFrameLiveness(a, b)).toThrow();
  });

  test('a jumped selection marker FAILS the contract', () => {
    const a = [line('▸ alpha  '), line('  beta   '), line('  gamma  ')];
    // Same structure, but the cursor marker jumped from row 0 to row 1.
    const b = [line('  alpha  '), line('▸ beta   '), line('  gamma  ')];
    expect(() => assertFrameLiveness(a, b)).toThrow();
  });

  test('an added row (line-count change) FAILS the contract', () => {
    const a = [line('▸ alpha  '), line('  beta   ')];
    const b = [line('▸ alpha  '), line('  beta   '), line('  gamma  ')];
    expect(() => assertFrameLiveness(a, b)).toThrow();
  });

  test('a values-only change on the SAME structure PASSES', () => {
    const a = [line('┌──────┐'), line('▸ v: 1 │'), line('└──────┘')];
    const b = [line('┌──────┐'), line('▸ v: 2 │'), line('└──────┘')];
    expect(() => assertFrameLiveness(a, b)).not.toThrow();
    const diffs = differingCells(a, b);
    expect(diffs).toEqual([{ row: 1, col: 5, from: '1', to: '2' }]);
  });
});

describe('liveness helpers', () => {
  test('selectionRow finds the marker row and returns -1 when absent', () => {
    expect(selectionRow([line('  a'), line('▸ b'), line('  c')])).toBe(1);
    expect(selectionRow([line('  a'), line('  b')])).toBe(-1);
  });

  test('differingCells reports precise (row,col,from,to)', () => {
    expect(differingCells([line('abc')], [line('aXc')])).toEqual([{ row: 0, col: 1, from: 'b', to: 'X' }]);
  });

  test('isValueCell predicate rejects a diff outside the declared value region', () => {
    const a = [line('label: 1')];
    const b = [line('lXbel: 2')]; // one diff in the label (col 1) + one in the value (col 7)
    // Declare only col 7 as a value cell → the stray label diff must fail.
    expect(() => assertFrameLiveness(a, b, { isValueCell: (_r, c) => c === 7 })).toThrow();
    // Declaring both differing columns as value cells passes.
    expect(() => assertFrameLiveness(a, b, { isValueCell: (_r, c) => c === 1 || c === 7 })).not.toThrow();
  });
});
