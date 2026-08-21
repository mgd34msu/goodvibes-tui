/**
 * Context status hint tests, TASK-056.
 *
 * Validates:
 *  1. Hint appears on suggest-compact and needs-repair signals.
 *  2. Hint is null for stable, watch, and unknown levels.
 *  3. Auto-compact vs manual wording is toggled by autoCompactEnabled.
 *  4. Usage percent is reflected in the hint text.
 *  5. The boot state (no tokens counted yet, window still the provider
 *     fallback) produces NO pressure hint, the regression that shipped
 *     "Context high (0% used), auto-compact will run before the next turn."
 *     to every launch. Every case above therefore states real, resolved
 *     numbers, because a pressure claim now has to be backed by them.
 *
 * These drive `resolveContextStatusHint`, the module's one public seam and
 * the exact call main.ts's render loop makes. The evaluator is stubbed so a
 * case can pin a maintenance level directly; what is NOT stubbed is the
 * relationship between that level and the numbers behind it, which is the
 * thing that went wrong.
 */
import { describe, test, expect } from 'bun:test';
import { resolveContextStatusHint } from '../../renderer/context-status-hint.ts';
import { DEFAULT_CONTEXT_WINDOW } from '@pellux/goodvibes-sdk/platform/providers';
import type { PanelSessionMaintenanceLevel } from '../../panels/session-maintenance.ts';

/** Real, provider-vouched numbers by default: a 200k window with usage actually counted. */
function hint(
  level: PanelSessionMaintenanceLevel,
  autoCompactEnabled: boolean,
  usagePct: number,
  opts: { currentTokens?: number; contextWindow?: number } = {},
): string | null {
  const contextWindow = opts.contextWindow ?? 200_000;
  const currentTokens = opts.currentTokens ?? Math.round((usagePct / 100) * contextWindow);
  return resolveContextStatusHint({
    evaluate: () => ({ level, autoCompactEnabled, usagePct }),
    currentTokens,
    contextWindow,
  });
}

describe('resolveContextStatusHint', () => {
  test('returns null for stable level', () => {
    expect(hint('stable', false, 30)).toBeNull();
  });

  test('returns null for watch level', () => {
    expect(hint('watch', false, 72)).toBeNull();
  });

  test('returns null for unknown level', () => {
    expect(hint('unknown', false, 0)).toBeNull();
  });

  test('returns a hint string for suggest-compact (manual mode)', () => {
    const text = hint('suggest-compact', false, 85);
    expect(text).not.toBeNull();
    expect(text).toContain('85%');
    expect(text).toContain('/compact');
  });

  test('returns a hint string for suggest-compact (auto mode)', () => {
    const text = hint('suggest-compact', true, 83);
    expect(text).not.toBeNull();
    expect(text).toContain('83%');
    // Auto mode should mention auto-compact running, not prompt user to /compact
    expect(text).toContain('auto-compact');
    expect(text).not.toContain('/compact');
  });

  test('returns a hint string for needs-repair', () => {
    const text = hint('needs-repair', false, 92);
    expect(text).not.toBeNull();
    expect(text).toContain('critical');
    expect(text).toContain('/compact');
  });

  test('returns a hint string for compacting level', () => {
    const text = hint('compacting', true, 80);
    expect(text).not.toBeNull();
    expect(text).toContain('Compact');
  });

  test('hint disappears when level returns to stable (boundary)', () => {
    const levels: PanelSessionMaintenanceLevel[] = ['stable', 'watch', 'unknown'];
    for (const level of levels) {
      expect(hint(level, false, 50)).toBeNull();
    }
  });

  test('hint appears at actionable levels (boundary)', () => {
    const levels: PanelSessionMaintenanceLevel[] = ['suggest-compact', 'needs-repair', 'compacting'];
    for (const level of levels) {
      expect(hint(level, false, 80)).not.toBeNull();
    }
  });

  test('the evaluator is handed exactly the numbers the guards use; they cannot be given different ones', () => {
    const seen: Array<{ currentTokens: number; contextWindow: number }> = [];
    resolveContextStatusHint({
      evaluate: (args) => { seen.push(args); return { level: 'stable', autoCompactEnabled: true, usagePct: 10 }; },
      currentTokens: 1234,
      contextWindow: 297_800,
    });
    expect(seen).toEqual([{ currentTokens: 1234, contextWindow: 297_800 }]);
  });
});

describe('boot state: a pressure claim must be backed by real numbers', () => {
  // What a real v1.19.6 boot actually looked like: nothing counted yet, and
  // the resolved window still the SDK's DEFAULT_CONTEXT_WINDOW fallback. The
  // evaluator legitimately reports 'suggest-compact' here, because 8,192 free
  // tokens is under its 15,000-token remaining-headroom rule.
  const bootHint = (
    level: PanelSessionMaintenanceLevel = 'suggest-compact',
    over: { currentTokens?: number; contextWindow?: number; usagePct?: number } = {},
  ): string | null => hint(level, true, over.usagePct ?? 0, {
    currentTokens: over.currentTokens ?? 0,
    contextWindow: over.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
  });

  test('no hint at boot: zero usage against the placeholder window', () => {
    expect(bootHint()).toBeNull();
  });

  test('the exact false sentence is never produced at boot', () => {
    expect(bootHint() ?? '').not.toContain('auto-compact will run before the next turn');
    expect(bootHint() ?? '').not.toContain('0% used');
  });

  test('no hint when the window is unknown (zero) even at a nonzero token count', () => {
    expect(bootHint('suggest-compact', { currentTokens: 4_000, contextWindow: 0, usagePct: 40 })).toBeNull();
  });

  test('no hint when tokens have been counted but the window is still the fallback', () => {
    expect(bootHint('suggest-compact', { currentTokens: 4_000, usagePct: 49 })).toBeNull();
  });

  test('needs-repair is held to the same evidence bar', () => {
    expect(bootHint('needs-repair')).toBeNull();
  });

  test('once the real window resolves and tokens are counted, the hint returns', () => {
    const text = bootHint('suggest-compact', { currentTokens: 250_000, usagePct: 84, contextWindow: 297_800 });
    expect(text).toContain('84% used');
    expect(text).toContain('auto-compact');
  });

  test("'compacting' is exempt: it reports work that is provably running, not predicted pressure", () => {
    expect(bootHint('compacting')).toContain('Compacting');
  });
});
