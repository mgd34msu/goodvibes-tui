/**
 * capture.ts — the ONE place this terminal opens a microphone.
 *
 * Two consumers sit on it and they share this single device path: push-to-talk
 * voice input (src/audio/voice-input-session.ts) and wake-word detection
 * (src/audio/wake-runtime.ts). A wake does not END a capture session, it starts
 * one — the SDK listener keeps the same stream open and switches it to recording
 * the utterance that follows — so a second opener would drop the beginning of a
 * sentence and race the operating system for a device that is already held.
 *
 * The framing arithmetic, the recorder argv and the utterance policy all live in
 * the SDK (`@pellux/goodvibes-sdk/platform/voice/capture`), because getting any
 * of them subtly wrong is SILENT: a container header out of byte alignment, or a
 * short frame, still "works" and simply never detects. What is local is the one
 * thing that cannot be shared — actually starting a process. That mirrors
 * playback exactly (see player.ts): resolve a command off PATH, spawn it, and
 * treat "no tool installed" as a reported state rather than an exception.
 */

import { accessSync, constants } from 'node:fs';
import { delimiter, join } from 'node:path';
import { spawn } from 'node:child_process';
import {
  createRecorderCaptureOpener,
  type AudioCaptureOpener,
  type AudioCaptureWarn,
  type CaptureChildProcess,
  type CaptureSpawn,
} from '@pellux/goodvibes-sdk/platform/voice/capture';

/**
 * Whether a command is runnable from PATH. Same scan `player.ts` uses for
 * mpv/ffplay (`resolveStreamingAudioPlayerCommand` -> `findExecutable`): every
 * PATH entry, X_OK access, Windows extensions included — kept identical so a
 * host where playback finds its tool and capture does not is a real difference
 * in what is installed, never a difference in how the two looked.
 */
export function isExecutableOnPath(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: string = process.platform,
): boolean {
  const pathValue = env.PATH ?? '';
  const extensions = platform === 'win32' ? ['', '.exe', '.cmd', '.bat'] : [''];
  for (const dir of pathValue.split(delimiter)) {
    if (!dir) continue;
    for (const ext of extensions) {
      try {
        accessSync(join(dir, `${name}${ext}`), constants.X_OK);
        return true;
      } catch {
        // Keep scanning PATH.
      }
    }
  }
  return false;
}

/**
 * Spawn a recorder with its stdout piped and stdin closed.
 *
 * `stdio: ['ignore', 'pipe', 'pipe']` is deliberate on all three: a recorder
 * with an inherited stdin would compete with the TUI for the terminal's raw-mode
 * keystrokes, stdout carries the raw PCM, and stderr is the ONLY place the
 * reason a device did not open is written, so it is kept for the error message
 * rather than discarded.
 */
export const spawnRecorderProcess: CaptureSpawn = (command, args): CaptureChildProcess => {
  const child = spawn(command, [...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  // Adapted rather than returned directly: the SDK's port declares the signal as
  // a plain `string` (it is shared with a browser bundle that has no
  // NodeJS.Signals) and node's narrower union is not assignable to it. The two
  // event listeners are branched explicitly for the same reason — node's `on` is
  // overloaded per event name and takes no union.
  return {
    stdout: child.stdout,
    stderr: child.stderr,
    on(event: 'error' | 'close', listener: (...args: never[]) => void): unknown {
      if (event === 'error') return child.on('error', listener as (error: Error) => void);
      return child.on('close', listener as (code: number | null, signal: NodeJS.Signals | null) => void);
    },
    kill: (signal?: string) => child.kill(signal as NodeJS.Signals | undefined),
  };
};

export interface TuiCaptureOpenerOptions {
  /** Injected in tests so no real recorder is ever started. */
  readonly spawn?: CaptureSpawn;
  /** Injected in tests; defaults to the PATH + X_OK scan above. */
  readonly isInstalled?: (command: string) => boolean;
  readonly platform?: string;
  readonly warn?: AudioCaptureWarn;
}

/**
 * Build the terminal's capture opener. Called once during startup wiring; both
 * voice consumers receive the SAME opener.
 */
export function createTuiCaptureOpener(options: TuiCaptureOpenerOptions = {}): AudioCaptureOpener {
  return createRecorderCaptureOpener({
    spawn: options.spawn ?? spawnRecorderProcess,
    isInstalled: options.isInstalled ?? ((command: string) => isExecutableOnPath(command)),
    platform: options.platform ?? process.platform,
    // FALSE here, and correct: a recorder subprocess captures raw PCM and filters
    // nothing. The suppression stage is applied by the SDK's own wrapper inside
    // WakeListener and PushToTalkSession, which ask this opener for raw frames —
    // so `speex` arriving at the RECORDER directly, unwrapped by either, is still
    // refused rather than passed through unfiltered.
    speexAvailable: false,
    ...(options.warn !== undefined ? { warn: options.warn } : {}),
  });
}
