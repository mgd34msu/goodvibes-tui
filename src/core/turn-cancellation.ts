import type { Orchestrator } from './orchestrator';
import type { SpokenTurnRuntime } from '../audio/spoken-turn-wiring.ts';

/**
 * Builds the shared "cancel the active turn" action: stops any in-flight
 * spoken output, then aborts the orchestrator's turn if one is actively
 * streaming. Extracted from main.ts so the file can stay under its 800-line
 * cap while still wiring `commandContext.isGenerating` (see W1.6 FIX 1).
 */
export function createCancelGeneration(
  orchestrator: Orchestrator,
  spokenTurns: Pick<SpokenTurnRuntime, 'stop'>,
): () => void {
  return () => {
    spokenTurns.stop('Spoken output stopped.');
    if (orchestrator.isThinking) {
      orchestrator.abort();
    }
  };
}
