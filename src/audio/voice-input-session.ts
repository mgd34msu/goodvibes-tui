/**
 * voice-input-session.ts — push-to-talk voice input for the terminal.
 *
 * PRESS TO START, PRESS AGAIN TO STOP — not press-and-hold. A terminal receives
 * discrete key EVENTS, not held-key state: there is no key-release event to
 * observe, so a genuine hold would have to be faked with a timer that guesses
 * when the user let go. The binding's description says "press to start, press
 * again to stop" for that reason, and the SDK's `captureMaxSeconds` ceiling still
 * applies as the backstop for a second press that never arrives (a lost focus, a
 * closed terminal) so the microphone cannot be left open indefinitely.
 *
 * The transcript is written into the COMPOSER DRAFT and never submitted. Speech
 * recognition is wrong often enough that submitting it unseen would send the
 * wrong prompt, and the composer is where the user already fixes things. The
 * wake path is where auto-submit is a choice (`voice.wake.autoSubmit`), because
 * there the user spoke a whole command on purpose.
 */

import {
  PushToTalkSession,
  utteranceToAudioArtifact,
  AudioCaptureError,
  type AudioCaptureOpener,
  type CapturedUtterance,
  type PushToTalkPhase,
  type WakeRuntimeSettings,
} from '@pellux/goodvibes-sdk/platform/voice';
import type { VoiceCaptureIndicatorState } from '../core/voice-capture-status.ts';
import type { VoiceSttGateway } from '../core/voice-stt-gateway.ts';
import { describeTranscriptionFailure } from '../core/voice-stt-gateway.ts';

export interface VoiceInputRuntimeDeps {
  readonly openCapture: AudioCaptureOpener;
  /**
   * Resolved `voice.wake.*` capture rows, read at each press so a device or
   * recorder change in /settings applies without a restart.
   */
  readonly readSettings: () => Pick<WakeRuntimeSettings, 'capture' | 'captureMaxSeconds' | 'indicator'>;
  /** Resolved per press, so a daemon that comes up mid-session starts working. */
  readonly resolveTranscriber: () => { readonly available: true; readonly gateway: VoiceSttGateway } | { readonly available: false; readonly reason: string };
  /** Writes the recognised text into the composer draft. */
  readonly writeDraft: (text: string) => void;
  readonly notify: (message: string) => void;
  readonly render: () => void;
}

export interface VoiceInputRuntime {
  /** The keybinding action: start capturing, or stop and transcribe. */
  toggle(): void;
  /** Current indicator row, or null when no microphone is open. */
  status(): VoiceCaptureIndicatorState | null;
  /** Release the device without transcribing. Used by the exit path. */
  release(): Promise<void>;
}

/** Indicator kinds for the phases worth showing; `idle`/`error` render nothing. */
const PHASE_INDICATOR: Partial<Record<PushToTalkPhase, VoiceCaptureIndicatorState['kind']>> = {
  requesting: 'requesting',
  recording: 'recording',
  stopping: 'transcribing',
};

/**
 * Wire push-to-talk. One session object is reused across presses (the SDK session
 * is restartable after both a stop and a failure), so a device is opened per
 * press and released on every path out of it — including the failing ones.
 */
export function wireVoiceInputRuntime(deps: VoiceInputRuntimeDeps): VoiceInputRuntime {
  let session: PushToTalkSession | null = null;
  let phase: PushToTalkPhase = 'idle';
  let transcribing = false;

  const status = (): VoiceCaptureIndicatorState | null => {
    const indicator = deps.readSettings().indicator;
    if (transcribing) {
      return { kind: 'transcribing', deviceLabel: session?.deviceLabel ?? null, indicator };
    }
    const kind = PHASE_INDICATOR[phase];
    if (kind === undefined) return null;
    const seconds = Math.floor((session?.durationMs ?? 0) / 1000);
    return {
      kind,
      deviceLabel: session?.deviceLabel ?? null,
      indicator,
      ...(kind === 'recording' ? { detail: `${seconds}s` } : {}),
    };
  };

  const transcribe = async (utterance: CapturedUtterance): Promise<void> => {
    if (utterance.silent) {
      deps.notify('[Voice] Nothing above the silence floor was captured, so nothing was transcribed.');
      deps.render();
      return;
    }
    const resolution = deps.resolveTranscriber();
    if (!resolution.available) {
      deps.notify(`[Voice] Captured ${Math.round(utterance.durationMs)} ms of audio but could not transcribe it: ${resolution.reason}`);
      deps.render();
      return;
    }
    transcribing = true;
    deps.render();
    try {
      const text = (await resolution.gateway.transcribe(utteranceToAudioArtifact(utterance))).trim();
      if (text.length === 0) {
        deps.notify('[Voice] Speech-to-text returned no words for that recording.');
      } else {
        deps.writeDraft(text);
      }
    } catch (error) {
      deps.notify(`[Voice] Transcription failed: ${describeTranscriptionFailure(error)}`);
    } finally {
      // The device is already released by the session's stop(); this only clears
      // the indicator so a failed transcription cannot leave a "recording" row up.
      transcribing = false;
      deps.render();
    }
  };

  const start = (): void => {
    const settings = deps.readSettings();
    const active = new PushToTalkSession({
      openCapture: deps.openCapture,
      capture: settings.capture,
      captureMaxSeconds: settings.captureMaxSeconds,
      // 0 disables silence-stop: someone who pressed the key and paused has not
      // finished talking, so the second press is what ends the recording.
      silenceStopMs: 0,
      onPhaseChange: (next) => { phase = next; deps.render(); },
      onAutoStop: (utterance) => {
        // The ceiling fired instead of a second keypress. The audio is still what
        // the user said, so it is transcribed rather than discarded.
        session = null;
        deps.notify(`[Voice] Recording reached the ${settings.captureMaxSeconds}s ceiling (voice.wake.captureMaxSeconds) and stopped on its own.`);
        void transcribe(utterance);
      },
      onError: (error) => { deps.notify(`[Voice] Capture stopped: ${error.message}`); deps.render(); },
    });
    session = active;
    void active.start().catch((error: unknown) => {
      session = null;
      phase = 'idle';
      const message = error instanceof AudioCaptureError
        ? `${error.message} (${error.reason})`
        : error instanceof Error ? error.message : String(error);
      deps.notify(`[Voice] Could not start recording: ${message}`);
      deps.render();
    });
  };

  const stop = (): void => {
    const active = session;
    if (active === null) return;
    session = null;
    void active.stop().then(
      (utterance) => { if (utterance !== null) void transcribe(utterance); else deps.render(); },
      (error: unknown) => {
        deps.notify(`[Voice] Recording could not be stopped cleanly: ${error instanceof Error ? error.message : String(error)}`);
        deps.render();
      },
    );
  };

  return {
    toggle: () => {
      if (transcribing) {
        deps.notify('[Voice] Still transcribing the previous recording.');
        return;
      }
      if (session === null) start();
      else stop();
    },
    status,
    release: async () => {
      const active = session;
      session = null;
      phase = 'idle';
      if (active !== null) await active.cancel();
    },
  };
}
