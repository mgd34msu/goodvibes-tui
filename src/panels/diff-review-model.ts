// ---------------------------------------------------------------------------
// Diff review model, pure parsing + steering-payload helpers for the
// comment-on-hunk review loop (see diff-review-panel.ts).
//
// The diff this operates on is the git working tree vs a base ref (HEAD),
// filtered to the files the current session actually edited (the SDK's
// SessionChangeTracker). That is the honest source: it is CURRENT working-tree
// content, not a turn-start snapshot, the panel labels it exactly that way.
// ---------------------------------------------------------------------------

/** One hunk of one file's diff, with enough structure to steer a comment at it. */
export interface ReviewHunk {
  readonly filePath: string;
  readonly fileIndex: number;
  readonly hunkIndex: number;
  /** The raw `@@ -a,b +c,d @@` header line. */
  readonly header: string;
  readonly oldStart: number;
  readonly oldCount: number;
  readonly newStart: number;
  readonly newCount: number;
  /** Raw hunk body lines, each still carrying its leading ' ', '+' or '-'. */
  readonly bodyLines: readonly string[];
  readonly added: number;
  readonly removed: number;
}

export interface ReviewFile {
  readonly filePath: string;
  readonly fileIndex: number;
  readonly hunks: readonly ReviewHunk[];
}

/** Extract the target file path from one `diff --git`-delimited chunk. */
function extractFilePath(chunk: string): string {
  const quotedGit = chunk.match(/^diff --git "a\/(.+)" "b\/(.+)"$/m);
  if (quotedGit) return quotedGit[2]!;
  const plainGit = chunk.match(/^diff --git a\/.+? b\/(.+)$/m);
  if (plainGit) return plainGit[1]!;
  const combined = chunk.match(/^diff --(?:cc|combined) "?([^"\n]+?)"?$/m);
  if (combined) return combined[1]!;
  const plus = chunk.match(/^\+\+\+ (?:b\/)?"?([^"\n]+?)"?\s*$/m);
  if (plus && plus[1] !== '/dev/null') return plus[1]!;
  const minus = chunk.match(/^--- (?:a\/)?"?([^"\n]+?)"?\s*$/m);
  if (minus && minus[1] !== '/dev/null') return minus[1]!;
  return 'unknown';
}

const HUNK_HEADER_RE = /^@@\s+-([0-9]+)(?:,([0-9]+))?\s+\+([0-9]+)(?:,([0-9]+))?\s+@@/;

/** Parse a multi-file unified `git diff` into per-file, per-hunk structures. */
export function parseReviewDiff(raw: string): ReviewFile[] {
  const files: ReviewFile[] = [];
  const chunks = raw.split(/(?=^diff --git |^diff --cc |^diff --combined )/m);
  let fileIndex = 0;
  for (const chunk of chunks) {
    if (!chunk.trim()) continue;
    const filePath = extractFilePath(chunk);
    const hunks: ReviewHunk[] = [];
    const lines = chunk.split('\n');
    let current: { header: string; oldStart: number; oldCount: number; newStart: number; newCount: number; body: string[] } | null = null;
    const flush = (): void => {
      if (!current) return;
      let added = 0;
      let removed = 0;
      for (const l of current.body) {
        if (l.startsWith('+')) added++;
        else if (l.startsWith('-')) removed++;
      }
      hunks.push({
        filePath,
        fileIndex,
        hunkIndex: hunks.length,
        header: current.header,
        oldStart: current.oldStart,
        oldCount: current.oldCount,
        newStart: current.newStart,
        newCount: current.newCount,
        bodyLines: current.body,
        added,
        removed,
      });
      current = null;
    };
    for (const line of lines) {
      const m = line.match(HUNK_HEADER_RE);
      if (m) {
        flush();
        current = {
          header: line,
          oldStart: parseInt(m[1]!, 10),
          oldCount: m[2] !== undefined ? parseInt(m[2], 10) : 1,
          newStart: parseInt(m[3]!, 10),
          newCount: m[4] !== undefined ? parseInt(m[4], 10) : 1,
          body: [],
        };
        continue;
      }
      if (current) current.body.push(line);
    }
    flush();
    if (hunks.length > 0) files.push({ filePath, fileIndex, hunks });
    fileIndex++;
  }
  return files;
}

