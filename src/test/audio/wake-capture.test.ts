import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  AudioCaptureHandlers,
  CaptureChildProcess,
  UtteranceAudioArtifact,
  WakeInferenceSession,
  WakeTensor,
} from '@pellux/goodvibes-sdk/platform/voice';
import {
  provisionWakeWordModelsAtInstall,
  resolveManagedWakePaths,
  retainedClipFileName,
  wakeProvisionStatus,
} from '@pellux/goodvibes-sdk/platform/voice';
import { createTuiCaptureOpener } from '../../audio/capture.ts';
import { extractOnnxRuntimeAssets } from '../../audio/wake-inference.ts';
import { wireWakeRuntime, type WakeRuntimeDeps } from '../../audio/wake-runtime.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

/**
 * Behavioural coverage for the terminal's microphone path, driven entirely
 * through injected fakes — a fake recorder subprocess and stub inference
 * sessions. No real microphone, no real recorder, no model file, no network.
 *
 * What these assert is the chain that was missing outright before capture was
 * wired: recorder bytes -> whole frames -> the real SDK engine and front end ->
 * a confirmed wake -> the activation sound -> the utterance that followed ->
 * `voice.stt` -> the composer or a submitted turn. Plus the two rules that must
 * hold no matter what: a disabled configuration opens NO device, and a recorder
 * that keeps dying is restarted a bounded number of times and then latches with
 * a reason the user is shown.
 */

const SAMPLES_PER_FRAME = 1280;
const EMBED_DIM = 96;
const cleanupPaths: string[] = [];

afterEach(() => {
  for (const path of cleanupPaths.splice(0)) rmSync(path, { recursive: true, force: true });
});

type DataListener = (chunk: Uint8Array) => void;
type CloseListener = (code: number | null, signal: string | null) => void;

/**
 * A recorder subprocess under test control. Mirrors what the SDK's capture
 * opener actually consumes: stdout data, stderr data, 'error', 'close', kill.
 */
class FakeRecorder implements CaptureChildProcess {
  readonly killSignals: string[] = [];
  private readonly dataListeners: DataListener[] = [];
  private readonly stderrListeners: DataListener[] = [];
  private readonly errorListeners: Array<(error: Error) => void> = [];
  private readonly closeListeners: CloseListener[] = [];
  private closed = false;

  readonly stdout = { on: (_event: 'data', listener: DataListener): unknown => { this.dataListeners.push(listener); return this; } };
  readonly stderr = { on: (_event: 'data', listener: DataListener): unknown => { this.stderrListeners.push(listener); return this; } };

  on(event: 'error' | 'close', listener: (...args: never[]) => void): unknown {
    if (event === 'error') this.errorListeners.push(listener as unknown as (error: Error) => void);
    else this.closeListeners.push(listener as unknown as CloseListener);
    return this;
  }

  kill(signal?: string): unknown {
    this.killSignals.push(signal ?? 'SIGTERM');
    // A real recorder exits on SIGTERM; emitting on a microtask (not synchronously)
    // matches that ordering, and lets the SDK's bounded stop() settle immediately
    // instead of waiting out its escalation timer.
    void Promise.resolve().then(() => this.emitClose(0));
    return true;
  }

  /** Test control: the recorder wrote raw PCM to stdout. */
  emitBytes(bytes: Uint8Array): void {
    for (const listener of [...this.dataListeners]) listener(bytes);
  }

  /** Test control: the recorder wrote a diagnostic to stderr. */
  emitStderr(text: string): void {
    const bytes = new TextEncoder().encode(text);
    for (const listener of [...this.stderrListeners]) listener(bytes);
  }

  /** Test control: the recorder exited. */
  emitClose(code: number | null): void {
    if (this.closed) return;
    this.closed = true;
    for (const listener of [...this.closeListeners]) listener(code, null);
  }

  /** Test control: the recorder could not be started at all. */
  emitError(error: Error): void {
    for (const listener of [...this.errorListeners]) listener(error);
  }
}

/** A spawn factory that records every call and hands back fakes. */
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

