/**
 * hint-grammar.ts, the single hint-bar grammar for every overlay footer.
 *
 * one grammar across the model picker, settings modal, help/shortcuts
 * overlays, and ModalFactory variants so footers stop drifting into three
 * different dialects (verbless brackets, prose sentences, ad-hoc separators).
 *
 * The grammar is:
 *   - each hint renders as `[Key] Verb` (a bracketed key followed by its verb),
 *   - hints are joined by a middle-dot separator (` · `),
 *   - any Escape hint is always sorted last (the conventional "way out").
 *
 * State segments that are not key hints (e.g. `Filter: All`) can be appended
 * verbatim via {@link joinHints}; they are never reordered.
 */

/** A single key hint. `verb` may be omitted for a bare key affordance. */
export interface HintSpec {
  key: string;
  verb?: string;
}

/** The canonical separator between hint segments. */
export const HINT_SEPARATOR = ' · ';

function isEscapeHint(spec: HintSpec): boolean {
  return spec.key.trim().toLowerCase() === 'esc';
}

/** Render one hint as `[Key] Verb` (or `[Key]` when it has no verb). */
function formatHint(spec: HintSpec): string {
  return spec.verb ? `[${spec.key}] ${spec.verb}` : `[${spec.key}]`;
}

/**
 * Format a list of key hints into a single footer string using the shared
 * grammar. Escape hints are moved to the end (stable for everything else).
 */
export function formatHints(specs: readonly HintSpec[]): string {
  // Stable partition: non-escape hints keep their order, escape hints trail.
  const ordered = [...specs].sort((a, b) => Number(isEscapeHint(a)) - Number(isEscapeHint(b)));
  return ordered.map(formatHint).join(HINT_SEPARATOR);
}

/**
 * Join already-rendered segments (hint bars, state tags) with the shared
 * separator, dropping empties. Order is preserved, use this to append state
 * indicators after a {@link formatHints} bar.
 */
export function joinHints(...segments: Array<string | null | undefined>): string {
  return segments.filter((s): s is string => !!s && s.length > 0).join(HINT_SEPARATOR);
}
