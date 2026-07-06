/**
 * spoken-turn-wiring.test.ts
 *
 * Integration smoke test for wireSpokenTurnRuntime. Verifies the full wiring
 * seam: TURN_SUBMITTED → STREAM_DELTA → TURN_COMPLETED with a fake
 * voiceService and injected player factory. Asserts audio bytes reach the
 * player without spawning any real subprocess.
 */
import { describe, expect, test } from 'bun:test';
import type { VoiceAudioChunk, VoiceSynthesisRequest, VoiceSynthesisStreamResult } from '@pellux/goodvibes-sdk/platform/voice';
import type { StreamingAudioPlayer } from '../../audio/player.ts';
import { wireSpokenTurnRuntime } from '../../audio/spoken-turn-wiring.ts';

// ---------------------------------------------------------------------------
// Minimal fake events surface
// ---------------------------------------------------------------------------

type Handler<E> = (event: E) => void;

function makeFakeEvents() {
  const listeners = new Map<string, Handler<unknown>[]>();

  function on(type: string, handler: Handler<unknown>): () => void {
    const existing = listeners.get(type) ?? [];
    existing.push(handler);
    listeners.set(type, existing);
    return () => {
      const arr = listeners.get(type);
      if (arr) {
        const idx = arr.indexOf(handler);
        if (idx >= 0) arr.splice(idx, 1);
      }
    };
  }

  function emit(type: string, event: unknown): void {
    for (const handler of listeners.get(type) ?? []) handler(event);
  }

  const turns = {
    on: (type: string, handler: Handler<unknown>) => on(type, handler),
  };

  return { turns: turns as never, emit };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function* audioChunks(text: string): AsyncIterable<VoiceAudioChunk> {
  yield {
    data: new TextEncoder().encode(text),
    sequence: 1,
    format: 'mp3',
  };
}

function makeFakeVoiceService() {
  const synthesized: string[] = [];
  const voiceService = {
    async synthesizeStream(_providerId: string | undefined, request: VoiceSynthesisRequest): Promise<VoiceSynthesisStreamResult> {
      synthesized.push(request.text);
      return {
        providerId: 'fake',
        mimeType: 'audio/mpeg',
        format: 'mp3',
        chunks: audioChunks(request.text),
        metadata: {},
      };
    },
  };
  return { voiceService, synthesized };
}

function makeFakePlayer(): { player: StreamingAudioPlayer; played: string[] } {
  const played: string[] = [];
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
  return { player, played };
}

async function drain(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('wireSpokenTurnRuntime integration seam', () => {
  test('TURN_SUBMITTED → STREAM_DELTA → TURN_COMPLETED delivers audio bytes to player', async () => {
    const { voiceService, synthesized } = makeFakeVoiceService();
    const { player, played } = makeFakePlayer();
    const events = makeFakeEvents();
    const messages: string[] = [];

    const runtime = wireSpokenTurnRuntime({
      voiceService,
      configManager: {
        get(key: string) {
          if (key === 'ui.voiceEnabled') return false;
          if (key === 'tts.provider') return 'fake';
          if (key === 'tts.voice') return '';
          return '';
        },
      } as never,
      events: { turns: events.turns } as never,
      notify: (msg) => messages.push(msg),
      playerFactory: () => player,
    });

    // Arm the turn manually (always-speak is off; simulate /tts <prompt>)
    expect(runtime.submitNextTurn('hello world')).toBe(true);

    events.emit('TURN_SUBMITTED', { type: 'TURN_SUBMITTED', turnId: 'turn-wiring-1', prompt: 'hello world' });
    events.emit('STREAM_DELTA', { type: 'STREAM_DELTA', turnId: 'turn-wiring-1', content: 'Hello, world.', accumulated: 'Hello, world.' });
    events.emit('TURN_COMPLETED', { type: 'TURN_COMPLETED', turnId: 'turn-wiring-1', response: 'Hello, world.', stopReason: 'completed' });

    await drain();

    expect(synthesized.length).toBeGreaterThan(0);
    expect(played.length).toBeGreaterThan(0);
    expect(played.join('')).toContain('Hello, world.');

    // Clean up subscriptions
    for (const unsub of runtime.unsubs) unsub();
  });

  test('always-speak mode arms turns automatically on TURN_SUBMITTED when ui.voiceEnabled is true', async () => {
    const { voiceService, synthesized } = makeFakeVoiceService();
    const { player, played } = makeFakePlayer();
    const events = makeFakeEvents();

    const runtime = wireSpokenTurnRuntime({
      voiceService,
      configManager: {
        get(key: string) {
          if (key === 'ui.voiceEnabled') return true; // always-speak ON
          if (key === 'tts.provider') return 'fake';
          if (key === 'tts.voice') return '';
          return '';
        },
      } as never,
      events: { turns: events.turns } as never,
      notify: () => {},
      playerFactory: () => player,
    });

    // No manual submitNextTurn call — always-speak mode handles it
    events.emit('TURN_SUBMITTED', { type: 'TURN_SUBMITTED', turnId: 'turn-auto', prompt: 'auto spoken' });
    events.emit('STREAM_DELTA', { type: 'STREAM_DELTA', turnId: 'turn-auto', content: 'Auto response.', accumulated: 'Auto response.' });
    events.emit('TURN_COMPLETED', { type: 'TURN_COMPLETED', turnId: 'turn-auto', response: 'Auto response.', stopReason: 'completed' });

    await drain();

    expect(synthesized.length).toBeGreaterThan(0);
    expect(played.join('')).toContain('Auto response.');

    for (const unsub of runtime.unsubs) unsub();
  });

  test('always-speak off does not auto-arm turns', async () => {
    const { voiceService, synthesized } = makeFakeVoiceService();
    const { player, played } = makeFakePlayer();
    const events = makeFakeEvents();

    wireSpokenTurnRuntime({
      voiceService,
      configManager: {
        get(key: string) {
          if (key === 'ui.voiceEnabled') return false; // always-speak OFF
          return '';
        },
      } as never,
      events: { turns: events.turns } as never,
      notify: () => {},
      playerFactory: () => player,
    });

    // No submitNextTurn — always-speak is off, nothing should synthesize
    events.emit('TURN_SUBMITTED', { type: 'TURN_SUBMITTED', turnId: 'turn-silent', prompt: 'silent' });
    events.emit('STREAM_DELTA', { type: 'STREAM_DELTA', turnId: 'turn-silent', content: 'Silent.', accumulated: 'Silent.' });
    events.emit('TURN_COMPLETED', { type: 'TURN_COMPLETED', turnId: 'turn-silent', response: 'Silent.', stopReason: 'completed' });

    await drain();

    expect(synthesized).toHaveLength(0);
    expect(played).toHaveLength(0);
  });

  test('unsubs unregister all event handlers', () => {
    const { voiceService } = makeFakeVoiceService();
    const { player } = makeFakePlayer();
    const events = makeFakeEvents();

    const runtime = wireSpokenTurnRuntime({
      voiceService,
      configManager: { get: () => false } as never,
      events: { turns: events.turns } as never,
      notify: () => {},
      playerFactory: () => player,
    });

    expect(runtime.unsubs.length).toBeGreaterThan(0);
    for (const unsub of runtime.unsubs) unsub();
    // After unsubscribing no throws should occur from emitting events
    expect(() => {
      events.emit('TURN_SUBMITTED', { type: 'TURN_SUBMITTED', turnId: 'x', prompt: 'x' });
    }).not.toThrow();
  });
});
