// ---------------------------------------------------------------------------
// workstream-attempts-validation.ts — plan-format validation for best-of-N.
//
// The plan format re-enables the per-item `attempts` field (SDK WorkItem/
// WorkItemSpec.attempts — best-of-N). The engine only honors it under two hard
// constraints, so the TUI enforces them at plan validation rather than letting
// a launch silently drop the field:
//   • WORKTREE isolation. Best-of-N needs isolated worktrees to run and compare
//     the N sibling attempts; under `shared` isolation the value is ignored.
//   • LEAF item. A best-of-N item declares no dependencies and nothing depends
//     on it — the winner is chosen by an explicit pick, not the dependency graph.
// Values above the engine's MAX_ATTEMPTS (5) are clamped by the engine; the TUI
// surfaces that as a note so the preview never overstates the fan-out.
// ---------------------------------------------------------------------------

import type { CreateWorkstreamInput } from '@pellux/goodvibes-sdk/platform/orchestration';

/** The engine's hard cap on sibling attempts per work item (SDK MAX_ATTEMPTS). */
export const MAX_ATTEMPTS = 5;

export interface AttemptsValidation {
  /** True when any item requests best-of-N (attempts >= 2). */
  readonly hasAttempts: boolean;
  /** Hard rule breaks that must block a launch (leaf + worktree). */
  readonly violations: readonly string[];
  /** Non-blocking notes (e.g. an over-cap value the engine will clamp). */
  readonly notes: readonly string[];
}

function itemKey(item: CreateWorkstreamInput['items'][number]): string {
  return item.id ?? item.title;
}

/**
 * Validate a draft spec's best-of-N usage against the leaf + worktree constraints.
 * Pure — no I/O. `violations` are hard (block launch); `notes` are advisory.
 */
export function validateAttempts(spec: CreateWorkstreamInput): AttemptsValidation {
  const violations: string[] = [];
  const notes: string[] = [];
  const worktree = spec.isolation === 'worktree';

  // Which items are depended upon (so a best-of-N item that is a dependency target breaks the leaf rule).
  const dependedUpon = new Set<string>();
  for (const item of spec.items) {
    for (const dep of item.dependsOn ?? []) dependedUpon.add(dep);
  }

  let hasAttempts = false;
  for (const item of spec.items) {
    const attempts = item.attempts ?? 1;
    if (attempts < 2) continue;
    hasAttempts = true;
    const label = item.title;

    if (!worktree) {
      violations.push(`"${label}" requests ${attempts} attempts, but the workstream is not worktree-isolated — best-of-N needs isolated trees. Set --isolation worktree.`);
    }
    if ((item.dependsOn ?? []).length > 0) {
      violations.push(`"${label}" is best-of-N but declares dependencies — a best-of-N item must be a leaf (no dependencies in or out).`);
    }
    if (dependedUpon.has(itemKey(item))) {
      violations.push(`another item depends on best-of-N item "${label}" — a best-of-N item must be a leaf (nothing may depend on it; the winner is chosen by pick).`);
    }
    if (attempts > MAX_ATTEMPTS) {
      notes.push(`"${label}" requests ${attempts} attempts — the engine caps best-of-N at ${MAX_ATTEMPTS}, so ${MAX_ATTEMPTS} siblings will run.`);
    }
  }

  return { hasAttempts, violations, notes };
}
