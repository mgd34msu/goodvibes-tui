// ---------------------------------------------------------------------------
// file-dev-panels-ux.test.ts — UX behavior tests for the development-surface
// panels (git / diff / file-explorer / file-preview / symbol-outline / worktree).
//
// These assert the *user-facing* improvements: at-a-glance counts, status
// glyphs, context-aware footer hints, and tree icons — not just geometry.
// ---------------------------------------------------------------------------

import { describe, test, expect, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Line } from '../../types/grid.ts';
import { DiffPanel } from '../../panels/diff-panel.ts';
import { GitPanel } from '../../panels/git-panel.ts';
import { FilePreviewPanel } from '../../panels/file-preview-panel.ts';
import { SymbolOutlinePanel } from '../../panels/symbol-outline-panel.ts';
import { WorktreePanel } from '../../panels/worktree-panel.ts';
import { createTestManagers } from '../helpers/test-managers.ts';
import type { PanelIntegrationContext } from '../../panels/types.ts';

function linesText(lines: Line[]): string {
  return lines.map((l) => l.map((c) => c.char ?? ' ').join('')).join('\n');
}

const W = 120;
const H = 24;

// ── Shared git fixture helpers (mirrors src/test/git/service.test.ts) ──────────

/** Create an isolated temp git repo and return its path. */
function makeTempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gv-git-panel-'));
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

