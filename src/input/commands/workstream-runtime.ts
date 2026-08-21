// ---------------------------------------------------------------------------
// workstream-runtime.ts, /workstream
//
// UX over the OrchestrationEngine (@pellux/goodvibes-sdk/platform/orchestration,
//) via its command-facing facade wired onto RuntimeServices as
// `workstreamCommands` (src/runtime/workstream-services.ts) and threaded
// through CommandContext.session.workstreamEngine exactly like wrfcController
// already is (bootstrap-command-context.ts).
//
// Render precedent: TRANSCRIPT + subcommand approve (like /plan approve,
// planning-runtime.ts), NOT a panel, a multi-phase proposal is too rich for
// a one-line confirm overlay, and Pillar-3 doctrine keeps work visible in the
// transcript. create -> approve -> launch is a real three-step flow (edit and
// cancel apply to the pending proposal too). The transcript IS the plan-review
// gate: between create and approve the proposal is reshapable in place,
// edit-item rewrites one item's brief, remove-item drops an item (and unlinks
// it from siblings' dependencies), move-item reorders authoring order, and
// each re-renders the whole proposal and clears any prior approval, so nothing
// launches until the reshaped plan is explicitly re-approved. The engine's own createWorkstream
// immediately materializes a real, ticking-eligible Workstream with no
// pre-creation "draft" concept, so approval happens on a TUI-held draft
// (workstream-services.ts's WorkstreamDraft) before anything is created in
// the engine at all, see that module's header doc for the full reality-wins
// divergence from the design brief.
// ---------------------------------------------------------------------------

import { AdaptivePlanner } from '@pellux/goodvibes-sdk/platform/core';
import type { CreateWorkstreamInput, PhaseKind, PhaseRole, WorkItem, WorkItemState, Workstream, WorkstreamIsolation } from '@pellux/goodvibes-sdk/platform/orchestration';
import type { WorkstreamCommandService, WorkstreamDraft, WorkstreamDraftProvenance } from '@pellux/goodvibes-sdk/platform/orchestration';
import { validateAttempts } from '@pellux/goodvibes-sdk/platform/orchestration';
import { handleAttemptsSubcommand } from './workstream-attempts.ts';
import type { CommandContext, CommandRegistry } from '../command-registry.ts';
import { describeOperatorRpcError, getOperatorRpc } from './operator-rpc.ts';

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function shortId(id: string): string {
  return id.length > 12 ? id.slice(0, 12) : id;
}

/**
 * The engine's ONLY two terminal work-item states (mirrors the SDK's own
 * internal TERMINAL_ITEM_STATES in platform/runtime/fleet/adapters/
 * orchestration.ts and engine.ts's kill() guard, neither is exported, so
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

/** Mirrors the engine's templateForPhase (phase-runner.ts): only 'review'/'gate' phases run the general template, everything else, INCLUDING 'custom', runs the engineer template regardless of phase.role's text. */
function templateForPhaseKind(kind: PhaseKind): string {
  return kind === 'review' || kind === 'gate' ? 'general' : 'engineer';
}

/**
 * Pre-fan-out quota consultation for /workstream launch. Assesses whether the
 * draft's work-item count (the fan-out this launch is about to create, worst
 * case, items can run concurrently within a phase) is likely to exhaust the
 * active provider's quota window, grounded in observed rate-limit signals
 * (quota.fanout.get). Returns a printable warning + evidence when the daemon
 * reports 'likely-exhausts'; returns null for 'unlikely'/'unknown' (no
 * evidence of risk is not itself evidence of safety, so those verdicts never
 * block) and whenever the check itself can't run (daemon unavailable/
 * unreachable, or no active provider), an infra gap in the quota check is
 * not grounds to block launching work the operator already approved.
 */