/** Flatten files into a single navigable hunk list, in file/hunk order. */
export function flattenHunks(files: readonly ReviewFile[]): ReviewHunk[] {
  const out: ReviewHunk[] = [];
  for (const file of files) out.push(...file.hunks);
  return out;
}

/** The new-file line range a hunk covers (1-based, inclusive). */
export function hunkLineRange(hunk: ReviewHunk): { start: number; end: number } {
  const start = hunk.newStart;
  const end = hunk.newCount > 0 ? hunk.newStart + hunk.newCount - 1 : hunk.newStart;
  return { start, end };
}

/** A short excerpt of a hunk's patch, header included, capped to `maxLines` body lines. */
export function hunkExcerpt(hunk: ReviewHunk, maxLines = 8): string {
  const body = hunk.bodyLines.slice(0, maxLines);
  const truncated = hunk.bodyLines.length > maxLines ? [`… (+${hunk.bodyLines.length - maxLines} more lines)`] : [];
  return [hunk.header, ...body, ...truncated].join('\n');
}

/** The full unified-diff hunk text (header + body) for one ReviewHunk, the input checkpoints.revertHunk takes. */
export function hunkPatchText(hunk: ReviewHunk): string {
  return [hunk.header, ...hunk.bodyLines].join('\n');
}

/** The subset of checkpoints.revertHunk's receipt the transcript block renders. */
export interface HunkRevertReceiptInput {
  readonly path: string;
  readonly hunkHeader: string;
  readonly addedLinesRemoved: number;
  readonly removedLinesRestored: number;
  readonly safetyCheckpointId: string | null;
}

/**
 * Build the distinct `[Revert]` transcript block for one applied hunk revert.
 * Pure. The `[Revert]` prefix is force-surfaced inline (system-message-router.ts)
 * so a working-tree mutation from /review is never a silent change.
 */
export function buildHunkRevertReceiptBlock(receipt: HunkRevertReceiptInput): string {
  const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;
  const lines = [
    `[Revert] Receipt: reverted one hunk in ${receipt.path} (${receipt.hunkHeader}).`,
    `  Restored ${plural(receipt.removedLinesRestored, 'deleted line')}, removed ${plural(receipt.addedLinesRemoved, 'added line')}.`,
    receipt.safetyCheckpointId
      ? `  Reversible: a pre-revert checkpoint was taken; /checkpoints restore ${receipt.safetyCheckpointId} undoes it.`
      : '  Reversible: the working tree already matched the latest checkpoint (nothing extra to snapshot).',
  ];
  return lines.join('\n');
}

/** A comment attached to a specific hunk, ready to steer. */
export interface HunkComment {
  readonly hunk: ReviewHunk;
  readonly comment: string;
}

/**
 * Build the structured steering message a review comment submits to the session.
 * Each block names the file, the new-file line range, the comment, and a short
 * patch excerpt so the model knows exactly what the comment targets. The
 * `sourceLabel` states the honest provenance of the diff (working tree vs base).
 */
export function buildSteerMessage(items: readonly HunkComment[], sourceLabel: string): string {
  const blocks = items.map(({ hunk, comment }) => {
    const range = hunkLineRange(hunk);
    return [
      `Review comment on ${hunk.filePath} (lines ${range.start}-${range.end}, new file):`,
      comment,
      '',
      'Referenced change:',
      '```diff',
      hunkExcerpt(hunk),
      '```',
    ].join('\n');
  });
  const header = items.length === 1
    ? `I am reviewing the current changes (${sourceLabel}) and left a comment on a specific hunk. Please address it.`
    : `I am reviewing the current changes (${sourceLabel}) and left comments on ${items.length} hunks. Please address each one.`;
  return [header, '', ...blocks].join('\n\n');
}
