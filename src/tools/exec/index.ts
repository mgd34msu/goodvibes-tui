import { resolve, isAbsolute, join, relative, dirname } from 'node:path';
import { copyFileSync, renameSync, unlinkSync, rmSync, cpSync, writeFileSync, mkdirSync, appendFileSync, existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import type { Tool } from '../../types/tools.ts';
import { resolveAndValidatePath } from '../../utils/path-safety.ts';
import { logger } from '../../utils/logger.ts';
import { EXEC_TOOL_SCHEMA } from './schema.ts';
import { overflowHandler } from '../shared/overflow.ts';
import { getToolResultMaxChars } from '../../providers/model-limits.ts';
import type {
  ExecInput,
  ExecCommandInput,
  ExecCommandResult,
  ExecFileOp,
  ExecVerbosity,
} from './schema.ts';
import { ProcessManager } from '../shared/process-manager.ts';
import { guardExecCommand, formatDenialResponse } from './ast-guard.ts';

// ─── Constants ──────────────────────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 120_000;
// OUTPUT_TRUNCATE_LIMIT is resolved dynamically via getToolResultMaxChars() at call time
const PROGRESS_AUTO_THRESHOLD_MS = 30_000;
const OVERFLOW_DIR = join(process.cwd(), '.goodvibes', '.overflow');

/**
 * Dangerous command patterns. We warn but do NOT block — the permission
 * system gates execution. These are purely advisory.
 */
const DANGEROUS_PATTERNS = [
  /rm\s+-[a-zA-Z]*r[a-zA-Z]*f?\s+[\/~]/,  // rm -rf /  rm -r /
  /rm\s+-[a-zA-Z]*f[a-zA-Z]*r?\s+[\/~]/,  // rm -fr /
  /\bmkfs\b/,                               // format disk
  /\bdd\b.*\bof=\/dev/,                     // raw disk write
  /chmod\s+777\s+\//,                       // chmod 777 /
  /chown\s+.*\s+\//,                        // chown on root
];

// ─── ProcessManager (module-level singleton) ──────────────────────────────────────

/** Expose for testing — reset the shared ProcessManager singleton. */
export function _resetProcessManager(): void {
  ProcessManager.resetInstance();
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function decodeCmd(cmdInput: ExecCommandInput): string {
  if (cmdInput.cmd_base64) {
    return Buffer.from(cmdInput.cmd_base64, 'base64').toString('utf-8');
  }
  if (cmdInput.cmd) return cmdInput.cmd;
  throw new Error('Each command must have either cmd or cmd_base64');
}

function truncate(s: string, label?: string): { text: string; truncated: boolean } {
  const result = overflowHandler.handle(s, { maxChars: getToolResultMaxChars(), label });
  return { text: result.content, truncated: result.overflowRef !== undefined };
}

function checkDangerous(cmd: string): void {
  for (const pat of DANGEROUS_PATTERNS) {
    if (pat.test(cmd)) {
      logger.info(`[exec] WARNING: Potentially dangerous command detected: ${cmd}`);
      break;
    }
  }
}

function resolveCwd(cwd?: string, globalCwd?: string): string | undefined {
  const effective = cwd ?? globalCwd;
  if (!effective) return undefined;
  // Allow absolute paths that exist; relative paths resolve against process.cwd()
  if (isAbsolute(effective)) return effective;
  return resolve(process.cwd(), effective);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function computeRetryDelay(attempt: number, delayMs: number, backoff: 'fixed' | 'exponential'): number {
  if (backoff === 'fixed') return delayMs;
  return delayMs * Math.pow(2, attempt);
}

// ─── Progress file helpers ────────────────────────────────────────────────────

/**
 * Returns the path for a progress file given a unique run ID.
 * Path: .goodvibes/.overflow/{id}-progress.txt
 */
function getProgressFilePath(id: string): string {
  return join(OVERFLOW_DIR, `${id}-progress.txt`);
}

/**
 * Initializes a progress file for a command run.
 * Returns the file path and an append function for streaming stdout lines.
 */
function initProgressFile(cmdStr: string): { path: string; append: (line: string) => void } {
  try {
    mkdirSync(OVERFLOW_DIR, { recursive: true });
  } catch (err) {
    logger.debug('initProgressFile: mkdirSync failed (dir may already exist)', { error: err instanceof Error ? err.message : String(err) });
  }
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const filePath = getProgressFilePath(id);
  writeFileSync(filePath, `# Progress: ${cmdStr}\n# Started: ${new Date().toISOString()}\n`);
  return {
    path: filePath,
    append: (chunk: string) => {
      try { appendFileSync(filePath, chunk); } catch (err) { logger.debug('initProgressFile: appendFileSync failed', { path: filePath, error: err instanceof Error ? err.message : String(err) }); }
    },
  };
}

// ─── File operations ─────────────────────────────────────────────────────────

/**
 * Resolve a file_ops path.
 * - delete: ALL paths (absolute or relative) must be validated within the project root.
 * - copy/move: absolute paths are used as-is (unrestricted per schema); relative paths
 *   are validated against the project root to prevent traversal.
 */
function resolveFileOpPath(p: string, op: 'copy' | 'move' | 'delete'): string {
  if (op === 'delete' || !isAbsolute(p)) {
    return resolveAndValidatePath(p);
  }
  return resolve(p);
}

interface FileOpResult {
  op: string;
  source: string;
  destination?: string;
  dry_run?: boolean;
  would_delete?: string[];
  updated_imports?: string[];
}

/**
 * Collect all files under a directory (recursively) or return [path] for a single file.
 * Used for dry_run delete reporting.
 */
function collectPaths(p: string, acc: string[] = []): string[] {
  try {
    const st = statSync(p);
    if (st.isDirectory()) {
      for (const entry of readdirSync(p)) {
        collectPaths(join(p, entry), acc);
      }
    } else {
      acc.push(p);
    }
  } catch {
    acc.push(p);
  }
  return acc;
}

/**
 * Compute the relative import specifier from one TS/JS file to another.
 * Both paths must be absolute. Returns a string like './foo' or '../bar/baz'.
 */
function computeRelativeImportPath(fromFile: string, toFile: string): string {
  const TS_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);
  const toDir = dirname(toFile);
  let rel = relative(dirname(fromFile), toDir);
  // relative() returns '' when both files are in the same directory; ensure it always starts with '.'
  if (rel === '' || !rel.startsWith('.')) rel = './' + (rel || '');
  // Append filename without extension if target has a TS/JS extension, else as-is
  const ext = toFile.slice(toFile.lastIndexOf('.'));
  const base = toFile.slice(toDir.length + 1, TS_EXTS.has(ext) ? toFile.lastIndexOf('.') : undefined);
  // rel is './' for same-dir; use endsWith('/') to determine join style
  return rel.endsWith('/') ? rel + base : rel + '/' + base;
}

/**
 * After a move, scan TS/JS files that import from the old path and rewrite them.
 * Returns list of files that were updated.
 */
async function updateImportsAfterMove(
  oldSrc: string,
  newDst: string,
  projectRoot: string,
): Promise<string[]> {
  const TS_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);
  const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', '.next', '.nuxt', '.cache', '__pycache__']);

  // Collect all TS/JS files in project
  const allFiles: string[] = [];
  function walkDir(dir: string): void {
    let entries: string[];
    try { entries = readdirSync(dir); } catch { return; }
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry)) continue;
      const full = join(dir, entry);
      try {
        const st = statSync(full);
        if (st.isDirectory()) { walkDir(full); continue; }
        const ext = full.slice(full.lastIndexOf('.'));
        if (TS_EXTS.has(ext)) allFiles.push(full);
      } catch { /* skip */ }
    }
  }
  walkDir(projectRoot);

  // Determine the old specifier stem (without extension) - we match relative imports
  // that resolve to the old source file path. We build regex patterns for:
  //   from '..old_relative..'
  //   require('..old_relative..')
  const updated: string[] = [];

  for (const file of allFiles) {
    if (file === newDst) continue; // skip the moved file itself
    let content: string;
    try { content = readFileSync(file, 'utf-8'); } catch { continue; }

    // Compute what the old specifier would look like from this file's perspective
    const oldSpecifier = computeRelativeImportPath(file, oldSrc);
    const newSpecifier = computeRelativeImportPath(file, newDst);

    // Skip if specifier wouldn't change
    if (oldSpecifier === newSpecifier) continue;

    const escaped = oldSpecifier.replace(/[.*+~?^${}()|[\\]\\/g, '\\$&');
    const importRe = new RegExp(`(from\\s+['"])${escaped}(['"])`, 'g');
    const requireRe = new RegExp(`(require\\(['"])${escaped}(['"]\\))`, 'g');

    const newContent = content
      .replace(importRe, `$1${newSpecifier}$2`)
      .replace(requireRe, `$1${newSpecifier}$2`);

    if (newContent !== content) {
      try {
        writeFileSync(file, newContent, 'utf-8');
        updated.push(file);
      } catch (err) {
        logger.debug('exec file_ops update_imports: write failed (non-fatal)', {
          file,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  return updated;
}

function executeFileOp(op: ExecFileOp, projectRoot: string): FileOpResult {
  const src = resolveFileOpPath(op.source, op.op);
  const result: FileOpResult = { op: op.op, source: src };

  if (op.op === 'delete') {
    if (op.dry_run) {
      // Collect what would be deleted without actually deleting
      const wouldDelete = collectPaths(src);
      result.dry_run = true;
      result.would_delete = wouldDelete;
      return result;
    }
    if (op.recursive) {
      rmSync(src, { recursive: true, force: true });
    } else {
      unlinkSync(src);
    }
    return result;
  }

  if (!op.destination) {
    throw new Error(`file_ops ${op.op} requires destination`);
  }
  const dst = resolveFileOpPath(op.destination, op.op);
  result.destination = dst;

  // Overwrite check for copy/move
  if (!op.overwrite && existsSync(dst)) {
    throw new Error(
      `file_ops ${op.op}: destination already exists: '${op.destination}'. Set overwrite: true to replace it.`,
    );
  }

  if (op.op === 'copy') {
    if (op.recursive) {
      cpSync(src, dst, { recursive: true });
    } else {
      copyFileSync(src, dst);
    }
    return result;
  }

  if (op.op === 'move') {
    try {
      renameSync(src, dst);
    } catch {
      // Cross-device move: copy then delete
      if (op.recursive) {
        cpSync(src, dst, { recursive: true });
        rmSync(src, { recursive: true, force: true });
      } else {
        copyFileSync(src, dst);
        unlinkSync(src);
      }
    }
    // update_imports is handled asynchronously after the sync op returns
  }

  return result;
}

// ─── Background command management ──────────────────────────────────────────

function spawnBackground(
  cmd: string,
  cwd: string | undefined,
  env: Record<string, string> | undefined,
): ExecCommandResult {
  return ProcessManager.getInstance().spawn(cmd, cwd, env);
}

function handleBgSpecialCommand(cmd: string): ExecCommandResult | null {
  return ProcessManager.getInstance().handleCommand(cmd);
}

// ─── Core execution ───────────────────────────────────────────────────────────

async function runCommand(
  cmdStr: string,
  cmdInput: ExecCommandInput,
  globalCwd: string | undefined,
  globalTimeout: number,
): Promise<ExecCommandResult> {
  // ─── AST guard: evaluate command before execution ───
  const guardResult = await guardExecCommand(cmdStr);
  if (!guardResult.allowed) {
    const denial = formatDenialResponse(guardResult, cmdStr);
    return {
      cmd: cmdStr,
      exit_code: null,
      stdout: '',
      stderr: denial.denial_reason as string ?? 'Command denied by policy',
      success: false,
      denied: true,
      denial_detail: denial,
    } as ExecCommandResult;
  }

  checkDangerous(cmdStr);

  const cwd = resolveCwd(cmdInput.cwd, globalCwd);
  const timeoutMs = cmdInput.timeout_ms ?? globalTimeout;
  const cleanEnv = Object.fromEntries(
    Object.entries(process.env).filter(([, v]) => v !== undefined),
  ) as Record<string, string>;
  const mergedEnv = { ...cleanEnv, ...cmdInput.env };
  const startTime = Date.now();

  // ─── Until pattern mode ───
  if (cmdInput.until) {
    return runUntil(cmdStr, cmdInput, cwd, mergedEnv, timeoutMs, startTime);
  }

  // ─── Determine if progress tracking is needed ───
  const useProgress = cmdInput.progress === true || timeoutMs > PROGRESS_AUTO_THRESHOLD_MS;

  if (useProgress) {
    return runCommandWithProgress(cmdStr, cmdInput, cwd, mergedEnv, timeoutMs, startTime);
  }

  // ─── Normal execution ───
  const proc = Bun.spawn(['/bin/sh', '-c', cmdStr], {
    cwd,
    env: mergedEnv,
    stdout: 'pipe',
    stderr: 'pipe',
  });

  let timedOut = false;
  let killTimer: ReturnType<typeof setTimeout> | undefined;

  // Set up a timeout sentinel promise that resolves (not rejects) on expiry,
  // so we can detect it even when the underlying process exits due to SIGTERM.
  let timeoutResolve!: () => void;
  const timeoutSentinel = new Promise<void>((res) => { timeoutResolve = res; });

  killTimer = setTimeout(async () => {
    timedOut = true;
    try {
      proc.kill('SIGTERM');
      // Give the process a moment to exit before SIGKILL
      await sleep(200);
      proc.kill('SIGKILL');
    } catch { /* process already exited */ }
    timeoutResolve();
  }, timeoutMs);

  try {
    // Race between process completion and timeout sentinel
    type ProcResult = [string, string, number];
    const procPromise = Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]) as Promise<ProcResult>;

    let procResult: ProcResult | undefined;
    await Promise.race([
      procPromise.then((r) => { procResult = r; }),
      timeoutSentinel,
    ]);

    clearTimeout(killTimer);

    // If timeout fired first (or concurrently), return timed_out result
    if (timedOut) {
      // Wait for process to fully exit (already killed)
      try { await procPromise; } catch { /* ignore */ }
      return {
        cmd: cmdStr,
        exit_code: null,
        stdout: '',
        stderr: '',
        success: false,
        timed_out: true,
        duration_ms: Date.now() - startTime,
        cwd,
      };
    }

    const [stdoutRaw, stderrRaw, exitCode] = procResult!;

    const stdoutResult = truncate(stdoutRaw, 'stdout');
    const stderrResult = truncate(stderrRaw, 'stderr');
    const duration = Date.now() - startTime;

    const result: ExecCommandResult = {
      cmd: cmdStr,
      exit_code: exitCode,
      stdout: stdoutResult.text,
      stderr: stderrResult.text,
      success: exitCode === 0,
      duration_ms: duration,
      cwd,
      env: cmdInput.env,
      ...(stdoutResult.truncated && { stdout_truncated: true }),
      ...(stderrResult.truncated && { stderr_truncated: true }),
    };

    // Check expectations
    if (cmdInput.expect) {
      const { exit_code: expCode, stdout_contains, stderr_contains } = cmdInput.expect;
      const failures: string[] = [];

      if (expCode !== undefined && exitCode !== expCode) {
        failures.push(`exit_code: expected ${expCode}, got ${exitCode}`);
      }
      if (stdout_contains !== undefined && !(result.stdout.includes(stdout_contains))) {
        failures.push(`stdout_contains: '${stdout_contains}' not found`);
      }
      if (stderr_contains !== undefined && !(result.stderr.includes(stderr_contains))) {
        failures.push(`stderr_contains: '${stderr_contains}' not found`);
      }

      if (failures.length > 0) {
        result.success = false;
        result.expectation_error = failures.join('; ');
      }
    }

    return result;
  } catch (err) {
    clearTimeout(killTimer);
    throw err;
  }
}

/**
 * Runs a command with streaming progress output to a pollable file.
 * Used when progress=true or timeout_ms > PROGRESS_AUTO_THRESHOLD_MS.
 */
async function runCommandWithProgress(
  cmdStr: string,
  cmdInput: ExecCommandInput,
  cwd: string | undefined,
  mergedEnv: Record<string, string>,
  timeoutMs: number,
  startTime: number,
): Promise<ExecCommandResult> {
  const progressFile = initProgressFile(cmdStr);

  const proc = Bun.spawn(['/bin/sh', '-c', cmdStr], {
    cwd,
    env: mergedEnv,
    stdout: 'pipe',
    stderr: 'pipe',
  });

  let timedOut = false;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  let timeoutResolve!: () => void;
  const timeoutSentinel = new Promise<void>((res) => { timeoutResolve = res; });

  killTimer = setTimeout(async () => {
    timedOut = true;
    try {
      proc.kill('SIGTERM');
      await sleep(200);
      proc.kill('SIGKILL');
    } catch { /* process already exited */ }
    progressFile.append('# Timed out\n');
    timeoutResolve();
  }, timeoutMs);

  let stdoutBuf = '';
  let stderrBuf = '';

  const readStdout = async (): Promise<void> => {
    const decoder = new TextDecoder();
    const reader = proc.stdout.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        stdoutBuf += chunk;
        progressFile.append(chunk);
      }
    } catch {
      /* stream ended */
    } finally {
      reader.releaseLock();
    }
  };

  const readStderr = async (): Promise<void> => {
    const decoder = new TextDecoder();
    const reader = proc.stderr.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        stderrBuf += chunk;
      }
    } catch {
      /* stream ended */
    } finally {
      reader.releaseLock();
    }
  };

  const ioPromise = Promise.all([readStdout(), readStderr(), proc.exited]);

  await Promise.race([
    ioPromise,
    timeoutSentinel,
  ]);

  clearTimeout(killTimer);

  if (timedOut) {
    try { await ioPromise; } catch { /* ignore */ }
    return {
      cmd: cmdStr,
      exit_code: null,
      stdout: stdoutBuf,
      stderr: stderrBuf,
      success: false,
      timed_out: true,
      duration_ms: Date.now() - startTime,
      cwd,
      progress_file: progressFile.path,
    };
  }

  const ioResult = await ioPromise.catch(() => [undefined, undefined, undefined] as [void, void, number | undefined]);
  const actualExitCode = (ioResult[2] as number | undefined) ?? await proc.exited;

  const stdoutResult = truncate(stdoutBuf, 'stdout');
  const stderrResult = truncate(stderrBuf, 'stderr');
  const duration = Date.now() - startTime;

  progressFile.append(`# Completed: exit=${actualExitCode} duration=${duration}ms\n`);

  const result: ExecCommandResult = {
    cmd: cmdStr,
    exit_code: actualExitCode,
    stdout: stdoutResult.text,
    stderr: stderrResult.text,
    success: actualExitCode === 0,
    duration_ms: duration,
    cwd,
    env: cmdInput.env,
    progress_file: progressFile.path,
    ...(stdoutResult.truncated && { stdout_truncated: true }),
    ...(stderrResult.truncated && { stderr_truncated: true }),
  };

  // Check expectations
  if (cmdInput.expect) {
    const { exit_code: expCode, stdout_contains, stderr_contains } = cmdInput.expect;
    const failures: string[] = [];

    if (expCode !== undefined && actualExitCode !== expCode) {
      failures.push(`exit_code: expected ${expCode}, got ${actualExitCode}`);
    }
    if (stdout_contains !== undefined && !result.stdout.includes(stdout_contains)) {
      failures.push(`stdout_contains: '${stdout_contains}' not found`);
    }
    if (stderr_contains !== undefined && !result.stderr.includes(stderr_contains)) {
      failures.push(`stderr_contains: '${stderr_contains}' not found`);
    }

    if (failures.length > 0) {
      result.success = false;
      result.expectation_error = failures.join('; ');
    }
  }

  return result;
}

