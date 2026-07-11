// ---------------------------------------------------------------------------
// workstream-attempts-validation.ts — plan-format validation for best-of-N.
//
// The plan format re-enables the per-item `attempts` field (SDK WorkItem/
// WorkItemSpec.attempts — best-of-N). A best-of-N item MAY be non-leaf: it may
// declare its own `dependsOn` (each sibling inherits it) and other items may
// depend on it — a dependent is held by the dependency gate until the group's
// winner is picked and merged, then resolves to that winner (SDK
// WorkItemSpec.attempts doc). The TUI enforces the engine's genuine constraints
// at plan validation rather than letting a launch silently drop the field:
//   • WORKTREE isolation. Best-of-N needs isolated worktrees to run and compare
//     the N sibling attempts; under `shared` isolation the value is ignored.
//   • STABLE id when depended upon. A dependency edge references an id, so a
//     best-of-N item that others depend on must carry a stable `id`; an
//     anonymous best-of-N item stays a leaf by construction (nothing can name it).
// Values above the engine's MAX_ATTEMPTS (5) are clamped by the engine; the TUI
// surfaces that as a note so the preview never overstates the fan-out.
// ---------------------------------------------------------------------------

import type { CreateWorkstreamInput } from '@pellux/goodvibes-sdk/platform/orchestration';

/** The engine's hard cap on sibling attempts per work item (SDK MAX_ATTEMPTS). */
export const MAX_ATTEMPTS = 5;

export interface AttemptsValidation {
  /** True when any item requests best-of-N (attempts >= 2). */
  readonly hasAttempts: boolean;
  /** Hard rule breaks that must block a launch (worktree isolation + stable id when depended upon). */
  readonly violations: readonly string[];
  /** Non-blocking notes (e.g. an over-cap value the engine will clamp). */
  readonly notes: readonly string[];
}

function itemKey(item: CreateWorkstreamInput['items'][number]): string {
  return item.id ?? item.title;
}

/**
 * Validate a draft spec's best-of-N usage against the worktree-isolation and
 * stable-id (when depended upon) constraints. Non-leaf best-of-N is allowed.
 * Pure — no I/O. `violations` are hard (block launch); `notes` are advisory.
 */
export function validateAttempts(spec: CreateWorkstreamInput): AttemptsValidation {
  const violations: string[] = [];
  const notes: string[] = [];
  const worktree = spec.isolation === 'worktree';

  // Which items are depended upon (so a best-of-N item that is a dependency
  // target can be checked for the stable-id requirement).
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
    // Non-leaf best-of-N is allowed. The only structural requirement: if other
    // items depend on this one, it must carry a stable id for the dependency
    // edge to name — an anonymous best-of-N item cannot be a dependency target.
    if (dependedUpon.has(itemKey(item)) && !item.id) {
      violations.push(`another item depends on best-of-N item "${label}", but it has no stable id — give the item an id so the dependency can resolve to the winner (an anonymous best-of-N item cannot be a dependency target).`);
    }
    if (attempts > MAX_ATTEMPTS) {
      notes.push(`"${label}" requests ${attempts} attempts — the engine caps best-of-N at ${MAX_ATTEMPTS}, so ${MAX_ATTEMPTS} siblings will run.`);
    }
  }

  return { hasAttempts, violations, notes };
}
