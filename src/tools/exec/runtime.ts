import { join, resolve, isAbsolute } from 'node:path';
import type { Tool } from '../../types/tools.ts';
import { logger } from '../../utils/logger.ts';
import { EXEC_TOOL_SCHEMA } from './schema.ts';
import { DEFAULT_MAX_CHARS, OverflowHandler } from '../shared/overflow.ts';
import type { ExecInput, ExecCommandInput, ExecCommandResult, ExecVerbosity } from './schema.ts';
import { ProcessManager } from '../shared/process-manager.ts';
import { guardExecCommand, formatDenialResponse } from './ast-guard.ts';
import { executeFileOperations } from './file-ops.ts';
import type { FeatureFlagManager } from '../../runtime/feature-flags/index.ts';
import { DEFAULT_ALLOWED_CLASSES } from '../../runtime/permissions/normalization/verdict.ts';

const DEFAULT_TIMEOUT_MS = 120_000;
const PROGRESS_AUTO_THRESHOLD_MS = 30_000;
const OVERFLOW_DIR = join(process.cwd(), '.goodvibes', '.overflow');

const DANGEROUS_PATTERNS = [
  /rm\s+-[a-zA-Z]*r[a-zA-Z]*f?\s+[\/~]/,
  /rm\s+-[a-zA-Z]*f[a-zA-Z]*r?\s+[\/~]/,
  /\bmkfs\b/,
  /\bdd\b.*\bof=\/dev/,
  /chmod\s+777\s+\//,
  /chown\s+.*\s+\//,
];

function decodeCmd(cmdInput: ExecCommandInput): string {
  if (cmdInput.cmd_base64) {
    return Buffer.from(cmdInput.cmd_base64, 'base64').toString('utf-8');
  }
  if (cmdInput.cmd) return cmdInput.cmd;
  throw new Error('Each command must have either cmd or cmd_base64');
}

function truncate(
  overflowHandler: OverflowHandler,
  s: string,
  label?: string,
  maxChars: number = DEFAULT_MAX_CHARS,
): { text: string; truncated: boolean } {
  const result = overflowHandler.handle(s, { maxChars, label });
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

function buildCleanEnv(): Record<string, string> {
  return Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== undefined)) as Record<string, string>;
}

function applyExpectations(
  result: ExecCommandResult,
  expect: ExecCommandInput['expect'] | undefined,
  exitCode: number | null,
): ExecCommandResult {
  if (!expect) return result;

  const failures: string[] = [];
  const { exit_code: expCode, stdout_contains, stderr_contains } = expect;

  if (expCode !== undefined && exitCode !== expCode) failures.push(`exit_code: expected ${expCode}, got ${exitCode}`);
  if (stdout_contains !== undefined && !result.stdout.includes(stdout_contains)) failures.push(`stdout_contains: '${stdout_contains}' not found`);
  if (stderr_contains !== undefined && !result.stderr.includes(stderr_contains)) failures.push(`stderr_contains: '${stderr_contains}' not found`);

  if (failures.length > 0) {
    return { ...result, success: false, expectation_error: failures.join('; ') };
  }

  return result;
}

function buildTimedOutResult(cmdStr: string, cwd: string | undefined, durationMs: number, progressFile?: string): ExecCommandResult {
  return { cmd: cmdStr, exit_code: null, stdout: '', stderr: '', success: false, timed_out: true, duration_ms: durationMs, cwd, ...(progressFile ? { progress_file: progressFile } : {}) };
}

function getProgressFilePath(id: string): string {
  return join(OVERFLOW_DIR, `${id}-progress.txt`);
}

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

import { copyFileSync, renameSync, unlinkSync, rmSync, cpSync, writeFileSync, mkdirSync, appendFileSync } from 'node:fs';

function spawnBackground(
  processManager: ProcessManager,
  cmd: string,
  cwd: string | undefined,
  env: Record<string, string> | undefined,
): ExecCommandResult {
  return processManager.spawn(cmd, cwd, env);
}

function handleBgSpecialCommand(processManager: ProcessManager, cmd: string): ExecCommandResult | null {
  return processManager.handleCommand(cmd);
}