/** Encode int16 magnitudes as the little-endian PCM a recorder writes. */
function pcmBytes(samples: readonly number[]): Uint8Array {
  const bytes = new Uint8Array(samples.length * 2);
  const view = new DataView(bytes.buffer);
  samples.forEach((value, index) => view.setInt16(index * 2, value, true));
  return bytes;
}

/** A run of loud audio — well above the SDK's silence floor of 180 RMS. */
function loudSamples(count: number, seed = 1): number[] {
  return Array.from({ length: count }, (_unused, index) => (index % 2 === 0 ? 9000 + seed : -9000 - seed));
}

/** A run of silence. */
function silentSamples(count: number): number[] {
  return Array.from({ length: count }, () => 0);
}

/** Let the listener's promise chain (framing -> inference -> handlers) settle. */
async function flush(times = 12): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

/** A stub embedding backbone: shape-correct output, no runtime involved. */
function stubEmbeddingSession(): WakeInferenceSession {
  return {
    inputNames: ['input_1'],
    outputNames: ['embedding'],
    run: async (): Promise<Readonly<Record<string, WakeTensor>>> => ({
      embedding: { data: new Float32Array(EMBED_DIM).fill(0.5), dims: [1, EMBED_DIM] },
    }),
  };
}

/**
 * A stub classifier that returns a scripted score per call, holding the last one
 * once the script runs out — so a test says exactly when a wake should confirm.
 */
function scriptedClassifierSession(scores: readonly number[]): { session: WakeInferenceSession; calls: () => number } {
  let index = 0;
  const session: WakeInferenceSession = {
    inputNames: ['onnx::Flatten_0'],
    outputNames: ['output'],
    run: async (): Promise<Readonly<Record<string, WakeTensor>>> => {
      const score = scores[Math.min(index, scores.length - 1)] ?? 0;
      index += 1;
      return { output: { data: new Float32Array([score]), dims: [1, 1] } };
    },
  };
  return { session, calls: () => index };
}

/** A config source backed by a plain map, with the subscription the runtime uses. */
function configSource(overrides: Readonly<Record<string, unknown>>): {
  readonly read: (key: string) => unknown;
  readonly subscribe: (key: string, listener: () => void) => () => void;
  readonly set: (key: string, value: unknown) => void;
} {
  const values = new Map<string, unknown>(Object.entries(overrides));
  const listeners = new Map<string, Array<() => void>>();
  return {
    read: (key) => values.get(key),
    subscribe: (key, listener) => {
      const list = listeners.get(key) ?? [];
      list.push(listener);
      listeners.set(key, list);
      return () => { listeners.set(key, (listeners.get(key) ?? []).filter((entry) => entry !== listener)); };
    },
    set: (key, value) => {
      values.set(key, value);
      for (const listener of [...(listeners.get(key) ?? [])]) listener();
    },
  };
}

interface WakeHarness {
  readonly runtime: ReturnType<typeof wireWakeRuntime>;
  readonly spawns: ReturnType<typeof recordingSpawn>;
  readonly config: ReturnType<typeof configSource>;
  readonly notices: string[];
  readonly drafts: string[];
  readonly submitted: string[];
  readonly sounds: string[];
  readonly transcribed: UtteranceAudioArtifact[];
  readonly timers: Array<{ handler: () => void; ms: number }>;
  readonly classifierCalls: () => number;
  /** Every model file the engine factory was asked to load, in order. */
  readonly loadedModelPaths: string[];
  now: number;
}

interface WakeHarnessOptions {
  readonly config?: Readonly<Record<string, unknown>>;
  readonly scores?: readonly number[];
  readonly transcript?: string;
  /** Rejects the transcription with this message instead of resolving. */
  readonly transcribeError?: string;
  /** Reports the models as absent, the way a fresh host does. */
  readonly notProvisioned?: boolean;
  /**
   * Drop the provision-status seam entirely, so the runtime uses the SDK's REAL
   * content-verifying read against `managedRoot`. Used by the install tests
   * below, where stubbing the very check under test would prove nothing.
   */
  readonly realProvisionStatus?: boolean;
  /** No daemon reachable — the honest refusal path. */
  readonly noTranscriber?: string;
  readonly managedRoot?: string;
}

