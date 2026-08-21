import { accessSync, constants } from 'node:fs';
import { delimiter, join } from 'node:path';
import { spawn } from 'node:child_process';
import type { Writable } from 'node:stream';
import type { VoiceAudioChunk } from '@pellux/goodvibes-sdk/platform/voice';

export interface StreamingAudioPlayerCommand {
  readonly command: string;
  readonly args: readonly string[];
  readonly label: string;
}

export interface StreamingAudioPlayer {
  readonly label: string;
  readonly available: boolean;
  play(chunks: AsyncIterable<VoiceAudioChunk>, options: StreamingAudioPlaybackOptions): Promise<void>;
  stop(): void;
  /**
   * Resolves once the currently playing sink has finished naturally (its
   * process closed) or after `timeoutMs`, whichever comes first; resolves
   * immediately when nothing is playing. The exit path uses this to let the
   * audio the user is already hearing finish inside a short bounded window
   * instead of killing it mid-drain. stop() remains the instant cut.
   */
  waitForDrain(timeoutMs: number): Promise<void>;
}

export interface StreamingAudioPlaybackOptions {
  readonly format?: string;
  readonly signal?: AbortSignal;
}

interface SpawnProcess {
  readonly stdin: Writable;
  once(event: 'close', listener: () => void): this;
  once(event: 'spawn', listener: () => void): this;
  once(event: 'error', listener: (error: unknown) => void): this;
  kill(signal?: NodeJS.Signals | number): boolean;
}
type SpawnProcessFactory = (command: string, args: readonly string[]) => SpawnProcess;

export interface LocalStreamingAudioPlayerOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly spawnProcess?: SpawnProcessFactory;
  /**
   * Injected player command, the test seam companion to `spawnProcess`.
   * When set, the constructor uses it verbatim instead of scanning PATH, so
   * deterministic fake-sink tests never depend on mpv/ffplay being installed
   * on the machine running them. Pass null to model "no player found".
   */
  readonly command?: StreamingAudioPlayerCommand | null;
}

export class LocalStreamingAudioPlayer implements StreamingAudioPlayer {
  readonly command: StreamingAudioPlayerCommand | null;
  private activeProcess: SpawnProcess | null = null;
  private readonly spawnProcess: SpawnProcessFactory;

  constructor(options: LocalStreamingAudioPlayerOptions = {}) {
    this.command = options.command !== undefined
      ? options.command
      : resolveStreamingAudioPlayerCommand(options.env ?? process.env);
    this.spawnProcess = options.spawnProcess ?? defaultSpawnProcess;
  }

  get label(): string {
    return this.command?.label ?? 'no streaming audio player found';
  }

  get available(): boolean {
    return this.command !== null;
  }

  async play(chunks: AsyncIterable<VoiceAudioChunk>, options: StreamingAudioPlaybackOptions = {}): Promise<void> {
    if (!this.command) {
      throw new Error('No streaming audio player found. Install mpv or ffplay to use /tts live playback.');
    }
    if (options.signal?.aborted) return;

    const proc = this.spawnProcess(this.command.command, buildPlayerArgs(this.command, options.format));
    this.activeProcess = proc;
    const abort = () => {
      try { proc.stdin.destroy(); } catch { /* ignore */ }
      try { proc.kill('SIGTERM'); } catch { /* ignore */ }
    };
    options.signal?.addEventListener('abort', abort, { once: true });

    try {
      // Head survival: hold the first audio byte until the sink has actually
      // started (its 'spawn' event) instead of writing into a process that has
      // not exec'd yet. Writing before the player is up is the spawn race that
      // clipped the beginning of playback. A spawn failure rejects here so the
      // caller can report it honestly rather than swallowing a dead player.
      await awaitReady(proc, options.signal);
      if (options.signal?.aborted) return;

      for await (const chunk of chunks) {
        if (options.signal?.aborted) break;
        if (chunk.data.byteLength === 0) continue;
        await writeStdin(proc, chunk.data);
      }

      // An intentional interrupt (turn cancel / quit chord / /tts stop) has
      // already torn the process down via `abort` and must cut immediately,
      // do not wait on a graceful drain. A natural end-of-speech, by contrast,
      // closes stdin and waits for the sink to play out every buffered sample
      // so the tail of the response is never truncated.
      if (options.signal?.aborted) return;
      try { proc.stdin.end(); } catch { /* ignore */ }
      await waitForExit(proc);
    } finally {
      options.signal?.removeEventListener('abort', abort);
      if (this.activeProcess === proc) this.activeProcess = null;
    }
  }

