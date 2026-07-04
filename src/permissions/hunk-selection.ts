import type { PermissionPromptRequest } from '@pellux/goodvibes-sdk/platform/permissions';

/**
 * Per-hunk accept/reject at the approval gate (W1.3 v1).
 *
 * Scoped to the `edit` tool only: EditInput.edits is already an array of
 * independent, atomic find/replace units (each a natural "hunk"), so no
 * diff/hunk-apply primitive is needed here. The `write` (whole-file
 * overwrite) tool stays whole-payload accept/reject — true whole-file hunk
 * splitting would require a genuinely new SDK diff/patch-apply primitive,
 * flagged as an explicit v2 follow-up, not built here.
 *
 * NOTE ON SDK TYPES: the installed @pellux/goodvibes-sdk (0.36.0) does not
 * yet export `EditItem`/`EditInput` from its `platform/tools` subpath (that
 * export is added in the in-flight SDK change for this work order, landing
 * in 0.37). Until then this module reads `request.args.edits` defensively
 * off a narrow local structural type rather than importing a not-yet-published
 * symbol, per the cross-repo compile contract for this wave.
 */

/** Structural shape of one EditItem, read defensively — see module doc. */
export interface EditItemLike {
  readonly path: string;
  readonly find: string;
  readonly replace: string;
  readonly id?: string | undefined;
}

export interface HunkSelectionState {
  readonly hunks: readonly EditItemLike[];
  readonly cursor: number;
  readonly selected: ReadonlySet<number>;
}

export type HunkCommit = 'apply' | 'cancel' | null;

/**
 * Structural widening of the installed SDK's `PermissionPromptDecision`
 * (0.36.0, no `modifiedArgs` field yet) so main.ts can resolve a decision
 * carrying `modifiedArgs` without a nominal import of a not-yet-published
 * SDK symbol. Assign to a variable of this type before calling the SDK's
 * typed `resolve(decision: PermissionPromptDecision)` — passing a variable
 * (not an object literal) sidesteps TypeScript's excess-property check, and
 * the extra field is invisible to 0.36.0 callers, structurally compatible
 * once 0.37 adds it for real.
 */
export interface PermissionPromptDecisionWithModifiedArgs {
  approved: boolean;
  remember?: boolean;
  modifiedArgs?: Record<string, unknown>;
}

export interface HunkKeyResult {
  readonly state: HunkSelectionState;
  readonly commit: HunkCommit;
}

/** Runtime guard: is `value` shaped like an EditItem? */
function isEditItemLike(value: unknown): value is EditItemLike {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate['path'] === 'string' &&
    typeof candidate['find'] === 'string' &&
    typeof candidate['replace'] === 'string' &&
    (candidate['id'] === undefined || typeof candidate['id'] === 'string')
  );
}

/** Extracts a validated EditItemLike[] from a permission request's args, or null if not edit-shaped. */
function readEditItems(args: Record<string, unknown>): EditItemLike[] | null {
  const edits = args['edits'];
  if (!Array.isArray(edits) || edits.length === 0) return null;
  const items: EditItemLike[] = [];
  for (const entry of edits) {
    if (!isEditItemLike(entry)) return null;
    items.push(entry);
  }
  return items;
}

/**
 * isHunkSelectable — true iff this is a multi-edit `edit` tool call. Single-edit
 * `edit` calls, `write` calls, and everything else keep the exact current
 * y/a/n flow untouched (zero behavior change for the common case).
 */
export function isHunkSelectable(request: PermissionPromptRequest): boolean {
  if (request.tool !== 'edit') return false;
  const items = readEditItems(request.args);
  return items !== null && items.length > 1;
}

/** Builds initial hunk-selection state — all hunks selected by default (matches today's "y = approve everything" expectation as the zero-navigation path). */
export function buildHunkSelectionState(request: PermissionPromptRequest): HunkSelectionState {
  const hunks = readEditItems(request.args) ?? [];
  return {
    hunks,
    cursor: 0,
    selected: new Set(hunks.map((_, i) => i)),
  };
}

/**
 * applyHunkKey — pure reducer over raw stdin `data` for an active hunk-selection
 * prompt. Mirrors the outer y/a/n prompt's raw-data key routing (not the
 * normalized panel key vocabulary) since Space must be distinguishable from
 * the trimmed/lowercased `key` the outer switch uses.
 */
export function applyHunkKey(state: HunkSelectionState, data: string): HunkKeyResult {
  const lower = data.toLowerCase().trim();

  if (data === 'j' || data === '\x1b[B') {
    return { state: { ...state, cursor: Math.min(state.hunks.length - 1, state.cursor + 1) }, commit: null };
  }
  if (data === 'k' || data === '\x1b[A') {
    return { state: { ...state, cursor: Math.max(0, state.cursor - 1) }, commit: null };
  }
  if (data === ' ') {
    const next = new Set(state.selected);
    if (next.has(state.cursor)) {
      next.delete(state.cursor);
    } else {
      next.add(state.cursor);
    }
    return { state: { ...state, selected: next }, commit: null };
  }
  if (lower === 'a') {
    return { state: { ...state, selected: new Set(state.hunks.map((_, i) => i)) }, commit: null };
  }
  if (data === '\r' || data === '\n') {
    if (state.selected.size === 0) {
      // No-op: nothing selected, prompt stays open rather than applying an empty edit.
      return { state, commit: null };
    }
    return { state, commit: 'apply' };
  }
  if (lower === 'y') {
    // Bypass-navigation shortcut: preserves muscle memory for non-hunk prompts.
    return { state: { ...state, selected: new Set(state.hunks.map((_, i) => i)) }, commit: 'apply' };
  }
  if (lower === 'n' || data === '\x1b' || data === '\x03') {
    return { state, commit: 'cancel' };
  }

  return { state, commit: null };
}

/**
 * buildModifiedEditArgs — returns request.args with `edits` filtered to exactly
 * the selected hunks (in original order), preserving every other EditInput
 * field (match/transaction/output/dry_run/validate) untouched.
 */
export function buildModifiedEditArgs(
  request: PermissionPromptRequest,
  state: HunkSelectionState,
): Record<string, unknown> {
  const filtered = state.hunks.filter((_, i) => state.selected.has(i));
  return { ...request.args, edits: filtered };
}

/**
 * buildPendingPermissionExtras — the `hunkState` + wrapped `resolve` fields
 * main.ts spreads onto its PendingPermissionState alongside `...request`.
 * Bundled into one helper (rather than inlined in main.ts) to keep main.ts's
 * net line count at zero for this change — main.ts sits at the 800-line
 * architecture cap and must never grow it.
 */
export function buildPendingPermissionExtras(
  request: PermissionPromptRequest,
  resolvePromise: (decision: PermissionPromptDecisionWithModifiedArgs) => void,
): {
  hunkState: HunkSelectionState | undefined;
  resolve: (approved: boolean, remember?: boolean, modifiedArgs?: Record<string, unknown>) => void;
} {
  return {
    hunkState: isHunkSelectable(request) ? buildHunkSelectionState(request) : undefined,
    resolve: (approved, remember = false, modifiedArgs) => resolvePromise({ approved, remember, modifiedArgs }),
  };
}
