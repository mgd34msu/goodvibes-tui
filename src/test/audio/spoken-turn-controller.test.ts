import { describe, expect, test } from 'bun:test';
import type { TurnEvent } from '@/runtime/index.ts';
import type { VoiceAudioChunk, VoiceSynthesisRequest, VoiceSynthesisStreamResult } from '@pellux/goodvibes-sdk/platform/voice';
import { SpokenTurnController } from '../../audio/spoken-turn-controller.ts';
import type { StreamingAudioPlayer } from '../../audio/player.ts';

function turn(event: TurnEvent): TurnEvent {
  return event;
}

async function* audioChunks(text: string): AsyncIterable<VoiceAudioChunk> {
  yield {
    data: new TextEncoder().encode(text),
    sequence: 1,
    format: 'mp3',
  };
}

function makeHarness() {
  const synthesized: string[] = [];
  const played: string[] = [];
  const messages: string[] = [];
  const voiceService = {
    async synthesizeStream(providerId: string | undefined, request: VoiceSynthesisRequest): Promise<VoiceSynthesisStreamResult> {
      synthesized.push(`${providerId ?? '(default)'}:${request.voiceId ?? '(default)'}:${request.text}`);
      return {
        providerId: providerId ?? 'fake',
        mimeType: 'audio/mpeg',
        format: 'mp3',
        chunks: audioChunks(request.text),
        metadata: {},
      };
    },
  };
  const player: StreamingAudioPlayer = {
    label: 'fake-player',
    available: true,
    async play(chunks) {
      for await (const chunk of chunks) {
        played.push(new TextDecoder().decode(chunk.data));
      }
    },
    stop() {},
    async waitForDrain() {},
  };
  const configManager = {
    get(key: string) {
      if (key === 'tts.provider') return 'fake-provider';
      if (key === 'tts.voice') return 'fake-voice';
      return '';
    },
  };
  const controller = new SpokenTurnController({
    voiceService,
    configManager: configManager as never,
    player,
    notify: (message) => messages.push(message),
    setInterval: (() => 1) as never,
    clearInterval: (() => {}) as never,
  });
  return { controller, synthesized, played, messages };
}

async function drain(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Harness whose fake sink keeps "playing" after all bytes are written until
 * the test releases it — models a real player process that is still draining
 * its audio buffer. Used to pin the exit-path (bounded drain) and preemption
 * (instant cut) semantics.
 */
function makeDrainHarness() {
  const played: string[] = [];
  const stopCalls: string[] = [];
  let finishActive: (() => void) | null = null;
  const drainWaiters: (() => void)[] = [];
  const release = () => {
    const finish = finishActive;
    finishActive = null;
    finish?.();
    for (const waiter of drainWaiters.splice(0)) waiter();
  };
  const player: StreamingAudioPlayer = {
    label: 'drain-aware',
    available: true,
    async play(chunks) {
      for await (const chunk of chunks) {
        played.push(new TextDecoder().decode(chunk.data));
      }
      await new Promise<void>((resolve) => { finishActive = resolve; });
    },
    stop() {
      stopCalls.push('stop');
      release();
    },
    waitForDrain(timeoutMs) {
      if (!finishActive) return Promise.resolve();
      return new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, timeoutMs);
        drainWaiters.push(() => { clearTimeout(timer); resolve(); });
      });
    },
  };
  const voiceService = {
    async synthesizeStream(providerId: string | undefined, request: VoiceSynthesisRequest): Promise<VoiceSynthesisStreamResult> {
      return {
        providerId: providerId ?? 'fake',
        mimeType: 'audio/mpeg',
        format: 'mp3',
        chunks: audioChunks(request.text),
        metadata: {},
      };
    },
  };
  const controller = new SpokenTurnController({
    voiceService,
    configManager: { get: () => '' } as never,
    player,
    setInterval: (() => 1) as never,
    clearInterval: (() => {}) as never,
  });
  return {
    controller,
    played,
    stopCalls,
    playing: () => finishActive !== null,
    finishActivePlay: release,
  };
}

/**
 * Harness for the request-pipeline tests: counts every synthesis request and
 * the number concurrently in flight, can defer each request until the test
 * releases it, can fail requests selectively (per text / per attempt), and
 * accepts an injected backoff clock.
 */