const ACTIVE_CONFIG: Readonly<Record<string, unknown>> = {
  'voice.wake.enabled': true,
  'voice.wake.surfaces.tui': true,
  'voice.wake.models': 'hey_goodvibes',
  'voice.wake.threshold': 0.9,
  'voice.wake.patienceFrames': 2,
  'voice.wake.cooldownMs': 2000,
  'voice.wake.silenceStopMs': 400,
  'voice.wake.captureMaxSeconds': 4,
  'voice.wake.preRollMs': 200,
  'voice.wake.autoSubmit': false,
  'voice.wake.activationSound': 'chime',
  'voice.wake.indicator': 'statusline',
  'voice.wake.maxRestarts': 1,
  'voice.wake.restartBackoffMs': 100,
  'voice.wake.crashWindowSeconds': 60,
};

function makeWakeHarness(options: WakeHarnessOptions = {}): WakeHarness {
  const spawns = recordingSpawn();
  const config = configSource({ ...ACTIVE_CONFIG, ...options.config });
  const notices: string[] = [];
  const drafts: string[] = [];
  const submitted: string[] = [];
  const sounds: string[] = [];
  const transcribed: UtteranceAudioArtifact[] = [];
  const timers: Array<{ handler: () => void; ms: number }> = [];
  const loadedModelPaths: string[] = [];
  const classifier = scriptedClassifierSession(options.scores ?? [0]);
  const embedding = stubEmbeddingSession();
  const harness: Partial<WakeHarness> & { now: number } = { now: 1_000_000 };

  const deps: WakeRuntimeDeps = {
    readConfig: config.read,
    subscribeConfig: config.subscribe,
    // The REAL capture opener, over an injected spawn: the framing, the argv and
    // the exit handling under test are the shipped ones.
    openCapture: createTuiCaptureOpener({ spawn: spawns.spawn, isInstalled: () => true, platform: 'linux', speexAvailable: false }),
    managedRoot: options.managedRoot ?? '/nonexistent-managed-root',
    assetDirectory: '/nonexistent-asset-dir',
    speexAvailable: false,
    resolveTranscriber: () => (options.noTranscriber !== undefined
      ? { available: false as const, reason: options.noTranscriber }
      : {
        available: true as const,
        gateway: {
          transcribe: async (audio: UtteranceAudioArtifact) => {
            transcribed.push(audio);
            if (options.transcribeError !== undefined) throw new Error(options.transcribeError);
            return options.transcript ?? 'open the deploy log';
          },
        },
      }),
    playActivationSound: (sound) => { sounds.push(sound.kind); },
    submitTurn: (text) => { submitted.push(text); },
    writeDraft: (text) => { drafts.push(text); },
    notify: (message) => { notices.push(message); },
    render: () => { /* no renderer under test */ },
    sessionId: 'session-under-test',
    warn: () => { /* warnings are not the subject here */ },
    loadSession: async (modelPath: string) => {
      loadedModelPaths.push(modelPath);
      return modelPath.includes('speech-embedding') ? embedding : classifier.session;
    },
    ...(options.realProvisionStatus === true ? {} : {
      provisionStatus: () => (options.notProvisioned === true
        ? { ready: false, reason: 'not-provisioned' }
        : { ready: true, reason: null }),
    }),
    now: () => harness.now,
    setTimeout: (handler, ms) => { timers.push({ handler, ms }); return timers.length; },
    clearTimeout: () => { /* fired manually */ },
  };

  return Object.assign(harness, {
    runtime: wireWakeRuntime(deps),
    spawns,
    config,
    notices,
    drafts,
    submitted,
    sounds,
    transcribed,
    timers,
    classifierCalls: classifier.calls,
    loadedModelPaths,
  }) as WakeHarness;
}

/**
 * Feed enough frames to fill the SDK front end's 16-frame window, so the next
 * frames are the ones that actually get scored.
 */
async function primeFrontEnd(recorder: FakeRecorder): Promise<void> {
  for (let i = 0; i < 20; i++) {
    recorder.emitBytes(pcmBytes(loudSamples(SAMPLES_PER_FRAME, i)));
    await flush(2);
  }
}

