/**
 * spoken-turn-toggle.test.ts
 *
 * Tests for the ui.voiceEnabled always-speak toggle and SpokenTurnController:
 * - submitNextTurn arms the turn for spoken output
 * - Turns not armed produce no synthesis or playback
 * - Defaults from SDK schema are present
 * - Speed is threaded through when readOptionalConfigNumber returns a value
 * - No-player notice fires once per session (suppressed on subsequent turns)
 */
import { describe, expect, test } from 'bun:test';
import type { VoiceAudioChunk, VoiceSynthesisRequest, VoiceSynthesisStreamResult } from '@pellux/goodvibes-sdk/platform/voice';
import { SpokenTurnController } from '../../audio/spoken-turn-controller.ts';
import type { StreamingAudioPlayer } from '../../audio/player.ts';
import { DEFAULT_CONFIG, CONFIG_SCHEMA } from '@pellux/goodvibes-sdk/platform/config';

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

function makeSynthesizer() {
  const calls: Array<{ text: string; speed: number | undefined }> = [];
  const voiceService = {
    async synthesizeStream(_providerId: string | undefined, request: VoiceSynthesisRequest): Promise<VoiceSynthesisStreamResult> {
      calls.push({ text: request.text, speed: request.speed });
      return {
        providerId: 'fake',
        mimeType: 'audio/mpeg',
        format: 'mp3',
        chunks: audioChunks(request.text),
        metadata: {},
      };
    },
  };
  return { voiceService, calls };
}

