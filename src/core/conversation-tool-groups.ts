/**
 * conversation-tool-groups.ts — detects runs of consecutive tool-result
 * messages that belong to one assistant turn, so the transcript can fold them
 * under a single collapsible group header instead of rendering one
 * "tool result" header per call. Before this module, an assistant turn with
 * N tool calls produced N independent header+body blocks in a row — visual
 * spam once N is more than one or two.
 *
 * A run only counts as a group when it has >= 2 matched tool-result messages:
 * a single result renders exactly as it always has (see
 * renderConversationToolMessage in conversation-rendering.ts, which only
 * consults this module's output when a membership entry exists).
 *
 * Pure function of the message slice — no rendering, no width, no side
 * effects. Called once per render pass (appendConversationMessages /
 * MessageLineCache.renderInto) over the currently-visible message slice, with
 * the absolute index of the slice's first message so group keys and member
 * indexes line up with the same collapseKey / blockRegistry indices a cold
 * render would produce (messages may be a post-clearDisplay slice, not the
 * full snapshot — see appendConversationMessages's msgIndexOffset doc).
 */

import type { ConversationMessageSnapshot } from '@pellux/goodvibes-sdk/platform/core';
import { renderExpandedToolResultLines } from '../renderer/tool-result-expanded-lines.ts';

type Message = ConversationMessageSnapshot;

/** One consolidated run of tool-result messages sharing one assistant turn. */
export interface ToolGroup {
  /** Absolute index of the assistant message that owns this group. */
  readonly assistantIdx: number;
  /** Absolute indexes of the matched tool-result messages, in order. */
  readonly toolMessageIndexes: readonly number[];
}

/**
 * Per-tool-message membership, keyed by the ABSOLUTE index of the tool-result
 * message (the owning assistant message is never a key — only its tool-result
 * children are). `isFirst` marks the member whose render site owns the
 * group's header line and BlockMeta; every other member renders nothing while
 * the group is collapsed (see renderConversationToolMessage).
 */
export interface ToolGroupMembership {
  readonly groupKey: string;
  readonly isFirst: boolean;
  /** Matched tool-result messages in the group (the header's "N tools"). */
  readonly toolCount: number;
  /** Sum of each member's EXPANDED render line count (the header's "N lines") —
   *  the same post-render count each member's own "N lines" badge shows, so
   *  the group total matches what expanding every member actually reveals,
   *  not a raw-content estimate (a folded JSON result can pretty-print to far
   *  more lines than its raw content has). */
  readonly totalLines: number;
  /** Each member's tool name, in order (falls back to 'tool' when a result
   *  carries no name) — the header dedupes these into e.g. "read×3 exec". */
  readonly toolNames: readonly string[];
  /**
   * Absolute indexes of every tool-result message in the group, in order —
   * the same list for every member. Carried onto the group's BlockMeta so a
   * single expand pass can also open each member's own collapse key
   * (`msg_<idx>`), since a folded member pushes no BlockMeta of its own to
   * toggle individually (see local-runtime.ts's toggleBlocks).
   */
  readonly memberIndexes: readonly number[];
}

/**
 * Scan `messages` for assistant-message runs of >=2 consecutive matching
 * tool-result messages. A run breaks on the first message that isn't a
 * matching tool result: any non-tool message (interleaved user/system/
 * assistant content), or a tool message whose callId isn't one of the
 * assistant's own toolCalls ids (a result belonging to a different turn never
 * gets folded into a group it doesn't belong to).
 */
export function detectToolGroups(
  messages: readonly Message[],
  indexOffset = 0,
): ToolGroup[] {
  const groups: ToolGroup[] = [];

  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    if (message.role !== 'assistant' || !message.toolCalls || message.toolCalls.length === 0) continue;
    const callIds = new Set(
      message.toolCalls
        .map((tc) => tc.id)
        .filter((id): id is string => id !== undefined),
    );
    if (callIds.size === 0) continue;

    const toolMessageIndexes: number[] = [];
    let j = i + 1;
    while (j < messages.length) {
      const next = messages[j];
      if (next.role !== 'tool' || !next.callId || !callIds.has(next.callId)) break;
      toolMessageIndexes.push(indexOffset + j);
      j++;
    }

    if (toolMessageIndexes.length >= 2) {
      groups.push({ assistantIdx: indexOffset + i, toolMessageIndexes });
    }
  }

  return groups;
}

/** Build the per-tool-message membership lookup used by the renderer/cache.
 *  `width` must match the width the transcript is actually rendered at — it
 *  feeds the same expanded-render line count each member's own badge uses
 *  (see renderExpandedToolResultLines), so the group total is never computed
 *  against a different width than what the member badges show. */
export function buildToolGroupMembership(
  groups: readonly ToolGroup[],
  messages: readonly Message[],
  indexOffset: number,
  width: number,
): ReadonlyMap<number, ToolGroupMembership> {
  const membership = new Map<number, ToolGroupMembership>();
  for (const group of groups) {
    const groupKey = `group_${group.assistantIdx}`;
    let totalLines = 0;
    const toolNames: string[] = [];
    for (const absIdx of group.toolMessageIndexes) {
      const message = messages[absIdx - indexOffset];
      if (message && message.role === 'tool') {
        totalLines += renderExpandedToolResultLines(message.content, width).length;
        toolNames.push(message.toolName ?? 'tool');
      }
    }
    group.toolMessageIndexes.forEach((absIdx, idx) => {
      membership.set(absIdx, {
        groupKey,
        isFirst: idx === 0,
        toolCount: group.toolMessageIndexes.length,
        totalLines,
        toolNames,
        memberIndexes: group.toolMessageIndexes,
      });
    });
  }
  return membership;
}

/** Convenience wrapper: detect groups, then build the membership map in one call. */
export function computeToolGroupMembership(
  messages: readonly Message[],
  indexOffset = 0,
  width = 80,
): ReadonlyMap<number, ToolGroupMembership> {
  return buildToolGroupMembership(detectToolGroups(messages, indexOffset), messages, indexOffset, width);
}
