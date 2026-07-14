// ---------------------------------------------------------------------------
// interaction-seams.ts — the command-context interaction seams and the memory-
// provenance UI controller, extracted from main.ts (file-size hygiene).
//
// The seams expose the in-process orchestrator's per-tool cancel and mid-turn
// queue edit/delete, the power toggle/status, and the provenance-chip drill-in
// to the command layer. The memory-provenance controller owns the "used N
// memories" chip's state (the latest turn's metadata.memory.recordIds and the
// expand flag), its per-turn capture, and its render.
// ---------------------------------------------------------------------------

import type { CommandContext } from '../input/command-registry.ts';
import type { PowerManager } from '@pellux/goodvibes-sdk/platform/power';
import type { Line } from '../types/grid.ts';
import type { ConfigManager } from '@pellux/goodvibes-sdk/platform/config';
import { createCancelToolCall, type ToolCancelOrchestrator } from '../core/turn-cancellation.ts';
import { powerSurfaceFromState } from '../core/power-status.ts';
import { memoryRecordIdsFromTurn, readMemoryShowProvenance } from '../core/memory-provenance.ts';
import { UIFactory } from '../renderer/ui-factory.ts';

/** The orchestrator surface the interaction seams need. */
export interface InteractionOrchestrator extends ToolCancelOrchestrator {
  listQueuedMessages(): ReadonlyArray<{ id: string; queuedAt: number; text: string }>;
  editQueuedMessage(id: string, text: string): boolean;
  deleteQueuedMessage(id: string): boolean;
}

export interface InteractionSeamDeps {
  readonly orchestrator: InteractionOrchestrator;
  readonly powerManager: PowerManager;
  readonly render: () => void;
  readonly notify: (message: string) => void;
  readonly getActiveToolCallId: () => string | undefined;
  readonly toggleMemoryProvenance: () => void;
}

/** Wire the per-tool cancel, queue edit/delete, power, and memory-provenance seams onto the command context. */
export function wireInteractionSeams(cc: CommandContext, deps: InteractionSeamDeps): void {
  cc.cancelToolCall = createCancelToolCall(deps.orchestrator, deps.getActiveToolCallId, () => {
    deps.notify('[Tool] Cancelled the running tool call — the turn continues.');
    deps.render();
  });
  cc.listQueuedMessages = () => deps.orchestrator.listQueuedMessages();
  cc.editQueuedMessage = (id, text) => { const ok = deps.orchestrator.editQueuedMessage(id, text); if (ok) deps.render(); return ok; };
  cc.deleteQueuedMessage = (id) => { const ok = deps.orchestrator.deleteQueuedMessage(id); if (ok) deps.render(); return ok; };
  cc.toggleMemoryProvenance = deps.toggleMemoryProvenance;
  cc.getPowerState = () => powerSurfaceFromState(deps.powerManager.getState());
  cc.setKeepAwake = async (enabled) => { const next = powerSurfaceFromState(await deps.powerManager.setKeepAwake(enabled)); deps.render(); return next; };
}

/** The memory-provenance chip UI: per-turn capture, drill-in state, and render. */
export interface MemoryProvenanceUi {
  /** Toggle the drill-in expand state (Alt+M). */
  toggle(): void;
  /** Capture the memory record ids from a completed turn's payload (metadata.memory.recordIds). */
  onTurnCompleted(evt: unknown): void;
  /** The chip lines for the current turn — empty when the setting is off or the turn used no memories. */
  renderChip(width: number, configManager: Pick<ConfigManager, 'get'>): Line[];
}

/** Create the memory-provenance chip controller (default OFF; reads nothing when off). */
export function createMemoryProvenanceUi(deps: { readonly render: () => void }): MemoryProvenanceUi {
  let latestRecordIds: readonly string[] = [];
  let expanded = false;
  return {
    toggle() { expanded = !expanded; deps.render(); },
    onTurnCompleted(evt) { latestRecordIds = memoryRecordIdsFromTurn(evt); expanded = false; },
    renderChip(width, configManager) {
      if (!readMemoryShowProvenance(configManager) || latestRecordIds.length === 0) return [];
      return UIFactory.createMemoryProvenanceChip(width, latestRecordIds.length, latestRecordIds, expanded);
    },
  };
}
