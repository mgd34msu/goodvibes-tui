/**
 * lane-graph/semantic-memo.ts, the ◈ semantic summary of an opened edit's
 * diff, computed once per diff and remembered.
 *
 * computeSemanticDiff parses with tree-sitter and is asynchronous, while the
 * transcript renders synchronously. The first render of an opened edit starts
 * the computation and draws without the summary; when it lands, every
 * registered listener is told so the transcript repaints with it. The summary
 * compares the diff's own before and after text (context plus removed lines
 * against context plus added lines), so it names what the edit touched.
 *
 * Bounded: the most recent MAX_ENTRIES diffs are kept.
 */

import type { SemanticDiff } from '../semantic-diff.ts';

const MAX_ENTRIES = 200;

const memo = new Map<string, SemanticDiff | null | 'pending'>();
const listeners = new Set<() => void>();
let generation = 0;

/** Bumps every time a summary lands: a render that drew an opened diff keys its cache on it. */
export function semanticSummaryGeneration(): number {
  return generation;
}

/** Be told when a summary that was being computed is ready. Returns the unsubscribe. */
export function onSemanticSummaryReady(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function beforeAfter(diff: string): { before: string; after: string } {
  const before: string[] = [];
  const after: string[] = [];
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('@@') || line.startsWith('diff ') || line.startsWith('index ')) continue;
    if (line.startsWith('+')) after.push(line.slice(1));
    else if (line.startsWith('-')) before.push(line.slice(1));
    else if (line.startsWith(' ')) { before.push(line.slice(1)); after.push(line.slice(1)); }
  }
  return { before: before.join('\n'), after: after.join('\n') };
}

/**
 * The summary for `diff`: a SemanticDiff, null when there is none to show,
 * or undefined while it is being computed (the first call starts it).
 */
export function semanticSummaryFor(diff: string, path: string | undefined): SemanticDiff | null | undefined {
  if (!path) return null;
  const key = `${path}\u0000${diff}`;
  const known = memo.get(key);
  if (known === 'pending') return undefined;
  if (known !== undefined) return known;
  memo.set(key, 'pending');
  while (memo.size > MAX_ENTRIES) {
    const oldest = memo.keys().next();
    if (oldest.done) break;
    memo.delete(oldest.value);
  }
  const { before, after } = beforeAfter(diff);
  void import('../semantic-diff.ts')
    .then(({ computeSemanticDiff }) => computeSemanticDiff(path, before, after))
    .catch(() => null)
    .then((result) => {
      memo.set(key, result);
      generation++;
      for (const listener of listeners) listener();
    });
  return undefined;
}

/** Seed a summary directly (tests and golden frames, which must not wait on tree-sitter). */
export function primeSemanticSummary(diff: string, path: string, summary: SemanticDiff | null): void {
  memo.set(`${path}\u0000${diff}`, summary);
}
