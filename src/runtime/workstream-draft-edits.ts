// ---------------------------------------------------------------------------
// workstream-draft-edits.ts — pure item edits for a not-yet-launched proposal
//
// The plan-review gate (see /workstream, input/commands/workstream-runtime.ts)
// lets a human reshape a decomposed proposal BEFORE anything is spent: rewrite
// one item's brief, drop an item, or reorder items. These are pure functions
// over the launchable CreateWorkstreamInput (@pellux/goodvibes-sdk/platform/
// orchestration) — no engine calls, no I/O — so the same spec that is edited
// here is byte-for-byte what launch hands createWorkstream. Extracted from
// workstream-services.ts to keep that construction module lean (its own
// header explains the 800-line-cap discipline) and to give the edits a clean
// unit-test target.
//
// HONEST SCOPE (stated so the review surface never overstates what an edit
// does):
//   - editItemBrief rewrites an item's `task` (the instructions its agent
//     runs), never its `title` (the short label). The engineer/review phase
//     template is unchanged — a brief is WHAT the item does, not HOW the
//     pipeline runs it.
//   - removeItem also strips the removed item's id from every other item's
//     `dependsOn`, so the spec never carries a dangling dependency into
//     fromPlanProposal's assembly (which would otherwise reject it). It
//     refuses to remove the last item — a workstream needs at least one.
//   - moveItem reorders the AUTHORING order (the ordinals shown in the review
//     and the tie-break when the engine has a free capacity slot and several
//     claimable items). It never rewrites dependencies, so it cannot create a
//     cycle; the engine still schedules strictly by dependency + capacity, not
//     by array position. Reordering is a presentation/authoring act, not a
//     scheduling override — and is documented as such where it is offered.
// ---------------------------------------------------------------------------

import type { CreateWorkstreamInput, WorkItemSpec } from '@pellux/goodvibes-sdk/platform/orchestration';

/** Success carries the rewritten spec; failure carries an honest, user-facing reason. */
export type DraftEditResult = { readonly spec: CreateWorkstreamInput } | { readonly error: string };

/**
 * Resolve a user-typed item reference to a 0-based index. A reference is
 * either the 1-based ordinal shown in the proposal (the primary handle) or an
 * item id / unique id-prefix (the stable handle that survives reordering). An
 * ambiguous or unmatched reference resolves to undefined so the caller can
 * refuse honestly rather than editing the wrong item.
 */
export function resolveItemIndex(items: readonly WorkItemSpec[], ref: string): number | undefined {
  const trimmed = ref.trim();
  const ordinal = Number(trimmed);
  if (Number.isInteger(ordinal) && ordinal >= 1 && ordinal <= items.length) return ordinal - 1;
  const matches = items
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => item.id !== undefined && item.id.startsWith(trimmed));
  return matches.length === 1 ? matches[0]!.index : undefined;
}

function unresolvedError(items: readonly WorkItemSpec[], ref: string): string {
  return `No draft item matches "${ref}". Use a number from 1 to ${items.length}, or an item id.`;
}

/** Rewrite one item's brief (its `task`). Empty/whitespace briefs are refused. */
export function editItemBrief(spec: CreateWorkstreamInput, ref: string, brief: string): DraftEditResult {
  const index = resolveItemIndex(spec.items, ref);
  if (index === undefined) return { error: unresolvedError(spec.items, ref) };
  const trimmed = brief.trim();
  if (!trimmed) return { error: 'A new brief cannot be empty.' };
  const items = spec.items.map((item, i) => (i === index ? { ...item, task: trimmed } : item));
  return { spec: { ...spec, items } };
}

/** Drop one item and strip its id from every sibling's dependsOn. Refuses to empty the plan. */
export function removeItemFromSpec(spec: CreateWorkstreamInput, ref: string): DraftEditResult {
  const index = resolveItemIndex(spec.items, ref);
  if (index === undefined) return { error: unresolvedError(spec.items, ref) };
  if (spec.items.length <= 1) return { error: 'Cannot remove the last item — a workstream needs at least one.' };
  const removedId = spec.items[index]!.id;
  const items = spec.items
    .filter((_, i) => i !== index)
    .map((item) =>
      removedId && item.dependsOn?.includes(removedId)
        ? { ...item, dependsOn: item.dependsOn.filter((dep) => dep !== removedId) }
        : item,
    );
  return { spec: { ...spec, items } };
}

/** Reorder one item to a new 1-based authoring position. Never touches dependencies. */
export function moveItemInSpec(spec: CreateWorkstreamInput, ref: string, toPosition: number): DraftEditResult {
  const index = resolveItemIndex(spec.items, ref);
  if (index === undefined) return { error: unresolvedError(spec.items, ref) };
  if (!Number.isInteger(toPosition) || toPosition < 1 || toPosition > spec.items.length) {
    return { error: `Position must be a whole number from 1 to ${spec.items.length}.` };
  }
  const items = [...spec.items];
  const [moved] = items.splice(index, 1);
  items.splice(toPosition - 1, 0, moved!);
  return { spec: { ...spec, items } };
}
