/**
 * SECURITY MODEL — TRUST BOUNDARY
 *
 * Hook commands are user-defined and execute with full process privileges
 * via `sh -c <command>`. Shell injection is by design: users author their
 * own hook commands and are responsible for the content of hooks.json.
 *
 * hooks.json is a TRUST BOUNDARY:
 *   - Only hooks.json files that belong to the current user or that the
 *     user has explicitly opted into should be loaded.
 *   - The HookDispatcher logs a warning if the file is world-writable.
 *   - Never load hooks.json from untrusted sources (e.g., project
 *     directories you did not create or audit).
 */
import type { HookDefinition, HookResult, HookEvent } from '../types.ts';
import { logger } from '../../utils/logger.ts';

/**
 * Run a shell command hook.
 * The event JSON is written to stdin; stdout is parsed as HookResult JSON.
 * If stdout is not valid JSON, returns { ok: true } (fire-and-forget semantics).
 */
export async function run(hook: HookDefinition, event: HookEvent): Promise<HookResult> {
  const command = hook.command;
  if (!command) {
    return { ok: false, error: 'command hook missing "command" field' };
  }

  const timeoutMs = (hook.timeout ?? 30) * 1000;
  const eventJson = JSON.stringify(event);

  try {
    const proc = Bun.spawn(['sh', '-c', command], {
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    });

    // Write event JSON to stdin then close
    const encoder = new TextEncoder();
    proc.stdin.write(encoder.encode(eventJson));
    proc.stdin.end();

    // Kill the process on timeout; always clear the timer on success.
    const timer = setTimeout(() => {
      try { proc.kill(); } catch { /* already exited */ }
    }, timeoutMs);

    let exitCode: number;
    try {
      exitCode = await proc.exited;
      clearTimeout(timer);
    } catch (err) {
      clearTimeout(timer);
      try { proc.kill(); } catch { /* already dead */ }
      throw err;
    }

    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();

    if (exitCode !== 0) {
      logger.error('command hook exited with non-zero code', {
        command,
        exitCode,
        stderr: stderr.slice(0, 500),
      });
      return {
        ok: false,
        error: `command exited with code ${exitCode}${stderr ? ': ' + stderr.slice(0, 200) : ''}`,
      };
    }

    const trimmed = stdout.trim();
    if (!trimmed) {
      return { ok: true };
    }

    try {
      const result = JSON.parse(trimmed) as HookResult;
      // Use the parsed ok value if present, default to true otherwise
      return { ok: result.ok ?? true, ...result };
    } catch {
      // Non-JSON output is acceptable; treat as success
      return { ok: true };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error('command hook error', { command, error: message });
    return { ok: false, error: message };
  }
}
