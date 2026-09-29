/**
 * changes-model.ts, the Changes modal's data: a unified diff split into files
 * and hunks, every line numbered on both sides.
 *
 * Built on the review model's hunk parser (panels/diff-review-model.ts) so the
 * hunks the Changes modal navigates are the very ReviewHunk values the review
 * comment and hunk-revert seams take. Each file keeps its own header lines so
 * one hunk can be turned back into a patch git will apply on its own (staging
 * a hunk is `git apply --cached` of exactly that patch).
 */

import { parseReviewDiff, type ReviewHunk } from '../panels/diff-review-model.ts';

export type ChangeLineKind = 'add' | 'del' | 'ctx' | 'note';

export interface ChangeLine {
  readonly kind: ChangeLineKind;
  /** The line without its leading '+', '-' or ' '. */
  readonly text: string;
  readonly oldNo: number | null;
  readonly newNo: number | null;
}

export interface ChangeHunk {
  readonly review: ReviewHunk;
  readonly lines: readonly ChangeLine[];
}

export interface ChangeFile {
  readonly path: string;
  /** The file's diff header (diff --git, index, ---, +++ …), needed to apply one hunk alone. */
  readonly headerLines: readonly string[];
  readonly hunks: readonly ChangeHunk[];
  readonly added: number;
  readonly removed: number;
  /** A binary file or a mode-only change: header only, nothing to show line by line. */
  readonly headerOnly: boolean;
}

function numberLines(hunk: ReviewHunk): ChangeLine[] {
  const out: ChangeLine[] = [];
  let oldNo = hunk.oldStart;
  let newNo = hunk.newStart;
  for (const raw of hunk.bodyLines) {
    if (raw.startsWith('+')) out.push({ kind: 'add', text: raw.slice(1), oldNo: null, newNo: newNo++ });
    else if (raw.startsWith('-')) out.push({ kind: 'del', text: raw.slice(1), oldNo: oldNo++, newNo: null });
    else if (raw.startsWith('\\')) out.push({ kind: 'note', text: raw, oldNo: null, newNo: null });
    else if (raw === '' ) continue; // the trailing split artifact of a chunk
    else out.push({ kind: 'ctx', text: raw.slice(1), oldNo: oldNo++, newNo: newNo++ });
  }
  return out;
}

/** Header lines (everything before the first hunk) of each `diff --git` chunk, in order. */
function chunkHeaders(raw: string): Array<{ lines: string[]; hasHunks: boolean }> {
  const chunks = raw.split(/(?=^diff --git |^diff --cc |^diff --combined )/m).filter((chunk) => chunk.trim());
  return chunks.map((chunk) => {
    const lines = chunk.split('\n');
    const first = lines.findIndex((line) => line.startsWith('@@'));
    return { lines: (first < 0 ? lines : lines.slice(0, first)).filter((line) => line.length > 0), hasHunks: first >= 0 };
  });
}

function pathFromHeader(header: readonly string[]): string {
  for (const line of header) {
    const m = /^diff --git "?a\/(.+?)"? "?b\/(.+?)"?$/.exec(line);
    if (m) return m[2]!;
  }
  for (const line of header) {
    const m = /^\+\+\+ (?:b\/)?(.+)$/.exec(line);
    if (m && m[1] !== '/dev/null') return m[1]!;
  }
  return 'unknown';
}

/** Split a unified diff (one or many files) into files and numbered hunks. */
export function parseChanges(raw: string): ChangeFile[] {
  const headers = chunkHeaders(raw);
  const reviewFiles = parseReviewDiff(raw);
  const byIndex = new Map(reviewFiles.map((file) => [file.fileIndex, file]));
  const files: ChangeFile[] = [];
  headers.forEach((header, index) => {
    const review = byIndex.get(index);
    const hunks: ChangeHunk[] = (review?.hunks ?? []).map((hunk) => ({ review: hunk, lines: numberLines(hunk) }));
    files.push({
      path: review?.filePath ?? pathFromHeader(header.lines),
      headerLines: header.lines,
      hunks,
      added: hunks.reduce((n, h) => n + h.review.added, 0),
      removed: hunks.reduce((n, h) => n + h.review.removed, 0),
      headerOnly: hunks.length === 0,
    });
  });
  return files;
}

/** One hunk as a complete patch (file header + hunk) that `git apply` accepts on its own. */
export function hunkPatch(file: ChangeFile, hunk: ChangeHunk): string {
  const header = file.headerLines.filter((line) => !line.startsWith('similarity') && !line.startsWith('rename'));
  const hasFileLines = header.some((line) => line.startsWith('--- ')) && header.some((line) => line.startsWith('+++ '));
  const fileLines = hasFileLines ? header : [...header, `--- a/${file.path}`, `+++ b/${file.path}`];
  return [...fileLines, hunk.review.header, ...hunk.review.bodyLines.filter((line, i, all) => !(line === '' && i === all.length - 1))].join('\n') + '\n';
}

/** The language fence tag for a path (its extension), for syntax colors. */
export function languageForPath(path: string): string {
  const base = path.split('/').pop() ?? path;
  if (base === 'Dockerfile') return 'dockerfile';
  if (base === 'Makefile') return 'make';
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
}

/** Total +/- across files. */
export function changeTotals(files: readonly ChangeFile[]): { added: number; removed: number } {
  return files.reduce((acc, f) => ({ added: acc.added + f.added, removed: acc.removed + f.removed }), { added: 0, removed: 0 });
}
