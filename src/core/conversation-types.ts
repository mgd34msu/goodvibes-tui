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

/** TUI extends the SDK BlockMeta with rendering position fields. */
export interface BlockMeta extends SdkBlockMeta {
  /** Index of this block (increments per renderable block). */
  blockIndex: number;
  /** First rendered line index in the history buffer. */
  startLine: number;
  /** Number of rendered lines (when not collapsed). */
  lineCount: number;
  /** Stable key for collapse state persistence across rebuilds (e.g. msg_N). */
  collapseKey: string;
}
