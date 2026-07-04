// ---------------------------------------------------------------------------
// workstream-runtime.ts — /workstream
//
// UX over the OrchestrationEngine (@pellux/goodvibes-sdk/platform/orchestration,
// wo701/W4.1) via its command-facing facade wired onto RuntimeServices as
// `workstreamCommands` (src/runtime/workstream-services.ts) and threaded
// through CommandContext.session.workstreamEngine exactly like wrfcController
// already is (bootstrap-command-context.ts).
//
// Render precedent: TRANSCRIPT + subcommand approve (like /plan approve,
// planning-runtime.ts), NOT a panel — a multi-phase proposal is too rich for
// a one-line confirm overlay, and Pillar-3 doctrine keeps work visible in the
// transcript. create -> approve -> launch is a real three-step flow (edit and
// cancel apply to the pending proposal too): the engine's own createWorkstream
// immediately materializes a real, ticking-eligible Workstream with no
// pre-creation "draft" concept, so approval happens on a TUI-held draft
// (workstream-services.ts's WorkstreamDraft) before anything is created in
// the engine at all — see that module's header doc for the full reality-wins
// divergence from the wo703 design brief.
// ---------------------------------------------------------------------------

import { AdaptivePlanner } from '@pellux/goodvibes-sdk/platform/core';
import type { PhaseKind, PhaseRole, WorkItem, WorkItemState, Workstream, WorkstreamIsolation } from '@pellux/goodvibes-sdk/platform/orchestration';
import type { WorkstreamCommandService, WorkstreamDraft, WorkstreamDraftProvenance } from '../../runtime/workstream-services.ts';
import type { CommandContext, CommandRegistry } from '../command-registry.ts';

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function shortId(id: string): string {
  return id.length > 12 ? id.slice(0, 12) : id;
}

/**
 * The engine's ONLY two terminal work-item states (mirrors the SDK's own
 * internal TERMINAL_ITEM_STATES in platform/runtime/fleet/adapters/
 * orchestration.ts and engine.ts's kill() guard — neither is exported, so
 * this is kept in lockstep by hand). Deriving "active" as NOT-terminal
 * instead of enumerating the non-terminal states means a state this module
 * doesn't know about yet (as 'blocked-budget' once was here) is still
 * correctly treated as in-flight rather than silently falling through the
 * cancel path.
 */
const TERMINAL_ITEM_STATES = new Set<WorkItemState>(['passed', 'failed']);

function isActiveItemState(state: WorkItemState): boolean {
  return !TERMINAL_ITEM_STATES.has(state);
}

/** Mirrors the engine's templateForPhase (phase-runner.ts): only 'review'/'gate' phases run the general template — everything else, INCLUDING 'custom', runs the engineer template regardless of phase.role's text. */
function templateForPhaseKind(kind: PhaseKind): string {
  return kind === 'review' || kind === 'gate' ? 'general' : 'engineer';
}

/**
 * phase.role for a 'custom' phase is the free-text description passed to
 * `/workstream insert-phase` — it is purely COSMETIC. Neither
 * templateForPhase nor buildPhaseTask (phase-runner.ts, engine-side) ever
 * reads it: a custom phase always runs the engineer template against the
 * work item's own task text. Rendering it as `<kind> — <role>` like a real
 * role would falsely imply the description drives what the phase does, so
 * custom phases get an explicit "this is a description, not a role" label
 * instead.
 */
function formatPhaseLabel(phase: { readonly kind: PhaseKind; readonly role: PhaseRole }): string {
  if (phase.kind === 'custom') {
    return `custom: "${phase.role}" (runs the ${templateForPhaseKind(phase.kind)} template)`;
  }
  return `${phase.kind} — ${phase.role}`;
}

/**
 * Extracts an optional `--isolation shared|worktree` flag from anywhere in
 * `args` (create/edit both accept it ahead of, or interleaved with, the task
 * text). Returns the flag stripped out so the remaining tokens are the task
 * text exactly as before this flag existed. An unrecognized value is a hard
 * error (never silently ignored or defaulted) — a typo'd isolation mode
 * must never quietly launch in the wrong one.
 */
function extractIsolationFlag(args: readonly string[]): { isolation?: WorkstreamIsolation; rest: string[]; error?: string } {
  const rest: string[] = [];
  let isolation: WorkstreamIsolation | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--isolation') {
      const value = args[i + 1];
      if (value !== 'shared' && value !== 'worktree') {
        return { rest, error: `--isolation must be "shared" or "worktree" (got: ${value ?? '<nothing>'})` };
      }
      isolation = value;
      i += 1; // consume the value token too
      continue;
    }
    rest.push(args[i]!);
  }
  return { isolation, rest };
}

