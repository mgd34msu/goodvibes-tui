import { resolve, isAbsolute } from 'node:path';
import { copyFileSync, renameSync, unlinkSync, rmSync, cpSync } from 'node:fs';
import type { Tool } from '../../types/tools.ts';
import { resolveAndValidatePath } from '../../utils/path-safety.ts';
import { logger } from '../../utils/logger.ts';
import { EXEC_TOOL_SCHEMA } from './schema.ts';
import type {
  ExecInput,
  ExecCommandInput,
  ExecCommandResult,
  ExecFileOp,
  ExecVerbosity,
  BackgroundProcess,
} from './schema.ts';

// ─── Constants ──────────────────────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 120_000;
const OUTPUT_TRUNCATE_LIMIT = 50_000;

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

let _bgCounter = 0;
const _bgProcesses = new Map<string, BackgroundProcess>();
// Parallel map storing the live Bun subprocess for kill support
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const _bgProcs = new Map<string, any>();

function newBgId(): string {
  return `bg_${++_bgCounter}_${Date.now()}`;
}

/** Expose for testing — clear all tracked background processes. */
export function _resetProcessManager(): void {
  _bgProcesses.clear();
  _bgProcs.clear();
  _bgCounter = 0;
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function decodeCmd(cmdInput: ExecCommandInput): string {
  if (cmdInput.cmd_base64) {
    return Buffer.from(cmdInput.cmd_base64, 'base64').toString('utf-8');
  }
  if (cmdInput.cmd) return cmdInput.cmd;
  throw new Error('Each command must have either cmd or cmd_base64');
}

function truncate(s: string): { text: string; truncated: boolean } {
  if (s.length <= OUTPUT_TRUNCATE_LIMIT) return { text: s, truncated: false };
  return {
    text: s.slice(0, OUTPUT_TRUNCATE_LIMIT) + `\n[... truncated at ${OUTPUT_TRUNCATE_LIMIT} chars]`,
    truncated: true,
  };
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

function executeFileOp(op: ExecFileOp): void {
  const src = resolveFileOpPath(op.source, op.op);

  if (op.op === 'delete') {
    if (op.recursive) {
      rmSync(src, { recursive: true, force: true });
    } else {
      unlinkSync(src);
    }
    return;
  }

  if (!op.destination) {
    throw new Error(`file_ops ${op.op} requires destination`);
  }
  const dst = resolveFileOpPath(op.destination, op.op);

  if (op.op === 'copy') {
    if (op.recursive) {
      cpSync(src, dst, { recursive: true });
    } else {
      copyFileSync(src, dst);
    }
    return;
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
  }
}

// ─── Background command management ──────────────────────────────────────────

function spawnBackground(
  cmd: string,
  cwd: string | undefined,
  env: Record<string, string> | undefined,
): ExecCommandResult {
  const id = newBgId();
  const entry: BackgroundProcess = {
    id,
    pid: 0,
    cmd,
    startTime: Date.now(),
    stdout: [],
    stderr: [],
    exitCode: null,
    done: false,
  };
  _bgProcesses.set(id, entry);

  const cleanEnv = Object.fromEntries(
    Object.entries(process.env).filter(([, v]) => v !== undefined),
  ) as Record<string, string>;
  const mergedEnv = { ...cleanEnv, ...env };

  const proc = Bun.spawn(['sh', '-c', cmd], {
    cwd,
    env: mergedEnv,
    stdout: 'pipe',
    stderr: 'pipe',
  });

  entry.pid = proc.pid;
  _bgProcs.set(id, proc);

  // Async collection — fire and forget, stored in entry
  void (async () => {
    const [stdoutText, stderrText] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    entry.stdout.push(stdoutText);
    entry.stderr.push(stderrText);
    entry.exitCode = await proc.exited;
    entry.done = true;
    _bgProcs.delete(id);
  })();

  return {
    cmd,
    exit_code: null,
    stdout: '',
    stderr: '',
    success: true,
    process_id: id,
    pid: proc.pid,
  };
}

function handleBgSpecialCommand(cmd: string): ExecCommandResult | null {
  // bg_status <id>
  const statusMatch = cmd.match(/^bg_status\s+(\S+)$/);
  if (statusMatch) {
    const entry = _bgProcesses.get(statusMatch[1]);
    if (!entry) {
      return { cmd, exit_code: 1, stdout: '', stderr: `Unknown process: ${statusMatch[1]}`, success: false };
    }
    const status = entry.done ? `done (exit ${entry.exitCode})` : 'running';
    return { cmd, exit_code: 0, stdout: JSON.stringify({ id: entry.id, pid: entry.pid, cmd: entry.cmd, status }), stderr: '', success: true };
  }

  // bg_output <id>
  const outputMatch = cmd.match(/^bg_output\s+(\S+)$/);
  if (outputMatch) {
    const entry = _bgProcesses.get(outputMatch[1]);
    if (!entry) {
      return { cmd, exit_code: 1, stdout: '', stderr: `Unknown process: ${outputMatch[1]}`, success: false };
    }
    return {
      cmd,
      exit_code: 0,
      stdout: entry.stdout.join(''),
      stderr: entry.stderr.join(''),
      success: true,
    };
  }

  // bg_stop <id>
  const stopMatch = cmd.match(/^bg_stop\s+(\S+)$/);
  if (stopMatch) {
    const entry = _bgProcesses.get(stopMatch[1]);
    if (!entry) {
      return { cmd, exit_code: 1, stdout: '', stderr: `Unknown process: ${stopMatch[1]}`, success: false };
    }
    const liveProc = _bgProcs.get(stopMatch[1]);
    if (liveProc && !entry.done) {
      try { liveProc.kill('SIGTERM'); } catch { /* already exited */ }
    }
    entry.done = true;
    _bgProcs.delete(stopMatch[1]);
    _bgProcesses.delete(stopMatch[1]);
    return { cmd, exit_code: 0, stdout: `Stopped ${stopMatch[1]}`, stderr: '', success: true };
  }

  // bg_list
  if (cmd.trim() === 'bg_list') {
    const list = Array.from(_bgProcesses.values()).map((e) => ({
      id: e.id,
      pid: e.pid,
      cmd: e.cmd,
      status: e.done ? `done (exit ${e.exitCode})` : 'running',
    }));
    return { cmd, exit_code: 0, stdout: JSON.stringify(list), stderr: '', success: true };
  }

  return null;
}

// ─── Core execution ───────────────────────────────────────────────────────────

async function runCommand(
  cmdStr: string,
  cmdInput: ExecCommandInput,
  globalCwd: string | undefined,
  globalTimeout: number,
): Promise<ExecCommandResult> {
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

  // ─── Normal execution ───
  const proc = Bun.spawn(['sh', '-c', cmdStr], {
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

    const stdoutResult = truncate(stdoutRaw);
    const stderrResult = truncate(stderrRaw);
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

  const proc = Bun.spawn(['sh', '-c', cmdStr], {
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

  const stdoutResult = truncate(stdoutBuf);
  const stderrResult = truncate(stderrBuf);

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
      const input = args as ExecInput;

      if (!Array.isArray(input.commands) || input.commands.length === 0) {
        return { success: false, error: 'commands must be a non-empty array' };
      }

      const verbosity: ExecVerbosity = (input.verbosity as ExecVerbosity) ?? 'standard';
      const globalTimeout = input.timeout_ms ?? DEFAULT_TIMEOUT_MS;
      const globalCwd = input.working_dir;

      // ── File ops first ──
      if (input.file_ops && input.file_ops.length > 0) {
        for (const op of input.file_ops) {
          try {
            executeFileOp(op);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return { success: false, error: `file_ops failed: ${msg}` };
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
        for (const { cmdStr, cmdInput } of resolvedCmds) {
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
        }
      }

      // ── Format output ──
      const formatted = results.map((r) => formatResult(r, verbosity));
      const allSuccess = results.every((r) => r.success);

      return {
        success: allSuccess,
        output: JSON.stringify(
          formatted.length === 1 ? formatted[0] : { commands: formatted, total: formatted.length },
        ),
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, error: message };
    }
  },
};
