// ---------------------------------------------------------------------------
// file-dev-panels-ux.test.ts, UX behavior tests for the development-surface
// panels (git / diff).
//
// (the purge): this file used to also cover file-explorer, file-preview,
// symbol-outline (all DELETE-disposition) and worktree (RETIRE-INTO-FLEET).
// Their describe blocks were removed along with the panels, see
// .goodvibes/audit/2026-07-04-wave6-briefs.json.
//
// These assert the *user-facing* improvements: at-a-glance counts, status
// glyphs, context-aware footer hints, and tree icons, not just geometry.
// ---------------------------------------------------------------------------

import { describe, test, expect, afterEach } from 'bun:test';
import { rmSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import type { Line } from '@pellux/goodvibes-sdk/platform/types';
import { DiffPanel } from '../../panels/diff-panel.ts';
import { GitPanel } from '../../panels/git-panel.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

function linesText(lines: Line[]): string {
  return lines.map((l) => l.map((c) => c.char ?? ' ').join('')).join('\n');
}

const W = 120;
const H = 24;

// ── Shared git fixture helpers (mirrors src/test/git/service.test.ts) ──────────

/** Create an isolated temp git repo and return its path. */
function makeTempRepo(): string {
  const dir = makeProjectTempDir('gv-git-panel');
  execSync('git init', { cwd: dir });
  execSync('git config user.email "test@test.com"', { cwd: dir });
  execSync('git config user.name "Test"', { cwd: dir });
  return dir;
}

/** Write a file into the repo and stage + commit it. */
function addCommit(dir: string, filename: string, content: string, message: string): void {
  writeFileSync(join(dir, filename), content);
  execSync(`git add ${filename}`, { cwd: dir });
  execSync(`git commit -m "${message}"`, { cwd: dir });
}

/** Poll `predicate` until it returns true or `timeoutMs` elapses. */
async function waitFor(predicate: () => boolean, timeoutMs = 4000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor: timed out');
    await new Promise((r) => setTimeout(r, 15));
  }
}

const tempDirs: string[] = [];
afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── DiffPanel ────────────────────────────────────────────────────────────────

describe('DiffPanel: at-a-glance change counts', () => {
  const diff = '@@ -1,3 +1,4 @@\n line one\n-line two\n+line two mod\n+line ins\n line three';

  test('tab bar surfaces +adds/-dels for the file', () => {
    const panel = new DiffPanel('/tmp');
    panel.showDiff('src/foo.ts', diff);
    const text = linesText(panel.render(W, H));
    // 2 additions, 1 deletion in the sample diff.
    expect(text).toContain('+2');
    expect(text).toContain('-1');
  });

  test('status bar surfaces counts and position', () => {
    const panel = new DiffPanel('/tmp');
    panel.showDiff('src/foo.ts', diff);
    const lines = panel.render(W, H);
    const status = (lines[lines.length - 1] ?? []).map((c) => c.char ?? ' ').join('');
    expect(status).toContain('src/foo.ts');
    expect(status).toContain('+2');
    expect(status).toContain('-1');
  });

  test('active file is marked with a leading caret in the tab bar', () => {
    const panel = new DiffPanel('/tmp');
    panel.showDiff('a.ts', '@@ -1,1 +1,1 @@\n-a\n+b');
    panel.showDiff('b.ts', '@@ -1,1 +1,1 @@\n-b\n+c');
    const text = linesText(panel.render(W, H));
    expect(text).toContain('▸ b.ts');
  });

  test('empty state points at /diff, not the retired /git diff command', () => {
    const panel = new DiffPanel('/tmp');
    const text = linesText(panel.render(W, H));
    expect(text).toContain('/diff');
    expect(text).not.toContain('/git diff');
  });

  test('shift-tab (backtab escape sequence) moves to the previous file', () => {
    const panel = new DiffPanel('/tmp');
    panel.showDiff('a.ts', '@@ -1,1 +1,1 @@\n-a\n+b');
    panel.showDiff('b.ts', '@@ -1,1 +1,1 @@\n-b\n+c');
    panel.showDiff('c.ts', '@@ -1,1 +1,1 @@\n-c\n+d');
    // showDiff() leaves the newest file selected (c.ts).
    expect(linesText(panel.render(W, H))).toContain('▸ c.ts');
    expect(panel.handleInput('\x1b[Z')).toBe(true);
    expect(linesText(panel.render(W, H))).toContain('▸ b.ts');
    expect(panel.handleInput('\x1b[Z')).toBe(true);
    expect(linesText(panel.render(W, H))).toContain('▸ a.ts');
  });
});

