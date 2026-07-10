import { describe, expect, test } from 'bun:test';
import {
  PERMISSION_MODE_CYCLE,
  nextPermissionMode,
  permissionModeLabel,
  permissionModeTone,
  isPlanMode,
  togglePlanMode,
} from '../../core/permission-mode.ts';

describe('permission-mode', () => {
  test('cycle order is normal → accept-edits → plan → auto → normal', () => {
    expect([...PERMISSION_MODE_CYCLE]).toEqual(['prompt', 'accept-edits', 'plan', 'allow-all']);
    expect(nextPermissionMode('prompt')).toBe('accept-edits');
    expect(nextPermissionMode('accept-edits')).toBe('plan');
    expect(nextPermissionMode('plan')).toBe('allow-all');
    expect(nextPermissionMode('allow-all')).toBe('prompt');
  });

  test('cycling from custom or unknown starts at normal', () => {
    expect(nextPermissionMode('custom')).toBe('prompt');
    expect(nextPermissionMode(undefined)).toBe('prompt');
    expect(nextPermissionMode('nonsense')).toBe('prompt');
  });

  test('labels map config values to user-facing names', () => {
    expect(permissionModeLabel('prompt')).toBe('normal');
    expect(permissionModeLabel('allow-all')).toBe('auto');
    expect(permissionModeLabel('plan')).toBe('plan');
    expect(permissionModeLabel('accept-edits')).toBe('accept-edits');
    expect(permissionModeLabel('custom')).toBe('custom');
    expect(permissionModeLabel(undefined)).toBe('normal');
  });

  test('tones: normal neutral, plan info, autonomy modes caution', () => {
    expect(permissionModeTone('prompt')).toBe('neutral');
    expect(permissionModeTone('plan')).toBe('info');
    expect(permissionModeTone('accept-edits')).toBe('caution');
    expect(permissionModeTone('allow-all')).toBe('caution');
    expect(permissionModeTone('custom')).toBe('caution');
  });

  test('plan-mode toggle enters plan from any non-plan and leaves to normal', () => {
    expect(isPlanMode('plan')).toBe(true);
    expect(isPlanMode('prompt')).toBe(false);
    expect(togglePlanMode('prompt')).toBe('plan');
    expect(togglePlanMode('accept-edits')).toBe('plan');
    expect(togglePlanMode('allow-all')).toBe('plan');
    expect(togglePlanMode('plan')).toBe('prompt');
  });
});