async function runUntil(
  cmdStr: string,
  cmdInput: ExecCommandInput,
  cwd: string | undefined,
  env: Record<string, string>,
  timeoutMs: number,
  startTime: number,
): Promise<ExecCommandResult> {
  const until = cmdInput.until!;
  const pattern = new RegExp(until.pattern);
  const untilTimeout = until.timeout_ms ?? timeoutMs;
  const killAfter = until.kill_after ?? false;

  const proc = Bun.spawn(['/bin/sh', '-c', cmdStr], {
    cwd,
    env,
    stdout: 'pipe',
    stderr: 'pipe',
  });

  let stdoutBuf = '';
  let stderrBuf = '';
  let matched = false;

  // We read chunks from stdout and stderr using the ReadableStream API
  const readStream = async (stream: ReadableStream<Uint8Array>, isStderr: boolean): Promise<void> => {
    const decoder = new TextDecoder();
    const reader = stream.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        if (isStderr) {
          stderrBuf += chunk;
        } else {
          stdoutBuf += chunk;
        }
        if (!matched && pattern.test(stdoutBuf + stderrBuf)) {
          matched = true;
          if (killAfter) {
            try { proc.kill('SIGTERM'); } catch { /* ok */ }
          }
          // Stop reading by releasing lock
          reader.releaseLock();
          return;
        }
      }
    } catch {
      reader.releaseLock();
    }
  };

  const timeoutPromise = sleep(untilTimeout).then(() => { /* resolved = timed out */ });

  await Promise.race([
    Promise.all([readStream(proc.stdout, false), readStream(proc.stderr, true)]),
    timeoutPromise,
  ]);

  if (!killAfter && !matched) {
    // Timed out without match — kill
    try { proc.kill('SIGTERM'); } catch { /* ok */ }
  }

  // Drain remaining output (for exit code)
  const exitCode = await proc.exited;
  const duration = Date.now() - startTime;

  const stdoutResult = truncate(stdoutBuf, 'stdout');
  const stderrResult = truncate(stderrBuf, 'stderr');

  return {
    cmd: cmdStr,
    exit_code: exitCode,
    stdout: stdoutResult.text,
    stderr: stderrResult.text,
    success: matched,
    duration_ms: duration,
    cwd,
    ...(stdoutResult.truncated && { stdout_truncated: true }),
    ...(stderrResult.truncated && { stderr_truncated: true }),
  };
}

