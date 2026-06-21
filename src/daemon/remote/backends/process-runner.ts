// Shared subprocess runner built on Bun.spawn. Captures stdout/stderr/exit code
// with a hard timeout. Used by every backend that shells out (docker/ssh/cloud/
// local-process). No credentials are ever passed as argv — callers pass key
// material via files or the `env` overlay.

export interface RunOptions {
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
  stdin?: string;
  timeoutMs: number;
}

export interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

interface BunSubprocessLike {
  readonly stdout: ReadableStream<Uint8Array> | null;
  readonly stderr: ReadableStream<Uint8Array> | null;
  readonly stdin: { write(chunk: string): void; end(): void | Promise<void> } | null;
  readonly exited: Promise<number>;
  kill(signal?: number | string): void;
}

interface BunSpawnOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  stdin?: 'pipe' | 'ignore';
  stdout: 'pipe';
  stderr: 'pipe';
}

type BunSpawn = (cmd: string[], options: BunSpawnOptions) => BunSubprocessLike;

function getBunSpawn(): BunSpawn {
  const globalBun = (globalThis as { Bun?: { spawn?: unknown } }).Bun;
  if (!globalBun || typeof globalBun.spawn !== 'function') {
    throw new Error('Bun.spawn is unavailable in this runtime.');
  }
  return globalBun.spawn as unknown as BunSpawn;
}

async function readStream(stream: ReadableStream<Uint8Array> | null): Promise<string> {
  if (!stream) return '';
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let out = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) out += decoder.decode(value, { stream: true });
    }
    out += decoder.decode();
  } finally {
    reader.releaseLock();
  }
  return out;
}

/**
 * Spawn a subprocess and capture its output with a hard timeout. The first
 * element of `args` is the executable. Throws only on spawn failure; non-zero
 * exit codes are returned in the result.
 */
export async function runProcess(options: RunOptions): Promise<RunResult> {
  if (options.args.length === 0) {
    throw new Error('runProcess requires at least one argument (the executable).');
  }
  const spawn = getBunSpawn();
  const mergedEnv: Record<string, string | undefined> = {
    ...process.env,
    ...(options.env ?? {}),
  };

  const child = spawn(options.args, {
    ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
    env: mergedEnv,
    stdin: options.stdin !== undefined ? 'pipe' : 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });

  if (options.stdin !== undefined && child.stdin) {
    child.stdin.write(options.stdin);
    await child.stdin.end();
  }

  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill('SIGKILL');
      } catch {
        // process may have already exited
      }
      resolve();
    }, options.timeoutMs);
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    readStream(child.stdout),
    readStream(child.stderr),
    Promise.race([child.exited, timeoutPromise.then(() => child.exited)]),
  ]);

  if (timer) clearTimeout(timer);

  return {
    exitCode: typeof exitCode === 'number' ? exitCode : -1,
    stdout,
    stderr,
    timedOut,
  };
}
