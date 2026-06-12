/**
 * Context status hint tests — TASK-056.
 *
 * Validates:
 *  1. Hint appears on suggest-compact and needs-repair signals.
 *  2. Hint is null for stable, watch, and unknown levels.
 *  3. Auto-compact vs manual wording is toggled by autoCompactEnabled.
 *  4. Usage percent is reflected in the hint text.
 */
import { describe, test, expect } from 'bun:test';
import { buildContextStatusHint } from '../../renderer/context-status-hint.ts';
import type { PanelSessionMaintenanceLevel } from '../../panels/session-maintenance.ts';

describe('buildContextStatusHint', () => {
  test('returns null for stable level', () => {
    expect(buildContextStatusHint({ level: 'stable', autoCompactEnabled: false, usagePct: 30 })).toBeNull();
  });

  test('returns null for watch level', () => {
    expect(buildContextStatusHint({ level: 'watch', autoCompactEnabled: false, usagePct: 72 })).toBeNull();
  });

  test('returns null for unknown level', () => {
    expect(buildContextStatusHint({ level: 'unknown', autoCompactEnabled: false, usagePct: 0 })).toBeNull();
  });

  test('returns a hint string for suggest-compact (manual mode)', () => {
    const hint = buildContextStatusHint({ level: 'suggest-compact', autoCompactEnabled: false, usagePct: 85 });
    expect(hint).not.toBeNull();
    expect(hint).toContain('85%');
    expect(hint).toContain('/compact');
  });

  test('returns a hint string for suggest-compact (auto mode)', () => {
    const hint = buildContextStatusHint({ level: 'suggest-compact', autoCompactEnabled: true, usagePct: 83 });
    expect(hint).not.toBeNull();
    expect(hint).toContain('83%');
    // Auto mode should mention auto-compact running, not prompt user to /compact
    expect(hint).toContain('auto-compact');
    expect(hint).not.toContain('/compact');
  });

  test('returns a hint string for needs-repair', () => {
    const hint = buildContextStatusHint({ level: 'needs-repair', autoCompactEnabled: false, usagePct: 92 });
    expect(hint).not.toBeNull();
    expect(hint).toContain('critical');
    expect(hint).toContain('/compact');
  });

  test('returns a hint string for compacting level', () => {
    const hint = buildContextStatusHint({ level: 'compacting', autoCompactEnabled: true, usagePct: 80 });
    expect(hint).not.toBeNull();
    expect(hint).toContain('Compact');
  });

  test('hint disappears when level returns to stable (boundary)', () => {
    const levels: PanelSessionMaintenanceLevel[] = ['stable', 'watch', 'unknown'];
    for (const level of levels) {
      expect(buildContextStatusHint({ level, autoCompactEnabled: false, usagePct: 50 })).toBeNull();
    }
  });

  test('hint appears at actionable levels (boundary)', () => {
    const levels: PanelSessionMaintenanceLevel[] = ['suggest-compact', 'needs-repair', 'compacting'];
    for (const level of levels) {
      expect(buildContextStatusHint({ level, autoCompactEnabled: false, usagePct: 80 })).not.toBeNull();
    }
  });
});