function makePlayer(): { player: StreamingAudioPlayer; played: string[] } {
  const played: string[] = [];
  const player: StreamingAudioPlayer = {
    label: 'test',
    available: true,
    async play(chunks) {
      for await (const chunk of chunks) {
        played.push(new TextDecoder().decode(chunk.data));
      }
    },
    stop() {},
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

describe('SpokenTurnController — always-speak via ui.voiceEnabled', () => {
  test('submitNextTurn arms the turn (baseline)', async () => {
    const { voiceService, calls } = makeSynthesizer();
    const { player, played } = makePlayer();
    const controller = new SpokenTurnController({
      voiceService,
      configManager: { get: (k: string) => (k === 'tts.provider' ? 'fake' : '') } as never,
      player,
      notify: () => {},
      setInterval: (() => 1) as never,
      clearInterval: (() => {}) as never,
    });

    expect(controller.submitNextTurn('arm test')).toBe(true);
    controller.handleTurnEvent({ type: 'TURN_SUBMITTED', turnId: 't1', prompt: 'arm test' });
    controller.handleTurnEvent({ type: 'STREAM_DELTA', turnId: 't1', content: 'Response.', accumulated: 'Response.' });
    controller.handleTurnEvent({ type: 'TURN_COMPLETED', turnId: 't1', response: 'Response.', stopReason: 'completed' });

    await drain();
    expect(calls.length).toBeGreaterThan(0);
    expect(played.join('')).toContain('Response.');
  });

  test('turn not armed — no synthesis or playback', async () => {
    const { voiceService, calls } = makeSynthesizer();
    const { player, played } = makePlayer();
    const controller = new SpokenTurnController({
      voiceService,
      configManager: { get: () => '' } as never,
      player,
      notify: () => {},
      setInterval: (() => 1) as never,
      clearInterval: (() => {}) as never,
    });

    // No submitNextTurn call — turn is not armed
    controller.handleTurnEvent({ type: 'TURN_SUBMITTED', turnId: 't2', prompt: 'silent' });
    controller.handleTurnEvent({ type: 'STREAM_DELTA', turnId: 't2', content: 'Silent.', accumulated: 'Silent.' });
    controller.handleTurnEvent({ type: 'TURN_COMPLETED', turnId: 't2', response: 'Silent.', stopReason: 'completed' });

    await drain();
    expect(calls).toHaveLength(0);
    expect(played).toHaveLength(0);
  });

  test('speed is threaded through synthesize when config provides a positive number', async () => {
    const { voiceService, calls } = makeSynthesizer();
    const { player } = makePlayer();
    const controller = new SpokenTurnController({
      voiceService,
      configManager: {
        get(key: string) {
          if (key === 'tts.speed') return 1.5;
          if (key === 'tts.provider') return 'fast-provider';
          return '';
        },
      } as never,
      player,
      notify: () => {},
      setInterval: (() => 1) as never,
      clearInterval: (() => {}) as never,
    });

    expect(controller.submitNextTurn('speed test')).toBe(true);
    controller.handleTurnEvent({ type: 'TURN_SUBMITTED', turnId: 't3', prompt: 'speed test' });
    controller.handleTurnEvent({ type: 'STREAM_DELTA', turnId: 't3', content: 'Fast reply.', accumulated: 'Fast reply.' });
    controller.handleTurnEvent({ type: 'TURN_COMPLETED', turnId: 't3', response: 'Fast reply.', stopReason: 'completed' });

    await drain();
    expect(calls.length).toBeGreaterThan(0);
    // speed should be threaded through from config
    expect(calls[0]!.speed).toBe(1.5);
  });

  test('no-player notice fires once per session and is suppressed on subsequent turns', () => {
    const { voiceService } = makeSynthesizer();
    const messages: string[] = [];
    const unavailablePlayer: StreamingAudioPlayer = {
      label: 'none',
      available: false,
      async play() {},
      stop() {},
    };
    const controller = new SpokenTurnController({
      voiceService,
      configManager: { get: () => '' } as never,
      player: unavailablePlayer,
      notify: (msg) => messages.push(msg),
      setInterval: (() => 1) as never,
      clearInterval: (() => {}) as never,
    });

    // First call — notice should fire
    controller.submitNextTurn('turn 1');
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('unavailable');

    // Second call — notice should be suppressed
    controller.submitNextTurn('turn 2');
    expect(messages).toHaveLength(1); // still just one message

    // Third call — still suppressed
    controller.submitNextTurn('turn 3');
    expect(messages).toHaveLength(1);
  });

  test('speed is undefined when config returns 0 or non-numeric', async () => {
    const { voiceService, calls } = makeSynthesizer();
    const { player } = makePlayer();
    const controller = new SpokenTurnController({
      voiceService,
      configManager: {
        get(key: string) {
          if (key === 'tts.speed') return 0;
          return '';
        },
      } as never,
      player,
      notify: () => {},
      setInterval: (() => 1) as never,
      clearInterval: (() => {}) as never,
    });

    expect(controller.submitNextTurn('zero speed')).toBe(true);
    controller.handleTurnEvent({ type: 'TURN_SUBMITTED', turnId: 't4', prompt: 'zero speed' });
    controller.handleTurnEvent({ type: 'STREAM_DELTA', turnId: 't4', content: 'Default speed.', accumulated: 'Default speed.' });
    controller.handleTurnEvent({ type: 'TURN_COMPLETED', turnId: 't4', response: 'Default speed.', stopReason: 'completed' });

    await drain();
    expect(calls.length).toBeGreaterThan(0);
    expect(calls[0]!.speed).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// SDK config defaults verification
// ---------------------------------------------------------------------------

describe('tts config defaults — SDK schema entries', () => {
  test('DEFAULT_CONFIG.tts has all expected keys with correct types', () => {
    const tts = DEFAULT_CONFIG.tts;
    expect(typeof tts.provider).toBe('string');
    expect(typeof tts.voice).toBe('string');
    expect(typeof tts.llmProvider).toBe('string');
    expect(typeof tts.llmModel).toBe('string');
    // Default provider is elevenlabs per SDK schema-domain-core
    expect(tts.provider).toBe('elevenlabs');
  });

  test('CONFIG_SCHEMA includes typed rows for all four tts.* keys', () => {
    const ttsKeys = CONFIG_SCHEMA.filter((s) => s.key.startsWith('tts.'));
    const keyNames = ttsKeys.map((s) => s.key);
    expect(keyNames).toContain('tts.provider');
    expect(keyNames).toContain('tts.voice');
    expect(keyNames).toContain('tts.llmProvider');
    expect(keyNames).toContain('tts.llmModel');
    // All entries have a description
    for (const entry of ttsKeys) {
      expect(entry.description.length).toBeGreaterThan(0);
      expect(entry.type).toMatch(/string|number|boolean|enum/);
    }
  });

  test('CONFIG_SCHEMA includes ui.voiceEnabled (always-speak toggle)', () => {
    const voiceEntry = CONFIG_SCHEMA.find((s) => s.key === 'ui.voiceEnabled');
    expect(voiceEntry).toBeDefined();
    expect(voiceEntry!.type).toBe('boolean');
    expect(voiceEntry!.default).toBe(false);
  });
});