describe('recorder bytes become whole frames', () => {
  test('chunks that do not align to a frame still deliver whole frames with the remainder carried', async () => {
    const spawns = recordingSpawn();
    const open = createTuiCaptureOpener({ spawn: spawns.spawn, isInstalled: () => true, platform: 'linux' });
    const frames: Float32Array[] = [];
    const handlers: AudioCaptureHandlers = { onFrame: (frame) => { frames.push(frame.slice()); }, onStopped: () => { /* not under test */ } };

    const stream = await open({ frameSamples: SAMPLES_PER_FRAME, device: '', backend: 'auto', noiseSuppression: 'none' }, handlers);
    const recorder = spawns.processes[0]!;

    // A deliberately hostile chunking: 700, 700, 500 and 380 samples. None is a
    // multiple of 1280, and the third chunk both completes frame 1 and starts
    // frame 2 — which is exactly where a dropped or padded remainder would show.
    const all = loudSamples(2280);
    recorder.emitBytes(pcmBytes(all.slice(0, 700)));
    expect(frames.length).toBe(0);
    recorder.emitBytes(pcmBytes(all.slice(700, 1400)));
    expect(frames.length).toBe(1);
    recorder.emitBytes(pcmBytes(all.slice(1400, 1900)));
    expect(frames.length).toBe(1);
    recorder.emitBytes(pcmBytes(all.slice(1900, 2280)));

    // Two whole frames, byte for byte, and 2280 - 2560 < 0 so the fourth chunk
    // leaves 2280 - 1280 = 1000 samples pending rather than emitting a short frame.
    expect(frames.length).toBe(1);
    expect([...frames[0]!]).toEqual(all.slice(0, SAMPLES_PER_FRAME));

    // One more chunk completes the second frame; its first samples must be the
    // ones carried over, not the ones this chunk starts with.
    const more = loudSamples(400, 7);
    recorder.emitBytes(pcmBytes(more));
    expect(frames.length).toBe(2);
    expect([...frames[1]!]).toEqual([...all.slice(SAMPLES_PER_FRAME, 2280), ...more.slice(0, SAMPLES_PER_FRAME - 1000)]);

    await stream.stop();
    expect(recorder.killSignals).toContain('SIGTERM');
  });

  test('frames reach the real wake engine through the listener', async () => {
    const harness = makeWakeHarness({ scores: [0.1] });
    await harness.runtime.refresh();
    expect(harness.spawns.calls.length).toBe(1);

    await primeFrontEnd(harness.spawns.processes[0]!);

    // The front end needs 16 frames before it scores anything; past that, every
    // frame reaches the classifier.
    expect(harness.classifierCalls()).toBeGreaterThan(0);
    expect(harness.runtime.status()?.kind).toBe('wake-listening');
    await harness.runtime.stop();
  });
});

