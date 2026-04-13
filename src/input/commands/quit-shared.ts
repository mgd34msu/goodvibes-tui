import type { StatusResult } from 'simple-git';
import { basename } from 'path';
import type { CommandContext } from '../command-registry.ts';
import { GitService } from '../../git/service.ts';

type GitLike = Pick<GitService, 'addAll' | 'status' | 'commit'>;

export type GitChange = {
  action: 'add' | 'update' | 'delete' | 'rename';
  path: string;
  from?: string;
  to?: string;
};

type GitStatusLike = Pick<StatusResult, 'staged' | 'modified' | 'not_added' | 'deleted' | 'created' | 'renamed'> & {
  isClean?: () => boolean;
};

export function collectGitChanges(status: GitStatusLike): GitChange[] {
  const changes = new Map<string, GitChange>();

  for (const rename of status.renamed ?? []) {
    const to = rename.to || rename.from;
    if (!to) continue;
    changes.set(to, { action: 'rename', path: to, from: rename.from, to: rename.to });
  }

  for (const path of status.created ?? []) {
    if (!changes.has(path)) changes.set(path, { action: 'add', path });
  }

  for (const path of status.not_added ?? []) {
    if (!changes.has(path)) changes.set(path, { action: 'add', path });
  }

  for (const path of status.deleted ?? []) {
    if (!changes.has(path)) changes.set(path, { action: 'delete', path });
  }

  for (const path of status.modified ?? []) {
    if (!changes.has(path)) changes.set(path, { action: 'update', path });
  }

  for (const path of status.staged ?? []) {
    if (!changes.has(path)) changes.set(path, { action: 'update', path });
  }

  return Array.from(changes.values()).sort((a, b) => a.path.localeCompare(b.path));
}

function formatList(items: string[]): string {
  if (items.length === 0) return '';
  if (items.length === 1) return items[0]!;
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`;
}

function topLevelScope(path: string): string {
  const normalized = path.replace(/\\/g, '/').replace(/^\.\/+/, '');
  if (!normalized) return 'root';
  const [first] = normalized.split('/');
  return first && first.length > 0 ? first : 'root';
}

function summarizeScopes(changes: GitChange[]): string | null {
  const scopes = Array.from(new Set(changes.map((change) => topLevelScope(change.path)).filter(Boolean)));
  if (scopes.length === 0) return null;
  if (scopes.length <= 3) {
    return scopes.length === 1 ? `${scopes[0]} files` : `${formatList(scopes)} files`;
  }
  return `${changes.length} files`;
}

function shortPath(path: string): string {
  return path.length > 42 ? basename(path) : path;
}

export function buildWriteQuitCommitMessage(changes: GitChange[]): string {
  if (changes.length === 0) return 'Update working tree';

  if (changes.length === 1) {
    const [change] = changes;
    if (!change) return 'Update working tree';
    if (change.action === 'rename') {
      return `Rename ${shortPath(change.from ?? change.path)} to ${shortPath(change.to ?? change.path)}`;
    }
    const verb = change.action === 'add'
      ? 'Add'
      : change.action === 'delete'
        ? 'Delete'
        : 'Update';
    return `${verb} ${shortPath(change.path)}`;
  }

  const uniqueActions = Array.from(new Set(changes.map((change) => change.action)));
  if (uniqueActions.length === 1) {
    const [action] = uniqueActions;
    const verb = action === 'add'
      ? 'Add'
      : action === 'delete'
        ? 'Delete'
        : action === 'rename'
          ? 'Rename'
          : 'Update';
    const scopeLabel = summarizeScopes(changes);
    if (scopeLabel) return `${verb} ${scopeLabel}`;
    return `${verb} ${changes.length} files`;
  }

  const scopeLabel = summarizeScopes(changes);
  if (scopeLabel) return `Update ${scopeLabel}`;
  return `Update ${changes.length} files`;
}

export type ExecuteWriteQuitOptions = {
  cwd?: string;
  isGitRepo?: (cwd: string) => boolean;
  getRepoRoot?: (cwd: string) => string | null;
  gitFactory?: (cwd: string) => GitLike;
};

export async function executeWriteQuit(
  ctx: Pick<CommandContext, 'print' | 'exit'> & {
    workspace?: CommandContext['workspace'];
  },
  options: ExecuteWriteQuitOptions = {},
): Promise<void> {
  const cwd = options.cwd ?? ctx.workspace?.shellPaths?.workingDirectory;
  if (!cwd) {
    throw new Error('commandContext.workspace.shellPaths is required when executeWriteQuit() is called without an explicit cwd');
  }
  const isGitRepo = options.isGitRepo ?? ((dir: string) => GitService.isGitRepo(dir));
  if (!isGitRepo(cwd)) {
    ctx.exit();
    return;
  }

  const repoRoot = options.getRepoRoot?.(cwd) ?? GitService.getRepoRoot(cwd) ?? cwd;
  const git = options.gitFactory?.(repoRoot) ?? new GitService(repoRoot);

  try {
    ctx.print(`[wq] Staging changes in ${repoRoot}...`);
    await git.addAll();
    const status = await git.status();
    if (status.isClean()) {
      ctx.print('[wq] Working tree clean. Exiting without creating a commit.');
      ctx.exit();
      return;
    }

    const changes = collectGitChanges(status);
    const message = buildWriteQuitCommitMessage(changes);
    ctx.print(`[wq] Committing ${changes.length} change${changes.length === 1 ? '' : 's'}: ${message}`);
    const result = await git.commit(message);
    const shortHash = result.hash ? result.hash.slice(0, 7) : 'unknown';
    ctx.print(`[wq] Commit complete: ${shortHash} ${message}`);
    ctx.exit();
  } catch (error) {
    ctx.print(`[wq] Commit failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}
