/**
 * resume-repair.ts
 *
 * Session resume repair pipeline for the v2 compaction engine (v3 §4.10).
 *
 * When a session is resumed from a saved boundary commit, this pipeline
 * validates and repairs the compacted message list before it is handed
 * to the active conversation context. Repairs are non-destructive and
 * append-only — they never discard information without recording the
 * action in the repair log.
 *
 * Repair checks (in order):
 * 1. Empty message list                  → inject an empty-state handoff
 * 2. Missing user message at position 0  → prepend synthetic user message
 * 3. Context overflow (tokens > limit)   → truncate oldest messages
 * 4. Corrupt content blocks              → strip non-serialisable blocks
 */

import type { ProviderMessage } from '../../providers/interface.ts';
import { estimateTokens } from '../../core/compaction-types.ts';
import type { BoundaryCommit } from './types.ts';
import type { RepairAction, ResumeRepairResult } from './types.ts';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Maximum tokens allowed in a resumed session before overflow truncation.
 * Set conservatively at 80% of a typical 100K context window.
 */
const RESUME_MAX_TOKENS = 80_000;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Options for the resume repair pipeline.
 */
export interface ResumeRepairOptions {
  /** The boundary commit being resumed. */
  commit: BoundaryCommit;
  /** Maximum tokens allowed in the resumed session (default: RESUME_MAX_TOKENS). */
  maxTokens?: number;
}

/**
 * Runs the session resume repair pipeline on a boundary commit.
 *
 * Each check is run in sequence. If a repair is applied, the message list
 * is updated in place for the next check. All repairs are recorded with
 * their severity and description.
 *
 * @param options - Repair options.
 * @returns A ResumeRepairResult with the (possibly repaired) messages and repair log.
 */
export function runResumeRepair(options: ResumeRepairOptions): ResumeRepairResult {
  const { commit, maxTokens = RESUME_MAX_TOKENS } = options;
  const { sessionId } = commit;
  const actions: RepairAction[] = [];

  // Work on a mutable copy
  let messages: ProviderMessage[] = [...commit.messages] as ProviderMessage[];

  // ── Check 1: Empty message list ───────────────────────────────────────────
  if (messages.length === 0) {
    actions.push({
      kind: 'inject_empty_state_handoff',
      description: 'Message list was empty; injected an empty-state handoff message.',
      severity: 'warn',
    });
    messages = [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: [
              '[Session Resume — Empty State]',
              `Session ${sessionId} was resumed with no prior messages.`,
              'Starting fresh with no context.',
            ].join('\n'),
          },
        ],
      },
    ];
  }

  // ── Check 2: First message must be from 'user' ────────────────────────────
  if (messages[0].role !== 'user') {
    actions.push({
      kind: 'prepend_user_message',
      description: `First message had role '${messages[0].role}'; prepended synthetic user message.`,
      severity: 'warn',
      meta: { originalFirstRole: messages[0].role },
    });
    const synthetic: ProviderMessage = {
      role: 'user',
      content: [
        {
          type: 'text',
          text: '[Session Resume] Continuing from a prior compacted session.',
        },
      ],
    };
    messages = [synthetic, ...messages];
  }

  // ── Check 3: Overflow truncation ─────────────────────────────────────────
  let estimate = estimateTokens(JSON.stringify(messages));
  if (estimate > maxTokens) {
    const originalCount = messages.length;
    while (messages.length > 1 && estimate > maxTokens) {
      // Drop from position 1 (preserve the handoff at [0])
      messages = [messages[0], ...messages.slice(2)];
      estimate = estimateTokens(JSON.stringify(messages));
    }
    const dropped = originalCount - messages.length;
    actions.push({
      kind: 'truncate_overflow',
      description: `Token estimate exceeded limit (${estimate}/${maxTokens}); dropped ${dropped} message(s).`,
      severity: 'warn',
      meta: { originalCount, droppedCount: dropped, tokenEstimate: estimate, maxTokens },
    });
  }

  // ── Check 4: Strip non-serialisable content blocks ───────────────────────
  const strippedCount = stripNonSerializableBlocks(messages);
  if (strippedCount > 0) {
    actions.push({
      kind: 'strip_non_serializable',
      description: `Stripped ${strippedCount} non-serialisable content block(s) from resumed messages.`,
      severity: 'warn',
      meta: { strippedCount },
    });
  }

  const repaired = actions.length > 0;
  const hasFatal = actions.some((a) => a.severity === 'error');

  return {
    sessionId,
    repaired,
    actions,
    messages,
    safeToResume: !hasFatal,
    failReason: hasFatal
      ? actions.find((a) => a.severity === 'error')?.description
      : undefined,
  };
}

// ---------------------------------------------------------------------------
// Repair helpers
// ---------------------------------------------------------------------------

/**
 * Strips content blocks that cannot be safely serialised to JSON.
 *
 * Returns the count of blocks stripped.
 */
function stripNonSerializableBlocks(messages: ProviderMessage[]): number {
  let stripped = 0;
  for (const msg of messages) {
    // Check all roles for array content with non-serializable blocks
    if (!Array.isArray(msg.content)) continue;
    const before = msg.content.length;
    const filtered = msg.content.filter((block) => {
      try {
        JSON.stringify(block);
        return true;
      } catch {
        // Non-serialisable block — strip it
        return false;
      }
    });
    // Re-assign through a type-compatible user message mutation
    (msg as { content: typeof filtered }).content = filtered;
    stripped += before - filtered.length;
  }
  return stripped;
}