/**
 * Per-item merge-state text for `/workstream status` (worktree isolation
 * only — see formatItemMergeState's caller). Distinct from `item.state` (the
 * pipeline verdict): an item can be terminally 'passed' while its branch is
 * still 'merge pending' in the integration lane, or stuck at
 * 'merge-conflict' with its worktree deliberately kept for inspection.
 */
function formatItemMergeState(item: WorkItem): string {
  switch (item.mergeState) {
    case 'merged':
      return item.mergeHash ? `merged ${shortId(item.mergeHash)}` : 'merged (nothing to merge)';
    case 'conflict':
      return 'merge-conflict (worktree kept for inspection)';
    case 'pending':
      return 'merge pending';
    case 'n-a':
    default:
      return item.worktreeKept ? 'worktree kept' : 'not yet integrated';
  }
}

function summarizeItemStates(ws: Workstream): string {
  const counts = new Map<string, number>();
  for (const item of ws.items) counts.set(item.state, (counts.get(item.state) ?? 0) + 1);
  return Array.from(counts.entries()).map(([state, n]) => `${n} ${state}`).join(', ') || 'no items';
}

/**
 * Honest one-line provenance for how the goal was decomposed. Three shapes,
 * mirroring the SDK decomposition service's outcomes:
 *   - a planning agent decomposed it (with item count + cost/tokens + elapsed)
 *   - the heuristic path ran because the agent path failed (fallback + reason)
 *   - the heuristic path ran deliberately (configured, or the gate declined)
 */
function formatProvenance(p: WorkstreamDraftProvenance): string {
  if (p.kind === 'agent') {
    const bits: string[] = [`${p.itemCount} item${p.itemCount === 1 ? '' : 's'}`];
    if (p.agentCostUsd !== undefined) bits.push(`$${p.agentCostUsd.toFixed(4)}`);
    else if (p.agentTokens !== undefined) bits.push(`${p.agentTokens} tok`);
    if (p.elapsedMs !== undefined) bits.push(`${Math.round(p.elapsedMs / 1000)}s`);
    return `Decomposition: planning agent (${bits.join(', ')})`;
  }
  if (p.kind === 'fallback') {
    return `Decomposition: heuristic (agent fallback: ${p.fallbackReason ?? 'unknown'})`;
  }
  if (p.kind === 'gate-declined') {
    return 'Decomposition: heuristic (single item; planner declined to decompose)';
  }
  return 'Decomposition: heuristic (configured)';
}

/** The engine's own PlanProposal is deliberately not rendered as the launchable spec — see workstream-services.ts's buildSpec doc. This renders the REAL launchable spec (so the proposal and the launch are always the same plan) plus an honest provenance line describing how the goal was decomposed. */
function renderDraftProposal(draft: WorkstreamDraft): string {
  const lines: string[] = [];
  lines.push(`Workstream proposal ${draft.id} — "${draft.task}"`);
  lines.push(`Isolation: ${draft.spec.isolation ?? 'shared (default)'}`);
  lines.push(
    `Planner: strategy=${draft.gate.strategy} (${draft.gate.reasonCode}) — ${AdaptivePlanner.explainReasonCode(draft.gate.reasonCode)}`,
  );
  lines.push(formatProvenance(draft.provenance));
  lines.push('Phases:');
  draft.spec.phases.forEach((phase, i) => {
    lines.push(`  ${i + 1}. ${formatPhaseLabel(phase)} (capacity ${phase.capacity})`);
  });
  lines.push('Work items:');
  for (const item of draft.spec.items) {
    lines.push(`  - ${item.title}`);
  }
  lines.push(
    draft.approved
      ? `Approved. Launch with: /workstream launch ${draft.id}`
      : `Approve with: /workstream approve ${draft.id}`,
  );
  lines.push(`Edit the task: /workstream edit ${draft.id} <new task...>   Discard: /workstream cancel ${draft.id}`);
  // Honest limitation (see workstream-services.ts's REALITY-WINS doc): the
  // engine has no pre-creation draft concept, so this proposal is
  // process-lifetime, in-memory state only — never journaled like a launched
  // Workstream is. State that plainly, the same way an unsent chat draft
  // would be, rather than letting a restart silently make it vanish.
  lines.push('Note: not saved — lost if the TUI restarts before launch.');
  return lines.join('\n');
}