describe('a confirmed wake drives the whole downstream chain', () => {
  test('sound, utterance, voice.stt and the composer (autoSubmit off)', async () => {
    // 0.95 twice clears the 0.9 threshold for the 2 patience frames the row asks
    // for, then drops back so the run does not re-fire while the utterance records.
    const harness = makeWakeHarness({ scores: [0.1, 0.95, 0.95, 0.0], transcript: 'show me the deploy log' });
    await harness.runtime.refresh();
    const recorder = harness.spawns.processes[0]!;
    await primeFrontEnd(recorder);

    // The wake confirms on the frames scored 0.95.
    expect(harness.sounds).toEqual(['chime']);
    expect(harness.runtime.status()?.kind).toBe('wake-capturing');

    // What follows the wake: speech, then 400ms of silence, which is the row's
    // silenceStopMs and therefore the end of the utterance.
    recorder.emitBytes(pcmBytes(loudSamples(SAMPLES_PER_FRAME)));
    await flush(2);
    for (let i = 0; i < 5; i++) {
      recorder.emitBytes(pcmBytes(silentSamples(SAMPLES_PER_FRAME)));
      await flush(2);
    }
    await flush();

    expect(harness.transcribed.length).toBe(1);
    const artifact = harness.transcribed[0]!;
    expect(artifact.mimeType).toBe('audio/wav');
    expect(artifact.format).toBe('wav');
    expect(artifact.sampleRateHz).toBe(16000);
    // A real WAV: the RIFF/WAVE header the daemon's whisper reads.
    const decoded = Uint8Array.from(atob(artifact.dataBase64).split(''), (char) => char.charCodeAt(0));
    expect(new TextDecoder().decode(decoded.subarray(0, 4))).toBe('RIFF');
    expect(new TextDecoder().decode(decoded.subarray(8, 12))).toBe('WAVE');
    // The pre-roll is in there: the utterance is longer than the frames pushed
    // after the wake, because the phrase that triggered it was carried over.
    expect(artifact.durationMs).toBeGreaterThan(6 * 80);

    // autoSubmit off: the transcript lands in the composer and no turn is sent.
    expect(harness.drafts).toEqual(['show me the deploy log']);
    expect(harness.submitted).toEqual([]);
    // Scoring resumed for the next phrase.
    expect(harness.runtime.status()?.kind).toBe('wake-listening');
    await harness.runtime.stop();
  });

  test('autoSubmit on sends the turn instead of drafting it', async () => {
    const harness = makeWakeHarness({
      config: { 'voice.wake.autoSubmit': true, 'voice.wake.activationSound': 'none' },
      scores: [0.1, 0.95, 0.95, 0.0],
      transcript: 'run the tests',
    });
    await harness.runtime.refresh();
    const recorder = harness.spawns.processes[0]!;
    await primeFrontEnd(recorder);
    recorder.emitBytes(pcmBytes(loudSamples(SAMPLES_PER_FRAME)));
    await flush(2);
    for (let i = 0; i < 5; i++) {
      recorder.emitBytes(pcmBytes(silentSamples(SAMPLES_PER_FRAME)));
      await flush(2);
    }
    await flush();

    expect(harness.submitted).toEqual(['run the tests']);
    expect(harness.drafts).toEqual([]);
    // activationSound: none means silence, not a default chime.
    expect(harness.sounds).toEqual(['none']);
    await harness.runtime.stop();
  });

  test('retainAudio: session-temp writes the clip where the SDK sweeper can reap it', async () => {
    const managedRoot = makeProjectTempDir('goodvibes-wake');
    cleanupPaths.push(managedRoot);
    const harness = makeWakeHarness({
      managedRoot,
      config: { 'voice.wake.retainAudio': 'session-temp' },
      scores: [0.1, 0.95, 0.95, 0.0],
    });
    await harness.runtime.refresh();
    const recorder = harness.spawns.processes[0]!;
    await primeFrontEnd(recorder);
    recorder.emitBytes(pcmBytes(loudSamples(SAMPLES_PER_FRAME)));
    await flush(2);
    for (let i = 0; i < 5; i++) {
      recorder.emitBytes(pcmBytes(silentSamples(SAMPLES_PER_FRAME)));
      await flush(2);
    }
    await flush();

    const retained = readdirSync(resolveManagedWakePaths(managedRoot).retainedDir);
    expect(retained.length).toBe(1);
    // The name comes from the SDK's own contract, not from a local convention: the
    // sweeper reads the owning session id off the first `--`-delimited segment, so a
    // clip named any other way is reaped as an orphan while this session still wants
    // it. Compared against the helper rather than a hand-written pattern so a change
    // to the convention fails here instead of silently losing clips.
    expect(retained[0]).toBe(retainedClipFileName('session-under-test', harness.now));
    await harness.runtime.stop();
  });

  test('a custom model id resolves into the managed custom directory and is reported as unpinned', async () => {
    const harness = makeWakeHarness({
      managedRoot: '/managed-under-test',
      // voice.wake.customModelDir left EMPTY on purpose: the row promises a fallback
      // to the managed custom directory, and a host that skipped it would look in the
      // process's working directory instead.
      config: { 'voice.wake.models': 'hey_goodvibes,my_phrase', 'voice.wake.customModelDir': '' },
    });
    await harness.runtime.refresh();

    expect(harness.loadedModelPaths).toEqual([
      '/managed-under-test/wake/front-end/speech-embedding-1.0.0.onnx',
      '/managed-under-test/wake/models/goodvibes-wakeword-hey-goodvibes-1.0.0.onnx',
      '/managed-under-test/wake/custom/my_phrase.onnx',
    ]);
    // Bytes with no checksum behind them are worth saying out loud.
    expect(harness.notices.some((line) => line.includes('not checksum-pinned') && line.includes('my_phrase'))).toBe(true);
    await harness.runtime.stop();
  });

  test('a failed transcription is reported, not swallowed', async () => {
    const harness = makeWakeHarness({ scores: [0.1, 0.95, 0.95, 0.0], transcribeError: 'whisper exited 1' });
    await harness.runtime.refresh();
    const recorder = harness.spawns.processes[0]!;
    await primeFrontEnd(recorder);
    recorder.emitBytes(pcmBytes(loudSamples(SAMPLES_PER_FRAME)));
    await flush(2);
    for (let i = 0; i < 5; i++) {
      recorder.emitBytes(pcmBytes(silentSamples(SAMPLES_PER_FRAME)));
      await flush(2);
    }
    await flush();

    expect(harness.drafts).toEqual([]);
    expect(harness.notices.some((line) => line.includes('Transcription failed') && line.includes('whisper exited 1'))).toBe(true);
    await harness.runtime.stop();
  });
});

