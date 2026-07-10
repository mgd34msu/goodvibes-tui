/**
 * Post-compaction receipt rendering.
 *
 * The SDK emits a mandatory COMPACTION_RECEIPT event after every automatic (and
 * the manual) compaction path, so a compaction is never silent. This module
 * turns that receipt into a distinct, multi-line `[Compaction]` block for the
 * transcript. It is a pure formatter — no state, no I/O — so it is unit-testable
 * and the wiring layer only has to route the returned string.
 *
 * Why a visible receipt: automatic behavior (the orchestrator's post-turn
 * auto-compaction) previously ran without any transcript trace. The receipt
 * makes the audit trail visible: what was compacted, the quality the guard
 * computed, whether the standing-instruction chain was re-injected, and the
 * outcome — applied, kept-original (quality guard rejected it), or failed.
 *
 * The `[Compaction]` prefix is one of the FORCE_CONVERSATION_PREFIXES the
 * system-message router always surfaces inline (see system-message-router.ts),
 * so the receipt cannot be routed away into a panel and vanish.
 */

/** The shape of the SDK's COMPACTION_RECEIPT event payload we render from. */
export interface CompactionReceiptInput {
  readonly trigger: 'auto' | 'manual';
  readonly strategy: string;
  readonly tokensBefore: number;
  readonly tokensAfter: number;
  readonly messagesBefore: number;
  readonly messagesAfter: number;
  readonly qualityScore: number;
  readonly qualityGrade: string;
  readonly lowQuality: boolean;
  readonly instructionsReinjected: boolean;
  readonly validationPassed: boolean;
  readonly outcome: 'applied' | 'kept-original' | 'failed';
  readonly detail?: string | undefined;
}

function fmtN(n: number): string {
  return Math.max(0, Math.round(n)).toLocaleString();
}

/** Human-readable outcome clause naming exactly what happened. */
function describeOutcome(outcome: CompactionReceiptInput['outcome']): string {
  switch (outcome) {
    case 'applied':
      return 'applied — compacted context committed';
    case 'kept-original':
      return 'kept original — quality guard rejected the summary, conversation retained';
    case 'failed':
      return 'failed — compaction did not produce a usable result';
    default:
      return outcome;
  }
}

/**
 * Build the distinct multi-line receipt block. Lines after the header are
 * indented two spaces so the transcript renders them as one grouped block under
 * the `[Compaction] Receipt` heading.
 */
export function buildCompactionReceiptBlock(receipt: CompactionReceiptInput): string {
  const triggerWord = receipt.trigger === 'auto' ? 'Automatic' : 'Manual';
  const savings = Math.max(0, receipt.tokensBefore - receipt.tokensAfter);
  const savingsPct = receipt.tokensBefore > 0
    ? Math.round((savings / receipt.tokensBefore) * 100)
    : 0;

  const lines: string[] = [];
  lines.push(`[Compaction] Receipt — ${triggerWord.toLowerCase()} compaction, outcome: ${describeOutcome(receipt.outcome)}`);

  // Only report the size delta when the summary was actually applied; on
  // kept-original / failed the "after" counts describe the retained original,
  // so a savings figure would be misleading.
  if (receipt.outcome === 'applied') {
    lines.push(
      `  ${receipt.messagesBefore} → ${receipt.messagesAfter} messages, ` +
      `~${fmtN(receipt.tokensBefore)} → ~${fmtN(receipt.tokensAfter)} tokens ` +
      `(saved ~${fmtN(savings)}, ${savingsPct}%).`,
    );
  } else {
    lines.push(`  Context retained at ~${fmtN(receipt.tokensBefore)} tokens across ${receipt.messagesBefore} messages.`);
  }

  const gradeStr = receipt.qualityGrade ? `${receipt.qualityGrade} ` : '';
  const qualitySuffix = receipt.lowQuality ? ' (below the quality bar)' : '';
  lines.push(`  Quality: ${gradeStr}${Math.round(receipt.qualityScore)}/100${qualitySuffix} · strategy: ${receipt.strategy || 'unknown'}.`);

  const reinjected = receipt.instructionsReinjected ? 'standing instructions re-injected' : 'no standing instructions to re-inject';
  const validated = receipt.validationPassed ? 'validation passed' : 'validation did NOT pass';
  lines.push(`  ${reinjected}; ${validated}.`);

  if (receipt.detail && receipt.detail.trim().length > 0) {
    lines.push(`  ${receipt.detail.trim()}`);
  }

  return lines.join('\n');
}
