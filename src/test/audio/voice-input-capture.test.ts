import { describe, expect, test } from 'bun:test';
import type {
  AudioCaptureError,
  CaptureChildProcess,
  UtteranceAudioArtifact,
  WakeRuntimeSettings,
} from '@pellux/goodvibes-sdk/platform/voice';
import { createTuiCaptureOpener, isExecutableOnPath } from '../../audio/capture.ts';
import { wireVoiceInputRuntime } from '../../audio/voice-input-session.ts';

/**
 * Push-to-talk voice input, and the recorder command lines the real tools accept.
 *
 * The argv assertions are here rather than left to the SDK's own tests because
 * this is the surface that spawns them: `--container raw` on pw-record is the
 * difference between raw PCM and a container header that byte-misaligns the whole
 * stream (a detector fed that never fires and never errors), and a backend the
 * user PINNED must resolve to nothing rather than quietly falling back to a
 * different recorder than the one they chose.
 */

const SAMPLES_PER_FRAME = 1280;

type DataListener = (chunk: Uint8Array) => void;
type CloseListener = (code: number | null, signal: string | null) => void;

class FakeRecorder implements CaptureChildProcess {
  readonly killSignals: string[] = [];
  private readonly dataListeners: DataListener[] = [];
  private readonly closeListeners: CloseListener[] = [];
  private closed = false;

  readonly stdout = { on: (_event: 'data', listener: DataListener): unknown => { this.dataListeners.push(listener); return this; } };
  readonly stderr = { on: (_event: 'data', _listener: DataListener): unknown => this };

  on(event: 'error' | 'close', listener: (...args: never[]) => void): unknown {
    if (event === 'close') this.closeListeners.push(listener as unknown as CloseListener);
    return this;
  }

  kill(signal?: string): unknown {
    this.killSignals.push(signal ?? 'SIGTERM');
    void Promise.resolve().then(() => {
      if (this.closed) return;
      this.closed = true;
      for (const listener of [...this.closeListeners]) listener(0, null);
    });
    return true;
  }

  emitBytes(bytes: Uint8Array): void {
    for (const listener of [...this.dataListeners]) listener(bytes);
  }
}

function recordingSpawn(): {
  readonly spawn: (command: string, args: readonly string[]) => CaptureChildProcess;
  readonly calls: Array<{ command: string; args: readonly string[] }>;
  readonly processes: FakeRecorder[];
} {
  const calls: Array<{ command: string; args: readonly string[] }> = [];
  const processes: FakeRecorder[] = [];
  return {
    calls,
    processes,
    spawn: (command, args) => {
      calls.push({ command, args });
      const proc = new FakeRecorder();
      processes.push(proc);
      return proc;
    },
  };
}

function pcmBytes(samples: readonly number[]): Uint8Array {
  const bytes = new Uint8Array(samples.length * 2);
  const view = new DataView(bytes.buffer);
  samples.forEach((value, index) => view.setInt16(index * 2, value, true));
  return bytes;
}

function loudSamples(count: number): number[] {
  return Array.from({ length: count }, (_unused, index) => (index % 2 === 0 ? 9000 : -9000));
}

async function flush(times = 8): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

const CAPTURE_SETTINGS: Pick<WakeRuntimeSettings, 'capture' | 'captureMaxSeconds' | 'indicator'> = {
  capture: { device: '', backend: 'auto', noiseSuppression: 'none', frameSamples: SAMPLES_PER_FRAME },
  captureMaxSeconds: 10,
  indicator: 'statusline',
};

interface VoiceInputHarness {
  readonly runtime: ReturnType<typeof wireVoiceInputRuntime>;
  readonly spawns: ReturnType<typeof recordingSpawn>;
  readonly drafts: string[];
  readonly notices: string[];
  readonly transcribed: UtteranceAudioArtifact[];
}

function makeVoiceInputHarness(options: {
  readonly transcript?: string;
  readonly transcribeError?: string;
  readonly noTranscriber?: string;
  readonly backend?: WakeRuntimeSettings['capture']['backend'];
  readonly installed?: (command: string) => boolean;
} = {}): VoiceInputHarness {
  const spawns = recordingSpawn();
  const drafts: string[] = [];
  const notices: string[] = [];
  const transcribed: UtteranceAudioArtifact[] = [];
  const runtime = wireVoiceInputRuntime({
    openCapture: createTuiCaptureOpener({
      spawn: spawns.spawn,
      isInstalled: options.installed ?? (() => true),
      platform: 'linux',
    }),
    readSettings: () => ({
      ...CAPTURE_SETTINGS,
      capture: { ...CAPTURE_SETTINGS.capture, backend: options.backend ?? 'auto' },
    }),
    resolveTranscriber: () => (options.noTranscriber !== undefined
      ? { available: false as const, reason: options.noTranscriber }
      : {
        available: true as const,
        gateway: {
          transcribe: async (audio: UtteranceAudioArtifact) => {
            transcribed.push(audio);
            if (options.transcribeError !== undefined) throw new Error(options.transcribeError);
            return options.transcript ?? 'deploy the staging build';
          },
        },
      }),
    writeDraft: (text) => { drafts.push(text); },
    notify: (message) => { notices.push(message); },
    render: () => { /* no renderer under test */ },
  });
  return { runtime, spawns, drafts, notices, transcribed };
}