function renderWorkstreamStatus(ws: Workstream): string {
  const isolated = ws.isolation === 'worktree';
  const lines: string[] = [];
  lines.push(`Workstream ${ws.id} — "${ws.title}"`);
  lines.push(`Isolation: ${ws.isolation ?? 'shared'}`);
  lines.push('Phases:');
  for (const phase of ws.phases) {
    lines.push(`  [${phase.ordinal}] ${formatPhaseLabel(phase)} (capacity ${phase.capacity})`);
  }
  lines.push('Items:');
  for (const item of ws.items) {
    const mergeNote = isolated ? `  — ${formatItemMergeState(item)}` : '';
    lines.push(`  ${shortId(item.id)}  [${item.state}]  ${item.title}  — phase: ${item.currentPhaseId ?? '—'}${mergeNote}`);
  }
  if (isolated) {
    // Honest terminal-summary truth (never inferred from item.state alone —
    // an item can be terminally 'passed' with its branch still unmerged):
    // an item counts as unmerged the instant it enters the integration lane
    // (mergeState 'pending') and stays counted through a conflict or any
    // KEPT worktree, until a clean merge clears it.
    const unmerged = ws.items.filter((item) => item.mergeState === 'pending' || item.mergeState === 'conflict' || item.worktreeKept);
    lines.push(
      unmerged.length > 0
        ? `Unmerged items: ${unmerged.length} (${unmerged.map((item) => shortId(item.id)).join(', ')}) — this run is NOT fully integrated yet.`
        : 'Unmerged items: none — every terminated item is merged (or had nothing to merge).',
    );
  }
  return lines.join('\n');
}

function renderWorkstreamList(service: WorkstreamCommandService): string {
  const drafts = service.listDrafts();
  const live = service.engine.listWorkstreams();
  if (drafts.length === 0 && live.length === 0) {
    return 'No workstreams yet. Use /workstream create <task...> to propose one.';
  }
  const sections: string[] = [];
  if (drafts.length > 0) {
    const rows = drafts.map((d) => `  ${d.id}  ${d.approved ? '[approved]' : '[draft]  '}  "${d.task}"`);
    sections.push([`Pending proposals (${drafts.length}, not yet launched):`, ...rows].join('\n'));
  }
  if (live.length > 0) {
    const rows = live.map((ws) => `  ${shortId(ws.id)}  "${ws.title}"  (${ws.phases.length} phases, ${summarizeItemStates(ws)})`);
    sections.push([`Workstreams (${live.length}):`, ...rows].join('\n'));
  }
  return sections.join('\n\n');
}

function resolveWorkstream(service: WorkstreamCommandService, ref: string): Workstream | undefined {
  const exact = service.engine.getWorkstream(ref);
  if (exact) return exact;
  return service.engine.listWorkstreams().find((ws) => ws.id.startsWith(ref));
}

/**
 * approve/edit/launch all fail this way when `id` doesn't resolve to a held
 * draft. A bare "No pending proposal found" reads like a typo'd id even when
 * the real cause is that drafts are process-lifetime, in-memory-only state
 * (see renderDraftProposal's note and workstream-services.ts's REALITY-WINS
 * doc) and a TUI restart wiped every one of them. Only hint at that when the
 * service is holding zero drafts at all — with other drafts present, a typo
 * or stale id is the more honest guess and the plain message stays.
 */