function makePipelineHarness(behavior: {
  failWhen?: (text: string, attempt: number) => boolean;
  deferred?: boolean;
  setTimeout?: typeof setTimeout;
  clearTimeout?: typeof clearTimeout;
} = {}) {
  const synthesized: string[] = [];
  const played: string[] = [];
  const messages: string[] = [];
  const attempts = new Map<string, number>();
  let totalRequests = 0;
  let inFlight = 0;
  let peakInFlight = 0;
  const pendingSynth: (() => void)[] = [];
  const voiceService = {
    async synthesizeStream(_providerId: string | undefined, request: VoiceSynthesisRequest): Promise<VoiceSynthesisStreamResult> {
      const attempt = (attempts.get(request.text) ?? 0) + 1;
      attempts.set(request.text, attempt);
      totalRequests++;
      inFlight++;
      peakInFlight = Math.max(peakInFlight, inFlight);
      try {
        if (behavior.deferred) {
          await new Promise<void>((resolve) => pendingSynth.push(resolve));
        }
        if (behavior.failWhen?.(request.text, attempt)) {
          throw new Error('ElevenLabs streaming synthesis failed: HTTP 429: {"detail":{"status":"too_many_concurrent_requests","message":"maximum of 3 concurrent requests"}}');
        }
        synthesized.push(request.text);
        return {
          providerId: 'fake',
          mimeType: 'audio/mpeg',
          format: 'mp3',
          chunks: audioChunks(request.text),
          metadata: {},
        };
      } finally {
        inFlight--;
      }
    },
  };
  const player: StreamingAudioPlayer = {
    label: 'fake-player',
    available: true,
    async play(chunks) {
      for await (const chunk of chunks) {
        played.push(new TextDecoder().decode(chunk.data));
      }
    },
    stop() {},
    async waitForDrain() {},
  };
  const controller = new SpokenTurnController({
    voiceService,
    configManager: { get: () => '' } as never,
    player,
    notify: (message) => messages.push(message),
    setInterval: (() => 1) as never,
    clearInterval: (() => {}) as never,
    ...(behavior.setTimeout ? { setTimeout: behavior.setTimeout } : {}),
    ...(behavior.clearTimeout ? { clearTimeout: behavior.clearTimeout } : {}),
  });
  return {
    controller,
    synthesized,
    played,
    messages,
    attempts,
    requests: () => totalRequests,
    peakInFlight: () => peakInFlight,
    releaseSynth: () => pendingSynth.shift()?.(),
  };
}

