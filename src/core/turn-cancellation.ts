import type { Orchestrator } from '@pellux/goodvibes-sdk/platform/core';
import type { SpokenTurnRuntime } from '../audio/spoken-turn-wiring.ts';

/**
 * Builds the shared "cancel the active turn" action: stops any in-flight
 * spoken output, then aborts the orchestrator's turn if one is actively
 * streaming. Extracted from main.ts so the file can stay under its 800-line
 * cap while still wiring `commandContext.isGenerating` (see FIX 1).
 *
 * Returns whether SPEECH was actively stopped — a Ctrl+C that silenced live
 * TTS is consumed by that job (an earlier replay fix), same as a press that
 * cleared a non-empty prompt; the quit chord starts from a quiet state.
 */
export function createCancelGeneration(
  orchestrator: Orchestrator,
  spokenTurns: Pick<SpokenTurnRuntime, 'stop'>,
): () => boolean {
  return () => {
    const stoppedSpeech = spokenTurns.stop('Spoken output stopped.');
    if (orchestrator.isThinking) {
      orchestrator.abort();
    }
    return stoppedSpeech;
  };
}

/** The narrow orchestrator surface the per-tool cancel needs. */
export interface ToolCancelOrchestrator {
  /** Cancel ONE in-flight tool call; false when no such call is running. */
  cancelToolCall(callId: string): boolean;
  /** The callIds of tool calls currently in flight. */
  listRunningToolCalls(): readonly string[];
}

/**
 * Builds the "cancel the running tool call" action: stops JUST the currently-
 * running tool call, leaving the turn to continue. The in-process orchestrator
 * holds the per-call AbortController — this is the local-session equivalent of
 * the sessions.toolCalls.cancel wire verb. The cancelled call settles as a
 * structured "cancelled by user" result (partial output preserved) the model
 * adapts to in the same turn.
 *
 * Target selection is honest: the tracked active callId (the live transcript
 * row) when known, else the sole in-flight call when exactly one is running,
 * else nothing (returns false — never guesses which of several to stop).
 * `onCancelled` fires only on a real cancellation, with the callId stopped.
 */
export function createCancelToolCall(
  orchestrator: ToolCancelOrchestrator,
  getActiveToolCallId: () => string | undefined,
  onCancelled: (callId: string) => void,
): () => boolean {
  return () => {
    let target = getActiveToolCallId();
    if (target === undefined) {
      const running = orchestrator.listRunningToolCalls();
      if (running.length === 1) target = running[0];
    }
    if (target === undefined) return false;
    const cancelled = orchestrator.cancelToolCall(target);
    if (cancelled) onCancelled(target);
    return cancelled;
  };
}