describe('disabled means no capture at all', () => {
  test('voice.wake.enabled false opens no device and spawns nothing', async () => {
    const harness = makeWakeHarness({ config: { 'voice.wake.enabled': false } });
    await harness.runtime.refresh();

    expect(harness.spawns.calls.length).toBe(0);
    expect(harness.spawns.processes.length).toBe(0);
    expect(harness.runtime.status()).toBeNull();
  });

  test('voice.wake.surfaces.tui false opens no device and spawns nothing', async () => {
    const harness = makeWakeHarness({ config: { 'voice.wake.surfaces.tui': false } });
    await harness.runtime.refresh();

    expect(harness.spawns.calls.length).toBe(0);
    expect(harness.spawns.processes.length).toBe(0);
    expect(harness.runtime.status()).toBeNull();
  });

  test('turning the row off at runtime releases the device; turning it on takes it again', async () => {
    const harness = makeWakeHarness({ config: { 'voice.wake.enabled': false } });
    // The subscription is what makes the row runtime-toggleable.
    const unsubs = [harness.config.subscribe('voice.wake.enabled', () => { void harness.runtime.refresh(); })];

    harness.config.set('voice.wake.enabled', true);
    await flush();
    expect(harness.spawns.calls.length).toBe(1);

    harness.config.set('voice.wake.enabled', false);
    await flush();
    expect(harness.spawns.processes[0]!.killSignals).toContain('SIGTERM');
    expect(harness.runtime.status()).toBeNull();

    harness.config.set('voice.wake.enabled', true);
    await flush();
    expect(harness.spawns.calls.length).toBe(2);

    for (const unsub of unsubs) unsub();
    await harness.runtime.stop();
  });

  test('an enabled detector with unprovisioned models says so and opens no device', async () => {
    const harness = makeWakeHarness({ notProvisioned: true });
    await harness.runtime.refresh();

    expect(harness.spawns.calls.length).toBe(0);
    expect(harness.notices.some((line) => line.includes('not provisioned') && line.includes('/voice wake setup'))).toBe(true);
  });

  test('a blocking row refuses startup and names the row (vadThreshold has no VAD model)', async () => {
    const harness = makeWakeHarness({ config: { 'voice.wake.vadThreshold': 0.5 } });
    await harness.runtime.refresh();

    expect(harness.spawns.calls.length).toBe(0);
    const blocked = harness.notices.join('\n');
    expect(blocked).toContain('voice.wake.vadThreshold');
    expect(blocked).toContain('no voice-activity-detection model is available');
  });
});

/**
 * The inference runtime's two assets. They are embedded in the compiled binary and
 * extracted to a directory this surface owns, because onnxruntime-web loads its
 * WASM glue by dynamic PATH import — which a bun-compiled binary cannot satisfy
 * from its own bundle.
 */
