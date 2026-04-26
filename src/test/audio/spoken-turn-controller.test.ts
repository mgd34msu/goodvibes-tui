import { describe, expect, test } from 'bun:test';
import type { TurnEvent } from '@pellux/goodvibes-sdk/platform/runtime/events/index';
import type { VoiceAudioChunk, VoiceSynthesisRequest, VoiceSynthesisStreamResult } from '@pellux/goodvibes-sdk/platform/voice/index';
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
      },
      notify: (message) => messages.push(message),
    });

    expect(controller.submitNextTurn('still submit text')).toBe(false);
    expect(messages.join('\n')).toContain('Text response will continue');
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