async function runWithRetry(
  cmdStr: string,
  cmdInput: ExecCommandInput,
  globalCwd: string | undefined,
  globalTimeout: number,
): Promise<ExecCommandResult> {
  if (!cmdInput.retry) {
    return runCommand(cmdStr, cmdInput, globalCwd, globalTimeout);
  }

  const maxRetries = Math.min(cmdInput.retry.max ?? 3, 10);
  const delayMs = cmdInput.retry.delay_ms ?? 1000;
  const backoff = cmdInput.retry.backoff ?? 'exponential';

  let lastResult: ExecCommandResult | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    lastResult = await runCommand(cmdStr, cmdInput, globalCwd, globalTimeout);

    if (lastResult.success) {
      return { ...lastResult, retries: attempt };
    }

    if (attempt < maxRetries) {
      const delay = computeRetryDelay(attempt, delayMs, backoff);
      await sleep(delay);
    }
  }

  return { ...lastResult!, retries: maxRetries };
}

// ─── Output formatting ───────────────────────────────────────────────────────

function formatResult(result: ExecCommandResult, verbosity: ExecVerbosity): Record<string, unknown> {
  // Skipped commands always get a minimal representation regardless of verbosity
  if (result.skipped) {
    return { cmd: result.cmd, success: false, skipped: true };
  }

  switch (verbosity) {
    case 'count_only':
      return { cmd: result.cmd, exit_code: result.exit_code, success: result.success };

    case 'minimal': {
      const firstStdout = result.stdout.split('\n')[0] ?? '';
      const firstStderr = result.stderr.split('\n')[0] ?? '';
      return {
        cmd: result.cmd,
        exit_code: result.exit_code,
        success: result.success,
        stdout: firstStdout,
        stderr: firstStderr,
        ...(result.expectation_error && { expectation_error: result.expectation_error }),
        ...(result.timed_out && { timed_out: true }),
        ...(result.process_id && { process_id: result.process_id, pid: result.pid }),
        ...(result.progress_file && { progress_file: result.progress_file }),
      };
    }

    case 'verbose':
      return { ...result };

    case 'standard':
    default:
      return {
        cmd: result.cmd,
        exit_code: result.exit_code,
        success: result.success,
        stdout: result.stdout,
        stderr: result.stderr,
        ...(result.expectation_error && { expectation_error: result.expectation_error }),
        ...(result.timed_out && { timed_out: true }),
        ...(result.process_id && { process_id: result.process_id, pid: result.pid }),
        ...(result.stdout_truncated && { stdout_truncated: true }),
        ...(result.stderr_truncated && { stderr_truncated: true }),
        ...(result.retries !== undefined && { retries: result.retries }),
        ...(result.progress_file && { progress_file: result.progress_file }),
      };
  }
}