async function checkFanoutQuotaWarning(ctx: CommandContext, draft: WorkstreamDraft): Promise<string | null> {
  const provider = ctx.session.runtime.provider;
  if (!provider) return null;
  const rpc = getOperatorRpc(ctx);
  if (!rpc.available) return null;
  const agentCount = Math.max(1, draft.proposal.workItems.length);
  const assessment = await rpc.sdk.operator.invoke('quota.fanout.get', { provider, agentCount }).catch((error: unknown) => {
    ctx.print(`[workstream launch] quota check could not run: ${describeOperatorRpcError(error)}`);
    return null;
  });
  if (!assessment || assessment.verdict !== 'likely-exhausts') return null;
  const ev = assessment.evidence;
  const evidenceParts = [
    `requested=${ev.requestedAgents}`,
    `recentRateLimitCount=${ev.recentRateLimitCount}`,
    ev.activeCooldownMs !== undefined ? `activeCooldownMs=${ev.activeCooldownMs}` : null,
    ev.observedRemaining !== undefined ? `observedRemaining=${ev.observedRemaining}` : null,
    ev.observedLimit !== undefined ? `observedLimit=${ev.observedLimit}` : null,
  ].filter((part): part is string => part !== null);
  return [
    `[workstream launch] WARNING: ${provider} likely exhausts its quota window for ${agentCount} agent(s) fanning out.`,
    `  reason: ${assessment.reason}`,
    `  evidence: ${evidenceParts.join(' ')}`,
    '',
    `Launch anyway: /workstream launch ${draft.id} --force`,
    'Cancel: do nothing; the approved proposal stays ready to launch later.',
  ].join('\n');
}

/**
 * Launch an already-approved draft through its gates (best-of-N attempt
 * validation, then the fan-out quota warning unless `--force`), and print the
 * outcome. Shared by `launch` and by `approve` (which launches in the same act
 *, the one confirmed step that replaces the old approve-then-retype ceremony).
 */
async function launchApprovedDraft(ctx: CommandContext, service: WorkstreamCommandService, id: string, draft: WorkstreamDraft, force: boolean): Promise<void> {
  const attemptsCheck = validateAttempts(draft.spec);
  if (attemptsCheck.violations.length > 0) {
    ctx.print(`Cannot launch ${id}: best-of-N plan constraints are violated:\n${attemptsCheck.violations.map((v) => `  - ${v}`).join('\n')}\nFix the plan (or drop the attempts) and re-approve.`);
    return;
  }
  if (!force) {
    const quotaWarning = await checkFanoutQuotaWarning(ctx, draft);
    if (quotaWarning) {
      ctx.print(quotaWarning);
      return;
    }
  }
  const result = service.launchDraft(id);
  if (!result) {
    ctx.print(`Could not launch ${id}.`);
    return;
  }
  ctx.print(`Launched workstream ${result.workstreamId}: track it with /workstream status ${result.workstreamId} or the Fleet panel.`);
}

/**
 * phase.role for a 'custom' phase is the free-text description passed to
 * `/workstream insert-phase`, it is purely COSMETIC. Neither
 * templateForPhase nor buildPhaseTask (phase-runner.ts, engine-side) ever
 * reads it: a custom phase always runs the engineer template against the
 * work item's own task text. Rendering it as `<kind>, <role>` like a real
 * role would falsely imply the description drives what the phase does, so
 * custom phases get an explicit "this is a description, not a role" label
 * instead.
 */
function formatPhaseLabel(phase: { readonly kind: PhaseKind; readonly role: PhaseRole }): string {
  if (phase.kind === 'custom') {
    return `custom: "${phase.role}" (runs the ${templateForPhaseKind(phase.kind)} template)`;
  }
  return `${phase.kind}: ${phase.role}`;
}

/**
 * Extracts an optional `--isolation shared|worktree` flag from anywhere in
 * `args` (create/edit both accept it ahead of, or interleaved with, the task
 * text). Returns the flag stripped out so the remaining tokens are the task
 * text exactly as before this flag existed. An unrecognized value is a hard
 * error (never silently ignored or defaulted), a typo'd isolation mode
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
 * only, see formatItemMergeState's caller). Distinct from `item.state` (the
 * pipeline verdict): an item can be terminally 'passed' while its branch is
 * still 'merge pending' in the integration lane, or stuck at
 * 'merge-conflict' with its worktree deliberately kept for inspection.
 */
function formatItemMergeState(item: WorkItem): string {
  switch (item.mergeState) {
    case 'merged':
      return item.mergeHash ? `merged ${shortId(item.mergeHash)}` : 'merged (no changes)';
    case 'conflict':
      return 'merge-conflict (worktree kept for inspection)';
    case 'pending':
      return 'merge pending';
    case 'n-a':
    default:
      return item.worktreeKept ? 'worktree kept' : 'not yet integrated';
  }
}

/**
 * Per-item dependency truth for `/workstream status` (BIG-3 item 2). A
 * dependency-blocked item shows its honest, engine-set reason verbatim
 * ('waiting on: X' or 'dependency failed: X'); an item that HAS dependencies
 * but is no longer blocked shows the static 'after: X, Y' provenance so the
 * ordering constraint stays visible even once satisfied. An item with no
 * dependencies contributes nothing.
 */