  stop(): void {
    const proc = this.activeProcess;
    this.activeProcess = null;
    if (!proc) return;
    try { proc.stdin.destroy(); } catch { /* ignore */ }
    try { proc.kill('SIGTERM'); } catch { /* ignore */ }
  }

  waitForDrain(timeoutMs: number): Promise<void> {
    const proc = this.activeProcess;
    if (!proc) return Promise.resolve();
    return new Promise((resolve) => {
      let settled = false;
      const settle = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(settle, timeoutMs);
      proc.once('close', settle);
    });
  }
}

export function resolveStreamingAudioPlayerCommand(env: NodeJS.ProcessEnv = process.env): StreamingAudioPlayerCommand | null {
  const mpv = findExecutable('mpv', env);
  if (mpv) {
    // No --cache=no: mpv's read-ahead cache buffers the incoming pipe so the
    // opening audio survives device-open latency and network jitter instead of
    // underrunning while the output device is still spinning up.
    return {
      command: mpv,
      args: ['--no-terminal', '--really-quiet', '--force-window=no', '-'],
      label: 'mpv',
    };
  }
  const ffplay = findExecutable('ffplay', env);
  if (ffplay) {
    return {
      command: ffplay,
      args: FFPLAY_BASE_ARGS,
      label: 'ffplay',
    };
  }
  return null;
}

// ffplay -autoexit quits as soon as its input ends, before the audio output
// buffer has drained, that clips the tail of the response. `apad` appends a
// short run of silence so the real audio is fully played out and only the
// trailing silence gets trimmed.
const FFPLAY_APAD = ['-af', 'apad=pad_dur=0.3'] as const;
const FFPLAY_BASE_ARGS = ['-nodisp', '-autoexit', '-loglevel', 'error', ...FFPLAY_APAD, '-i', 'pipe:0'] as const;

function buildPlayerArgs(command: StreamingAudioPlayerCommand, format?: string): readonly string[] {
  if (command.label !== 'ffplay' || !format) return command.args;
  const normalized = format.trim().toLowerCase();
  if (!normalized || normalized.includes('/')) return command.args;
  return ['-nodisp', '-autoexit', '-loglevel', 'error', ...FFPLAY_APAD, '-f', normalized, '-i', 'pipe:0'];
}

/**
 * awaitReady, resolves once the spawned player has actually started (its
 * 'spawn' event), rejects if it fails to start ('error'), and resolves early
 * if the caller aborts during startup so an intentional interrupt is never
 * blocked. This is the readiness gate that keeps the first audio byte from
 * being written into a not-yet-running sink.
 */
function awaitReady(proc: SpawnProcess, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const settle = (action: () => void) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      action();
    };
    const onSpawn = () => settle(resolve);
    const onError = (error: unknown) => settle(() => reject(error instanceof Error ? error : new Error(String(error))));
    const onAbort = () => settle(resolve);
    proc.once('spawn', onSpawn);
    proc.once('error', onError);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function findExecutable(name: string, env: NodeJS.ProcessEnv): string | null {
  const pathValue = env.PATH ?? '';
  const extensions = process.platform === 'win32'
    ? ['', '.exe', '.cmd', '.bat']
    : [''];
  for (const dir of pathValue.split(delimiter)) {
    if (!dir) continue;
    for (const ext of extensions) {
      const candidate = join(dir, `${name}${ext}`);
      try {
        accessSync(candidate, constants.X_OK);
        return candidate;
      } catch {
        // Keep scanning PATH.
      }
    }
  }
  return null;
}

function defaultSpawnProcess(command: string, args: readonly string[]): SpawnProcess {
  return spawn(command, [...args], { stdio: ['pipe', 'ignore', 'ignore'] });
}

function writeStdin(proc: SpawnProcess, data: Uint8Array): Promise<void> {
  return new Promise((resolve, reject) => {
    proc.stdin.write(Buffer.from(data), (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function waitForExit(proc: SpawnProcess): Promise<void> {
  return new Promise((resolve) => {
    proc.once('close', () => resolve());
  });
}
