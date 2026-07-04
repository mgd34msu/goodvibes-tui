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
import type { Workstream } from '@pellux/goodvibes-sdk/platform/orchestration';
import type { WorkstreamCommandService, WorkstreamDraft } from '../../runtime/workstream-services.ts';
import type { CommandContext, CommandRegistry } from '../command-registry.ts';

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function shortId(id: string): string {
  return id.length > 12 ? id.slice(0, 12) : id;
}

const ACTIVE_ITEM_STATES = new Set(['pending', 'awaiting-capacity', 'in-phase']);

function summarizeItemStates(ws: Workstream): string {
  const counts = new Map<string, number>();
  for (const item of ws.items) counts.set(item.state, (counts.get(item.state) ?? 0) + 1);
  return Array.from(counts.entries()).map(([state, n]) => `${n} ${state}`).join(', ') || 'no items';
}

/** The engine's own PlanProposal is deliberately not rendered — see workstream-services.ts's buildSpec doc. This renders the REAL launchable spec instead, so the proposal and the launch are always the same plan. */
function renderDraftProposal(draft: WorkstreamDraft): string {
  const lines: string[] = [];
  lines.push(`Workstream proposal ${draft.id} — "${draft.task}"`);
  lines.push(
    `Planner: strategy=${draft.gate.strategy} (${draft.gate.reasonCode}) — ${AdaptivePlanner.explainReasonCode(draft.gate.reasonCode)}`,
  );
  lines.push('Phases:');
  draft.spec.phases.forEach((phase, i) => {
    lines.push(`  ${i + 1}. ${phase.kind} — ${phase.role} (capacity ${phase.capacity})`);
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
  return lines.join('\n');
}

function renderWorkstreamStatus(ws: Workstream): string {
  const lines: string[] = [];
  lines.push(`Workstream ${ws.id} — "${ws.title}"`);
  lines.push('Phases:');
  for (const phase of ws.phases) {
    lines.push(`  [${phase.ordinal}] ${phase.kind} — ${phase.role} (capacity ${phase.capacity})`);
  }
  lines.push('Items:');
  for (const item of ws.items) {
    lines.push(`  ${shortId(item.id)}  [${item.state}]  ${item.title}  — phase: ${item.currentPhaseId ?? '—'}`);
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

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

export function registerWorkstreamRuntimeCommands(registry: CommandRegistry): void {
  registry.register({
    name: 'workstream',
    description: 'Author and oversee multi-phase agent workstreams (orchestration engine)',
    usage: 'create <task...> | list | status [id] | insert-phase <id> <description...> | approve <id> | edit <id> <task...> | launch <id> | cancel <id>',
    argsHint: 'create <task> | list | status [id] | approve | edit | launch | cancel',
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
        const task = args.slice(1).join(' ').trim();
        if (!task) {
          ctx.print('Usage: /workstream create <task...>');
          return;
        }
        const draft = service.proposeDraft(task);
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
          ctx.print(`No pending proposal found: ${id}`);
          return;
        }
        ctx.print(`Approved ${id}. Launch with: /workstream launch ${id}`);
        return;
      }

      if (sub === 'edit') {
        const id = args[1];
        const task = args.slice(2).join(' ').trim();
        if (!id || !task) {
          ctx.print('Usage: /workstream edit <id> <new task...>');
          return;
        }
        const draft = service.editDraft(id, task);
        if (!draft) {
          ctx.print(`No pending proposal found: ${id}`);
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
          ctx.print(`No pending proposal found: ${id}`);
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
        const active = ws.items.filter((item) => ACTIVE_ITEM_STATES.has(item.state));
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
        + '  /workstream create <task...>\n'
        + '  /workstream list\n'
        + '  /workstream status [id]\n'
        + '  /workstream insert-phase <id> <description...>\n'
        + '  /workstream approve <id>\n'
        + '  /workstream edit <id> <new task...>\n'
        + '  /workstream launch <id>\n'
        + '  /workstream cancel <id>',
      );
    },
  });
}