// ─── Tool implementation ────────────────────────────────────────────────────────

export const execTool: Tool = {
  definition: {
    name: 'exec',
    description:
      'Execute shell commands. Supports batch, parallel, background, retry, timeout,'
      + ' expectation-checking, until-pattern, and pre-command file operations.',
    parameters: EXEC_TOOL_SCHEMA,
  },

  async execute(args: Record<string, unknown>) {
    try {
      // Runtime validation before cast: ensure required fields exist.
      if (!Array.isArray(args['commands']) || (args['commands'] as unknown[]).length === 0) {
        return { success: false, error: 'commands must be a non-empty array' };
      }
      const input = args as unknown as ExecInput;

      const verbosity: ExecVerbosity = (input.verbosity as ExecVerbosity) ?? 'standard';
      const globalTimeout = input.timeout_ms ?? DEFAULT_TIMEOUT_MS;
      const globalCwd = input.working_dir;
      const failFast = input.fail_fast === true || input.stop_on_error === true;

      const projectRoot = resolve(process.cwd());

      // ── File ops first ──
      const fileOpResults: FileOpResult[] = [];
      const pendingImportUpdates: Array<{ src: string; dst: string }> = [];
      if (input.file_ops && input.file_ops.length > 0) {
        for (const op of input.file_ops) {
          try {
            const opResult = executeFileOp(op, projectRoot);
            fileOpResults.push(opResult);
            // Queue async import update after move completes
            if (op.op === 'move' && op.update_imports && opResult.destination) {
              pendingImportUpdates.push({ src: opResult.source, dst: opResult.destination });
            }
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return { success: false, error: `file_ops failed: ${msg}` };
          }
        }
        // Run import updates after all file ops complete (async)
        for (const { src, dst } of pendingImportUpdates) {
          try {
            const updated = await updateImportsAfterMove(src, dst, projectRoot);
            const matchingResult = fileOpResults.find((r) => r.source === src && r.destination === dst);
            if (matchingResult) matchingResult.updated_imports = updated;
          } catch (err) {
            logger.debug('exec file_ops: update_imports failed (non-fatal)', {
              src,
              dst,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
      }

      // ── Resolve commands ──
      const resolvedCmds: Array<{ cmdStr: string; cmdInput: ExecCommandInput }> = [];
      for (const cmdInput of input.commands) {
        let cmdStr: string;
        try {
          cmdStr = decodeCmd(cmdInput);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return { success: false, error: msg };
        }
        resolvedCmds.push({ cmdStr, cmdInput });
      }

      // ── Execute ──
      let results: ExecCommandResult[];

      if (input.parallel) {
        results = await Promise.all(
          resolvedCmds.map(({ cmdStr, cmdInput }) => {
            // Background commands in parallel mode
            if (cmdInput.background) {
              const bgSpecial = handleBgSpecialCommand(cmdStr);
              if (bgSpecial) return Promise.resolve(bgSpecial);
              return Promise.resolve(spawnBackground(cmdStr, resolveCwd(cmdInput.cwd, globalCwd), cmdInput.env));
            }
            return runWithRetry(cmdStr, cmdInput, globalCwd, globalTimeout);
          }),
        );
      } else {
        results = [];
        let stopped = false;
        for (const { cmdStr, cmdInput } of resolvedCmds) {
          // If fail_fast already triggered, append skipped entries
          if (stopped) {
            results.push({
              cmd: cmdStr,
              exit_code: null,
              stdout: '',
              stderr: '',
              success: false,
              skipped: true,
            });
            continue;
          }

          // Handle bg special commands
          const bgSpecial = handleBgSpecialCommand(cmdStr);
          if (bgSpecial) {
            results.push(bgSpecial);
            continue;
          }

          if (cmdInput.background) {
            results.push(spawnBackground(cmdStr, resolveCwd(cmdInput.cwd, globalCwd), cmdInput.env));
            continue;
          }

          const result = await runWithRetry(cmdStr, cmdInput, globalCwd, globalTimeout);
          results.push(result);

          // Check fail_fast after each sequential command
          if (failFast && !result.success) {
            stopped = true;
          }
        }
      }

      // ── Format output ──
      const formatted = results.map((r) => formatResult(r, verbosity));
      const allSuccess = results.every((r) => r.success);

      const responseData: Record<string, unknown> =
        formatted.length === 1 ? { ...formatted[0] } : { commands: formatted, total: formatted.length };
      if (fileOpResults.length > 0) responseData.file_ops = fileOpResults;

      return {
        success: allSuccess,
        output: JSON.stringify(responseData),
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, error: message };
    }
  },
};