// (the purge): 'DiffPanel, o opens the current file in preview via the
// bridge' removed here, 'preview' is DELETE-disposition with no successor
// surface, and diff-panel.ts no longer has an 'o' key or a
// handlePanelIntegrationAction hook (see diff-panel.ts's comment at the old
// hook's former location).

describe('DiffPanel: self-load via its own diff plumbing (w/h/s)', () => {
  test('w loads the working-tree diff (unstaged only)', async () => {
    const dir = makeTempRepo();
    tempDirs.push(dir);
    addCommit(dir, 'a.txt', 'one\n', 'initial');
    writeFileSync(join(dir, 'a.txt'), 'one\ntwo\n');

    const panel = new DiffPanel(dir);
    expect(panel.handleInput('w')).toBe(true);
    await waitFor(() => linesText(panel.render(W, H)).includes('a.txt'));
    expect(linesText(panel.render(W, H))).toContain('a.txt');
  });

  test('s loads the staged diff via its own git plumbing (not the /diff command)', async () => {
    const dir = makeTempRepo();
    tempDirs.push(dir);
    addCommit(dir, 'a.txt', 'one\n', 'initial');
    writeFileSync(join(dir, 'a.txt'), 'one\ntwo\n');
    execSync('git add a.txt', { cwd: dir });

    const panel = new DiffPanel(dir);
    expect(panel.handleInput('s')).toBe(true);
    await waitFor(() => linesText(panel.render(W, H)).includes('a.txt'));
    expect(linesText(panel.render(W, H))).toContain('a.txt');
  });

  test('h loads the diff vs HEAD (staged + unstaged)', async () => {
    const dir = makeTempRepo();
    tempDirs.push(dir);
    addCommit(dir, 'a.txt', 'one\n', 'initial');
    writeFileSync(join(dir, 'b.txt'), 'new file\n');
    execSync('git add b.txt', { cwd: dir });

    const panel = new DiffPanel(dir);
    expect(panel.handleInput('h')).toBe(true);
    await waitFor(() => linesText(panel.render(W, H)).includes('b.txt'));
    expect(linesText(panel.render(W, H))).toContain('b.txt');
  });
});

describe('DiffPanel: not-a-git-repo gate (defensive, mirrors GitPanel)', () => {
  test('w/h/s and showFileDiffs all report a friendly not-a-git-repo placeholder instead of a raw git error', async () => {
    const dir = makeProjectTempDir('gv-diff-nogit');
    tempDirs.push(dir);

    const panel = new DiffPanel(dir);
    await panel.showGitDiff();
    expect(linesText(panel.render(W, H))).toContain('(not a git repo)');

    const panel2 = new DiffPanel(dir);
    await panel2.showStagedDiff();
    expect(linesText(panel2.render(W, H))).toContain('(not a git repo)');

    const panel3 = new DiffPanel(dir);
    await panel3.showFileDiffs(['a.txt']);
    expect(linesText(panel3.render(W, H))).toContain('(not a git repo)');
  });

  test('placeholder entries render with a distinct color from real filenames', () => {
    const panel = new DiffPanel('/tmp');
    panel.showDiff('src/real.ts', '@@ -1,1 +1,1 @@\n-a\n+b');
    const realStatus = panel.render(W, H);
    const realFg = (realStatus[realStatus.length - 1] ?? []).find((c) => (c.char ?? '') === 's')?.fg;

    const placeholderPanel = new DiffPanel('/tmp');
    placeholderPanel.showDiff('(error)', '@@ -0,0 +1,1 @@\n+boom');
    const placeholderStatus = placeholderPanel.render(W, H);
    const placeholderFg = (placeholderStatus[placeholderStatus.length - 1] ?? []).find((c) => (c.char ?? '') === '(')?.fg;

    expect(placeholderFg).toBeDefined();
    expect(placeholderFg).not.toBe(realFg);
  });
});

describe('DiffPanel: w/h/s hotkeys give visible confirmation (not just a silent re-render)', () => {
  test('pressing w immediately shows a loading status, then a reloaded confirmation once git resolves', async () => {
    const dir = makeTempRepo();
    tempDirs.push(dir);
    addCommit(dir, 'a.txt', 'one\n', 'initial');
    writeFileSync(join(dir, 'a.txt'), 'one\ntwo\n');

    let renderRequested = 0;
    const panel = new DiffPanel(dir, () => { renderRequested++; });
    // Seed an entry so the status bar (which only renders once entries exist) is visible immediately.
    panel.showDiff('a.txt', '@@ -1,1 +1,2 @@\n one\n+two');

    expect(panel.handleInput('w')).toBe(true);
    // Synchronous feedback, before the background git subprocess has resolved.
    expect(linesText(panel.render(W, H))).toContain('Loading working tree diff');

    await waitFor(() => renderRequested > 0);
    expect(linesText(panel.render(W, H))).toContain('Reloaded working tree diff');
  });
});