describe('push-to-talk voice input', () => {
  test('press starts a recording, press again transcribes it into the composer', async () => {
    const harness = makeVoiceInputHarness({ transcript: 'summarise the failing job' });

    harness.runtime.toggle();
    await flush();
    expect(harness.spawns.calls.length).toBe(1);
    const recorder = harness.spawns.processes[0]!;
    expect(harness.runtime.status()?.kind).toBe('recording');

    recorder.emitBytes(pcmBytes(loudSamples(SAMPLES_PER_FRAME * 3)));
    await flush();

    // The SECOND press is what stops it: a terminal has no key-release event, so
    // this is two discrete presses by design, not a simulated hold.
    harness.runtime.toggle();
    await flush();

    expect(recorder.killSignals).toContain('SIGTERM');
    expect(harness.transcribed.length).toBe(1);
    expect(harness.transcribed[0]!.mimeType).toBe('audio/wav');
    expect(harness.drafts).toEqual(['summarise the failing job']);
    // Nothing is left claiming the microphone is open.
    expect(harness.runtime.status()).toBeNull();
  });

  test('a failed transcription still releases the device and reports the failure', async () => {
    const harness = makeVoiceInputHarness({ transcribeError: 'whisper model missing' });

    harness.runtime.toggle();
    await flush();
    const recorder = harness.spawns.processes[0]!;
    recorder.emitBytes(pcmBytes(loudSamples(SAMPLES_PER_FRAME * 2)));
    await flush();
    harness.runtime.toggle();
    await flush();

    // The device is released before the transcription is even attempted, so a
    // failure cannot strand an open microphone.
    expect(recorder.killSignals).toContain('SIGTERM');
    expect(harness.drafts).toEqual([]);
    expect(harness.notices.some((line) => line.includes('Transcription failed') && line.includes('whisper model missing'))).toBe(true);
    expect(harness.runtime.status()).toBeNull();
  });

  test('no reachable daemon reports the reason verbatim and keeps the audio out of the composer', async () => {
    const harness = makeVoiceInputHarness({ noTranscriber: 'the daemon is disabled (daemon.enabled=false)' });

    harness.runtime.toggle();
    await flush();
    harness.spawns.processes[0]!.emitBytes(pcmBytes(loudSamples(SAMPLES_PER_FRAME * 2)));
    await flush();
    harness.runtime.toggle();
    await flush();

    expect(harness.drafts).toEqual([]);
    expect(harness.notices.some((line) => line.includes('daemon.enabled=false'))).toBe(true);
  });

  test('release() abandons an in-flight recording without transcribing it', async () => {
    const harness = makeVoiceInputHarness();

    harness.runtime.toggle();
    await flush();
    const recorder = harness.spawns.processes[0]!;
    recorder.emitBytes(pcmBytes(loudSamples(SAMPLES_PER_FRAME * 2)));
    await flush();

    // The exit path: the device goes, the audio does not become a draft.
    await harness.runtime.release();
    await flush();
    expect(recorder.killSignals).toContain('SIGTERM');
    expect(harness.transcribed).toEqual([]);
    expect(harness.drafts).toEqual([]);
  });

  test('a recorder that cannot be found is reported and nothing is spawned', async () => {
    const harness = makeVoiceInputHarness({ installed: () => false });

    harness.runtime.toggle();
    await flush();

    expect(harness.spawns.calls.length).toBe(0);
    expect(harness.notices.some((line) => line.includes('no-recorder') && line.includes('no audio recorder is installed'))).toBe(true);
    expect(harness.runtime.status()).toBeNull();
  });
});

