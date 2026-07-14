// ---------------------------------------------------------------------------
// consolidation-receipt.ts — the one-line notice for an idle-time memory
// consolidation run.
//
// The SDK's MemoryConsolidationScheduler runs at idle and produces a
// MemoryConsolidationRunReceipt (merged / archived / decayed / proposed). This
// formats it into the same one-line shape every other attach-time receipt
// uses, so a run that changed something surfaces on the next attach like a
// crash/update/migration receipt. A pure no-op run yields null — no noise.
// ---------------------------------------------------------------------------

import type { MemoryConsolidationRunReceipt } from '@pellux/goodvibes-sdk/platform/state';

/**
 * A one-line receipt for a consolidation run that changed something, or null
 * when the run merged/archived/decayed/proposed nothing (a quiet idle pass —
 * no notice, matching the check-in "stayed quiet" discipline).
 */
export function formatConsolidationReceipt(receipt: MemoryConsolidationRunReceipt): string | null {
  const merged = receipt.merged.length;
  const archived = receipt.archived.length;
  const decayed = receipt.decayed.length;
  const proposed = receipt.proposed.length;
  if (merged + archived + decayed + proposed === 0) return null;
  const parts: string[] = [];
  if (merged) parts.push(`${merged} merged`);
  if (archived) parts.push(`${archived} archived`);
  if (decayed) parts.push(`${decayed} decayed`);
  if (proposed) parts.push(`${proposed} proposed`);
  return `Memory consolidation: ${parts.join(', ')} (scanned ${receipt.scanned}).`;
}
