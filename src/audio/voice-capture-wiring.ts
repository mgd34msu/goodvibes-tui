/**
 * voice-capture-wiring.ts — composes the terminal's two voice consumers over ONE
 * capture path.
 *
 * Push-to-talk and wake detection are not two audio stacks. They share the
 * opener built here (capture.ts), the transcription gateway (core/voice-stt-gateway.ts)
 * and the same `voice.wake.*` capture rows — device, recorder, noise
 * suppression, ceiling — so a device that works for one works for the other and
 * a change in /settings applies to both.
 *
 * This is the composition root the shell calls once. It owns nothing the shell
 * does not hand it: the composer draft, the turn submission, the message router
 * and the render request all arrive as callbacks, which is what keeps this file
 * out of the shell-UI layers the architecture check bars src/audio from importing.
 */

import { logger } from '@pellux/goodvibes-sdk/platform/utils';
import type { ConfigKey, ConfigManager } from '@pellux/goodvibes-sdk/platform/config';
import type { VoiceCaptureIndicatorState } from '../core/voice-capture-status.ts';
import { createTuiCaptureOpener, SURFACE_APPLIES_SPEEX_SUPPRESSION } from './capture.ts';
import { playActivationSound } from './activation-sound.ts';
import { LocalStreamingAudioPlayer } from './player.ts';
import type { StreamingAudioPlayer } from './player.ts';
import { createVoiceSttGateway } from '../core/voice-stt-gateway.ts';
import { wireVoiceInputRuntime } from './voice-input-session.ts';
import { startWakeRuntime, wireWakeRuntime } from './wake-runtime.ts';
import { terminalWakeCapabilities } from '../core/wake-provision-status.ts';
import { resolveWakeRuntimeSettings } from '@pellux/goodvibes-sdk/platform/voice/wake/runtime';

export interface VoiceCaptureWiringDeps {
  readonly configManager: ConfigManager;
  /** `<root>/voice` — the managed root the wake tree hangs off (same root /voice setup uses). */
  readonly managedVoiceRoot: string;
  /** A directory this surface owns for the extracted onnxruntime assets. */
  readonly assetDirectory: string;
  readonly homeDirectory: string | (() => string);
  /** Names retained clips so the SDK's sweeper can reap them when the session ends. */
  readonly sessionId: string;
  /** Writes recognised text into the composer draft. */
  readonly writeDraft: (text: string) => void;
  /** Submits recognised text as a turn (`voice.wake.autoSubmit` on). */
  readonly submitTurn: (text: string) => void;
  readonly notify: (message: string) => void;
  readonly render: () => void;
  /** Injected in tests; defaults to a real streaming player for the activation sound. */
  readonly player?: StreamingAudioPlayer;
}

export interface VoiceCaptureWiring {
  /** The Alt+V action: start recording, or stop and transcribe. */
  readonly toggleVoiceInput: () => void;
  /**
   * The live footer row. A push-to-talk recording OUTRANKS the wake row: the user
   * pressed a key and is waiting on that one, while the detector's row describes a
   * standing condition they already know about.
   */
  readonly status: () => VoiceCaptureIndicatorState | null;
  /** Teardown, for the shell's `unsubs` registry — releases any open device. */
  readonly unsubs: readonly (() => void)[];
}

/** Compose voice input and wake detection. Opens no device by itself. */
export function wireVoiceCapture(deps: VoiceCaptureWiringDeps): VoiceCaptureWiring {
  const readConfig = (key: string): unknown => deps.configManager.get(key as ConfigKey);
  const warn = (message: string, meta?: Readonly<Record<string, unknown>>): void => {
    logger.debug(`voice capture: ${message}`, meta ?? {});
  };
  // Not a probe: this surface does not apply speex suppression, so `speex` is
  // refused with its reason rather than being silently skipped (see capture.ts).
  const speexAvailable = SURFACE_APPLIES_SPEEX_SUPPRESSION;
  // ONE opener, both consumers.
  const openCapture = createTuiCaptureOpener({ speexAvailable, warn });
  const resolveTranscriber = () => {
    const resolution = createVoiceSttGateway({ configManager: deps.configManager, homeDirectory: deps.homeDirectory });
    return resolution.available
      ? { available: true as const, gateway: resolution.gateway }
      : { available: false as const, reason: resolution.reason };
  };
  const readSettings = () => resolveWakeRuntimeSettings(readConfig, 'tui', terminalWakeCapabilities(speexAvailable));
  const subscribeConfig = (key: string, listener: () => void): (() => void) => deps.configManager.subscribe(key as ConfigKey, listener);
  const player = deps.player ?? new LocalStreamingAudioPlayer();

  const voiceInput = wireVoiceInputRuntime({
    openCapture,
    readSettings,
    resolveTranscriber,
    writeDraft: deps.writeDraft,
    notify: deps.notify,
    render: deps.render,
  });

  const wake = wireWakeRuntime({
    readConfig,
    subscribeConfig,
    openCapture,
    managedRoot: deps.managedVoiceRoot,
    assetDirectory: deps.assetDirectory,
    speexAvailable,
    resolveTranscriber,
    playActivationSound: (sound) => playActivationSound(sound, { player, notify: deps.notify }),
    submitTurn: deps.submitTurn,
    writeDraft: deps.writeDraft,
    notify: deps.notify,
    render: deps.render,
    sessionId: deps.sessionId,
    warn,
  });

  return {
    toggleVoiceInput: voiceInput.toggle,
    status: () => voiceInput.status() ?? wake.status(),
    unsubs: [...startWakeRuntime(wake, { subscribeConfig }), () => { void voiceInput.release(); }],
  };
}
