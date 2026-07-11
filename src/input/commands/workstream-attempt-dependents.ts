// ---------------------------------------------------------------------------
// workstream-attempt-dependents.ts — held-dependent rendering for non-leaf
// best-of-N groups.
//
// A best-of-N item may be NON-LEAF: other items can depend on it. The scheduler
// holds each such dependent until the group's winner is picked AND merged, then
// resolves the dependency to that winner (SDK scheduler.ts attemptGroup
// DependencyStatus). This module mirrors that status computation as a pure
// function so the /workstream attempts surface can show, honestly, which
// dependents are held/waiting/released for a group — and reflect the losing
// attempts' cleanup that the winner pick performs.
// ---------------------------------------------------------------------------

/** Minimal structural view of a WorkItem needed to compute group + dependent status. */
export interface AttemptGraphItem {
  readonly id: string;
  readonly title: string;
  readonly dependsOn?: readonly string[] | undefined;
  readonly state: string;
  readonly attemptSourceId?: string | undefined;
  readonly attemptWinner?: boolean | undefined;
  readonly mergeState?: string | undefined;
}

export type AttemptGroupDependencyStatus = 'waiting' | 'satisfied' | 'failed' | 'not-a-group';

/**
 * Mirror of the SDK scheduler's attemptGroupDependencyStatus: resolve a
 * best-of-N source id to the status of its sibling group.
 *   - a picked winner that has merged   → 'satisfied' (dependents release)
 *   - a picked winner not yet merged     → 'waiting'
 *   - no winner but some sibling alive   → 'waiting'
 *   - every sibling failed               → 'failed'
 */
export function attemptGroupDependencyStatus(
  items: readonly AttemptGraphItem[],
  sourceId: string,
): AttemptGroupDependencyStatus {
  const siblings = items.filter((i) => i.attemptSourceId === sourceId);
  if (siblings.length === 0) return 'not-a-group';
  const winner = siblings.find((s) => s.attemptWinner === true);
  if (winner) return winner.mergeState === 'merged' ? 'satisfied' : 'waiting';
  const anyNonFailed = siblings.some((s) => s.state !== 'failed');
  return anyNonFailed ? 'waiting' : 'failed';
}

/** The best-of-N source id for a group, resolved from any of its candidate item ids. */
export function resolveGroupSourceId(
  items: readonly AttemptGraphItem[],
  candidateItemIds: readonly string[],
): string | null {
  for (const id of candidateItemIds) {
    const sourceId = items.find((i) => i.id === id)?.attemptSourceId;
    if (sourceId) return sourceId;
  }
  return null;
}

/** One dependent held by a best-of-N group, with the honest hold descriptor. */
export interface DependentHold {
  readonly title: string;
  readonly descriptor: string;
}

function holdDescriptor(status: AttemptGroupDependencyStatus): string {
  switch (status) {
    case 'satisfied':
      return 'released — the winner was picked and merged';
    case 'failed':
      return 'blocked — every attempt in the group failed';
    default:
      return 'held until the winner is picked and merged';
  }
}

/** Dependents held by a group's source, each tagged with the group's hold status. */
export function dependentsHeldByGroup(
  items: readonly AttemptGraphItem[],
  sourceId: string | null,
): DependentHold[] {
  if (!sourceId) return [];
  const status = attemptGroupDependencyStatus(items, sourceId);
  const descriptor = holdDescriptor(status);
  return items
    .filter((i) => (i.dependsOn ?? []).includes(sourceId))
    .map((d) => ({ title: d.title, descriptor }));
}

/**
 * Render the dependent-hold block for a best-of-N group. Empty for a leaf group
 * (no dependents) so leaf best-of-N output is unchanged.
 */
export function renderDependentHoldLines(
  items: readonly AttemptGraphItem[],
  candidateItemIds: readonly string[],
): string[] {
  const sourceId = resolveGroupSourceId(items, candidateItemIds);
  const holds = dependentsHeldByGroup(items, sourceId);
  if (holds.length === 0) return [];
  const lines = [`    ${holds.length} dependent(s) ${holds[0]!.descriptor}:`];
  for (const h of holds) lines.push(`      - "${h.title}"`);
  return lines;
}
