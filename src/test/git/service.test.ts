import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { execSync } from 'child_process';
import { join, resolve } from 'path';
import { tmpdir } from 'os';
import { GitService } from '@pellux/goodvibes-sdk/platform/git';
import { HookDispatcher } from '@pellux/goodvibes-sdk/platform/hooks';
import type { HookEvent } from '@pellux/goodvibes-sdk/platform/hooks';
import { getTestGitService, resetTestGitServices, disposeTestRuntimeServicesAfterAll } from '../helpers/runtime-services.ts';

// Stop the shared test runtime graph when this file ends. Called here, not
// registered inside the helper, for the reason its doc comment gives.
disposeTestRuntimeServicesAfterAll();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create an isolated temp git repo and return its path */
function makeTempRepo(): string {
  const tmpDir = mkdtempSync(join(tmpdir(), 'git-test-'));
  execSync('git init', { cwd: tmpDir });
  execSync('git config user.email "test@test.com"', { cwd: tmpDir });
  execSync('git config user.name "Test"', { cwd: tmpDir });
  return tmpDir;
}

function makeTempPath(prefix: string): string {
  return join(tmpdir(), `${prefix}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
}

function makeExternalDir(prefix: string): string {
  return mkdtempSync(join(resolve(process.cwd(), '..'), `${prefix}-`));
}

/** Write a file into the repo and stage + commit it */
function addCommit(dir: string, filename: string, content: string, message: string): void {
  writeFileSync(join(dir, filename), content);
  execSync(`git add ${filename}`, { cwd: dir });
  execSync(`git commit -m "${message}"`, { cwd: dir });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GitService', () => {
  let tmpDir: string;
  let svc: GitService;

  beforeEach(() => {
    tmpDir = makeTempRepo();
    svc = new GitService(tmpDir);
  });

  afterEach(() => {
    svc.dispose();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // status
  // -------------------------------------------------------------------------

  describe('status', () => {
    test('clean repo has no modified files', async () => {
      const st = await svc.status();
      expect(st.modified).toHaveLength(0);
      expect(st.staged).toHaveLength(0);
      expect(st.not_added).toHaveLength(0);
    });

    test('shows untracked file', async () => {
      writeFileSync(join(tmpDir, 'hello.txt'), 'hello');
      const st = await svc.status();
      expect(st.not_added).toContain('hello.txt');
    });

    test('shows staged file', async () => {
      writeFileSync(join(tmpDir, 'staged.txt'), 'content');
      execSync('git add staged.txt', { cwd: tmpDir });
      const st = await svc.status();
      expect(st.created).toContain('staged.txt');
    });

    test('shows modified file after commit', async () => {
      addCommit(tmpDir, 'file.txt', 'v1', 'initial');
      writeFileSync(join(tmpDir, 'file.txt'), 'v2');
      const st = await svc.status();
      expect(st.modified).toContain('file.txt');
    });
  });

  // -------------------------------------------------------------------------
  // add + commit + log
  // -------------------------------------------------------------------------

  describe('add / commit / log', () => {
    test('add stages a file', async () => {
      writeFileSync(join(tmpDir, 'new.txt'), 'data');
      await svc.add('new.txt');
      const st = await svc.status();
      expect(st.created).toContain('new.txt');
    });

    test('add accepts array of files', async () => {
      writeFileSync(join(tmpDir, 'a.txt'), 'a');
      writeFileSync(join(tmpDir, 'b.txt'), 'b');
      await svc.add(['a.txt', 'b.txt']);
      const st = await svc.status();
      expect(st.created).toContain('a.txt');
      expect(st.created).toContain('b.txt');
    });

    test('commit creates a log entry', async () => {
      writeFileSync(join(tmpDir, 'f.txt'), 'x');
      await svc.add('f.txt');
      const result = await svc.commit('first commit');
      expect(result.hash).toBeTruthy();
      const entries = await svc.log();
      expect(entries.length).toBe(1);
      expect(entries[0].message).toBe('first commit');
    });

    test('log returns multiple entries in reverse chronological order', async () => {
      addCommit(tmpDir, 'a.txt', '1', 'first');
      addCommit(tmpDir, 'b.txt', '2', 'second');
      const entries = await svc.log();
      expect(entries.length).toBe(2);
      expect(entries[0].message).toBe('second');
      expect(entries[1].message).toBe('first');
    });

    test('log respects maxCount', async () => {
      addCommit(tmpDir, 'a.txt', '1', 'first');
      addCommit(tmpDir, 'b.txt', '2', 'second');
      addCommit(tmpDir, 'c.txt', '3', 'third');
      const entries = await svc.log(2);
      expect(entries.length).toBe(2);
    });
  });

  // -------------------------------------------------------------------------
  // diff
  // -------------------------------------------------------------------------

  describe('diff', () => {
    test('diff returns empty string on clean repo', async () => {
      addCommit(tmpDir, 'file.txt', 'v1', 'initial');
      const d = await svc.diff();
      expect(d).toBe('');
    });

    test('diff shows unstaged changes', async () => {
      addCommit(tmpDir, 'file.txt', 'v1', 'initial');
      writeFileSync(join(tmpDir, 'file.txt'), 'v2');
      const d = await svc.diff();
      expect(d).toContain('v2');
    });

    test('diff with ref shows changes relative to that commit', async () => {
      addCommit(tmpDir, 'file.txt', 'v1', 'initial');
      addCommit(tmpDir, 'file.txt', 'v2', 'update');
      const entries = await svc.log();
      const firstHash = entries[1].hash;
      const d = await svc.diff(firstHash);
      expect(d).toContain('v2');
    });

    test('diffBetween returns full diff between two refs', async () => {
      addCommit(tmpDir, 'file.txt', 'v1', 'initial');
      addCommit(tmpDir, 'file.txt', 'v2', 'update');
      const entries = await svc.log();
      const beforeRef = entries[1].hash;
      const afterRef = entries[0].hash;
      const d = await svc.diffBetween(beforeRef, afterRef);
      expect(d).toContain('+v2');
      expect(d).toContain('-v1');
    });

    test('diffBetween scoped to specific files returns only those files', async () => {
      addCommit(tmpDir, 'a.txt', 'a1', 'add a');
      addCommit(tmpDir, 'b.txt', 'b1', 'add b');
      addCommit(tmpDir, 'a.txt', 'a2', 'update a');
      const entries = await svc.log();
      // Diff from second-to-last to last, scoped to a.txt
      const beforeRef = entries[1].hash;
      const afterRef = entries[0].hash;
      const d = await svc.diffBetween(beforeRef, afterRef, ['a.txt']);
      expect(d).toContain('a.txt');
      expect(d).not.toContain('b.txt');
    });

    test('diffStat returns stat summary between two refs', async () => {
      addCommit(tmpDir, 'stat-file.txt', 'line1\nline2', 'initial');
      addCommit(tmpDir, 'stat-file.txt', 'line1\nline2\nline3', 'add line');
      const entries = await svc.log();
      const beforeRef = entries[1].hash;
      const afterRef = entries[0].hash;
      const stat = await svc.diffStat(beforeRef, afterRef);
      expect(stat).toContain('stat-file.txt');
      // stat format includes change count and insertion markers
      expect(stat).toMatch(/\d+ insertion/);
    });

    test('diffStat returns empty string when refs are identical', async () => {
      addCommit(tmpDir, 'same.txt', 'content', 'commit');
      const entries = await svc.log();
      const hash = entries[0].hash;
      const stat = await svc.diffStat(hash, hash);
      expect(stat.trim()).toBe('');
    });
  });

  // -------------------------------------------------------------------------
  // branch
  // -------------------------------------------------------------------------

  describe('branch', () => {
    test('branch returns current branch', async () => {
      addCommit(tmpDir, 'init.txt', 'x', 'init');
      const b = await svc.branch();
      // git init creates master or main depending on config
      expect(b.current).toMatch(/^(main|master)$/);
    });

    test('checkout with create:true creates new branch', async () => {
      addCommit(tmpDir, 'init.txt', 'x', 'init');
      await svc.checkout('feature-x', { create: true });
      const b = await svc.branch();
      expect(b.current).toBe('feature-x');
      expect(b.all).toContain('feature-x');
    });

    test('checkout switches to existing branch', async () => {
      addCommit(tmpDir, 'init.txt', 'x', 'init');
      execSync('git checkout -b other', { cwd: tmpDir });
      execSync('git checkout master || git checkout main', { cwd: tmpDir });
      await svc.checkout('other');
      const b = await svc.branch();
      expect(b.current).toBe('other');
    });

    test('branch lists all branches', async () => {
      addCommit(tmpDir, 'init.txt', 'x', 'init');
      execSync('git checkout -b feature-a', { cwd: tmpDir });
      execSync('git checkout -b feature-b', { cwd: tmpDir });
      const b = await svc.branch();
      expect(b.all).toContain('feature-a');
      expect(b.all).toContain('feature-b');
    });
  });

  // -------------------------------------------------------------------------
  // merge
  // -------------------------------------------------------------------------

  describe('merge', () => {
    test('clean merge returns success:true', async () => {
      addCommit(tmpDir, 'base.txt', 'base', 'base commit');
      execSync('git checkout -b feature', { cwd: tmpDir });
      addCommit(tmpDir, 'feature.txt', 'feat content', 'add feature');
      const mainBranch = execSync('git log --format=%D HEAD~1', { cwd: tmpDir })
        .toString()
        .split(',')
        .map((s) => s.trim())
        .find((s) => s === 'master' || s === 'main') ?? 'master';
      execSync(`git checkout ${mainBranch}`, { cwd: tmpDir });
      const result = await svc.merge('feature');
      expect(result.success).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // stash
  // -------------------------------------------------------------------------

  describe('stash', () => {
    test('stash push saves changes', async () => {
      addCommit(tmpDir, 'file.txt', 'v1', 'initial');
      writeFileSync(join(tmpDir, 'file.txt'), 'v2');
      await svc.stash('push', 'my stash');
      const st = await svc.status();
      expect(st.modified).toHaveLength(0);
    });

    test('stash pop restores changes', async () => {
      addCommit(tmpDir, 'file.txt', 'v1', 'initial');
      writeFileSync(join(tmpDir, 'file.txt'), 'v2');
      await svc.stash('push');
      await svc.stash('pop');
      const st = await svc.status();
      expect(st.modified).toContain('file.txt');
    });

    test('stash list returns list output', async () => {
      addCommit(tmpDir, 'file.txt', 'v1', 'initial');
      writeFileSync(join(tmpDir, 'file.txt'), 'v2');
      await svc.stash('push', 'my-named-stash');
      const list = await svc.stash('list');
      expect(list).toContain('my-named-stash');
    });
  });

  // -------------------------------------------------------------------------
  // worktree
  // -------------------------------------------------------------------------

  describe('worktree', () => {
    test('worktreeAdd creates a new worktree', async () => {
      addCommit(tmpDir, 'init.txt', 'x', 'init');
      const wtPath = join(tmpDir, '..', `wt-${Date.now()}`);
      await svc.worktreeAdd(wtPath, 'wt-branch');
      const list = await svc.worktreeList();
      const paths = list.map((w) => w.path);
      expect(paths.some((p) => p.includes('wt-'))).toBe(true);
      // Cleanup
      await svc.worktreeRemove(wtPath);
    });

    test('worktreeList includes main worktree', async () => {
      addCommit(tmpDir, 'init.txt', 'x', 'init');
      const list = await svc.worktreeList();
      expect(list.length).toBeGreaterThanOrEqual(1);
      const paths = list.map((w) => w.path);
      expect(paths.some((p) => p.includes(tmpDir.split('/').pop()!))).toBe(true);
    });

    test('worktreeRemove removes the worktree', async () => {
      addCommit(tmpDir, 'init.txt', 'x', 'init');
      const wtPath = join(tmpDir, '..', `wt2-${Date.now()}`);
      await svc.worktreeAdd(wtPath, 'wt2-branch');
      await svc.worktreeRemove(wtPath);
      const list = await svc.worktreeList();
      expect(list.every((w) => !w.path.includes('wt2-'))).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // blame
  // -------------------------------------------------------------------------

  describe('blame', () => {
    test('blame returns author, line number, and content for a committed file', async () => {
      addCommit(tmpDir, 'blame-me.txt', 'hello world', 'add blame-me');
      const result = await svc.blame('blame-me.txt');
      expect(result.length).toBeGreaterThanOrEqual(1);
      expect(result[0].author).toBe('Test');
      expect(result[0].line).toBe(1);
      expect(result[0].content).toBe('hello world');
      expect(result[0].hash).toMatch(/^[0-9a-f]{40}$/);
    });
  });

  // -------------------------------------------------------------------------
  // reset
  // -------------------------------------------------------------------------

  describe('reset', () => {
    test('reset unstages a file', async () => {
      addCommit(tmpDir, 'base.txt', 'base', 'base');
      writeFileSync(join(tmpDir, 'new.txt'), 'data');
      execSync('git add new.txt', { cwd: tmpDir });
      await svc.reset('new.txt');
      const st = await svc.status();
      expect(st.created).toHaveLength(0);
      expect(st.not_added).toContain('new.txt');
    });
  });

  // -------------------------------------------------------------------------
  // Hook emission
  // -------------------------------------------------------------------------

  describe('hook emission', () => {
    /**
     * Register a spy that captures every fired event for the given pattern.
     * Uses the 'ts' runner indirectly by registering a programmatic hook.
     * We monkey-patch by registering a command hook then inspecting via
     * the fire() method directly through a proxy dispatcher subclass.
     *
     * Simpler approach: subclass HookDispatcher to intercept fire().
     */
    class SpyDispatcher extends HookDispatcher {
      readonly events: HookEvent[] = [];
      override async fire(event: HookEvent) {
        this.events.push(event);
        return super.fire(event);
      }
    }

    test('Pre:git:commit fires before commit', async () => {
      const spy = new SpyDispatcher();
      const spySvc = new GitService(tmpDir, spy);
      writeFileSync(join(tmpDir, 'hook-test.txt'), 'data');
      await spySvc.add('hook-test.txt');
      await spySvc.commit('hook test commit');
      const preEvents = spy.events.filter(
        (e) => e.phase === 'Pre' && e.specific === 'commit',
      );
      expect(preEvents.length).toBe(1);
      expect(preEvents[0].category).toBe('git');
      expect(preEvents[0].payload.message).toBe('hook test commit');
      spySvc.dispose();
    });

    test('Post:git:commit fires after successful commit', async () => {
      const spy = new SpyDispatcher();
      const spySvc = new GitService(tmpDir, spy);
      writeFileSync(join(tmpDir, 'hook-post.txt'), 'data');
      await spySvc.add('hook-post.txt');
      await spySvc.commit('post hook commit');
      const postEvents = spy.events.filter(
        (e) => e.phase === 'Post' && e.specific === 'commit',
      );
      expect(postEvents.length).toBe(1);
      expect(postEvents[0].payload.message).toBe('post hook commit');
      expect(postEvents[0].payload.hash).toBeTruthy();
      spySvc.dispose();
    });

    test('Fail:git:commit fires when commit fails', async () => {
      const spy = new SpyDispatcher();
      // Use a non-git directory to force simple-git to throw
      const nonRepoDir = makeExternalDir('non-repo');
      try {
        const spySvc = new GitService(nonRepoDir, spy);
        await expect(spySvc.commit('should fail')).rejects.toThrow();
        const failEvents = spy.events.filter(
          (e) => e.phase === 'Fail' && e.specific === 'commit',
        );
        expect(failEvents.length).toBe(1);
        expect(failEvents[0].payload.error).toBeTruthy();
        spySvc.dispose();
      } finally {
        rmSync(nonRepoDir, { recursive: true, force: true });
      }
    });

    test('Pre:git:commit deny blocks commit', async () => {
      const spy = new SpyDispatcher();
      // Register a hook that denies
      spy.register('Pre:git:commit', {
        match: 'Pre:git:commit',
        type: 'command',
        command: 'echo \'{"ok":true,"decision":"deny","reason":"test block"}\'',
      });
      const spySvc = new GitService(tmpDir, spy);
      writeFileSync(join(tmpDir, 'blocked.txt'), 'data');
      await spySvc.add('blocked.txt');
      await expect(spySvc.commit('blocked commit')).rejects.toThrow(/blocked|hook/i);
      spySvc.dispose();
    });

    test('Pre:git:checkout fires before checkout', async () => {
      const spy = new SpyDispatcher();
      const spySvc = new GitService(tmpDir, spy);
      addCommit(tmpDir, 'init2.txt', 'x', 'init2');
      await spySvc.checkout('feature-hook', { create: true });
      const preEvents = spy.events.filter(
        (e) => e.phase === 'Pre' && e.specific === 'checkout',
      );
      expect(preEvents.length).toBe(1);
      spySvc.dispose();
    });

    test('Pre:git:push fires before push', async () => {
      const spy = new SpyDispatcher();
      const spySvc = new GitService(tmpDir, spy);
      // Push will fail (no remote) but Pre should still fire
      try { await spySvc.push('nonexistent-remote'); } catch {}
      const preEvents = spy.events.filter(
        (e) => e.phase === 'Pre' && e.specific === 'push',
      );
      expect(preEvents.length).toBe(1);
      spySvc.dispose();
    });

    test('Pre:git:stash fires before stash', async () => {
      const spy = new SpyDispatcher();
      const spySvc = new GitService(tmpDir, spy);
      addCommit(tmpDir, 'stash-init.txt', 'x', 'stash-init');
      writeFileSync(join(tmpDir, 'stash-init.txt'), 'changed');
      await spySvc.stash('push');
      const preEvents = spy.events.filter(
        (e) => e.phase === 'Pre' && e.specific === 'stash',
      );
      expect(preEvents.length).toBe(1);
      spySvc.dispose();
    });

    test('Post:git:stash fires after successful stash', async () => {
      const spy = new SpyDispatcher();
      const spySvc = new GitService(tmpDir, spy);
      addCommit(tmpDir, 'stash-post.txt', 'x', 'stash-post');
      writeFileSync(join(tmpDir, 'stash-post.txt'), 'modified');
      await spySvc.stash('push', 'test-stash');
      const postEvents = spy.events.filter(
        (e) => e.phase === 'Post' && e.specific === 'stash',
      );
      expect(postEvents.length).toBe(1);
      spySvc.dispose();
    });

    test('Pre:git:pull fires before pull', async () => {
      const spy = new SpyDispatcher();
      const spySvc = new GitService(tmpDir, spy);
      addCommit(tmpDir, 'pull-test.txt', 'x', 'pull-test');
      // Pull on an up-to-date repo (no remote) will fail, but Pre should fire
      try { await spySvc.pull('nonexistent-remote'); } catch {}
      const preEvents = spy.events.filter(
        (e) => e.phase === 'Pre' && e.specific === 'pull',
      );
      expect(preEvents.length).toBe(1);
      spySvc.dispose();
    });

    test('Post:git:pull fires after successful pull', async () => {
      const spy = new SpyDispatcher();
      // Set up bare remote and clone to test a real pull
      const bareDir = makeTempPath('bare');
      const cloneDir = makeTempPath('clone');
      try {
        mkdirSync(bareDir, { recursive: true });
        addCommit(tmpDir, 'remote-file.txt', 'content', 'remote commit');
        execSync(`git clone --bare ${tmpDir} ${bareDir}`);
        execSync(`git clone ${bareDir} ${cloneDir}`);
        execSync('git config user.email "test@test.com"', { cwd: cloneDir });
        execSync('git config user.name "Test"', { cwd: cloneDir });
        const cloneSvc = new GitService(cloneDir, spy);
        // Clone is already up-to-date; pull should still emit hooks
        await cloneSvc.pull('origin');
        const postEvents = spy.events.filter(
          (e) => e.phase === 'Post' && e.specific === 'pull',
        );
        expect(postEvents.length).toBe(1);
        cloneSvc.dispose();
      } finally {
        rmSync(bareDir, { recursive: true, force: true });
        rmSync(cloneDir, { recursive: true, force: true });
      }
    });

    test('Pre:git:worktree-create fires before worktreeAdd', async () => {
      const spy = new SpyDispatcher();
      const spySvc = new GitService(tmpDir, spy);
      addCommit(tmpDir, 'wt-hook-init.txt', 'x', 'wt-hook-init');
      const wtPath = makeTempPath('wt-hook');
      try {
        await spySvc.worktreeAdd(wtPath, 'wt-hook-branch');
        const preEvents = spy.events.filter(
          (e) => e.phase === 'Pre' && e.specific === 'worktreeAdd',
        );
        expect(preEvents.length).toBe(1);
        expect(preEvents[0].payload.path).toBe(wtPath);
        expect(preEvents[0].payload.branch).toBe('wt-hook-branch');
        await spySvc.worktreeRemove(wtPath);
      } finally {
        rmSync(wtPath, { recursive: true, force: true });
        spySvc.dispose();
      }
    });

    test('Post:git:worktree-create fires after worktreeAdd', async () => {
      const spy = new SpyDispatcher();
      const spySvc = new GitService(tmpDir, spy);
      addCommit(tmpDir, 'wt-post-init.txt', 'x', 'wt-post-init');
      const wtPath = makeTempPath('wt-post');
      try {
        await spySvc.worktreeAdd(wtPath, 'wt-post-branch');
        const postEvents = spy.events.filter(
          (e) => e.phase === 'Post' && e.specific === 'worktreeAdd',
        );
        expect(postEvents.length).toBe(1);
        await spySvc.worktreeRemove(wtPath);
      } finally {
        rmSync(wtPath, { recursive: true, force: true });
        spySvc.dispose();
      }
    });

    test('Pre:git:worktree-remove fires before worktreeRemove', async () => {
      const spy = new SpyDispatcher();
      const spySvc = new GitService(tmpDir, spy);
      addCommit(tmpDir, 'wt-rm-init.txt', 'x', 'wt-rm-init');
      const wtPath = makeTempPath('wt-rm');
      try {
        await spySvc.worktreeAdd(wtPath, 'wt-rm-branch');
        spy.events.length = 0; // clear add events
        await spySvc.worktreeRemove(wtPath);
        const preEvents = spy.events.filter(
          (e) => e.phase === 'Pre' && e.specific === 'worktreeRemove',
        );
        expect(preEvents.length).toBe(1);
        expect(preEvents[0].payload.path).toBe(wtPath);
      } finally {
        rmSync(wtPath, { recursive: true, force: true });
        spySvc.dispose();
      }
    });

    test('Post:git:worktree-remove fires after worktreeRemove', async () => {
      const spy = new SpyDispatcher();
      const spySvc = new GitService(tmpDir, spy);
      addCommit(tmpDir, 'wt-rm-post-init.txt', 'x', 'wt-rm-post-init');
      const wtPath = makeTempPath('wt-rm-post');
      try {
        await spySvc.worktreeAdd(wtPath, 'wt-rm-post-branch');
        spy.events.length = 0; // clear add events
        await spySvc.worktreeRemove(wtPath);
        const postEvents = spy.events.filter(
          (e) => e.phase === 'Post' && e.specific === 'worktreeRemove',
        );
        expect(postEvents.length).toBe(1);
      } finally {
        rmSync(wtPath, { recursive: true, force: true });
        spySvc.dispose();
      }
    });

    test('Pre:git:merge fires before merge', async () => {
      const spy = new SpyDispatcher();
      const spySvc = new GitService(tmpDir, spy);
      addCommit(tmpDir, 'merge-base.txt', 'base', 'merge-base');
      execSync('git checkout -b merge-feat', { cwd: tmpDir });
      addCommit(tmpDir, 'merge-feat.txt', 'feat', 'merge-feat');
      const mainBranch = execSync('git log --format=%D HEAD~1', { cwd: tmpDir })
        .toString().split(',').map((s) => s.trim())
        .find((s) => s === 'master' || s === 'main') ?? 'master';
      execSync(`git checkout ${mainBranch}`, { cwd: tmpDir });
      await spySvc.merge('merge-feat');
      const preEvents = spy.events.filter(
        (e) => e.phase === 'Pre' && e.specific === 'merge',
      );
      expect(preEvents.length).toBe(1);
      spySvc.dispose();
    });

    test('stash list does NOT emit hooks', async () => {
      const spy = new SpyDispatcher();
      const hookedSvc = new GitService(tmpDir, spy);
      writeFileSync(join(tmpDir, 'stashme.txt'), 'data');
      execSync('git add . && git commit -m "base"', { cwd: tmpDir });
      spy.events.length = 0;
      await hookedSvc.stash('list');
      expect(spy.events.length).toBe(0);
      hookedSvc.dispose();
    });

    test('merge rethrows non-conflict errors', async () => {
      const spy = new SpyDispatcher();
      const hookedSvc = new GitService(tmpDir, spy);
      writeFileSync(join(tmpDir, 'file.txt'), 'data');
      execSync('git add . && git commit -m "init"', { cwd: tmpDir });
      spy.events.length = 0;
      let threw = false;
      try {
        await hookedSvc.merge('nonexistent-branch-xyz');
      } catch {
        threw = true;
      }
      expect(threw).toBe(true);
      const failEvents = spy.events.filter((e) => e.phase === 'Fail');
      expect(failEvents.length).toBeGreaterThan(0);
      hookedSvc.dispose();
    });
  });

  // -------------------------------------------------------------------------
  // Static utilities
  // -------------------------------------------------------------------------

  describe('static utilities', () => {
    let nonRepoDir: string;

    beforeEach(() => {
      nonRepoDir = makeExternalDir('non-repo');
    });

    afterEach(() => {
      rmSync(nonRepoDir, { recursive: true, force: true });
    });

    test('isGitRepo returns false in a non-repo directory', () => {
      expect(GitService.isGitRepo(nonRepoDir)).toBe(false);
    });

    test('isGitRepo returns true after git init', () => {
      execSync('git init', { cwd: nonRepoDir });
      expect(GitService.isGitRepo(nonRepoDir)).toBe(true);
    });

    test('initRepo creates .git directory and returns { success: true }', () => {
      const result = GitService.initRepo(nonRepoDir);
      expect(result.success).toBe(true);
      expect(result.error).toBeUndefined();
      expect(GitService.isGitRepo(nonRepoDir)).toBe(true);
    });

    test('initRepo is idempotent on an already-initialized repo', () => {
      execSync('git init', { cwd: nonRepoDir });
      const result = GitService.initRepo(nonRepoDir);
      expect(result.success).toBe(true);
    });

    test('helper cache reset yields a fresh GitService for the same cwd', () => {
      const a = getTestGitService(tmpDir);
      resetTestGitServices(tmpDir);
      const b = getTestGitService(tmpDir);
      expect(a).not.toBe(b);
      b.dispose();
    });
  });
});
