/**
 * rewind-receipt.ts — transcript rendering for an applied unified rewind.
 *
 * The SDK's UnifiedRewindService returns a RewindReceipt from rewind.apply (and
 * emits a matching REWIND_APPLIED workspace event). This module turns that
 * receipt into a distinct, multi-line `[Rewind]` block, mirroring the
 * `[Compaction]` receipt (compaction-receipt.ts) so a rewind is never a silent
 * mutation of files or conversation history — the transcript records exactly
 * what was restored and whether it can be reversed.
 *
 * The `[Rewind]` prefix is one of the FORCE_CONVERSATION_PREFIXES the
 * system-message router always surfaces inline (see core/system-message-router.ts),
 * so the receipt cannot be routed into a panel and vanish.
 */

/** The subset of the SDK's RewindReceipt this formatter renders. */
export interface RewindReceiptInput {
  readonly scope: 'files' | 'conversation' | 'both';
  readonly turnId: string | null;
  readonly files: {
    readonly restored: boolean;
    readonly restoredFileCount: number;
    readonly removedFileCount: number;
    readonly safetyCheckpointId: string | null;
  } | null;
  readonly conversation: {
    readonly rewound: boolean;
    readonly droppedMessages: number;
    readonly undoSnapshotId: string | null;
  } | null;
  readonly undoAvailable: boolean;
  readonly warnings: readonly string[];
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/** Short, human turn reference for the receipt heading. */
function describeAnchor(turnId: string | null): string {
  return turnId ? `turn ${turnId.length > 12 ? `${turnId.slice(0, 12)}…` : turnId}` : 'the most recent checkpoint';
}

/**
 * Build the distinct multi-line `[Rewind]` receipt block. Pure — no state, no
 * I/O. Lines after the header are indented two spaces so the transcript renders
 * them as one grouped block under the `[Rewind] Receipt` heading.
 */
export function buildRewindReceiptBlock(receipt: RewindReceiptInput): string {
  const lines: string[] = [];
  lines.push(`[Rewind] Receipt — rewound ${receipt.scope} to ${describeAnchor(receipt.turnId)}.`);

  if (receipt.files) {
    if (receipt.files.restored) {
      lines.push(
        `  Files: restored ${plural(receipt.files.restoredFileCount, 'file')}, ` +
        `removed ${plural(receipt.files.removedFileCount, 'file')}.`,
      );
    } else {
      lines.push('  Files: not restored — no workspace checkpoint matched this anchor.');
    }
  }

  if (receipt.conversation) {
    if (receipt.conversation.rewound) {
      lines.push(`  Conversation: dropped ${plural(receipt.conversation.droppedMessages, 'message')} after this turn.`);
    } else {
      lines.push('  Conversation: not rewound — no conversation boundary was recorded for this anchor.');
    }
  }

  lines.push(
    receipt.undoAvailable
      ? '  Reversible: run /undo rewind to restore the pre-rewind state (/redo rewind re-applies).'
      : '  Reversible: no undo point was recorded for this rewind.',
  );

  for (const warning of receipt.warnings) {
    lines.push(`  note: ${warning}`);
  }

  return lines.join('\n');
}