async function runCommand(
  processManager: ProcessManager,
  overflowHandler: OverflowHandler,
  featureFlags: Pick<FeatureFlagManager, 'isEnabled'> | null,
  cmdStr: string,
  cmdInput: ExecCommandInput,
  globalCwd: string | undefined,
  globalTimeout: number,
): Promise<ExecCommandResult> {
  const guardResult = await guardExecCommand(cmdStr, DEFAULT_ALLOWED_CLASSES, featureFlags);
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
  const mergedEnv = { ...buildCleanEnv(), ...cmdInput.env };
  const startTime = Date.now();

  if (cmdInput.until) {
    return runUntil(processManager, overflowHandler, cmdStr, cmdInput, cwd, mergedEnv, timeoutMs, startTime);
  }

  const useProgress = cmdInput.progress === true || timeoutMs > PROGRESS_AUTO_THRESHOLD_MS;
  if (useProgress) {
    return runCommandWithProgress(processManager, overflowHandler, cmdStr, cmdInput, cwd, mergedEnv, timeoutMs, startTime);
  }

  const proc = Bun.spawn(['/bin/sh', '-c', cmdStr], { cwd, env: mergedEnv, stdout: 'pipe', stderr: 'pipe' });
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
    } catch {
      // process already exited
    }
    timeoutResolve();
  }, timeoutMs);

  try {
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
    if (timedOut) {
      try { await procPromise; } catch { /* ignore */ }
      return buildTimedOutResult(cmdStr, cwd, Date.now() - startTime);
    }

    const [stdoutRaw, stderrRaw, exitCode] = procResult!;
    const stdoutResult = truncate(overflowHandler, stdoutRaw, 'stdout');
    const stderrResult = truncate(overflowHandler, stderrRaw, 'stderr');
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
    return applyExpectations(result, cmdInput.expect, exitCode);
  } catch (err) {
    clearTimeout(killTimer);
    throw err;
  }
}

async function runCommandWithProgress(
  _processManager: ProcessManager,
  overflowHandler: OverflowHandler,
  cmdStr: string,
  cmdInput: ExecCommandInput,
  cwd: string | undefined,
  mergedEnv: Record<string, string>,
  timeoutMs: number,
  startTime: number,
): Promise<ExecCommandResult> {
  const progressFile = initProgressFile(cmdStr);
  const proc = Bun.spawn(['/bin/sh', '-c', cmdStr], { cwd, env: mergedEnv, stdout: 'pipe', stderr: 'pipe' });
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
    } catch {
      // ok
    }
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
      // stream ended
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
      // stream ended
    } finally {
      reader.releaseLock();
    }
  };

  const ioPromise = Promise.all([readStdout(), readStderr(), proc.exited]);
  await Promise.race([ioPromise, timeoutSentinel]);
  clearTimeout(killTimer);

  if (timedOut) {
    try { await ioPromise; } catch { /* ignore */ }
    return { ...buildTimedOutResult(cmdStr, cwd, Date.now() - startTime, progressFile.path), stdout: stdoutBuf, stderr: stderrBuf };
  }

  const ioResult = await ioPromise.catch(() => [undefined, undefined, undefined] as [void, void, number | undefined]);
  const actualExitCode = (ioResult[2] as number | undefined) ?? await proc.exited;
  const stdoutResult = truncate(overflowHandler, stdoutBuf, 'stdout');
  const stderrResult = truncate(overflowHandler, stderrBuf, 'stderr');
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
  return applyExpectations(result, cmdInput.expect, actualExitCode);
}

