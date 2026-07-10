import { describe, expect, test } from 'bun:test';
import {
  parseReviewDiff,
  flattenHunks,
  hunkLineRange,
  hunkExcerpt,
  buildSteerMessage,
} from '../../panels/diff-review-model.ts';
import { DiffReviewPanel } from '../../panels/diff-review-panel.ts';

const SAMPLE_DIFF = `diff --git a/src/app.ts b/src/app.ts
index 111..222 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ -10,3 +10,4 @@ function greet() {
 const a = 1;
-const b = 2;
+const b = 3;
+const c = 4;
@@ -40,2 +41,2 @@ function bye() {
 keep();
-old();
+neo();
diff --git a/README.md b/README.md
index 333..444 100644
--- a/README.md
+++ b/README.md
@@ -1,1 +1,2 @@
 Title
+more
`;

describe('diff review model', () => {
  test('parses per-file, per-hunk structure with new-file line ranges', () => {
    const files = parseReviewDiff(SAMPLE_DIFF);
    expect(files.map((f) => f.filePath)).toEqual(['src/app.ts', 'README.md']);
    expect(files[0]!.hunks.length).toBe(2);
    const first = files[0]!.hunks[0]!;
    expect(hunkLineRange(first)).toEqual({ start: 10, end: 13 });
    expect(first.added).toBe(2);
    expect(first.removed).toBe(1);
    const second = files[0]!.hunks[1]!;
    expect(hunkLineRange(second)).toEqual({ start: 41, end: 42 });
  });

  test('flattens hunks across files in order', () => {
    const hunks = flattenHunks(parseReviewDiff(SAMPLE_DIFF));
    expect(hunks.length).toBe(3);
    expect(hunks[2]!.filePath).toBe('README.md');
  });

  test('excerpt carries the header and body', () => {
    const hunk = parseReviewDiff(SAMPLE_DIFF)[0]!.hunks[0]!;
    const excerpt = hunkExcerpt(hunk);
    expect(excerpt).toContain('@@ -10,3 +10,4 @@');
    expect(excerpt).toContain('+const b = 3;');
  });

  test('steer message carries file path, line range, comment, and patch excerpt', () => {
    const hunk = parseReviewDiff(SAMPLE_DIFF)[0]!.hunks[0]!;
    const msg = buildSteerMessage([{ hunk, comment: 'use a constant here' }], 'working tree vs HEAD');
    expect(msg).toContain('src/app.ts');
    expect(msg).toContain('lines 10-13');
    expect(msg).toContain('use a constant here');
    expect(msg).toContain('```diff');
    expect(msg).toContain('+const b = 3;');
    expect(msg).toContain('working tree vs HEAD');
  });

  test('batch steer message names every commented hunk', () => {
    const files = parseReviewDiff(SAMPLE_DIFF);
    const msg = buildSteerMessage([
      { hunk: files[0]!.hunks[0]!, comment: 'first' },
      { hunk: files[1]!.hunks[0]!, comment: 'second' },
    ], 'working tree vs HEAD');
    expect(msg).toContain('2 hunks');
    expect(msg).toContain('first');
    expect(msg).toContain('second');
    expect(msg).toContain('README.md');
  });
});

describe('DiffReviewPanel comment-to-steer loop', () => {
  function typed(panel: DiffReviewPanel, text: string): void {
    for (const ch of text) panel.handleInput(ch);
  }

  test('attaching a comment and sending it steers structured context to the session', () => {
    const captured: string[] = [];
    const panel = new DiffReviewPanel('/tmp', () => {});
    panel.setSubmit((t) => captured.push(t));
    panel.loadReview(parseReviewDiff(SAMPLE_DIFF), 'working tree vs HEAD (2 files edited this session)');

    // Open the composer on the first hunk, type a comment, confirm it.
    expect(panel.handleInput('c')).toBe(true);
    typed(panel, 'rename b');
    expect(panel.handleInput('return')).toBe(true); // attach

    // Not composing now: Enter submits the current hunk's comment.
    expect(panel.handleInput('return')).toBe(true);
    expect(captured.length).toBe(1);
    expect(captured[0]).toContain('src/app.ts');
    expect(captured[0]).toContain('lines 10-13');
    expect(captured[0]).toContain('rename b');
  });

  test('send-all batches every unsent comment into one steering message', () => {
    const captured: string[] = [];
    const panel = new DiffReviewPanel('/tmp', () => {});
    panel.setSubmit((t) => captured.push(t));
    panel.loadReview(parseReviewDiff(SAMPLE_DIFF), 'working tree vs HEAD');

    panel.handleInput('c'); typed(panel, 'one'); panel.handleInput('return');
    panel.handleInput('down'); // move to hunk 2
    panel.handleInput('c'); typed(panel, 'two'); panel.handleInput('return');
    panel.handleInput('a'); // send all

    expect(captured.length).toBe(1);
    expect(captured[0]).toContain('one');
    expect(captured[0]).toContain('two');
    // A second send-all has nothing unsent left to send.
    panel.handleInput('a');
    expect(captured.length).toBe(1);
  });

  test('renders without throwing and shows the honest source label', () => {
    const panel = new DiffReviewPanel('/tmp', () => {});
    panel.loadReview(parseReviewDiff(SAMPLE_DIFF), 'working tree vs HEAD (2 files edited this session)');
    const lines = panel.render(80, 24);
    expect(lines.length).toBeGreaterThan(0);
    const text = lines.map((l) => l.map((c) => c.char ?? '').join('')).join('\n');
    expect(text).toContain('edited this session');
  });
});
