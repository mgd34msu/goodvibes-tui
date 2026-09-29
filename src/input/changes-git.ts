/**
 * changes-git.ts, the git reads and writes behind the Changes modal.
 *
 * Every spawn captures stdout and stderr: a child left with inherited stdio
 * would write straight to the TUI's terminal, outside the renderer. Nothing
 * here throws into the render loop; failures come back as text to show.
 */

import { isAbsolute, join, relative } from 'node:path';
import { GitService } from '@pellux/goodvibes-sdk/platform/git';
import { summarizeError } from '@pellux/goodvibes-sdk/platform/utils';

/** Which diff the modal shows. */
export type ChangesSource = 'session' | 'working' | 'staged' | 'head';

export const CHANGES_SOURCES: readonly ChangesSource[] = ['session', 'working', 'staged', 'head'];

export const CHANGES_SOURCE_LABELS: Readonly<Record<ChangesSource, string>> = {
  session: 'this session',
  working: 'not staged',
  staged: 'staged',
  head: 'all changes vs HEAD',
};

interface RunResult { readonly out: string; readonly err: string; readonly ok: boolean }

/**
 * Pin the a/ and b/ path prefixes: a user's diff.mnemonicPrefix or
 * diff.noprefix setting would otherwise turn paths into w/src/x.ts or
 * src/x.ts, which the file list, hunk staging and the semantic reader all
 * misread.
 */
const DIFF_PREFIX_ARGS: readonly string[] = ['--src-prefix=a/', '--dst-prefix=b/'];