function draftNotFoundMessage(service: WorkstreamCommandService, id: string): string {
  const base = `No pending proposal found: ${id}`;
  if (service.listDrafts().length > 0) return base;
  return `${base} (proposals aren't saved — a TUI restart since you created it would explain this; recreate it with /workstream create)`;
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

export function registerWorkstreamRuntimeCommands(registry: CommandRegistry): void {
  registry.register({
    name: 'workstream',
    description: 'Author and oversee multi-phase agent workstreams (orchestration engine)',
    usage: 'create [--isolation shared|worktree] <task...> | list | status [id] | insert-phase <id> <description...> | approve <id> | edit <id> [--isolation shared|worktree] <task...> | launch <id> | cancel <id>',
    argsHint: 'create [--isolation worktree] <task> | list | status [id] | approve | edit | launch | cancel',
    handler: async (args, ctx: CommandContext) => {
      const service = ctx.session.workstreamEngine;
      if (!service) {
        ctx.print('Workstreams are not available in this session.');
        return;
      }

      const sub = args[0];

      if (!sub || sub === 'list') {
        ctx.print(renderWorkstreamList(service));
        return;
      }

      if (sub === 'create') {
        const { isolation, rest, error } = extractIsolationFlag(args.slice(1));
        if (error) {
          ctx.print(`Usage: /workstream create [--isolation shared|worktree] <task...>\n${error}`);
          return;
        }
        const task = rest.join(' ').trim();
        if (!task) {
          ctx.print('Usage: /workstream create [--isolation shared|worktree] <task...>');
          return;
        }
        const draft = await service.proposeDraft(task, isolation);
        ctx.print(renderDraftProposal(draft));
        return;
      }

      if (sub === 'status') {
        const ref = args[1];
        const live = service.engine.listWorkstreams();
        const target = ref ? resolveWorkstream(service, ref) : (live.length === 1 ? live[0] : undefined);
        if (!target) {
          if (!ref && live.length > 1) {
            ctx.print(`Multiple workstreams running — specify one: ${live.map((ws) => shortId(ws.id)).join(', ')}`);
            return;
          }
          ctx.print(ref ? `No workstream found: ${ref}` : 'No workstreams running. Use /workstream list to see pending proposals.');
          return;
        }
        ctx.print(renderWorkstreamStatus(target));
        return;
      }

      if (sub === 'insert-phase') {
        const id = args[1];
        const description = args.slice(2).join(' ').trim();
        if (!id || !description) {
          ctx.print('Usage: /workstream insert-phase <id> <description...>');
          return;
        }
        const ws = resolveWorkstream(service, id);
        if (!ws) {
          ctx.print(`No workstream found: ${id}`);
          return;
        }
        const lastOrdinal = ws.phases.reduce((max, phase) => Math.max(max, phase.ordinal), 0);
        const templateGate = ws.phases.at(-1)?.gate ?? { scope: 'scoped' as const, gates: [] };
        const inserted = service.engine.insertPhase(ws.id, lastOrdinal, {
          role: description,
          capacity: 1,
          kind: 'custom',
          gate: templateGate,
        });
        if (!inserted) {
          ctx.print(`Could not insert phase — is "${id}" still an active workstream?`);
          return;
        }
        ctx.print(`Inserted phase "${description}" into ${shortId(ws.id)} after ordinal ${lastOrdinal} (new ordinal ${inserted.ordinal}).`);
        return;
      }

      if (sub === 'approve') {
        const id = args[1];
        if (!id) {
          ctx.print('Usage: /workstream approve <id>');
          return;
        }
        const draft = service.approveDraft(id);
        if (!draft) {
          ctx.print(draftNotFoundMessage(service, id));
          return;
        }
        ctx.print(`Approved ${id}. Launch with: /workstream launch ${id}`);
        return;
      }

      if (sub === 'edit') {
        const id = args[1];
        const { isolation, rest, error } = extractIsolationFlag(args.slice(2));
        if (error) {
          ctx.print(`Usage: /workstream edit <id> [--isolation shared|worktree] <new task...>\n${error}`);
          return;
        }
        const task = rest.join(' ').trim();
        if (!id || !task) {
          ctx.print('Usage: /workstream edit <id> [--isolation shared|worktree] <new task...>');
          return;
        }
        const draft = await service.editDraft(id, task, isolation);
        if (!draft) {
          ctx.print(draftNotFoundMessage(service, id));
          return;
        }
        ctx.print(renderDraftProposal(draft));
        return;
      }

      if (sub === 'launch') {
        const id = args[1];
        if (!id) {
          ctx.print('Usage: /workstream launch <id>');
          return;
        }
        const draft = service.getDraft(id);
        if (!draft) {
          ctx.print(draftNotFoundMessage(service, id));
          return;
        }
        if (!draft.approved) {
          ctx.print(`Proposal ${id} is not approved yet. Run /workstream approve ${id} first.`);
          return;
        }
        const result = service.launchDraft(id);
        if (!result) {
          ctx.print(`Could not launch ${id}.`);
          return;
        }
        ctx.print(`Launched workstream ${result.workstreamId} — track it with /workstream status ${result.workstreamId} or the Fleet panel.`);
        return;
      }

      if (sub === 'cancel') {
        const id = args[1];
        if (!id) {
          ctx.print('Usage: /workstream cancel <id>');
          return;
        }
        if (service.getDraft(id)) {
          service.removeDraft(id);
          ctx.print(`Discarded pending proposal ${id}.`);
          return;
        }
        const ws = resolveWorkstream(service, id);
        if (!ws) {
          ctx.print(`No workstream or pending proposal found: ${id}`);
          return;
        }
        const active = ws.items.filter((item) => isActiveItemState(item.state));
        let killedCount = 0;
        for (const item of active) {
          if (service.engine.kill(item.id)) killedCount++;
        }
        ctx.print(
          killedCount > 0
            ? `Cancelled ${killedCount} of ${active.length} in-flight work item(s) in ${shortId(ws.id)}.`
            : `${shortId(ws.id)} has no in-flight work items to cancel.`,
        );
        return;
      }

      ctx.print(
        'Usage:\n'
        + '  /workstream create [--isolation shared|worktree] <task...>\n'
        + '  /workstream list\n'
        + '  /workstream status [id]\n'
        + '  /workstream insert-phase <id> <description...>\n'
        + '  /workstream approve <id>\n'
        + '  /workstream edit <id> [--isolation shared|worktree] <new task...>\n'
        + '  /workstream launch <id>\n'
        + '  /workstream cancel <id>',
      );
    },
  });
}
