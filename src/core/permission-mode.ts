/**
 * Session permission mode — the small vocabulary and cycle logic shared by the
 * Shift+Tab mode-cycle key, the `/plan` toggle, and the footer mode pill.
 *
 * The SDK owns the permission mode: it lives at config key `permissions.mode`
 * and is read by the SDK's PermissionManager.getMode() (which the orchestrator
 * consults for the standing plan-mode instruction). Setting the config value is
 * the SDK-sanctioned way to change the mode — the SDK's mode-change emitter then
 * broadcasts PERMISSION_MODE_CHANGED on the runtime bus so every attached
 * surface can reflect it. This module only maps and cycles the values; it never
 * owns the state.
 *
 * Two vocabularies exist and must not be confused:
 *  - the CONFIG values ('prompt' | 'allow-all' | 'custom' | 'plan' |
 *    'accept-edits') — what is stored and what this module operates on.
 *  - the user-facing LABELS ('normal' | 'auto' | 'custom' | 'plan' |
 *    'accept-edits') — what the pill shows.
 */

/** The config `permissions.mode` values, exactly as the SDK schema defines them. */
export type PermissionModeValue = 'prompt' | 'allow-all' | 'custom' | 'plan' | 'accept-edits';

/**
 * The Shift+Tab cycle order over the four named SESSION modes. `custom` is a
 * per-rule policy, not a session posture, so it is deliberately excluded from
 * the cycle — cycling FROM custom starts at the first entry (normal).
 *
 * Order (matches the settled convention: escalating autonomy, then wrap):
 *   normal → accept-edits → plan → auto → normal
 */
export const PERMISSION_MODE_CYCLE: readonly PermissionModeValue[] = [
  'prompt',
  'accept-edits',
  'plan',
  'allow-all',
] as const;

/** User-facing label for a mode value (what the pill and messages show). */
export function permissionModeLabel(mode: PermissionModeValue | string | undefined): string {
  switch (mode) {
    case 'prompt': return 'normal';
    case 'allow-all': return 'auto';
    case 'plan': return 'plan';
    case 'accept-edits': return 'accept-edits';
    case 'custom': return 'custom';
    default: return 'normal';
  }
}

/**
 * A coarse tone key for the pill, so the renderer can color modes without
 * importing the value vocabulary. `neutral` for normal, `caution` for the
 * autonomy-raising modes, `info` for plan (read-only, safe).
 */
export type PermissionModeTone = 'neutral' | 'info' | 'caution';

export function permissionModeTone(mode: PermissionModeValue | string | undefined): PermissionModeTone {
  switch (mode) {
    case 'plan': return 'info';
    case 'accept-edits': return 'caution';
    case 'allow-all': return 'caution';
    case 'custom': return 'caution';
    default: return 'neutral';
  }
}

/**
 * Next mode in the Shift+Tab cycle. An unknown or `custom` current value maps
 * to the first cycle entry (normal), so the cycle is always well-defined.
 */
export function nextPermissionMode(current: PermissionModeValue | string | undefined): PermissionModeValue {
  const idx = PERMISSION_MODE_CYCLE.indexOf(current as PermissionModeValue);
  if (idx < 0) return PERMISSION_MODE_CYCLE[0];
  return PERMISSION_MODE_CYCLE[(idx + 1) % PERMISSION_MODE_CYCLE.length];
}

/** True when the value is plan mode. */
export function isPlanMode(mode: PermissionModeValue | string | undefined): boolean {
  return mode === 'plan';
}

/**
 * The result of a `/plan` toggle: entering plan mode from any non-plan mode,
 * or leaving it back to normal. Kept here so the command and any future caller
 * agree on the toggle target.
 */
export function togglePlanMode(current: PermissionModeValue | string | undefined): PermissionModeValue {
  return isPlanMode(current) ? 'prompt' : 'plan';
}
