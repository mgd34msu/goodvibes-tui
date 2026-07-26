/**
 * conversation-render-context.ts — the inputs a transcript row render reads,
 * and the small pure derivations over them.
 *
 * Kept apart from conversation-rendering.ts (which draws) so that both the
 * drawing module and the per-row modules that hang off it can depend on the
 * SHAPE of a render without depending on each other. Every import here is
 * type-only, which is what makes this a leaf of the import graph.
 */

import type { Line } from '../types/grid.ts';
import type { BlockMeta } from './conversation-types.ts';
import type { AssistantTurnMembership } from './conversation-turn-structure.ts';
import type { SplashOptions } from '../utils/splash-lines.ts';
import type { ConfigManager } from '@pellux/goodvibes-sdk/platform/config';
import type { ConversationMessageSnapshot } from '@pellux/goodvibes-sdk/platform/core';
// SystemMessageKind imported from runtime directly to avoid cycle:
//   conversation-rendering.ts → system-message-router.ts → conversation.ts → conversation-rendering.ts
import type { SystemMessageKind } from '@/runtime/index.ts';

type Message = ConversationMessageSnapshot;

/**
 * How a tool call settled, as read from the result message it produced.
 *
 * The transcript stores a failure as content leading with `Error: ` (see the
 * SDK's ConversationManager.addToolResults), and a per-call user cancellation
 * as the more specific `Error: cancelled by user`. Reading the outcome —
 * rather than only "did a result arrive" — is what lets the CALL row show
 * ✓ / ✕ / ⊘ honestly instead of a ✓ that means nothing more than "it finished".
 */
export type ToolCallOutcome = 'ok' | 'error' | 'cancelled';

function outcomeOfToolContent(content: string): ToolCallOutcome {
  if (/^Error: cancelled by user\b/.test(content)) return 'cancelled';
  if (/^Error: /.test(content)) return 'error';
  return 'ok';
}

/**
 * Collect, per tool-call id, how that call settled — for the calls that have a
 * matching tool-result message in the given slice. A call absent from the map
 * has not run yet (e.g. it is still awaiting an approval decision) and renders
 * with the pending glyph. (item 2c.)
 */
export function collectToolCallOutcomes(messages: readonly Message[]): Map<string, ToolCallOutcome> {
  const outcomes = new Map<string, ToolCallOutcome>();
  for (const message of messages) {
    if (message.role === 'tool' && message.callId) {
      outcomes.set(message.callId, outcomeOfToolContent(message.content));
    }
  }
  return outcomes;
}

/**
 * Ids of tool calls that have a matching tool-result message — i.e. the tools
 * that actually ran, regardless of how they settled. Derived from
 * collectToolCallOutcomes so the two can never disagree about what "ran" means.
 */
export function collectCompletedToolCallIds(messages: readonly Message[]): Set<string> {
  return new Set(collectToolCallOutcomes(messages).keys());
}

export interface ConversationRenderContext {
  readonly history: {
    addLine: (line: Line) => void;
    addLines: (lines: Line[]) => void;
    getLineCount: () => number;
  };
  readonly blockRegistry: BlockMeta[];
  readonly collapseState: Map<string, boolean>;
  readonly errorLineRegistry: number[];
  /** Maps message index → SystemMessageKind for typed system messages. */
  readonly messageKindRegistry: ReadonlyMap<number, SystemMessageKind>;
  readonly configManager: ConfigManager | null;
  readonly splashOptions: SplashOptions;
  /**
   * Tool-call ids that have a corresponding tool-result message (i.e. the tool
   * actually ran). An assistant tool call whose id is NOT in this set is still
   * awaiting a decision (e.g. an approval prompt) and renders with a pending
   * glyph instead of the completed ✓. When undefined (single-message callers
   * without sibling context), every tool call renders as done — the prior
   * behaviour. (item 2c.)
   */
  readonly completedToolCallIds?: ReadonlySet<string>;
  /**
   * How each settled tool call turned out, keyed by call id (see
   * collectToolCallOutcomes). Lets a call row show ✕ for a failure and ⊘ for a
   * cancellation instead of a blanket ✓ the moment any result arrives. When
   * undefined the row falls back to completedToolCallIds' ran/not-ran split.
   */
  readonly toolCallOutcomes?: ReadonlyMap<string, ToolCallOutcome>;
  /**
   * Which assistant messages share one `● assistant` header, and what that
   * header must say (see conversation-turn-structure.ts). Keyed by absolute
   * index for every assistant message in a run AND every tool-result message
   * the run's calls produced, so a collapsed turn can hide its results too.
   * A message absent from this map (or an undefined map) renders standalone,
   * exactly as it did before turn merging.
   */
  readonly assistantTurns?: ReadonlyMap<number, AssistantTurnMembership>;
  /**
   * Live snapshot reader for a spawned agent's own conversation, used to
   * splice that agent's rows in beneath the call that spawned it (see
   * conversation-turn-structure.ts). Undefined disables nesting entirely and
   * the transcript renders exactly as it would without subagents.
   */
  readonly resolveAgentSnapshot?: (agentId: string) => readonly Message[] | null;
}

/**
 * Whether a turn's branches are hidden. Turns default to EXPANDED (unlike
 * every other collapsible block here, which defaults to collapsed): a turn
 * collapsed by default would hide the activity the transcript exists to show.
 */
export function isTurnCollapsed(
  turn: AssistantTurnMembership | undefined,
  collapseState: ReadonlyMap<string, boolean>,
): boolean {
  return turn !== undefined && (collapseState.get(turn.turnKey) ?? false);
}
