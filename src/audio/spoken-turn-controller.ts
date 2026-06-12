import type { ConfigManager } from '@pellux/goodvibes-sdk/platform/config';
import type { ConfigKey } from '@pellux/goodvibes-sdk/platform/config';
import type { TurnEvent } from '@/runtime/index.ts';
import type { VoiceService, VoiceSynthesisStreamResult } from '@pellux/goodvibes-sdk/platform/voice';
import { summarizeError } from '@pellux/goodvibes-sdk/platform/utils';
import { TtsTextChunker } from './text-chunker.ts';
import type { StreamingAudioPlayer } from './player.ts';

export interface SpokenTurnControllerOptions {
  readonly voiceService: Pick<VoiceService, 'synthesizeStream'>;
  readonly configManager: Pick<ConfigManager, 'get'>;
  readonly player: StreamingAudioPlayer;
  readonly notify?: (message: string) => void;
  readonly now?: () => number;
  readonly setInterval?: typeof setInterval;
  readonly clearInterval?: typeof clearInterval;
}

export class SpokenTurnController {
  private pendingPrompt: string | null = null;
  private activeTurnId: string | null = null;
  private chunker: TtsTextChunker | null = null;
  private chunkSequence = 0;
  private playbackChain: Promise<void> = Promise.resolve();
  private readonly abortControllers = new Set<AbortController>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private errorReportedForTurn = false;
  private noPlayerNoticed = false;
  private readonly voiceService: Pick<VoiceService, 'synthesizeStream'>;
  private readonly configManager: Pick<ConfigManager, 'get'>;
  private readonly player: StreamingAudioPlayer;
  private readonly notify?: (message: string) => void;
  private readonly now: () => number;
  private readonly setIntervalImpl: typeof setInterval;
  private readonly clearIntervalImpl: typeof clearInterval;

  constructor(options: SpokenTurnControllerOptions) {
    this.voiceService = options.voiceService;
    this.configManager = options.configManager;
    this.player = options.player;
    this.notify = options.notify;
    this.now = options.now ?? (() => Date.now());
    this.setIntervalImpl = options.setInterval ?? setInterval;
    this.clearIntervalImpl = options.clearInterval ?? clearInterval;
  }

  submitNextTurn(prompt: string): boolean {
    const normalized = prompt.trim();
    if (!normalized) return false;
    this.stop();
    if (!this.player.available) {
      if (!this.noPlayerNoticed) {
        this.noPlayerNoticed = true;
        this.notify?.('[TTS] Text response will continue, but live audio is unavailable. Install mpv or ffplay.');
      }
      return false;
    }
    // Reset the no-player notice if player becomes available again.
    this.noPlayerNoticed = false;
    this.pendingPrompt = normalized;
    return true;
  }

  stop(message?: string): void {
    this.pendingPrompt = null;
    this.activeTurnId = null;
    this.chunker?.reset();
    this.chunker = null;
    this.stopTimer();
    for (const controller of this.abortControllers) controller.abort();
    this.abortControllers.clear();
    this.player.stop();
    this.playbackChain = Promise.resolve();
    this.errorReportedForTurn = false;
    if (message) this.notify?.(`[TTS] ${message}`);
  }

  handleTurnEvent(event: TurnEvent): void {
    if (event.type === 'TURN_SUBMITTED') {
      this.maybeStartTurn(event.turnId, event.prompt);
      return;
    }
    if (!this.activeTurnId || event.turnId !== this.activeTurnId) return;

    if (event.type === 'STREAM_DELTA') {
      this.enqueueChunks(this.chunker?.push(event.content) ?? []);
      return;
    }
    if (event.type === 'STREAM_END') {
      return;
    }
    if (event.type === 'TURN_COMPLETED') {
      this.finishTurn(event.turnId);
      return;
    }
    if (event.type === 'TURN_CANCEL' || event.type === 'TURN_ERROR' || event.type === 'PREFLIGHT_FAIL') {
      this.stop(event.type === 'TURN_CANCEL' ? 'Spoken output stopped.' : 'Spoken output stopped because the turn did not complete.');
    }
  }

  private maybeStartTurn(turnId: string, prompt: string): void {
    if (!this.pendingPrompt) return;
    if (prompt.trim() !== this.pendingPrompt) return;
    this.pendingPrompt = null;
    this.activeTurnId = turnId;
    this.chunkSequence = 0;
    this.errorReportedForTurn = false;
    this.chunker = new TtsTextChunker({ now: this.now });
    this.playbackChain = Promise.resolve();
    this.startTimer();
    this.notify?.(`[TTS] Live playback queued through ${this.player.label}.`);
  }

