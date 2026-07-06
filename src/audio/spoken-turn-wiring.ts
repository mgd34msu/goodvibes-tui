import type { ConfigManager } from '@pellux/goodvibes-sdk/platform/config';
import type { UiRuntimeEvents } from '@/runtime/index.ts';
import type { VoiceService } from '@pellux/goodvibes-sdk/platform/voice';
import type { StreamingAudioPlayer } from './player.ts';
import { LocalStreamingAudioPlayer } from './player.ts';
import { SpokenTurnController } from './spoken-turn-controller.ts';

export interface SpokenTurnRuntime {
  readonly unsubs: readonly (() => void)[];
  submitNextTurn(prompt: string): boolean;
  /** Returns whether speech was actually active (see controller.stop). */
  stop(message?: string): boolean;
  /** Exit-path stop: lets the audio already playing drain, bounded (see controller.stopForExit). */
  stopForExit(drainTimeoutMs?: number): Promise<void>;
}

export interface WireSpokenTurnRuntimeOptions {
  readonly voiceService: Pick<VoiceService, 'synthesizeStream'>;
  readonly configManager: Pick<ConfigManager, 'get'>;
  readonly events: UiRuntimeEvents;
  readonly notify: (message: string) => void;
  /**
   * Optional player factory — injected in tests to avoid spawning real
   * subprocesses. Defaults to LocalStreamingAudioPlayer.
   */
  readonly playerFactory?: () => StreamingAudioPlayer;
}

/**
 * wireSpokenTurnRuntime — wires the spoken-turn pipeline against the runtime
 * event bus.
 *
 * Always-speak mode: when `ui.voiceEnabled` is true in config, every
 * TURN_SUBMITTED event arms the turn for spoken output automatically — the
 * user does not need to prefix the prompt with /tts. The availability check
 * inside SpokenTurnController still gates gracefully when no player is found.
 */
export function wireSpokenTurnRuntime(options: WireSpokenTurnRuntimeOptions): SpokenTurnRuntime {
  const player = options.playerFactory ? options.playerFactory() : new LocalStreamingAudioPlayer();
  const controller = new SpokenTurnController({
    voiceService: options.voiceService,
    configManager: options.configManager,
    player,
    notify: options.notify,
  });

  const turns = options.events.turns;
  const unsubs = [
    turns.on('TURN_SUBMITTED', (event) => {
      // Always-speak mode: auto-arm when ui.voiceEnabled is set.
      if (options.configManager.get('ui.voiceEnabled')) {
        controller.submitNextTurn(event.prompt);
      }
      controller.handleTurnEvent(event);
    }),
    turns.on('PREFLIGHT_FAIL', (event) => controller.handleTurnEvent(event)),
    turns.on('STREAM_DELTA', (event) => controller.handleTurnEvent(event)),
    turns.on('STREAM_END', (event) => controller.handleTurnEvent(event)),
    turns.on('TURN_COMPLETED', (event) => controller.handleTurnEvent(event)),
    turns.on('TURN_ERROR', (event) => controller.handleTurnEvent(event)),
    turns.on('TURN_CANCEL', (event) => controller.handleTurnEvent(event)),
  ];

  return {
    unsubs,
    submitNextTurn: (prompt) => controller.submitNextTurn(prompt),
    stop: (message) => controller.stop(message),
    stopForExit: (drainTimeoutMs) => controller.stopForExit(drainTimeoutMs),
  };
}
