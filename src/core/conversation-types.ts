/**
 * conversation-types.ts — shared TUI extension types for ConversationManager.
 *
 * Extracted from conversation.ts so that conversation-rendering.ts can import
 * BlockMeta without creating a circular dependency:
 *   conversation.ts ↔ conversation-rendering.ts
 *
 * Both files import from this module; conversation.ts re-exports BlockMeta for
 * backward compatibility of all existing importers.
 */

import type { BlockMeta as SdkBlockMeta } from '@pellux/goodvibes-sdk/platform/core';

/**
 * TUI extends the SDK BlockMeta with rendering position fields, plus a
 * TUI-only block type: 'tool_group' is the synthetic header block that folds
 * a run of >=2 consecutive tool-result messages under one collapsible header
 * (see conversation-tool-groups.ts). Defined as an intersection rather than
 * `interface X extends SdkBlockMeta` because TypeScript requires an extending
 * interface's members to be subtypes of the base interface's — widening the
 * `type` union that way is a compile error. Omit + intersection adds the new
 * variant without touching the SDK's published type.
 */
export type BlockMeta = Omit<SdkBlockMeta, 'type'> & {
  type: SdkBlockMeta['type'] | 'tool_group';
  /** Index of this block (increments per renderable block). */
  blockIndex: number;
  /** First rendered line index in the history buffer. */
  startLine: number;
  /** Number of rendered lines (when not collapsed). */
  lineCount: number;
  /** Stable key for collapse state persistence across rebuilds (e.g. msg_N). */
  collapseKey: string;
  /**
   * Absolute message indexes of every member of a folded tool-result group
   * (see conversation-tool-groups.ts). Present only on 'tool_group' blocks —
   * lets /expand also open each member's own collapse key in the same pass,
   * since a folded member pushes no BlockMeta of its own to toggle
   * individually while the group stays collapsed.
   */
  groupMemberIndexes?: readonly number[];
};
