/**
 * ProcessManager — tracks background processes for a single GoodVibes runtime.
 *
 * Extracted from tools/exec/index.ts so that other modules (UI, agent system,
 * live-tail) can query running processes without importing the exec tool.
 */

// ─── BackgroundProcess interface ──────────────────────────────────────────────

export interface BackgroundProcess {
  id: string;
  pid: number;
  cmd: string;
  startTime: number;
  stdout: string[];
  stderr: string[];
  exitCode: number | null;
  done: boolean;
}

// ─── ExecCommandResult subset (for command handler return values) ─────────────

export interface BgCommandResult {
  cmd: string;
  exit_code: number | null;
  stdout: string;
  stderr: string;
  success: boolean;
  process_id?: string;
  pid?: number;
}

// ─── ProcessManager ───────────────────────────────────────────────────────────

export class ProcessManager {
  private _counter = 0;
  private _processes = new Map<string, BackgroundProcess>();
  private _procs = new Map<string, ReturnType<typeof Bun.spawn>>();

  // ─── Private helpers ────────────────────────────────────────────────────────

  private newId(): string {
    return `bg_${++this._counter}_${Date.now()}`;
  }

  // ─── Public API ─────────────────────────────────────────────────────────────

  /**
   * Spawn a background process and start collecting its output.
   * Returns a BgCommandResult with the process_id and pid.
   */
  spawn(
    cmd: string,
    cwd: string | undefined,
    env: Record<string, string> | undefined,
  ): BgCommandResult {
    const id = this.newId();
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
    this._processes.set(id, entry);

    const cleanEnv = Object.fromEntries(
      Object.entries(process.env).filter(([, v]) => v !== undefined),
    ) as Record<string, string>;
    const mergedEnv = { ...cleanEnv, ...env };

    const proc = Bun.spawn(['/bin/sh', '-c', cmd], {
      cwd,
      env: mergedEnv,
      stdout: 'pipe',
      stderr: 'pipe',
    });

    entry.pid = proc.pid;
    this._procs.set(id, proc);

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
      this._procs.delete(id);
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

  /** Get the status record for a background process, or undefined if not found. */
  getStatus(id: string): BackgroundProcess | undefined {
    return this._processes.get(id);
  }

  /** Get the accumulated stdout/stderr for a background process. */
  getOutput(id: string): { stdout: string; stderr: string } | undefined {
    const entry = this._processes.get(id);
    if (!entry) return undefined;
    return {
      stdout: entry.stdout.join(''),
      stderr: entry.stderr.join(''),
    };
  }

  /**
   * Stop a background process by ID.
   * Returns true if the process was found and stopped, false if unknown.
   */
  stop(id: string): boolean {
    const entry = this._processes.get(id);
    if (!entry) return false;

    const liveProc = this._procs.get(id);
    if (liveProc && !entry.done) {
      try { liveProc.kill('SIGTERM'); } catch { /* already exited */ }
    }
    entry.done = true;
    this._procs.delete(id);
    this._processes.delete(id);
    return true;
  }

  /** List all tracked background processes with their status summaries. */
  list(): Array<{ id: string; pid: number; cmd: string; status: string }> {
    return Array.from(this._processes.values()).map((e) => ({
      id: e.id,
      pid: e.pid,
      cmd: e.cmd,
      status: e.done ? `done (exit ${e.exitCode})` : 'running',
    }));
  }

  /**
   * Handle bg_status / bg_output / bg_stop / bg_list special commands.
   * Returns a BgCommandResult if the command was handled, null otherwise.
   */
  handleCommand(cmd: string): BgCommandResult | null {
    // bg_status <id>
    const statusMatch = cmd.match(/^bg_status\s+(\S+)$/);
    if (statusMatch) {
      const entry = this._processes.get(statusMatch[1]);
      if (!entry) {
        return { cmd, exit_code: 1, stdout: '', stderr: `Unknown process: ${statusMatch[1]}`, success: false };
      }
      const status = entry.done ? `done (exit ${entry.exitCode})` : 'running';
      return {
        cmd,
        exit_code: 0,
        stdout: JSON.stringify({ id: entry.id, pid: entry.pid, cmd: entry.cmd, status }),
        stderr: '',
        success: true,
      };
    }

    // bg_output <id>
    const outputMatch = cmd.match(/^bg_output\s+(\S+)$/);
    if (outputMatch) {
      const entry = this._processes.get(outputMatch[1]);
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
      const found = this.stop(stopMatch[1]);
      if (!found) {
        return { cmd, exit_code: 1, stdout: '', stderr: `Unknown process: ${stopMatch[1]}`, success: false };
      }
      return { cmd, exit_code: 0, stdout: `Stopped ${stopMatch[1]}`, stderr: '', success: true };
    }

    // bg_list
    if (cmd.trim() === 'bg_list') {
      return { cmd, exit_code: 0, stdout: JSON.stringify(this.list()), stderr: '', success: true };
    }

    return null;
  }
}