describe('DiffPanel: splitIntoDiffEntries recognizes non-standard diff headers', () => {
  test('a combined/merge-conflict header ("diff --cc") resolves the real file path, not "unknown"', () => {
    const raw = 'diff --cc conflicted.ts\nindex 111,222..333\n--- a/conflicted.ts\n+++ b/conflicted.ts\n@@@ -1,1 -1,1 +1,1 @@@\n++resolved\n';
    const panel = new DiffPanel('/tmp');
    panel.loadRawDiff(raw);
    const text = linesText(panel.render(W, H));
    expect(text).toContain('conflicted.ts');
    expect(text).not.toContain('unknown');
  });

  test('a quoted-path header ("diff --git \\"a/x y\\" \\"b/x y\\"") resolves the real file path', () => {
    const raw = 'diff --git "a/my file.ts" "b/my file.ts"\nindex 111..222 100644\n--- "a/my file.ts"\n+++ "b/my file.ts"\n@@ -1,1 +1,1 @@\n-old\n+new\n';
    const panel = new DiffPanel('/tmp');
    panel.loadRawDiff(raw);
    const text = linesText(panel.render(W, H));
    expect(text).toContain('my file.ts');
    expect(text).not.toContain('unknown');
  });
});

// ── GitPanel ─────────────────────────────────────────────────────────────────

describe('GitPanel: loading + geometry', () => {
  test('still renders exactly height lines while loading', () => {
    const panel = new GitPanel('/tmp');
    const lines = panel.render(W, H);
    expect(lines).toHaveLength(H);
    for (const line of lines) expect(line).toHaveLength(W);
  });
});


describe('GitPanel: selection skips header/section/empty filler rows', () => {
  test('initial selection and down both land on file/commit rows, never filler', async () => {
    const dir = makeTempRepo();
    tempDirs.push(dir);
    addCommit(dir, 'a.txt', 'one\n', 'initial');
    writeFileSync(join(dir, 'a.txt'), 'one\ntwo\n');

    const panel = new GitPanel(dir);
    panel.onActivate();
    await waitFor(() => !linesText(panel.render(W, H)).includes('Loading git status'));

    // I5: the initial selection must never rest on the branch header, a
    // section label, or an "(no ... files)" empty-row placeholder, the
    // "Selected" detail panel resolves what's actually selected.
    const initial = linesText(panel.render(W, H));
    expect(initial).toContain(' File ');
    expect(initial).toContain('a.txt');

    // Only the unstaged file and the "initial" commit are selectable rows;
    // 'down' must skip straight over the "Recent Commits" section label.
    expect(panel.handleInput('down')).toBe(true);
    const afterDown = linesText(panel.render(W, H));
    expect(afterDown).toContain(' Commit ');
    expect(afterDown).toContain('initial');

    panel.onDestroy();
  });
});

describe('GitPanel: stage/unstage/commit round trip', () => {
  test('s stages, u unstages the selected file via GitService add/reset', async () => {
    const dir = makeTempRepo();
    tempDirs.push(dir);
    addCommit(dir, 'a.txt', 'one\n', 'initial');
    writeFileSync(join(dir, 'a.txt'), 'one\ntwo\n');

    const panel = new GitPanel(dir);
    panel.onActivate();
    await waitFor(() => !linesText(panel.render(W, H)).includes('Loading git status'));
    await waitFor(() => linesText(panel.render(W, H)).includes('1 unstaged'));

    expect(panel.handleInput('s')).toBe(true);
    await waitFor(() => linesText(panel.render(W, H)).includes('1 staged'));
    expect(execSync('git diff --cached --name-only', { cwd: dir }).toString().trim()).toBe('a.txt');

    expect(panel.handleInput('u')).toBe(true);
    await waitFor(() => linesText(panel.render(W, H)).includes('1 unstaged'));
    expect(execSync('git diff --cached --name-only', { cwd: dir }).toString().trim()).toBe('');

    panel.onDestroy();
  });

  test('c composes a message, Enter opens a Commit confirm, y commits via GitService.commit', async () => {
    const dir = makeTempRepo();
    tempDirs.push(dir);
    addCommit(dir, 'a.txt', 'one\n', 'initial');
    writeFileSync(join(dir, 'a.txt'), 'one\ntwo\n');
    execSync('git add a.txt', { cwd: dir });

    const panel = new GitPanel(dir);
    panel.onActivate();
    await waitFor(() => linesText(panel.render(W, H)).includes('1 staged'));

    expect(panel.handleInput('c')).toBe(true);
    for (const ch of 'second commit') panel.handleInput(ch);
    expect(panel.handleInput('enter')).toBe(true);
    const confirmText = linesText(panel.render(W, H));
    expect(confirmText).toContain('Commit');
    expect(confirmText).toContain('second commit');

    expect(panel.handleInput('y')).toBe(true);
    await waitFor(() => execSync('git log --oneline', { cwd: dir }).toString().trim().split('\n').length === 2);
    expect(execSync('git log -1 --pretty=%s', { cwd: dir }).toString().trim()).toBe('second commit');

    panel.onDestroy();
  });
});