function formatItemDependencyNote(item: WorkItem, ws: Workstream): string {
  if (item.state === 'blocked-dependency' && item.blockedReason) return `  — ${item.blockedReason}`;
  if (item.dependsOn && item.dependsOn.length > 0) {
    const titleById = new Map(ws.items.map((i) => [i.id, i.title]));
    return `  — after: ${item.dependsOn.map((d) => titleById.get(d) ?? shortId(d)).join(', ')}`;
  }
  return '';
}

/**
 * Compact item + dependency graph for the draft-approval view (BIG-3 item 4):
 * items in ordinal order (the spec preserves the proposal's order), each with
 * an honest text 'after: X, Y' clause when it depends on siblings, no fake DAG
 * art. Dependency ids are resolved back to titles from the spec itself.
 */
function formatDraftItems(spec: CreateWorkstreamInput): string[] {
  const titleById = new Map(spec.items.map((it) => [it.id ?? it.title, it.title] as const));
  const lines: string[] = [];
  spec.items.forEach((it, i) => {
    const deps = it.dependsOn ?? [];
    const after = deps.length > 0 ? ` (after: ${deps.map((d) => titleById.get(d) ?? d).join(', ')})` : '';
    const attempts = (it.attempts ?? 1) > 1 ? `  [best-of-${it.attempts}${it.autoAcceptWinner ? ', auto-accept winner' : ''}]` : '';
    lines.push(`  ${i + 1}. ${it.title}${after}${attempts}`);
    // Show the brief (the instructions the item's agent runs) only when it says
    // something the title doesn't, an edited brief (via /workstream edit-item)
    // must be visible on the review surface, but a decomposition whose title and
    // brief coincide would just repeat itself.
    if (it.task.trim() && it.task.trim() !== it.title.trim()) {
      lines.push(`       brief: ${it.task.trim()}`);
    }
  });
  return lines;
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

/** The engine's own PlanProposal is deliberately not rendered as the launchable spec, see workstream-services.ts's buildSpec doc. This renders the REAL launchable spec (so the proposal and the launch are always the same plan) plus an honest provenance line describing how the goal was decomposed. */
function renderDraftProposal(draft: WorkstreamDraft): string {
  const lines: string[] = [];
  lines.push(`Workstream proposal ${draft.id}: "${draft.task}"`);
  lines.push(`Isolation: ${draft.spec.isolation ?? 'shared (default)'}`);
  lines.push(
    `Planner: strategy=${draft.gate.strategy} (${draft.gate.reasonCode}); ${AdaptivePlanner.explainReasonCode(draft.gate.reasonCode)}`,
  );
  lines.push(formatProvenance(draft.provenance));
  // Honest mapping boundary (BIG-3 item 4): a multi-item proposal launches as
  // the REAL dependency-scheduled workstream (fromPlanProposal); a single-item
  // one launches as the compat engineer→review chain (fromChainSpec). State
  // which, so the preview never overstates what launch will do.
  const multiItem = draft.spec.items.length > 1;
  lines.push(
    multiItem
      ? `Mapping: multi-item plan; ${draft.spec.items.length} items run the engineer→review pipeline, dependency-scheduled.`
      : 'Mapping: single-item compat chain (engineer→review); no multi-item structure to schedule.',
  );
  lines.push('Phases:');
  draft.spec.phases.forEach((phase, i) => {
    lines.push(`  ${i + 1}. ${formatPhaseLabel(phase)} (capacity ${phase.capacity})`);
  });
  lines.push('Work items (ordinal order):');
  lines.push(...formatDraftItems(draft.spec));
  // Best-of-N plan validation (workstream-attempts-validation.ts): surface the
  // worktree/stable-id constraint breaks here so a violating plan is visible
  // before approve, and blocked at launch. Non-leaf best-of-N (items with
  // dependents) is allowed. Notes (e.g. the engine's attempts cap) are advisory.
  const attemptsCheck = validateAttempts(draft.spec);
  if (attemptsCheck.violations.length > 0) {
    lines.push('Best-of-N: plan is INVALID and cannot launch until fixed:');
    for (const v of attemptsCheck.violations) lines.push(`  ✗ ${v}`);
  } else if (attemptsCheck.hasAttempts) {
    lines.push('Best-of-N: worktree + stable-id constraints satisfied; winners are chosen via /workstream attempts pick, and any dependents wait for the winner to be picked and merged.');
  }
  for (const n of attemptsCheck.notes) lines.push(`  note: ${n}`);
  lines.push(
    draft.approved
      ? `Approved. Launch with: /workstream launch ${draft.id}`
      : `Approve with: /workstream approve ${draft.id}`,
  );
  lines.push(`Reshape: /workstream edit-item ${draft.id} <#> <brief...> | remove-item ${draft.id} <#> | move-item ${draft.id} <#> <pos>`);
  lines.push(`Re-decompose from a new goal: /workstream edit ${draft.id} <new task...>   Discard: /workstream cancel ${draft.id}`);
  // Honest durability note (see workstream-services.ts's REALITY-WINS doc):
  // the engine has no pre-launch draft concept, but the TUI journals this
  // proposal to disk (.goodvibes/orchestration/drafts/) and reloads it at
  // startup, so it survives a restart and is here to launch afterward, its
  // approval state included.
  lines.push('Note: saved to .goodvibes/orchestration/drafts/; survives a restart until you launch or cancel it.');
  return lines.join('\n');
}

function renderWorkstreamStatus(ws: Workstream): string {
  const isolated = ws.isolation === 'worktree';
  const lines: string[] = [];
  lines.push(`Workstream ${ws.id}: "${ws.title}"`);
  lines.push(`Isolation: ${ws.isolation ?? 'shared'}`);
  // Origin provenance (BIG-3 item 1), only present on workstreams assembled
  // from a decomposition proposal; absent for compat/authored ones.
  if (ws.provenance) {
    const pv = ws.provenance;
    const bits: string[] = [];
    if (pv.decomposedBy) bits.push(`${pv.decomposedBy}-decomposed`);
    if (pv.proposalId) bits.push(`plan ${pv.proposalId}`);
    if (pv.strategy) bits.push(pv.strategy);
    if (bits.length > 0) lines.push(`Origin: ${bits.join(', ')}`);
  }
  lines.push('Phases:');
  for (const phase of ws.phases) {
    lines.push(`  [${phase.ordinal}] ${formatPhaseLabel(phase)} (capacity ${phase.capacity})`);
  }
  lines.push('Items:');
  for (const item of ws.items) {
    const mergeNote = isolated ? `  — ${formatItemMergeState(item)}` : '';
    const depNote = formatItemDependencyNote(item, ws);
    lines.push(`  ${shortId(item.id)}  [${item.state}]  ${item.title}  — phase: ${item.currentPhaseId ?? '—'}${depNote}${mergeNote}`);
  }
  if (isolated) {
    // Honest terminal-summary truth (never inferred from item.state alone,
    // an item can be terminally 'passed' with its branch still unmerged):
    // an item counts as unmerged the instant it enters the integration lane
    // (mergeState 'pending') and stays counted through a conflict or any
    // KEPT worktree, until a clean merge clears it.
    const unmerged = ws.items.filter((item) => item.mergeState === 'pending' || item.mergeState === 'conflict' || item.worktreeKept);
    lines.push(
      unmerged.length > 0
        ? `Unmerged items: ${unmerged.length} (${unmerged.map((item) => shortId(item.id)).join(', ')}); this run is NOT fully integrated yet.`
        : 'Unmerged items: none; every terminated item is merged (or had nothing to merge).',
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
 * approve/edit/launch/*-item all fail this way when `id` doesn't resolve to a
 * held draft. Drafts are now journaled to disk and reloaded at startup (see
 * renderDraftProposal's note and workstream-services.ts's REALITY-WINS doc), so
 * a restart no longer silently wipes them, a missing id is a typo or a
 * stale/already-launched proposal, and the plain message is the honest guess.
 * `service` is kept in the signature so callers stay uniform and a future
 * "did you mean <closest id>?" hint has somewhere to live.
 */
function draftNotFoundMessage(_service: WorkstreamCommandService, id: string): string {
  return `No pending proposal found: ${id}`;
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

export function registerWorkstreamRuntimeCommands(registry: CommandRegistry): void {
  registry.register({
    name: 'workstream',
    description: 'Author and oversee multi-phase agent workstreams (orchestration engine)',
    usage: 'create [--isolation shared|worktree] <task...> | list | status [id] | insert-phase <id> <description...> | edit-item <id> <item#> <brief...> | remove-item <id> <item#> | move-item <id> <item#> <pos> | approve <id> [--no-launch] [--force] | edit <id> [--isolation shared|worktree] <task...> | launch <id> [--force] | cancel <id> | attempts list|diff|judge|pick',
    argsHint: 'create [--isolation worktree] <task> | list | status [id] | edit-item | remove-item | move-item | approve | edit | launch | cancel | attempts',
    handler: async (args, ctx: CommandContext) => {
      const service = ctx.session.workstreamEngine;
      if (!service) {
        ctx.print('Workstreams are not available in this session.');
        return;
      }

      const sub = args[0];

      // Best-of-N surface: /workstream attempts list|diff|judge|pick (workstream-attempts.ts).
      if (await handleAttemptsSubcommand(ctx, service, args)) return;

      /** Thread editItem/removeItem/moveItem's tri-state result to the transcript: a missing draft gets the restart-aware not-found message, a bad reference/argument gets its honest reason, and a success re-renders the whole reshaped proposal so the review surface always shows the current plan. */
      const printItemEdit = (id: string, res: WorkstreamDraft | { error: string } | undefined): void => {
        if (res === undefined) {
          ctx.print(draftNotFoundMessage(service, id));
          return;
        }
        if ('error' in res) {
          ctx.print(res.error);
          return;
        }
        ctx.print(renderDraftProposal(res));
      };

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
            ctx.print(`Multiple workstreams running: specify one: ${live.map((ws) => shortId(ws.id)).join(', ')}`);
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
          ctx.print(`Could not insert phase: is "${id}" still an active workstream?`);
          return;
        }
        ctx.print(`Inserted phase "${description}" into ${shortId(ws.id)} after ordinal ${lastOrdinal} (new ordinal ${inserted.ordinal}).`);
        return;
      }

      if (sub === 'approve') {
        // Approve IS the one confirmed act: it approves AND launches (typing the
        // verb with an explicit id is the confirmation). --no-launch keeps the
        // old split for scripts; --force skips the fan-out quota warning.
        const noLaunch = args.includes('--no-launch');
        const force = args.includes('--force');
        const id = args.find((arg, index) => index > 0 && arg !== '--no-launch' && arg !== '--force');
        if (!id) {
          ctx.print('Usage: /workstream approve <id> [--no-launch] [--force]');
          return;
        }
        const draft = service.approveDraft(id);
        if (!draft) {
          ctx.print(draftNotFoundMessage(service, id));
          return;
        }
        if (noLaunch) {
          ctx.print(`Approved ${id} (held, not launched). Launch it with /workstream launch ${id}.`);
          return;
        }
        await launchApprovedDraft(ctx, service, id, draft, force);
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

      if (sub === 'edit-item') {
        const id = args[1];
        const itemRef = args[2];
        const brief = args.slice(3).join(' ').trim();
        if (!id || !itemRef || !brief) {
          ctx.print('Usage: /workstream edit-item <id> <item#> <new brief...>');
          return;
        }
        printItemEdit(id, service.editItem(id, itemRef, brief));
        return;
      }

      if (sub === 'remove-item') {
        const id = args[1];
        const itemRef = args[2];
        if (!id || !itemRef) {
          ctx.print('Usage: /workstream remove-item <id> <item#>');
          return;
        }
        printItemEdit(id, service.removeItem(id, itemRef));
        return;
      }

      if (sub === 'move-item') {
        const id = args[1];
        const itemRef = args[2];
        const posRaw = args[3];
        const position = Number(posRaw);
        if (!id || !itemRef || posRaw === undefined || !Number.isInteger(position)) {
          ctx.print('Usage: /workstream move-item <id> <item#> <new-position#>');
          return;
        }
        printItemEdit(id, service.moveItem(id, itemRef, position));
        return;
      }

      if (sub === 'launch') {
        const force = args.includes('--force');
        const id = args.find((arg, index) => index > 0 && arg !== '--force');
        if (!id) {
          ctx.print('Usage: /workstream launch <id> [--force]');
          return;
        }
        const draft = service.getDraft(id);
        if (!draft) {
          ctx.print(draftNotFoundMessage(service, id));
          return;
        }
        if (!draft.approved) {
          ctx.print(`Proposal ${id} is not approved yet. Run /workstream approve ${id} first (or approve launches it directly).`);
          return;
        }
        await launchApprovedDraft(ctx, service, id, draft, force);
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
        + '  /workstream edit-item <id> <item#> <new brief...>\n'
        + '  /workstream remove-item <id> <item#>\n'
        + '  /workstream move-item <id> <item#> <new-position#>\n'
        + '  /workstream approve <id> [--no-launch] [--force]   (approves AND launches in one act)\n'
        + '  /workstream edit <id> [--isolation shared|worktree] <new task...>\n'
        + '  /workstream launch <id> [--force]   (for a --no-launch-held or re-launched draft)\n'
        + '  /workstream cancel <id>',
      );
    },
  });
}
