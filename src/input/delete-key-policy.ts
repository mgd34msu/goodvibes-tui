// ---------------------------------------------------------------------------
// Delete-key policy, single source of truth for text-editing key semantics
//
// In text-editing contexts:
//   'backspace'  → delete one character backward (the character before cursor /
//                  the last character in an end-anchored buffer)
//   'delete'     → forward-delete (the character after cursor) when a moveable
//                  cursor exists; a no-op in cursorless/end-anchored contexts,
//                  EXCEPT where it opens a confirmation-gated clear action
//                  (see planning panel: Delete opens the ConfirmState gate that
//                  lets the user clear their entire draft answer).
//
// Consequences for each surface:
//   Panel search filters (end-anchored, no cursor)
//     'backspace' → remove last char   ✓
//     'delete'    → no-op              ✓ (no cursor; nothing is "forward")
//
//   Selection modal filters (end-anchored, no cursor)
//     'backspace' → remove last char   ✓
//     'delete'    → no-op              ✓
//
//   Planning panel draft answer (end-anchored, no cursor)
//     'backspace' → remove last char   ✓
//     'delete'    → open ConfirmState gate (y/Enter confirms clear; n/Esc cancels)
//                   The draft is NOT wiped until the user confirms.
//
// NEVER assign bulk-destructive actions (clear / wipe) to the Delete key
// without an explicit confirmation gate.
// ---------------------------------------------------------------------------

/**
 * Returns true when `key` should perform a backward-delete (remove the
 * character before the cursor / at end of an end-anchored buffer).
 */
export function isTextBackspace(key: string): boolean {
  return key === 'backspace';
}

/**
 * Returns true when `key` should perform a forward-delete (remove the
 * character after the cursor). Only meaningful when a moveable cursor
 * exists; callers should treat this as a no-op when there is no cursor.
 */
export function isTextForwardDelete(key: string): boolean {
  return key === 'delete';
}