  private finishTurn(turnId: string): void {
    if (turnId !== this.activeTurnId) return;
    this.enqueueChunks(this.chunker?.flushAll() ?? []);
    this.stopTimer();
    const chain = this.playbackChain;
    chain.finally(() => {
      if (this.activeTurnId !== turnId) return;
      this.activeTurnId = null;
      this.chunker = null;
      this.abortControllers.clear();
    }).catch(() => {
      // Errors are already reported in the queued task.
    });
  }

  private startTimer(): void {
    this.stopTimer();
    this.timer = this.setIntervalImpl(() => {
      if (!this.activeTurnId || !this.chunker) return;
      this.enqueueChunks(this.chunker.flushDue());
    }, 250);
  }

  private stopTimer(): void {
    if (!this.timer) return;
    this.clearIntervalImpl(this.timer);
    this.timer = null;
  }

  private enqueueChunks(chunks: readonly string[]): void {
    for (const chunk of chunks) {
      this.enqueueChunk(chunk);
    }
  }

  private enqueueChunk(text: string): void {
    const turnId = this.activeTurnId;
    if (!turnId || !text.trim()) return;
    const sequence = ++this.chunkSequence;
    const abortController = new AbortController();
    this.abortControllers.add(abortController);
    const resultPromise = this.synthesize(text, turnId, sequence, abortController.signal)
      .then((result) => ({ ok: true as const, result }))
      .catch((error: unknown) => ({ ok: false as const, error }));

    this.playbackChain = this.playbackChain.then(async () => {
      if (abortController.signal.aborted) return;
      const result = await resultPromise;
      this.abortControllers.delete(abortController);
      if (!result.ok) {
        this.reportError(result.error);
        return;
      }
      await this.player.play(result.result.chunks, {
        format: String(result.result.format ?? 'mp3'),
        signal: abortController.signal,
      });
    }).catch((error: unknown) => {
      this.abortControllers.delete(abortController);
      this.reportError(error);
    });
  }

  private synthesize(text: string, turnId: string, sequence: number, signal: AbortSignal): Promise<VoiceSynthesisStreamResult> {
    // tts.speed: VoiceSynthesisRequest accepts speed (number | undefined).
    // No ConfigKey for tts.speed exists in the current SDK schema — pending
    // SDK schema addition. Speed is not threaded from config until that key
    // is added. See docs/voice-and-live-tts.md § Speed.
    return this.voiceService.synthesizeStream(readOptionalConfigString(this.configManager, 'tts.provider'), {
      text,
      voiceId: readOptionalConfigString(this.configManager, 'tts.voice'),
      format: 'mp3',
      speed: readOptionalConfigNumber(this.configManager, 'tts.speed'),
      signal,
      metadata: {
        source: 'goodvibes-tui',
        feature: 'live-tts',
        turnId,
        sequence,
      },
    });
  }

  private reportError(error: unknown): void {
    if (this.errorReportedForTurn) return;
    this.errorReportedForTurn = true;
    this.activeTurnId = null;
    this.chunker = null;
    this.stopTimer();
    for (const controller of this.abortControllers) controller.abort();
    this.abortControllers.clear();
    this.player.stop();
    this.playbackChain = Promise.resolve();
    this.notify?.(`[TTS] Live playback stopped: ${summarizeError(error)}`);
  }
}

function readOptionalConfigString(configManager: Pick<ConfigManager, 'get'>, key: ConfigKey): string | undefined {
  const value = String(configManager.get(key) ?? '').trim();
  return value || undefined;
}

/**
 * readOptionalConfigNumber — reads a numeric config value by key.
 *
 * `tts.speed` is not yet a ConfigKey in the SDK schema. This helper accepts
 * a string key and casts it, returning undefined when the value is absent,
 * zero, or not a finite positive number. Once `tts.speed` is added to the
 * SDK schema the cast can be removed and the key typed statically.
 *
 * SDK handoff note: add { key: 'tts.speed', type: 'number', default: 1,
 * description: '...' } to schema-domain-core.js and `tts: { ..., speed: 1 }`
 * to DEFAULT_CONFIG.tts to complete this feature.
 */
function readOptionalConfigNumber(configManager: Pick<ConfigManager, 'get'>, key: string): number | undefined {
  // Cast required: key is not yet a valid ConfigKey in the SDK schema.
  const raw = configManager.get(key as ConfigKey);
  const value = typeof raw === 'number' ? raw : parseFloat(String(raw ?? ''));
  return isFinite(value) && value > 0 ? value : undefined;
}
