import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'fs';
import { execSync } from 'child_process';
import { join } from 'path';
import { tmpdir } from 'os';
import { AgentWorktree } from '@pellux/goodvibes-sdk/platform/agents/worktree';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create an isolated temp git repo and return its path. */
function makeTempRepo(): string {
  const tmpDir = mkdtempSync(join(tmpdir(), 'gv-worktree-test-'));
  execSync('git init', { cwd: tmpDir });
  execSync('git config user.email "test@test.com"', { cwd: tmpDir });
  execSync('git config user.name "Test"', { cwd: tmpDir });
  // Need at least one commit so branches can be created from HEAD
  writeFileSync(join(tmpDir, 'README.md'), 'init');
  execSync('git add README.md', { cwd: tmpDir });
  execSync('git commit -m "init"', { cwd: tmpDir });
  return tmpDir;
}

/** Cleanup a worktree from a repo if it exists. */
function cleanupWorktree(repoDir: string, worktreePath: string): void {
  try {
    if (existsSync(worktreePath)) {
      execSync(`git worktree remove --force "${worktreePath}"`, { cwd: repoDir });
    }
  } catch {
    // best-effort
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AgentWorktree', () => {
  let tmpDir: string;
  let aw: AgentWorktree;

  beforeEach(() => {
    tmpDir = makeTempRepo();
    aw = new AgentWorktree(tmpDir);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // create
  // -------------------------------------------------------------------------

  describe('create', () => {
    test('creates a worktree directory', async () => {
      const agentId = 'abc123';
      const worktreePath = await aw.create(agentId);
      expect(existsSync(worktreePath)).toBe(true);
      // Cleanup
      await aw.cleanup(agentId);
    });

    test('returns path inside .goodvibes/.worktrees/', async () => {
      const agentId = 'path-test';
      const worktreePath = await aw.create(agentId);
      expect(worktreePath).toContain('.goodvibes/.worktrees/agent-path-test');
      await aw.cleanup(agentId);
    });

    test('worktree appears in git worktree list', async () => {
      const agentId = 'list-test';
      await aw.create(agentId);
      const list = execSync('git worktree list --porcelain', { cwd: tmpDir }).toString();
      expect(list).toContain(`agent-${agentId}`);
      await aw.cleanup(agentId);
    });

    test('creates a branch named agent/{agentId}', async () => {
      const agentId = 'branch-test';
      await aw.create(agentId);
      const branches = execSync('git branch', { cwd: tmpDir }).toString();
      expect(branches).toContain(`agent/${agentId}`);
      await aw.cleanup(agentId);
    });
  });

  // -------------------------------------------------------------------------
  // cleanup
  // -------------------------------------------------------------------------

  describe('cleanup', () => {
    test('removes the worktree directory', async () => {
      const agentId = 'cleanup-test';
      const worktreePath = await aw.create(agentId);
      expect(existsSync(worktreePath)).toBe(true);
      await aw.cleanup(agentId);
      expect(existsSync(worktreePath)).toBe(false);
    });

    test('cleanup on non-existent worktree does not throw', async () => {
      await expect(aw.cleanup('nonexistent-agent')).resolves.toBeUndefined();
    });

    test('deletes the agent branch after cleanup', async () => {
      const agentId = 'branch-del-test';
      await aw.create(agentId);
      await aw.cleanup(agentId);
      const branches = execSync('git branch', { cwd: tmpDir }).toString();
      expect(branches).not.toContain(`agent/${agentId}`);
    });
  });

  // -------------------------------------------------------------------------
  // merge
  // -------------------------------------------------------------------------

  describe('merge', () => {
    test('returns false and removes worktree when no commits on branch', async () => {
      const agentId = 'merge-no-changes';
      const worktreePath = await aw.create(agentId);
      // No commits on the branch
      const merged = await aw.merge(agentId);
      expect(merged).toBe(false);
      expect(existsSync(worktreePath)).toBe(false);
    });

    test('returns true and merges when branch has commits', async () => {
      const agentId = 'merge-with-changes';
      const worktreePath = await aw.create(agentId);

      // Add a commit to the agent branch
      writeFileSync(join(worktreePath, 'agent-file.txt'), 'agent work');
      execSync('git add agent-file.txt', { cwd: worktreePath });
      execSync('git commit -m "agent: add file"', {
        cwd: worktreePath,
        env: { ...process.env, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@test.com',
               GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@test.com' },
      });

      const merged = await aw.merge(agentId);
      expect(merged).toBe(true);

      // Worktree is removed
      expect(existsSync(worktreePath)).toBe(false);

      // The file should now exist on the main branch
      expect(existsSync(join(tmpDir, 'agent-file.txt'))).toBe(true);
    });

    test('removes the agent branch after successful merge', async () => {
      const agentId = 'merge-branch-cleanup';
      const worktreePath = await aw.create(agentId);

      // Add a commit
      writeFileSync(join(worktreePath, 'x.txt'), 'x');
      execSync('git add x.txt', { cwd: worktreePath });
      execSync('git commit -m "add x"', {
        cwd: worktreePath,
        env: { ...process.env, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@test.com',
               GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@test.com' },
      });

      await aw.merge(agentId);

      const branches = execSync('git branch', { cwd: tmpDir }).toString();
      expect(branches).not.toContain(`agent/${agentId}`);
    });
  });
});
