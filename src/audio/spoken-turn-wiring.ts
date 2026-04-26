import type { ConfigManager } from '@pellux/goodvibes-sdk/platform/config/manager';
import type { UiRuntimeEvents } from '@pellux/goodvibes-sdk/platform/runtime/ui-events';
import type { VoiceService } from '@pellux/goodvibes-sdk/platform/voice/index';
import { LocalStreamingAudioPlayer } from './player.ts';
import { SpokenTurnController } from './spoken-turn-controller.ts';

export interface SpokenTurnRuntime {
  readonly unsubs: readonly (() => void)[];
  submitNextTurn(prompt: string): boolean;
  stop(message?: string): void;
}

export interface WireSpokenTurnRuntimeOptions {
  readonly voiceService: VoiceService;
  readonly configManager: ConfigManager;
  readonly events: UiRuntimeEvents;
  readonly notify: (message: string) => void;
}

export function wireSpokenTurnRuntime(options: WireSpokenTurnRuntimeOptions): SpokenTurnRuntime {
  const controller = new SpokenTurnController({
    voiceService: options.voiceService,
    configManager: options.configManager,
    player: new LocalStreamingAudioPlayer(),
    notify: options.notify,
  });

  const turns = options.events.turns;
  const unsubs = [
    turns.on('TURN_SUBMITTED', (event) => controller.handleTurnEvent(event)),
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
  };
}