async function run(args: string[], cwd: string, stdin?: string): Promise<RunResult> {
  try {
    const proc = Bun.spawn(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe', stdin: stdin !== undefined ? 'pipe' : 'ignore' });
    if (stdin !== undefined && proc.stdin) {
      proc.stdin.write(stdin);
      await proc.stdin.end();
    }
    const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    const code = await proc.exited;
    return { out, err: err.trim(), ok: code === 0 };
  } catch (error) {
    return { out: '', err: summarizeError(error), ok: false };
  }
}

export function isGitRepo(cwd: string): boolean {
  return GitService.isGitRepo(cwd);
}

export interface LoadedDiff {
  readonly raw: string;
  /** What the diff is, in words ("this session: 3 files vs HEAD"). */
  readonly label: string;
  readonly error: string | null;
}

/** Untracked files larger than this show as added with a note instead of every line. */
export const MAX_UNTRACKED_BYTES = 256 * 1024;
/** Untracked files with more lines than this show as added with a note instead of every line. */
export const MAX_UNTRACKED_LINES = 4000;
/** At most this many untracked files are read into one diff; the label counts the rest. */
export const MAX_UNTRACKED_FILES = 200;

/**
 * A new-file chunk with no hunks and a note line in place of the content. The
 * note line starts with "# ", which no git header line does; parseChanges
 * reads it into ChangeFile.note.
 */
function noteChunk(path: string, note: string): string {
  return `diff --git a/${path} b/${path}\nnew file mode 100644\n# ${note}\n`;
}

/** One untracked file as an all-added diff chunk (paths relative to the repo root). */
async function untrackedChunk(repoRoot: string, path: string): Promise<string> {
  let size = 0;
  try {
    size = Bun.file(join(repoRoot, path)).size;
  } catch {
    size = 0;
  }
  if (size > MAX_UNTRACKED_BYTES) return noteChunk(path, `large new file (${Math.round(size / 1024)} KB), not shown line by line`);
  // --no-index against /dev/null is git's own new-file patch: binary detection,
  // "new file mode", "--- /dev/null", and a hunk staging can apply as is.
  const result = await run(['diff', '--no-index', '--no-color', ...DIFF_PREFIX_ARGS, '--', '/dev/null', path], repoRoot);
  // --no-index exits 1 when the files differ, which is the expected case here.
  if (!result.out.trim()) return result.err ? noteChunk(path, `could not read: ${result.err.split('\n')[0]}`) : noteChunk(path, 'empty new file');
  const lines = result.out.split('\n').length;
  if (lines > MAX_UNTRACKED_LINES) return noteChunk(path, `large new file (${lines} lines), not shown line by line`);
  return result.out.endsWith('\n') ? result.out : `${result.out}\n`;
}

/**
 * Untracked, non-ignored files as all-added diff chunks, one per file. With
 * `only` set, just the untracked files among those paths (the session's own
 * new files); otherwise every untracked file in the repository.
 */
export async function loadUntrackedDiff(cwd: string, only?: readonly string[]): Promise<{ raw: string; count: number; skipped: number }> {
  if (only && only.length === 0) return { raw: '', count: 0, skipped: 0 };
  const top = await run(['rev-parse', '--show-toplevel'], cwd);
  if (!top.ok) return { raw: '', count: 0, skipped: 0 };
  const repoRoot = top.out.trim() || cwd;
  // A session path outside this repository would fail the whole listing; leave it out.
  const specs = only ? only.filter((path) => !isAbsolute(path) || path.startsWith(`${repoRoot}/`)) : [':/'];
  if (specs.length === 0) return { raw: '', count: 0, skipped: 0 };
  const listed = await run(['ls-files', '--others', '--exclude-standard', '--full-name', '-z', '--', ...specs], cwd);
  if (!listed.ok) return { raw: '', count: 0, skipped: 0 };
  const paths = listed.out.split('\0').filter((path) => path.length > 0).sort();
  const shown = paths.slice(0, MAX_UNTRACKED_FILES);
  const chunks: string[] = [];
  // A few at a time: one git process per file, never hundreds at once.
  for (let i = 0; i < shown.length; i += 8) {
    chunks.push(...await Promise.all(shown.slice(i, i + 8).map((path) => untrackedChunk(repoRoot, path))));
  }
  return { raw: chunks.join(''), count: shown.length, skipped: paths.length - shown.length };
}

/**
 * The diff for a source. `sessionFiles` are the files this session edited.
 * Untracked files are part of every source except "staged": they show as
 * added files with their whole content (the session source takes only the
 * untracked files this session wrote).
 */
export async function loadDiff(cwd: string, source: ChangesSource, sessionFiles: readonly string[]): Promise<LoadedDiff> {
  let args: string[];
  let label: string;
  let untrackedOnly: readonly string[] | undefined;
  if (source === 'working') {
    args = ['diff', '--no-color', ...DIFF_PREFIX_ARGS];
    label = 'not staged';
  } else if (source === 'staged') {
    args = ['diff', '--cached', '--no-color', ...DIFF_PREFIX_ARGS];
    label = 'staged';
  } else if (source === 'session' && sessionFiles.length > 0) {
    args = ['diff', '--no-color', ...DIFF_PREFIX_ARGS, 'HEAD', '--', ...sessionFiles];
    label = `this session · ${sessionFiles.length} file${sessionFiles.length === 1 ? '' : 's'} vs HEAD`;
    untrackedOnly = sessionFiles;
  } else {
    args = ['diff', '--no-color', ...DIFF_PREFIX_ARGS, 'HEAD'];
    label = source === 'session' ? 'no files tracked this session · all changes vs HEAD' : 'all changes vs HEAD';
  }
  const [result, untracked] = await Promise.all([
    run(args, cwd),
    source === 'staged' ? Promise.resolve({ raw: '', count: 0, skipped: 0 }) : loadUntrackedDiff(cwd, untrackedOnly),
  ]);
  if (!result.ok) return { raw: '', label, error: result.err || 'git diff failed' };
  const total = untracked.count + untracked.skipped;
  if (total > 0) {
    label += ` · ${total} untracked`;
    if (untracked.skipped > 0) label += ` (${untracked.skipped} not shown)`;
  }
  const tracked = result.out && !result.out.endsWith('\n') ? `${result.out}\n` : result.out;
  return { raw: tracked + untracked.raw, label, error: null };
}

export interface CommitEntry {
  readonly hash: string;
  readonly message: string;
  readonly date: string;
}

export async function loadRecentCommits(cwd: string, count = 10): Promise<CommitEntry[]> {
  try {
    const entries = await new GitService(cwd).log(count);
    return entries.map((entry) => ({ hash: entry.hash, message: entry.message, date: entry.date }));
  } catch {
    return [];
  }
}

/** A commit's patch (works for root commits too). */
export async function loadCommitDiff(cwd: string, hash: string): Promise<LoadedDiff> {
  const result = await run(['show', '--no-color', '--format=', '--patch', ...DIFF_PREFIX_ARGS, hash], cwd);
  const label = `commit ${hash.slice(0, 7)}`;
  if (!result.ok) return { raw: '', label, error: result.err || 'git show failed' };
  return { raw: result.out, label, error: null };
}

export interface RepoSummary {
  readonly branch: string;
  readonly staged: number;
  readonly unstaged: number;
}

export async function loadRepoSummary(cwd: string): Promise<RepoSummary | null> {
  try {
    const git = new GitService(cwd);
    const [status, branch] = await Promise.all([git.status(), git.branch()]);
    let staged = 0;
    let unstaged = 0;
    for (const f of status.files) {
      if (f.index === '?' && f.working_dir === '?') { unstaged++; continue; }
      if (f.index !== ' ') staged++;
      if (f.working_dir !== ' ') unstaged++;
    }
    return { branch: branch.current || (branch.detached ? 'detached' : 'no branch'), staged, unstaged };
  } catch {
    return null;
  }
}

/** Stage (or with reverse, unstage) exactly one hunk. */
export async function applyHunkToIndex(cwd: string, patch: string, reverse: boolean): Promise<string | null> {
  const args = ['apply', '--cached', '--recount', ...(reverse ? ['-R'] : []), '-'];
  const result = await run(args, cwd, patch);
  return result.ok ? null : (result.err || 'git apply failed');
}

/** Stage or unstage a whole file. */
export async function setFileStaged(cwd: string, path: string, staged: boolean): Promise<string | null> {
  const result = staged ? await run(['add', '--', path], cwd) : await run(['reset', '-q', '--', path], cwd);
  return result.ok ? null : (result.err || `git ${staged ? 'add' : 'reset'} failed`);
}

export async function commitStaged(cwd: string, message: string): Promise<{ hash: string; error: string | null }> {
  try {
    const result = await new GitService(cwd).commit(message);
    return { hash: result.hash, error: null };
  } catch (error) {
    return { hash: '', error: summarizeError(error) };
  }
}

export function initRepo(cwd: string): string | null {
  const result = GitService.initRepo(cwd);
  return result.success ? null : (result.error ?? 'git init failed');
}

/**
 * The semantic changes in one file (functions, classes, imports added,
 * removed or changed), comparing `ref` against the file on disk. Null when it
 * cannot be computed (a new file, an unsupported language, no repo).
 */
export async function loadSemanticDiff(cwd: string, filePath: string, ref: string): Promise<import('../renderer/semantic-diff.ts').SemanticDiff | null> {
  try {
    const top = await run(['rev-parse', '--show-toplevel'], cwd);
    const repoRoot = top.ok ? top.out.trim() || cwd : cwd;
    const absPath = filePath.startsWith('/') ? filePath : join(repoRoot, filePath);
    const repoRel = filePath.startsWith('/') ? relative(repoRoot, filePath) : filePath;
    const before = await run(['show', `${ref}:${repoRel}`], repoRoot);
    if (!before.ok) return null;
    const after = await Bun.file(absPath).text();
    const { computeSemanticDiff } = await import('../renderer/semantic-diff.ts');
    return await computeSemanticDiff(filePath, before.out, after);
  } catch {
    return null;
  }
}