describe('SpokenTurnController request pipeline', () => {
  test('a turn that completes before first audio becomes exactly one synthesis request', async () => {
    const h = makePipelineHarness();

    expect(h.controller.submitNextTurn('quick weather answer')).toBe(true);
    h.controller.handleTurnEvent(turn({ type: 'TURN_SUBMITTED', turnId: 't-one', prompt: 'quick weather answer' }));
    // Three sentence-boundary deltas plus completion, all in one synchronous
    // burst — the whole answer arrived before the first request could fire,
    // so everything merges into ONE request (not one per sentence).
    h.controller.handleTurnEvent(turn({ type: 'STREAM_DELTA', turnId: 't-one', content: 'Tonight will be cool and clear. ', accumulated: '' }));
    h.controller.handleTurnEvent(turn({ type: 'STREAM_DELTA', turnId: 't-one', content: 'Expect a low around fifteen degrees. ', accumulated: '' }));
    h.controller.handleTurnEvent(turn({ type: 'STREAM_DELTA', turnId: 't-one', content: 'Winds stay light through the morning.', accumulated: '' }));
    h.controller.handleTurnEvent(turn({ type: 'TURN_COMPLETED', turnId: 't-one', response: '', stopReason: 'completed' }));
    await drain();

    const full = 'Tonight will be cool and clear. Expect a low around fifteen degrees. Winds stay light through the morning.';
    expect(h.requests()).toBe(1);
    expect(h.synthesized).toEqual([full]);
    expect(h.played).toEqual([full]);
  });

  test('a fast-streaming multi-paragraph turn stays within three requests and the in-flight window', async () => {
    const h = makePipelineHarness({ deferred: true });
    const p1 = 'This is the first paragraph of the answer. ';
    const p2 = 'Here is the second paragraph with more detail. ';
    const p3 = 'The third paragraph continues the explanation. ';
    const p4 = 'And the fourth paragraph wraps everything up.';

    expect(h.controller.submitNextTurn('long explanation')).toBe(true);
    h.controller.handleTurnEvent(turn({ type: 'TURN_SUBMITTED', turnId: 't-many', prompt: 'long explanation' }));
    h.controller.handleTurnEvent(turn({ type: 'STREAM_DELTA', turnId: 't-many', content: p1, accumulated: '' }));
    await drain();
    h.controller.handleTurnEvent(turn({ type: 'STREAM_DELTA', turnId: 't-many', content: p2, accumulated: '' }));
    await drain();
    // Paragraphs 3 and 4 land while the window is full: they queue, they do
    // NOT fire more requests.
    h.controller.handleTurnEvent(turn({ type: 'STREAM_DELTA', turnId: 't-many', content: p3, accumulated: '' }));
    h.controller.handleTurnEvent(turn({ type: 'STREAM_DELTA', turnId: 't-many', content: p4, accumulated: '' }));
    h.controller.handleTurnEvent(turn({ type: 'TURN_COMPLETED', turnId: 't-many', response: '', stopReason: 'completed' }));
    await drain();
    expect(h.requests()).toBe(2);

    // Each release lets one synthesis finish and its playback complete; the
    // freed slot merges EVERYTHING still queued into a single request.
    h.releaseSynth();
    await drain();
    h.releaseSynth();
    await drain();
    h.releaseSynth();
    await drain();

    expect(h.requests()).toBe(3);
    expect(h.peakInFlight()).toBeLessThanOrEqual(2);
    expect(h.played).toEqual([
      'This is the first paragraph of the answer.',
      'Here is the second paragraph with more detail.',
      'The third paragraph continues the explanation. And the fourth paragraph wraps everything up.',
    ]);
  });

  test('a 429 is retried with backoff and the chunk plays with no user-facing error', async () => {
    const delays: number[] = [];
    const h = makePipelineHarness({
      failWhen: (_text, attempt) => attempt === 1,
      setTimeout: ((cb: () => void, ms: number) => {
        delays.push(ms);
        queueMicrotask(cb);
        return 0;
      }) as unknown as typeof setTimeout,
      clearTimeout: (() => {}) as unknown as typeof clearTimeout,
    });

    expect(h.controller.submitNextTurn('retry me')).toBe(true);
    h.controller.handleTurnEvent(turn({ type: 'TURN_SUBMITTED', turnId: 't-retry', prompt: 'retry me' }));
    h.controller.handleTurnEvent(turn({ type: 'STREAM_DELTA', turnId: 't-retry', content: 'The weather stays clear tonight. ', accumulated: '' }));
    h.controller.handleTurnEvent(turn({ type: 'TURN_COMPLETED', turnId: 't-retry', response: '', stopReason: 'completed' }));
    await drain();

    expect(h.played).toEqual(['The weather stays clear tonight.']);
    expect(h.requests()).toBe(2); // first attempt 429s, the retry succeeds
    expect(delays).toEqual([1000]);
    const log = h.messages.join('\n');
    expect(log).not.toContain('stopped');
    expect(log).not.toContain('Skipping');
  });

  test('exhausted retries skip that chunk with one honest notice and the turn continues', async () => {
    const delays: number[] = [];
    const h = makePipelineHarness({
      failWhen: (text) => text.startsWith('First'),
      setTimeout: ((cb: () => void, ms: number) => {
        delays.push(ms);
        queueMicrotask(cb);
        return 0;
      }) as unknown as typeof setTimeout,
      clearTimeout: (() => {}) as unknown as typeof clearTimeout,
    });
    const failing = 'First segment of the response that keeps failing. ';
    const fine = 'Second segment plays fine after the failure.';

    expect(h.controller.submitNextTurn('gap not silence')).toBe(true);
    h.controller.handleTurnEvent(turn({ type: 'TURN_SUBMITTED', turnId: 't-skip', prompt: 'gap not silence' }));
    h.controller.handleTurnEvent(turn({ type: 'STREAM_DELTA', turnId: 't-skip', content: failing, accumulated: '' }));
    await drain();
    h.controller.handleTurnEvent(turn({ type: 'STREAM_DELTA', turnId: 't-skip', content: fine, accumulated: '' }));
    h.controller.handleTurnEvent(turn({ type: 'TURN_COMPLETED', turnId: 't-skip', response: '', stopReason: 'completed' }));
    await drain();
    await drain();

    // The failing chunk burned all its attempts (1 original + 2 retries)...
    expect(h.attempts.get(failing.trim())).toBe(3);
    expect(delays).toEqual([1000, 2500]);
    // ...was skipped with exactly ONE notice, and the rest still played.
    const notices = h.messages.filter((m) => m.includes('Skipping part of the spoken response'));
    expect(notices.length).toBe(1);
    expect(h.messages.join('\n')).not.toContain('Live playback stopped');
    expect(h.played).toEqual([fine]);
  });

  test('an abort during retry backoff clears the timer and stays silent', async () => {
    const timers = new Map<number, () => void>();
    let nextId = 1;
    const h = makePipelineHarness({
      failWhen: () => true,
      setTimeout: ((cb: () => void) => {
        const id = nextId++;
        timers.set(id, cb);
        return id;
      }) as unknown as typeof setTimeout,
      clearTimeout: ((id: number) => {
        timers.delete(id);
      }) as unknown as typeof clearTimeout,
    });

    expect(h.controller.submitNextTurn('abort mid-backoff')).toBe(true);
    h.controller.handleTurnEvent(turn({ type: 'TURN_SUBMITTED', turnId: 't-abort', prompt: 'abort mid-backoff' }));
    h.controller.handleTurnEvent(turn({ type: 'STREAM_DELTA', turnId: 't-abort', content: 'This request is going to fail hard. ', accumulated: '' }));
    await drain();

    // First attempt failed; the backoff timer is armed and waiting.
    expect(timers.size).toBe(1);

    // A deliberate stop lands mid-backoff: the timer must be cleared
    // synchronously (no leak) and no error notice may follow.
    h.controller.stop();
    expect(timers.size).toBe(0);
    await drain();

    const log = h.messages.join('\n');
    expect(log).not.toContain('Skipping');
    expect(log).not.toContain('Live playback stopped');
    expect(h.played).toEqual([]);
  });
});