async function runUntil(
  _processManager: ProcessManager,
  overflowHandler: OverflowHandler,
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
  const proc = Bun.spawn(['/bin/sh', '-c', cmdStr], { cwd, env, stdout: 'pipe', stderr: 'pipe' });

  let stdoutBuf = '';
  let stderrBuf = '';
  let matched = false;

  const readStream = async (stream: ReadableStream<Uint8Array>, isStderr: boolean): Promise<void> => {
    const decoder = new TextDecoder();
    const reader = stream.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        if (isStderr) stderrBuf += chunk; else stdoutBuf += chunk;
        if (!matched && pattern.test(stdoutBuf + stderrBuf)) {
          matched = true;
          if (killAfter) {
            try { proc.kill('SIGTERM'); } catch { /* ok */ }
          }
          reader.releaseLock();
          return;
        }
      }
    } catch {
      reader.releaseLock();
    }
  };

  const timeoutPromise = sleep(untilTimeout).then(() => undefined);
  await Promise.race([Promise.all([readStream(proc.stdout, false), readStream(proc.stderr, true)]), timeoutPromise]);

  if (!killAfter && !matched) {
    try { proc.kill('SIGTERM'); } catch { /* ok */ }
  }

  const exitCode = await proc.exited;
  const duration = Date.now() - startTime;
  const stdoutResult = truncate(overflowHandler, stdoutBuf, 'stdout');
  const stderrResult = truncate(overflowHandler, stderrBuf, 'stderr');
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
  processManager: ProcessManager,
  overflowHandler: OverflowHandler,
  featureFlags: Pick<FeatureFlagManager, 'isEnabled'> | null,
  cmdStr: string,
  cmdInput: ExecCommandInput,
  globalCwd: string | undefined,
  globalTimeout: number,
): Promise<ExecCommandResult> {
  if (!cmdInput.retry) {
    return runCommand(processManager, overflowHandler, featureFlags, cmdStr, cmdInput, globalCwd, globalTimeout);
  }

  const maxRetries = Math.min(cmdInput.retry.max ?? 3, 10);
  const delayMs = cmdInput.retry.delay_ms ?? 1000;
  const backoff = cmdInput.retry.backoff ?? 'exponential';
  let lastResult: ExecCommandResult | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    lastResult = await runCommand(processManager, overflowHandler, featureFlags, cmdStr, cmdInput, globalCwd, globalTimeout);
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

async function executeResolvedCommand(
  processManager: ProcessManager,
  overflowHandler: OverflowHandler,
  featureFlags: Pick<FeatureFlagManager, 'isEnabled'> | null,
  cmdStr: string,
  cmdInput: ExecCommandInput,
  globalCwd: string | undefined,
  globalTimeout: number,
): Promise<ExecCommandResult> {
  const bgSpecial = handleBgSpecialCommand(processManager, cmdStr);
  if (bgSpecial) return bgSpecial;
  if (cmdInput.background) {
    return spawnBackground(processManager, cmdStr, resolveCwd(cmdInput.cwd, globalCwd), cmdInput.env);
  }
  return runWithRetry(processManager, overflowHandler, featureFlags, cmdStr, cmdInput, globalCwd, globalTimeout);
}

async function executeResolvedCommands(
  processManager: ProcessManager,
  overflowHandler: OverflowHandler,
  featureFlags: Pick<FeatureFlagManager, 'isEnabled'> | null,
  resolvedCmds: Array<{ cmdStr: string; cmdInput: ExecCommandInput }>,
  parallel: boolean,
  globalCwd: string | undefined,
  globalTimeout: number,
  failFast: boolean,
): Promise<ExecCommandResult[]> {
  if (parallel) {
    return Promise.all(
      resolvedCmds.map(({ cmdStr, cmdInput }) =>
        executeResolvedCommand(processManager, overflowHandler, featureFlags, cmdStr, cmdInput, globalCwd, globalTimeout),
      ),
    );
  }

  const results: ExecCommandResult[] = [];
  let stopped = false;
  for (const { cmdStr, cmdInput } of resolvedCmds) {
    if (stopped) {
      results.push({ cmd: cmdStr, exit_code: null, stdout: '', stderr: '', success: false, skipped: true });
      continue;
    }

    const result = await executeResolvedCommand(processManager, overflowHandler, featureFlags, cmdStr, cmdInput, globalCwd, globalTimeout);
    results.push(result);
    if (failFast && !result.success) {
      stopped = true;
    }
  }

  return results;
}

function formatResult(result: ExecCommandResult, verbosity: ExecVerbosity): Record<string, unknown> {
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

export function createExecTool(
  processManager: ProcessManager,
  options: {
    readonly featureFlags?: Pick<FeatureFlagManager, 'isEnabled'> | null;
    readonly overflowHandler?: OverflowHandler;
  } = {},
): Tool {
  const overflowHandler = options.overflowHandler ?? new OverflowHandler();
  const featureFlags = options.featureFlags ?? null;

  return {
    definition: {
      name: 'exec',
      description:
        'Execute shell commands. Supports batch, parallel, background, retry, timeout,'
        + ' expectation-checking, until-pattern, and pre-command file operations.',
      parameters: EXEC_TOOL_SCHEMA,
      sideEffects: ['exec', 'read_fs', 'write_fs'],
      concurrency: 'serial',
      supportsProgress: true,
      supportsStreamingOutput: true,
    },

    async execute(args: Record<string, unknown>) {
      try {
        if (!Array.isArray(args['commands']) || (args['commands'] as unknown[]).length === 0) {
          return { success: false, error: 'commands must be a non-empty array' };
        }
        const input = args as unknown as ExecInput;
        const verbosity: ExecVerbosity = (input.verbosity as ExecVerbosity) ?? 'standard';
        const globalTimeout = input.timeout_ms ?? DEFAULT_TIMEOUT_MS;
        const globalCwd = input.working_dir;
        const failFast = input.fail_fast === true || input.stop_on_error === true;
        const projectRoot = resolve(process.cwd());

        const { fileOpResults, fileOpError } = await executeFileOperations(input.file_ops, projectRoot);
        if (fileOpError) return { success: false, error: fileOpError };

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

        const results = await executeResolvedCommands(
          processManager,
          overflowHandler,
          featureFlags,
          resolvedCmds,
          input.parallel === true,
          globalCwd,
          globalTimeout,
          failFast,
        );
        const formatted = results.map((r) => formatResult(r, verbosity));
        const allSuccess = results.every((r) => r.success);
        const responseData: Record<string, unknown> = formatted.length === 1 ? { ...formatted[0] } : { commands: formatted, total: formatted.length };
        if (fileOpResults.length > 0) responseData.file_ops = fileOpResults;

        return { success: allSuccess, output: JSON.stringify(responseData) };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { success: false, error: message };
      }
    },
  };
}