describe('the recorder command line is what the real tools accept', () => {
  test('pw-record is asked for --container raw, or the stream carries a header that misaligns it', async () => {
    const spawns = recordingSpawn();
    const open = createTuiCaptureOpener({ spawn: spawns.spawn, isInstalled: (cmd) => cmd === 'pw-record', platform: 'linux' });

    const stream = await open({ frameSamples: SAMPLES_PER_FRAME, device: '', backend: 'pw-record', noiseSuppression: 'none' }, {
      onFrame: () => { /* not under test */ },
      onStopped: () => { /* not under test */ },
    });

    const call = spawns.calls[0]!;
    expect(call.command).toBe('pw-record');
    const containerIndex = call.args.indexOf('--container');
    expect(containerIndex).toBeGreaterThanOrEqual(0);
    expect(call.args[containerIndex + 1]).toBe('raw');
    // Raw signed 16-bit mono at the rate the models were trained on.
    expect(call.args).toContain('s16');
    expect(call.args).toContain('16000');
    expect(stream.label).toBe('pw-record');
    expect(stream.deviceSelectable).toBe(true);
    await stream.stop();
  });

  test('parecord is asked for --raw, so it writes samples to stdout rather than a file format', async () => {
    const spawns = recordingSpawn();
    const open = createTuiCaptureOpener({ spawn: spawns.spawn, isInstalled: (cmd) => cmd === 'parecord', platform: 'linux' });

    const stream = await open({ frameSamples: SAMPLES_PER_FRAME, device: 'alsa_input.pci-0000_00_1f.3.analog-stereo', backend: 'parecord', noiseSuppression: 'none' }, {
      onFrame: () => { /* not under test */ },
      onStopped: () => { /* not under test */ },
    });

    const call = spawns.calls[0]!;
    expect(call.command).toBe('parecord');
    expect(call.args).toContain('--raw');
    expect(call.args).toContain('--format=s16le');
    expect(call.args).toContain('--rate=16000');
    // A PulseAudio device name goes through as parecord's own --device flag.
    expect(call.args).toContain('--device=alsa_input.pci-0000_00_1f.3.analog-stereo');
    await stream.stop();
  });

  test('a named-but-missing backend resolves to nothing instead of falling back', async () => {
    const spawns = recordingSpawn();
    // arecord IS installed here — a fallback would find it. The point is that a
    // pinned choice must not be silently overridden by one.
    const open = createTuiCaptureOpener({ spawn: spawns.spawn, isInstalled: (cmd) => cmd === 'arecord', platform: 'linux' });

    const failure = await open({ frameSamples: SAMPLES_PER_FRAME, device: '', backend: 'pw-record', noiseSuppression: 'none' }, {
      onFrame: () => { /* not under test */ },
      onStopped: () => { /* not under test */ },
    }).then(() => null, (error: unknown) => error as AudioCaptureError);

    expect(failure?.reason).toBe('no-recorder');
    expect(failure?.message).toContain('pw-record');
    expect(spawns.calls.length).toBe(0);
  });

  test('auto reports which recorder it actually resolved to, never "auto"', async () => {
    const spawns = recordingSpawn();
    const open = createTuiCaptureOpener({ spawn: spawns.spawn, isInstalled: (cmd) => cmd === 'sox', platform: 'linux' });

    const stream = await open({ frameSamples: SAMPLES_PER_FRAME, device: 'ignored-by-sox', backend: 'auto', noiseSuppression: 'none' }, {
      onFrame: () => { /* not under test */ },
      onStopped: () => { /* not under test */ },
    });

    expect(spawns.calls[0]!.command).toBe('sox');
    expect(stream.label).toBe('sox (auto)');
    // sox cannot target a device at all, and says so rather than pretending.
    expect(stream.deviceSelectable).toBe(false);
    await stream.stop();
  });

  test('speex reaching the RECORDER unwrapped is refused, and says which layer filters', async () => {
    // No speexAvailable passed: the default is what a real launch uses, and it must
    // refuse rather than capture unfiltered audio through a stage the user believes
    // is running. The flag means "this surface applies suppression", not "the box
    // has the library" — nothing in the platform applies speex today.
    const spawns = recordingSpawn();
    const open = createTuiCaptureOpener({ spawn: spawns.spawn, isInstalled: () => true, platform: 'linux' });

    const failure = await open({ frameSamples: SAMPLES_PER_FRAME, device: '', backend: 'auto', noiseSuppression: 'speex' }, {
      onFrame: () => { /* not under test */ },
      onStopped: () => { /* not under test */ },
    }).then(() => null, (error: unknown) => error as AudioCaptureError);

    expect(failure?.reason).toBe('noise-suppression-unavailable');
    // The recorder subprocess produces raw PCM; the speexdsp stage runs one layer
    // up, inside the wake listener and the push-to-talk session. A request that
    // reaches the bare opener is therefore refused with the layering named,
    // rather than passed through unfiltered.
    expect(failure?.message).toContain('does not filter it');
    expect(failure?.message).toContain('createNoiseSuppressingOpener');
    // Audio never flowed unfiltered through a stage the user configured.
    expect(spawns.calls.length).toBe(0);
  });

  test('noiseSuppression "none" — the default, and the only value that runs — opens normally', async () => {
    const spawns = recordingSpawn();
    const open = createTuiCaptureOpener({ spawn: spawns.spawn, isInstalled: () => true, platform: 'linux' });

    const stream = await open({ frameSamples: SAMPLES_PER_FRAME, device: '', backend: 'arecord', noiseSuppression: 'none' }, {
      onFrame: () => { /* not under test */ },
      onStopped: () => { /* not under test */ },
    });

    expect(spawns.calls[0]!.command).toBe('arecord');
    expect(stream.label).toBe('arecord');
    await stream.stop();
  });
});

describe('recorder discovery uses the same PATH scan as playback', () => {
  test('an empty PATH finds nothing', () => {
    expect(isExecutableOnPath('pw-record', { PATH: '' })).toBe(false);
  });

  test('a directory with no matching executable finds nothing', () => {
    expect(isExecutableOnPath('definitely-not-a-recorder', { PATH: '/usr/bin' })).toBe(false);
  });
});