describe('the onnxruntime assets reach disk', () => {
  test('written once, left alone when they already match, replaced when they do not', () => {
    const directory = join(makeProjectTempDir('goodvibes-ort'), 'onnxruntime');
    cleanupPaths.push(directory);

    const prefix = extractOnnxRuntimeAssets(directory);
    // The runtime concatenates a file name onto this, so the trailing slash is
    // load-bearing: without it the glue is looked for as a sibling of the directory.
    expect(prefix.endsWith('/')).toBe(true);

    const glue = join(directory, 'ort-wasm-simd-threaded.mjs');
    const wasm = join(directory, 'ort-wasm-simd-threaded.wasm');
    const firstGlue = statSync(glue).mtimeMs;
    const firstWasm = statSync(wasm).mtimeMs;
    // The real runtime, not a stub: ~13 MB of WebAssembly.
    expect(statSync(wasm).size).toBeGreaterThan(1_000_000);

    // A second call with identical bytes rewrites nothing — otherwise every launch
    // would copy 13 MB.
    extractOnnxRuntimeAssets(directory);
    expect(statSync(glue).mtimeMs).toBe(firstGlue);
    expect(statSync(wasm).mtimeMs).toBe(firstWasm);

    // Bytes that do NOT match this build are replaced, so a stale extraction left
    // by an older version is never loaded.
    writeFileSync(glue, 'stale');
    extractOnnxRuntimeAssets(directory);
    expect(statSync(glue).size).toBeGreaterThan(1000);
  });
});