describe('DiffPanel — at-a-glance change counts', () => {
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

describe('DiffPanel — o opens the current file in preview via the bridge', () => {
  let pm: ReturnType<typeof createTestManagers>['panelManager'] | undefined;
  afterEach(() => { pm?.destroyAll(); });

  test('handlePanelIntegrationAction opens/focuses preview with the selected file', () => {
    const { panelManager } = createTestManagers();
    pm = panelManager;
    panelManager.registerType({
      id: 'preview',
      name: 'Preview',
      icon: 'P',
      category: 'development',
      description: 'preview',
      factory: () => new FilePreviewPanel(),
    });

    const panel = new DiffPanel('/tmp');
    panel.showDiff('src/foo.ts', '@@ -1,1 +1,1 @@\n-a\n+b');

    expect(panel.handleInput('o')).toBe(true);
    const ctx = { panelManager } as unknown as PanelIntegrationContext;
    expect(panel.handlePanelIntegrationAction?.('o', ctx)).toBe(true);

    const preview = panelManager.getPanel('preview');
    expect(preview).toBeInstanceOf(FilePreviewPanel);
    expect((preview as FilePreviewPanel).getCurrentFilePath()).toBe('src/foo.ts');
  });
});

describe('DiffPanel — self-load via its own diff plumbing (w/h/s)', () => {
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

// ── GitPanel ─────────────────────────────────────────────────────────────────

describe('GitPanel — loading + geometry', () => {
  test('still renders exactly height lines while loading', () => {
    const panel = new GitPanel('/tmp');
    const lines = panel.render(W, H);
    expect(lines).toHaveLength(H);
    for (const line of lines) expect(line).toHaveLength(W);
  });
});

// ── SymbolOutlinePanel — tree-sitter outline ─────────────────────────────────
//
// loadFile() parses via a real tree-sitter query (background WASM parse), so
// tests that need parsed symbols poll render() output until it settles
// rather than asserting synchronously right after loadFile().

async function waitForSymbolText(
  panel: SymbolOutlinePanel,
  needle: string,
  timeoutMs = 2000,
): Promise<string> {
  const start = Date.now();
  let text = linesText(panel.render(80, H));
  while (!text.includes(needle) && Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, 10));
    text = linesText(panel.render(80, H));
  }
  return text;
}

describe('GitPanel — selection skips header/section/empty filler rows', () => {
  test('initial selection and down both land on file/commit rows, never filler', async () => {
    const dir = makeTempRepo();
    tempDirs.push(dir);
    addCommit(dir, 'a.txt', 'one\n', 'initial');
    writeFileSync(join(dir, 'a.txt'), 'one\ntwo\n');

    const panel = new GitPanel(dir);
    panel.onActivate();
    await waitFor(() => !linesText(panel.render(W, H)).includes('Loading git status'));

    // I5: the initial selection must never rest on the branch header, a
    // section label, or an "(no ... files)" empty-row placeholder — the
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

describe('GitPanel — stage/unstage/commit round trip', () => {
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

describe('GitPanel — Enter on a commit row shows diffBetween/diffStat', () => {
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

describe('GitPanel — no more auto `git init`; explicit i confirm instead', () => {
  test('a non-git directory does not get auto-initialised, but i + y does it explicitly', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gv-git-panel-nonrepo-'));
    tempDirs.push(dir);

    const panel = new GitPanel(dir);
    panel.onActivate();
    await waitFor(() => linesText(panel.render(W, H)).includes('Not a git repository'));

    // I4: refresh() must not have run `git init` as a side effect.
    expect(() => execSync('git rev-parse --is-inside-work-tree', { cwd: dir, stdio: 'pipe' })).toThrow();

    expect(panel.handleInput('i')).toBe(true);
    const confirmText = linesText(panel.render(W, H));
    expect(confirmText).toContain('Init');

    expect(panel.handleInput('y')).toBe(true);
    await waitFor(() => {
      try {
        execSync('git rev-parse --is-inside-work-tree', { cwd: dir, stdio: 'pipe' });
        return true;
      } catch {
        return false;
      }
    });

    panel.onDestroy();
  });
});

// ── SymbolOutlinePanel — tree icons ──────────────────────────────────────────

describe('SymbolOutlinePanel — tree icons and footer', () => {
  const src = 'export class Foo {\n  bar() {}\n}\nexport function baz() {}\n';

  test('renders a per-kind type icon for classes and functions', async () => {
    const panel = new SymbolOutlinePanel();
    panel.loadFile('a.ts', src);
    const text = await waitForSymbolText(panel, 'baz');
    expect(text).toContain('Foo');
    expect(text).toContain('baz');
    // Container icon (class) and function icon are present.
    expect(text).toContain('C');
    expect(text).toContain('ƒ');
  });

  test('footer hints reference jump-to-source', async () => {
    const panel = new SymbolOutlinePanel();
    panel.loadFile('a.ts', src);
    await waitForSymbolText(panel, 'baz');
    const text = linesText(panel.render(80, H));
    expect(text).toContain('jump to source');
  });

  test('empty (no file) state offers a concrete next-step command', () => {
    const panel = new SymbolOutlinePanel();
    const text = linesText(panel.render(80, H));
    expect(text).toContain('No file loaded');
    expect(text).toContain('/panel open explorer');
  });

  test('arrow-function class fields, getters, and decorated members appear in the outline', async () => {
    const tsSrc = [
      'export class Widget {',
      '  @observable',
      '  onClick = () => {',
      '    return 1;',
      '  };',
      '',
      '  get label() {',
      '    return this._label;',
      '  }',
      '',
      '  @bound()',
      '  render() {',
      '    return null;',
      '  }',
      '}',
      '',
    ].join('\n');

    const panel = new SymbolOutlinePanel();
    panel.loadFile('widget.ts', tsSrc);
    const text = await waitForSymbolText(panel, 'onClick');
    // Arrow-function class field.
    expect(text).toContain('onClick');
    // Getter.
    expect(text).toContain('label');
    // Decorated method.
    expect(text).toContain('render');
    // All three are nested under the class header.
    expect(text).toContain('Widget');
  });

  test('Enter returns false when there is no selected location to jump to', () => {
    const panel = new SymbolOutlinePanel();
    // No file loaded — nothing to select — Enter must not swallow the key.
    expect(panel.handleInput('enter')).toBe(false);
    expect(panel.getSelectedLocation()).toBeNull();
  });
});

// ── WorktreePanel — active glyph + aligned columns ───────────────────────────

describe('WorktreePanel — status glyph and column header', () => {
  function makeRegistry() {
    return {
      list: async () => [
        { path: '/repo/wt-a', kind: 'agent', state: 'active', branch: 'feature/x', head: 'abc123def456', updatedAt: Date.now(), sessionId: 's1', taskId: 't1' },
        { path: '/repo/wt-b', kind: 'orchestrator', state: 'paused', branch: 'main', head: '0000', updatedAt: Date.now() },
      ],
      subscribe: () => () => {},
    } as unknown as ConstructorParameters<typeof WorktreePanel>[0];
  }

  test('renders an active status glyph and a column header', async () => {
    const panel = new WorktreePanel(makeRegistry());
    await new Promise((r) => setTimeout(r, 30));
    const text = linesText(panel.render(100, H));
    expect(text).toContain('KIND');
    expect(text).toContain('feature/x');
    expect(text).toContain('●'); // active state glyph
  });

  test('empty state offers a concrete /worktree command', async () => {
    const empty = { list: async () => [], subscribe: () => () => {} } as unknown as ConstructorParameters<typeof WorktreePanel>[0];
    const panel = new WorktreePanel(empty);
    await new Promise((r) => setTimeout(r, 30)); // let the initial async refresh settle
    const text = linesText(panel.render(100, H));
    expect(text).toContain('/worktree attach');
  });

  test('the Next Actions section and per-row Next: strings are gone', async () => {
    const panel = new WorktreePanel(makeRegistry());
    await new Promise((r) => setTimeout(r, 30));
    const text = linesText(panel.render(100, H));
    expect(text).not.toContain('Next Actions');
    expect(text).not.toContain('Next:');
  });

  test('footer hints show the real bound keys, not slash-command signposts', async () => {
    const panel = new WorktreePanel(makeRegistry());
    await new Promise((r) => setTimeout(r, 30));
    const text = linesText(panel.render(100, H));
    expect(text).toContain('pause/resume/keep');
    expect(text).toContain('discard/cleanup');
    expect(text).toContain('jump to session/task');
    expect(text).not.toContain('/worktree inspect');
  });

  function makeMutableRegistry() {
    const rows: Array<{ path: string; kind: string; state: string; branch: string; head: string; updatedAt: number; sessionId?: string; taskId?: string }> = [
      { path: '/repo/wt-a', kind: 'agent', state: 'active', branch: 'feature/x', head: 'abc123def456', updatedAt: Date.now(), sessionId: 's1' },
    ];
    const setStateCalls: Array<[string, string]> = [];
    const cleanupCalls: string[] = [];
    const registry = {
      list: async () => rows.map((r) => ({ ...r })),
      attach: () => {},
      setState: (path: string, state: string) => {
        setStateCalls.push([path, state]);
        const row = rows.find((r) => r.path === path);
        if (row) row.state = state;
      },
      cleanup: async (path: string) => {
        cleanupCalls.push(path);
      },
      subscribe: () => () => {},
    } as unknown as ConstructorParameters<typeof WorktreePanel>[0];
    return { registry, setStateCalls, cleanupCalls };
  }

  test('p/u/k dispatch setState on the same registry the /worktree command mutates', async () => {
    const { registry, setStateCalls } = makeMutableRegistry();
    const panel = new WorktreePanel(registry);
    await new Promise((r) => setTimeout(r, 30));

    expect(panel.handleInput('p')).toBe(true);
    await new Promise((r) => setTimeout(r, 10));
    expect(setStateCalls).toContainEqual(['/repo/wt-a', 'paused']);

    expect(panel.handleInput('u')).toBe(true);
    await new Promise((r) => setTimeout(r, 10));
    expect(setStateCalls).toContainEqual(['/repo/wt-a', 'active']);

    expect(panel.handleInput('k')).toBe(true);
    await new Promise((r) => setTimeout(r, 10));
    expect(setStateCalls).toContainEqual(['/repo/wt-a', 'kept']);
  });

  test('d opens a ConfirmState before discarding; y confirms, n cancels', async () => {
    const { registry, setStateCalls } = makeMutableRegistry();
    const panel = new WorktreePanel(registry);
    await new Promise((r) => setTimeout(r, 30));

    expect(panel.handleInput('d')).toBe(true);
    const confirmText = linesText(panel.render(100, H));
    expect(confirmText).toContain('Discard');
    expect(setStateCalls.some(([, state]) => state === 'discard')).toBe(false);

    expect(panel.handleInput('n')).toBe(true); // cancel
    expect(setStateCalls.some(([, state]) => state === 'discard')).toBe(false);

    expect(panel.handleInput('d')).toBe(true);
    expect(panel.handleInput('y')).toBe(true); // confirm
    await new Promise((r) => setTimeout(r, 10));
    expect(setStateCalls).toContainEqual(['/repo/wt-a', 'discard']);
  });

  test('c opens a ConfirmState before cleanup; confirming calls registry.cleanup', async () => {
    const { registry, cleanupCalls } = makeMutableRegistry();
    const panel = new WorktreePanel(registry);
    await new Promise((r) => setTimeout(r, 30));

    expect(panel.handleInput('c')).toBe(true);
    const confirmText = linesText(panel.render(100, H));
    expect(confirmText).toContain('Clean up');
    expect(panel.handleInput('enter')).toBe(true); // confirm via Enter
    await new Promise((r) => setTimeout(r, 10));
    expect(cleanupCalls).toContain('/repo/wt-a');
  });

  test('Enter on an attached row stages a jump to the session panel via handlePanelIntegrationAction', async () => {
    const { registry } = makeMutableRegistry();
    const panel = new WorktreePanel(registry);
    await new Promise((r) => setTimeout(r, 30));

    expect(panel.handleInput('enter')).toBe(true);
    const opened: string[] = [];
    const ctx = { panelManager: { open: (id: string) => opened.push(id) } } as unknown as import('../../panels/types.ts').PanelIntegrationContext;
    expect(panel.handlePanelIntegrationAction?.('enter', ctx)).toBe(true);
    expect(opened).toEqual(['sessions']);
  });
});
