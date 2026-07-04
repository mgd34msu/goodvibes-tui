// ---------------------------------------------------------------------------
// fleet-panel-worktree-detail.ts
//
// NET-NEW helper (not moved code — it was authored here because fleet-panel.ts
// sits at the architecture check's 800-line cap, scripts/check-architecture.ts):
// a single pure helper for the Fleet panel's per-work-item detail view, so a
// new panel feature doesn't have to fight that cap inline.
// ---------------------------------------------------------------------------

import type { WorkItem } from '@pellux/goodvibes-sdk/platform/orchestration';

/**
 * Per-item worktree-isolation detail text for the Fleet panel's expanded
 * node detail (fleet-panel.ts renderDetail), or null for a shared-isolation
 * item (or any node that isn't a work item). Inferred from the item's OWN
 * fields (worktreePath/worktreeBranch/mergeState) rather than a
 * workstream-level flag — adaptWorkItem's ProcessNode.raw carries
 * `{ item, workstreamId }`, not the full Workstream, and these fields are
 * set ONLY when the owning workstream's isolation is 'worktree'
 * (engine.ts/worktree-isolation.ts, SDK), so they are a reliable
 * self-contained signal with no fleet-adapter change needed.
 */
export function formatWorkItemIsolationDetail(item: WorkItem): string | null {
  const isolated = item.worktreePath !== undefined || item.worktreeBranch !== undefined || item.mergeState !== undefined;
  if (!isolated) return null;
  switch (item.mergeState) {
    case 'merged':
      return item.mergeHash ? `worktree — merged ${item.mergeHash.slice(0, 12)}` : 'worktree — merged (nothing to merge)';
    case 'conflict':
      return 'worktree — merge-conflict (kept for inspection)';
    case 'pending':
      return 'worktree — merge pending';
    case 'n-a':
    default:
      return item.worktreeKept ? 'worktree — kept' : 'worktree — not yet integrated';
  }
}

/** `node.raw` for a 'work-item' ProcessNode is `{ item, workstreamId }` (unknown to the panel's own types) — this narrows without fleet-panel.ts needing its own WorkItem import at the call site. Non-work-item nodes (raw is undefined/some other shape) fall through to null. */
export function formatWorkItemIsolationDetailFromRaw(raw: unknown): string | null {
  const item = (raw as { item?: WorkItem } | undefined)?.item;
  return item ? formatWorkItemIsolationDetail(item) : null;
}