describe('a recorder that keeps dying is restarted, then latched', () => {
  test('a non-zero exit schedules a restart and a second one latches with a stated reason', async () => {
    const harness = makeWakeHarness();
    await harness.runtime.refresh();
    expect(harness.spawns.calls.length).toBe(1);

    // First crash: the recorder exits non-zero with a diagnostic.
    harness.spawns.processes[0]!.emitStderr('pw-record: failed to connect\n');
    harness.spawns.processes[0]!.emitClose(1);
    await flush();

    expect(harness.runtime.status()?.kind).toBe('wake-restarting');
    expect(harness.timers.length).toBe(1);
    // restartBackoffMs * attempt, linear: 100 * 1.
    expect(harness.timers[0]!.ms).toBe(100);
    expect(harness.notices.some((line) => line.includes('restarting the wake-word detector'))).toBe(true);

    // Fire the injected backoff timer: the detector comes back on a fresh device.
    harness.timers[0]!.handler();
    await flush();
    expect(harness.spawns.calls.length).toBe(2);

    // Second crash, inside crashWindowSeconds, exceeds maxRestarts: 1.
    harness.spawns.processes[1]!.emitClose(1);
    await flush();

    expect(harness.runtime.status()?.kind).toBe('wake-latched');
    // No third attempt was scheduled.
    expect(harness.timers.length).toBe(1);
    const latched = harness.notices.join('\n');
    expect(latched).toContain('The wake-word detector stopped');
    expect(latched).toContain('crashed 2 times within 60s');
    expect(latched).toContain('turned off and on again');
    // The latch reason is on the indicator row too, not only in a message.
    expect(harness.runtime.status()?.detail).toContain('crashed 2 times');
  });

  test('a crash older than the window gets its restart budget back', async () => {
    const harness = makeWakeHarness();
    await harness.runtime.refresh();

    harness.spawns.processes[0]!.emitClose(1);
    await flush();
    harness.timers[0]!.handler();
    await flush();

    // Age the first crash out of the 60s rolling window before the second one.
    harness.now += 61_000;
    harness.spawns.processes[1]!.emitClose(1);
    await flush();

    expect(harness.runtime.status()?.kind).toBe('wake-restarting');
    expect(harness.timers.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// The model ships with the installation, so turning the feature on must need
// NOTHING else. These are the tests for that claim, and for the claim that
// enabling still never downloads.
// ---------------------------------------------------------------------------
describe('enabling wake detection after the installation provisioned the model', () => {
  test('the listener starts on the two enablement rows alone, loading the artifacts the installer wrote', async () => {
    const managedRoot = makeProjectTempDir('wake-install');
    // The paths the install policy writes to. Nothing here re-derives them: they
    // come from the same SDK function the installer, the daemon and the detector
    // all call, which is the whole point — an installer that wrote 6 MB into a
    // directory the detector never reads would report success and detect nothing.
    const paths = resolveManagedWakePaths(managedRoot);

    const harness = makeWakeHarness({ managedRoot });
    await harness.runtime.refresh();

    // Started, with no setup command run and no config beyond the two rows.
    expect(harness.spawns.processes.length).toBe(1);
    expect(harness.runtime.status()?.kind).toBe('wake-listening');
    expect(harness.notices.join('\n')).not.toContain('/voice wake setup');

    // And it loaded EXACTLY the installed artifacts: the pinned classifier from
    // the managed models directory and the shared front end from front-end/.
    expect(harness.loadedModelPaths).toContain(paths.embeddingPath);
    expect(harness.loadedModelPaths).toContain(paths.classifierPath);
    // The tflite twin is provisioned for other runtimes; this one must not load it.
    expect(harness.loadedModelPaths).not.toContain(paths.mobileClassifierPath);
    rmSync(managedRoot, { recursive: true, force: true });
  });

  test('turning the feature on issues NO network request, however the artifacts look', async () => {
    // The rule that survived making provisioning automatic: a switch is not a
    // sanctioned download. Installing and booting are, each with a receipt.
    const managedRoot = makeProjectTempDir('wake-enable-no-fetch');
    const realFetch = globalThis.fetch;
    const attempted: string[] = [];
    globalThis.fetch = ((input: unknown) => {
      attempted.push(String(input));
      throw new Error('the enable path must never fetch');
    }) as unknown as typeof fetch;
    try {
      // Both postures: artifacts absent, and artifacts present-but-torn.
      const absent = makeWakeHarness({ managedRoot, realProvisionStatus: true });
      await absent.runtime.refresh();
      const paths = resolveManagedWakePaths(managedRoot);
      mkdirSync(paths.modelsDir, { recursive: true });
      writeFileSync(paths.classifierPath, Buffer.alloc(64));
      const torn = makeWakeHarness({ managedRoot, realProvisionStatus: true });
      await torn.runtime.refresh();
      expect(attempted).toEqual([]);
    } finally {
      globalThis.fetch = realFetch;
      rmSync(managedRoot, { recursive: true, force: true });
    }
  });

  test('an install that could not download degrades to the recovery command, verified by content', async () => {
    const managedRoot = makeProjectTempDir('wake-install-offline');
    // The real install policy against a machine with no network. It must not
    // throw, and must leave nothing behind.
    const outcome = await provisionWakeWordModelsAtInstall({
      managedRoot,
      recoveryHint: '/voice wake setup',
      env: {},
      fetchImpl: (async () => { throw new Error('ENETUNREACH'); }) as unknown as typeof fetch,
    });
    expect(outcome.state).toBe('degraded');
    expect(outcome.message).toContain('/voice wake setup');

    // Now enable the feature, with the SDK's REAL content check — no stub, because
    // the content check is the thing being trusted here.
    const harness = makeWakeHarness({ managedRoot, realProvisionStatus: true });
    await harness.runtime.refresh();
    expect(harness.spawns.processes.length).toBe(0);
    expect(harness.runtime.status()).toBeNull();
    const notice = harness.notices.join('\n');
    expect(notice).toContain('not provisioned');
    expect(notice).toContain('/voice wake setup');
    expect(wakeProvisionStatus({ managedRoot }).ready).toBe(false);
    rmSync(managedRoot, { recursive: true, force: true });
  });

  test('a torn artifact left by a killed install reads as corrupt, not as present', async () => {
    const managedRoot = makeProjectTempDir('wake-install-torn');
    const paths = resolveManagedWakePaths(managedRoot);
    mkdirSync(paths.modelsDir, { recursive: true });
    // Full-size and zero-filled: the exact shape that once trained a model on zeros.
    writeFileSync(paths.classifierPath, Buffer.alloc(2_367_644));
    expect(wakeProvisionStatus({ managedRoot }).classifier.corrupt).toBe(true);

    const harness = makeWakeHarness({ managedRoot, realProvisionStatus: true });
    await harness.runtime.refresh();
    expect(harness.spawns.processes.length).toBe(0);
    expect(harness.notices.join('\n')).toContain('checksum-mismatch');
    rmSync(managedRoot, { recursive: true, force: true });
  });
});