describe('GitPanel: Enter on a commit row shows diffBetween/diffStat', () => {
  test('opens the patch and stat for the selected commit', async () => {
    const dir = makeTempRepo();
    tempDirs.push(dir);
    addCommit(dir, 'a.txt', 'one\n', 'initial');
    addCommit(dir, 'a.txt', 'one\ntwo\n', 'second commit');

    const panel = new GitPanel(dir);
    panel.onActivate();
    await waitFor(() => linesText(panel.render(W, H)).includes('second commit'));

    // Both file sections are empty, so the initial selection (I5: never a
    // header/section/empty filler row) already rests on the newest commit row.
    expect(panel.handleInput('return')).toBe(true);
    await waitFor(() => !linesText(panel.render(W, H)).includes('Loading diff'));
    const diffText = linesText(panel.render(W, H));
    expect(diffText).toContain('a.txt');

    panel.onDestroy();
  });
});

describe('GitPanel: no more auto `git init`; explicit i confirm instead', () => {
  test('a non-git directory does not get auto-initialised, but i + y does it explicitly', async () => {
    const dir = makeProjectTempDir('gv-git-panel-nonrepo');
    tempDirs.push(dir);

    // This test needs `dir` to be genuinely outside any git work tree. That is
    // NOT guaranteed by mkdtemp alone: the suite runner (scripts/run-tests.ts)
    // redirects TMPDIR into `.test-tmp/` *inside* this project's own repo, so a
    // bare temp dir sits under the project's `.git` and git discovery walks up
    // and finds it, the panel would show the parent repo instead of "Not a git
    // repository". Fence discovery with GIT_CEILING_DIRECTORIES set to the temp
    // dir's parent so git stops there; the panel's own git subprocesses inherit
    // it via process.env. `git init` is unaffected, it still creates `.git` in
    // `dir` on i+y.
    const prevCeiling = process.env.GIT_CEILING_DIRECTORIES;
    process.env.GIT_CEILING_DIRECTORIES = dirname(dir);
    // Git matches the ceiling against the *logical* cwd ($PWD). This test's own
    // execSync calls otherwise inherit the runner's stale PWD (= project root,
    // above the ceiling) and would sail past it straight to the project repo, so
    // pin PWD to `dir` explicitly for them.
    const gitEnv = { ...process.env, PWD: dir };
    try {
      const panel = new GitPanel(dir);
      panel.onActivate();
      await waitFor(() => linesText(panel.render(W, H)).includes('Not a git repository'));

      // I4: refresh() must not have run `git init` as a side effect.
      expect(() =>
        execSync('git rev-parse --is-inside-work-tree', { cwd: dir, env: gitEnv, stdio: 'pipe' }),
      ).toThrow();

      expect(panel.handleInput('i')).toBe(true);
      const confirmText = linesText(panel.render(W, H));
      expect(confirmText).toContain('Init');

      expect(panel.handleInput('y')).toBe(true);
      await waitFor(() => {
        try {
          execSync('git rev-parse --is-inside-work-tree', { cwd: dir, env: gitEnv, stdio: 'pipe' });
          return true;
        } catch {
          return false;
        }
      });

      panel.onDestroy();
    } finally {
      if (prevCeiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES;
      else process.env.GIT_CEILING_DIRECTORIES = prevCeiling;
    }
  });

  test('i is left unconsumed when a repo is already loaded (no silent key swallow)', async () => {
    const dir = makeTempRepo();
    tempDirs.push(dir);
    addCommit(dir, 'a.txt', 'one\n', 'initial');

    const panel = new GitPanel(dir);
    panel.onActivate();
    await waitFor(() => !linesText(panel.render(W, H)).includes('Not a git repository'));

    expect(panel.handleInput('i')).toBe(false);
    expect(linesText(panel.render(W, H))).not.toContain('Init');

    panel.onDestroy();
  });
});

