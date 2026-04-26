import { accessSync, constants } from 'node:fs';
import { delimiter, join } from 'node:path';
import { spawn } from 'node:child_process';
import type { Writable } from 'node:stream';
import type { VoiceAudioChunk } from '@pellux/goodvibes-sdk/platform/voice/index';

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
}

export interface StreamingAudioPlaybackOptions {
  readonly format?: string;
  readonly signal?: AbortSignal;
}

interface SpawnProcess {
  readonly stdin: Writable;
  once(event: 'close', listener: () => void): this;
  kill(signal?: NodeJS.Signals | number): boolean;
}
type SpawnProcessFactory = (command: string, args: readonly string[]) => SpawnProcess;

export interface LocalStreamingAudioPlayerOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly spawnProcess?: SpawnProcessFactory;
}

export class LocalStreamingAudioPlayer implements StreamingAudioPlayer {
  readonly command: StreamingAudioPlayerCommand | null;
  private activeProcess: SpawnProcess | null = null;
  private readonly spawnProcess: SpawnProcessFactory;

  constructor(options: LocalStreamingAudioPlayerOptions = {}) {
    this.command = resolveStreamingAudioPlayerCommand(options.env ?? process.env);
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
      for await (const chunk of chunks) {
        if (options.signal?.aborted) break;
        if (chunk.data.byteLength === 0) continue;
        await writeStdin(proc, chunk.data);
      }
      proc.stdin.end();
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
}

export function resolveStreamingAudioPlayerCommand(env: NodeJS.ProcessEnv = process.env): StreamingAudioPlayerCommand | null {
  const mpv = findExecutable('mpv', env);
  if (mpv) {
    return {
      command: mpv,
      args: ['--no-terminal', '--really-quiet', '--force-window=no', '--cache=no', '-'],
      label: 'mpv',
    };
  }
  const ffplay = findExecutable('ffplay', env);
  if (ffplay) {
    return {
      command: ffplay,
      args: ['-nodisp', '-autoexit', '-loglevel', 'error', '-i', 'pipe:0'],
      label: 'ffplay',
    };
  }
  return null;
}

function buildPlayerArgs(command: StreamingAudioPlayerCommand, format?: string): readonly string[] {
  if (command.label !== 'ffplay' || !format) return command.args;
  const normalized = format.trim().toLowerCase();
  if (!normalized || normalized.includes('/')) return command.args;
  return ['-nodisp', '-autoexit', '-loglevel', 'error', '-f', normalized, '-i', 'pipe:0'];
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
