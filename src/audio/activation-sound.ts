/**
 * activation-sound.ts, the sound a confirmed wake makes.
 *
 * A wake takes the microphone from "scoring frames nobody hears" to "recording
 * what you say next", and the user needs to know the moment that happened,
 * otherwise the only feedback is a transcript arriving seconds later, and a
 * false accept is indistinguishable from nothing having happened at all. So the
 * sound is played AT the wake, before transcription, per
 * `voice.wake.activationSound`:
 *
 *  - `chime` , a short two-tone WAV synthesised here. No asset file to ship,
 *               install, provision or lose, and nothing to fetch at runtime.
 *  - `custom`, the file named by `voice.wake.activationSoundPath`.
 *  - `none`  , silent.
 *
 * Playback reuses the streaming player the spoken-turn path already owns
 * (player.ts), so a host with mpv or ffplay needs nothing extra and a host with
 * neither degrades to silence with a reported reason rather than an exception in
 * the middle of a capture.
 */

import { readFileSync } from 'node:fs';
import { extname } from 'node:path';
import { encodeWavPcm16 } from '@pellux/goodvibes-sdk/platform/voice';
import type { WakeActivationSound } from '@pellux/goodvibes-sdk/platform/voice';
import type { VoiceAudioChunk } from '@pellux/goodvibes-sdk/platform/voice';
import type { StreamingAudioPlayer } from './player.ts';

/** Sample rate of the synthesised chime. 16 kHz is plenty for two short tones. */
const CHIME_SAMPLE_RATE = 16000;
/** The two tones, in Hz: a rising pair reads as "listening", not as an error. */
const CHIME_TONES_HZ = [880, 1320] as const;
/** Milliseconds per tone. Short enough not to overlap the start of an utterance. */
const CHIME_TONE_MS = 70;
/** Peak amplitude on the int16 magnitude scale, audible without being startling. */
const CHIME_PEAK = 6000;
/**
 * Fade applied to each end of each tone, in samples. Without it the abrupt start
 * and stop of a sine burst is a click, which on small laptop speakers is louder
 * than the tone itself.
 */
const CHIME_FADE_SAMPLES = 96;

/**
 * Synthesise the built-in chime as a complete WAV file.
 *
 * Written as samples rather than shipped as an asset for the same reason the
 * wake front end is computed in code: a binary blob is one more thing that can
 * be missing, and this one is 40 milliseconds of two sine waves.
 */
export function buildActivationChimeWav(): Uint8Array {
  const perTone = Math.round((CHIME_TONE_MS / 1000) * CHIME_SAMPLE_RATE);
  const samples = new Float32Array(perTone * CHIME_TONES_HZ.length);
  let offset = 0;
  for (const frequency of CHIME_TONES_HZ) {
    for (let i = 0; i < perTone; i++) {
      const fadeIn = Math.min(1, i / CHIME_FADE_SAMPLES);
      const fadeOut = Math.min(1, (perTone - 1 - i) / CHIME_FADE_SAMPLES);
      const envelope = Math.min(fadeIn, fadeOut);
      samples[offset + i] = Math.sin((2 * Math.PI * frequency * i) / CHIME_SAMPLE_RATE) * CHIME_PEAK * envelope;
    }
    offset += perTone;
  }
  return encodeWavPcm16(samples, CHIME_SAMPLE_RATE);
}

/** One-chunk stream, matching what the streaming player consumes. */
async function* singleChunk(data: Uint8Array, format: string): AsyncIterable<VoiceAudioChunk> {
  yield { data, sequence: 1, format };
}

export interface ActivationSoundPlayerDeps {
  readonly player: StreamingAudioPlayer;
  /** Where a sound that could not be played is reported, in the user's words. */
  readonly notify: (message: string) => void;
  /** Injected in tests; defaults to reading the custom file off disk. */
  readonly readFile?: (path: string) => Uint8Array;
}

/**
 * Play the resolved activation sound. Never throws and never blocks the caller
 * on the audio finishing: a wake's next step is recording the utterance, and a
 * sound that fails to play must not delay or cancel that.
 *
 * `settings.activationSound` arrives already resolved against surface capability
 *, the SDK downgrades `custom` to `chime` on a surface that cannot read a local
 * file, and this surface can, so `custom` here means a real path.
 */
export function playActivationSound(sound: WakeActivationSound, deps: ActivationSoundPlayerDeps): void {
  if (sound.kind === 'none') return;
  if (!deps.player.available) {
    deps.notify(`[Voice] Wake heard, but no audio player is installed to play the ${sound.kind} activation sound (${deps.player.label}).`);
    return;
  }
  let data: Uint8Array;
  let format: string;
  if (sound.kind === 'custom') {
    const path = sound.path.trim();
    if (path.length === 0) {
      deps.notify('[Voice] voice.wake.activationSound is "custom" but voice.wake.activationSoundPath is empty, so no sound was played.');
      return;
    }
    try {
      data = (deps.readFile ?? ((target: string) => new Uint8Array(readFileSync(target))))(path);
    } catch (error) {
      deps.notify(`[Voice] Could not read the activation sound at ${path}: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    format = extname(path).replace('.', '').toLowerCase() || 'wav';
  } else {
    data = buildActivationChimeWav();
    format = 'wav';
  }
  void deps.player.play(singleChunk(data, format), { format }).catch((error: unknown) => {
    deps.notify(`[Voice] The activation sound could not be played: ${error instanceof Error ? error.message : String(error)}`);
  });
}