describe('SpokenTurnController', () => {
  test('speaks only assistant deltas from the marked turn', async () => {
    const { controller, synthesized, played } = makeHarness();

    expect(controller.submitNextTurn('say hello')).toBe(true);
    controller.handleTurnEvent(turn({ type: 'TURN_SUBMITTED', turnId: 'ignored', prompt: 'different' }));
    controller.handleTurnEvent(turn({ type: 'STREAM_DELTA', turnId: 'ignored', content: 'Wrong.', accumulated: 'Wrong.' }));
    controller.handleTurnEvent(turn({ type: 'TURN_SUBMITTED', turnId: 'turn-1', prompt: 'say hello' }));
    controller.handleTurnEvent(turn({ type: 'STREAM_DELTA', turnId: 'turn-1', content: 'Hello there. ', accumulated: 'Hello there. ' }));
    controller.handleTurnEvent(turn({ type: 'TURN_COMPLETED', turnId: 'turn-1', response: 'Hello there.', stopReason: 'completed' }));
    await drain();

    expect(synthesized).toEqual(['fake-provider:fake-voice:Hello there.']);
    expect(played).toEqual(['Hello there.']);
  });

  test('does not treat provider STREAM_END as the logical spoken-turn end', async () => {
    const { controller, synthesized, played } = makeHarness();

    expect(controller.submitNextTurn('check the weather')).toBe(true);
    controller.handleTurnEvent(turn({ type: 'TURN_SUBMITTED', turnId: 'turn-tool', prompt: 'check the weather' }));
    controller.handleTurnEvent(turn({ type: 'STREAM_DELTA', turnId: 'turn-tool', content: 'Checking. ', accumulated: 'Checking. ' }));
    controller.handleTurnEvent(turn({ type: 'STREAM_END', turnId: 'turn-tool', scope: 'provider', terminal: false }));
    controller.handleTurnEvent(turn({ type: 'STREAM_DELTA', turnId: 'turn-tool', content: 'Tonight will be cool.', accumulated: 'Checking. Tonight will be cool.' }));
    controller.handleTurnEvent(turn({ type: 'TURN_COMPLETED', turnId: 'turn-tool', response: 'Checking. Tonight will be cool.', stopReason: 'completed' }));
    await drain();

    expect(synthesized).toEqual(['fake-provider:fake-voice:Checking. Tonight will be cool.']);
    expect(played).toEqual(['Checking. Tonight will be cool.']);
  });

  test('keeps the normal turn alive when player is unavailable', () => {
    const messages: string[] = [];
    const controller = new SpokenTurnController({
      voiceService: { synthesizeStream: async () => { throw new Error('should not synthesize'); } },
      configManager: { get: () => '' } as never,
      player: {
        label: 'missing',
        available: false,
        play: async () => {},
        stop: () => {},
        waitForDrain: async () => {},
      },
      notify: (message) => messages.push(message),
    });

    expect(controller.submitNextTurn('still submit text')).toBe(false);
    expect(messages.join('\n')).toContain('Text response will continue');
  });

  test('speaks the final unpunctuated tail flushed at turn completion', async () => {
    const { controller, synthesized, played } = makeHarness();

    expect(controller.submitNextTurn('tell me the number')).toBe(true);
    controller.handleTurnEvent(turn({ type: 'TURN_SUBMITTED', turnId: 'turn-tail', prompt: 'tell me the number' }));
    // The response never ends on sentence punctuation, so the tail only ever
    // leaves the chunker via flushAll() on TURN_COMPLETED. If completion released
    // before draining that flush, this tail would be truncated (the bug).
    controller.handleTurnEvent(turn({ type: 'STREAM_DELTA', turnId: 'turn-tail', content: 'The answer is forty two', accumulated: 'The answer is forty two' }));
    controller.handleTurnEvent(turn({ type: 'TURN_COMPLETED', turnId: 'turn-tail', response: 'The answer is forty two', stopReason: 'completed' }));
    await drain();

    expect(synthesized).toEqual(['fake-provider:fake-voice:The answer is forty two']);
    expect(played).toEqual(['The answer is forty two']);
  });

  test('exit lets the audio already playing drain, drops queued chunks, then tears down', async () => {
    const h = makeDrainHarness();

    expect(h.controller.submitNextTurn('long answer')).toBe(true);
    h.controller.handleTurnEvent(turn({ type: 'TURN_SUBMITTED', turnId: 'turn-exit', prompt: 'long answer' }));
    h.controller.handleTurnEvent(turn({ type: 'STREAM_DELTA', turnId: 'turn-exit', content: 'First part of the answer. ', accumulated: 'First part of the answer. ' }));
    await drain();
    // Chunk 1 is now in the sink (its playback is pending); chunk 2 is queued behind it.
    h.controller.handleTurnEvent(turn({ type: 'STREAM_DELTA', turnId: 'turn-exit', content: 'Second part of the answer. ', accumulated: 'First part of the answer. Second part of the answer. ' }));
    await drain();
    expect(h.playing()).toBe(true);
    // Discard the housekeeping stop() from the arming submitNextTurn call;
    // from here on, only exit-path teardown may touch the player.
    h.stopCalls.length = 0;

    let exitResolved = false;
    const exiting = h.controller.stopForExit(1000).then(() => { exitResolved = true; });
    await drain();

    // While the sink is still draining, the exit path must not hard-stop it.
    expect(h.stopCalls.length).toBe(0);
    expect(exitResolved).toBe(false);

    // The sink finishes naturally: exit completes and the backstop teardown runs.
    h.finishActivePlay();
    await exiting;
    expect(exitResolved).toBe(true);
    expect(h.stopCalls.length).toBe(1);
    await drain();

    // Only the audio that was already playing was heard; the queued chunk was dropped.
    expect(h.played).toEqual(['First part of the answer.']);
  });

  test('a new spoken turn preempts the previous one instantly, without a drain wait', async () => {
    const h = makeDrainHarness();

    expect(h.controller.submitNextTurn('first prompt')).toBe(true);
    h.controller.handleTurnEvent(turn({ type: 'TURN_SUBMITTED', turnId: 'turn-a', prompt: 'first prompt' }));
    h.controller.handleTurnEvent(turn({ type: 'STREAM_DELTA', turnId: 'turn-a', content: 'Still speaking this response. ', accumulated: 'Still speaking this response. ' }));
    await drain();
    expect(h.playing()).toBe(true);
    // Discard the housekeeping stop() from the first arming call; the next
    // one below is the preemption cut under test.
    h.stopCalls.length = 0;

    // Preemption is an intentional cut: the hard stop lands synchronously.
    expect(h.controller.submitNextTurn('next prompt')).toBe(true);
    expect(h.stopCalls.length).toBe(1);
  });

  test('stops playback without throwing on turn cancellation', async () => {
    const { controller, messages } = makeHarness();

    controller.submitNextTurn('cancel this');
    controller.handleTurnEvent(turn({ type: 'TURN_SUBMITTED', turnId: 'turn-2', prompt: 'cancel this' }));
    controller.handleTurnEvent(turn({ type: 'TURN_CANCEL', turnId: 'turn-2', stopReason: 'cancelled', reason: 'operator cancel' }));
    await drain();

    expect(messages.join('\n')).toContain('Spoken output stopped');
  });
});
