// ---------------------------------------------------------------------------
// workstream-attempts.ts — the /workstream attempts surface for best-of-N.
//
// The engine runs a best-of-N work item as N sibling attempts in isolated
// worktrees and HOLDS the merge, exposing the candidates for a winner pick
// (orchestration engine.listHeldMergeGroups / proposeAttemptWinner /
// pickAttemptWinner — the same seam the fleet.attempts.* gateway verbs use).
// This module drives that seam from the /workstream command:
//   • list             — the held-merge groups awaiting a pick, with candidates.
//   • diff <c>         — one candidate's worktree diff in the existing DiffPanel.
//   • judge            — the OPTIONAL model proposal, clearly labelled a model
//                        judgment (scoredBy 'model'), with its reasons; never a pick.
//   • pick <c>         — behind a DiffPanel confirm; merges the winner and lets
//                        the engine clean the losers, then renders the receipt.
// ---------------------------------------------------------------------------

import type {
  AttemptCandidate,
  AttemptJudgment,
  AttemptPickResult,
  HeldMergeGroup,
} from '@pellux/goodvibes-sdk/platform/orchestration';
import { AttemptError } from '@pellux/goodvibes-sdk/platform/orchestration';
import { summarizeError } from '@pellux/goodvibes-sdk/platform/utils';
import type { CommandContext } from '../command-registry.ts';
import type { WorkstreamCommandService } from '../../runtime/workstream-services.ts';
import { requirePanelManager } from './runtime-services.ts';

function shortId(id: string): string {
  return id.length > 10 ? `${id.slice(0, 10)}…` : id;
}

/** Resolve a group by exact id or unambiguous id prefix. */
function resolveGroup(groups: readonly HeldMergeGroup[], ref: string): HeldMergeGroup | { error: string } {
  const exact = groups.find((g) => g.groupId === ref);
  if (exact) return exact;
  const prefix = groups.filter((g) => g.groupId.startsWith(ref));
  if (prefix.length === 1) return prefix[0]!;
  if (prefix.length > 1) return { error: `Group ref "${ref}" is ambiguous (${prefix.length} matches). Use the full id.` };
  return { error: `No held-merge group found: ${ref}. Run /workstream attempts list.` };
}

/** Resolve a candidate within a group by 1-based attempt number or itemId (prefix). */
function resolveCandidate(group: HeldMergeGroup, ref: string): AttemptCandidate | { error: string } {
  if (/^\d+$/.test(ref)) {
    const cand = group.candidates.find((c) => c.attemptIndex + 1 === Number(ref));
    return cand ?? { error: `No attempt #${ref} in group ${shortId(group.groupId)} (1–${group.candidates.length}).` };
  }
  const byId = group.candidates.filter((c) => c.itemId === ref || c.itemId.startsWith(ref));
  if (byId.length === 1) return byId[0]!;
  if (byId.length > 1) return { error: `Candidate ref "${ref}" is ambiguous. Use the attempt number instead.` };
  return { error: `No candidate "${ref}" in group ${shortId(group.groupId)}.` };
}

function candidateLine(c: AttemptCandidate): string {
  const files = c.diff ? `${c.diff.files.length} file(s)` : 'no diff';
  const state = c.state === 'held-merge' ? 'held (pick-ready)' : `failed${c.failureReason ? `: ${c.failureReason}` : ''}`;
  return `    ${c.attemptIndex + 1}. [${state}] ${c.title} — ${files}, item ${shortId(c.itemId)}`;
}

function renderGroupList(groups: readonly HeldMergeGroup[]): string {
  if (groups.length === 0) {
    return 'No best-of-N groups awaiting a pick. A worktree-isolated item with attempts>1 appears here once its siblings finish.';
  }
  const lines: string[] = ['Best-of-N groups (held for a winner pick):'];
  for (const g of groups) {
    lines.push(`  ${shortId(g.groupId)} — "${g.sourceTitle}" (workstream ${shortId(g.workstreamId)})  ${g.ready ? 'READY' : 'still running'}${g.autoAccept ? ', auto-accept' : ''}`);
    for (const c of g.candidates) lines.push(candidateLine(c));
    if (g.judgment?.proposedWinnerItemId) {
      lines.push(`    judge proposal: item ${shortId(g.judgment.proposedWinnerItemId)} (model, advisory)`);
    }
  }
  lines.push('Compare: /workstream attempts diff <group> <#>   Judge: /workstream attempts judge <group>   Pick: /workstream attempts pick <group> <#>');
  return lines.join('\n');
}

/** The model proposal, CLEARLY labelled a model judgment (never ground truth), with reasons. */
function renderJudgment(group: HeldMergeGroup, judgment: AttemptJudgment): string {
  const lines: string[] = [`Judge proposal for group ${shortId(group.groupId)} — "${group.sourceTitle}"`];
  lines.push('  MODEL PROPOSAL (scoredBy: model) — advisory only; a human still confirms the pick.');
  if (judgment.proposedWinnerItemId) {
    const cand = group.candidates.find((c) => c.itemId === judgment.proposedWinnerItemId);
    lines.push(`  Proposed winner: ${cand ? `attempt ${cand.attemptIndex + 1} — ${cand.title}` : `item ${shortId(judgment.proposedWinnerItemId)}`}`);
  } else {
    lines.push('  Proposed winner: none — the judge declined to choose.');
  }
  if (judgment.model) lines.push(`  Model: ${judgment.model}`);
  if (judgment.reasons.length > 0) {
    lines.push('  Reasons:');
    for (const r of judgment.reasons) lines.push(`    - ${r}`);
  }
  if (judgment.proposedWinnerItemId) {
    const cand = group.candidates.find((c) => c.itemId === judgment.proposedWinnerItemId);
    lines.push(`  Accept it with: /workstream attempts pick ${shortId(group.groupId)} ${cand ? cand.attemptIndex + 1 : judgment.proposedWinnerItemId}`);
  }
  return lines.join('\n');
}

function renderPickReceipt(result: AttemptPickResult): string {
  const losers = result.loserItemIds.length;
  return [
    `[Workstream] Winner picked for group ${shortId(result.groupId)}${result.auto ? ' (auto-accepted by judge)' : ''}.`,
    `  Winner item ${shortId(result.winnerItemId)} merged through the integration lane.`,
    `  ${losers} loser worktree(s) cleaned by the engine.`,
  ].join('\n');
}

/**
 * Handle `/workstream attempts …`. Returns true when it consumed the subcommand
 * (so the main handler can stop), false when `attempts` was not the subcommand.
 */
export async function handleAttemptsSubcommand(ctx: CommandContext, service: WorkstreamCommandService, args: readonly string[]): Promise<boolean> {
  if (args[0] !== 'attempts') return false;
  const action = args[1] ?? 'list';

  let groups: HeldMergeGroup[];
  try {
    groups = await service.engine.listHeldMergeGroups();
  } catch (err) {
    ctx.print(`Could not read best-of-N groups: ${summarizeError(err)}`);
    return true;
  }

  if (action === 'list') {
    ctx.print(renderGroupList(groups));
    return true;
  }

  const groupRef = args[2];
  if (!groupRef) {
    ctx.print(`Usage: /workstream attempts ${action} <group> ${action === 'list' ? '' : '<#>'}`.trim());
    return true;
  }
  const group = resolveGroup(groups, groupRef);
  if ('error' in group) {
    ctx.print(group.error);
    return true;
  }

  if (action === 'judge') {
    try {
      const judgment = await service.engine.proposeAttemptWinner(group.groupId);
      ctx.print(renderJudgment(group, judgment));
    } catch (err) {
      ctx.print(err instanceof AttemptError
        ? `No judge available: ${err.message}. Configure a judge model to get a proposal; you can still pick manually.`
        : `Judge failed: ${summarizeError(err)}`);
    }
    return true;
  }

  if (action === 'diff') {
    const candRef = args[3];
    if (!candRef) {
      ctx.print(`Candidates in group ${shortId(group.groupId)}:\n${group.candidates.map(candidateLine).join('\n')}\nView one: /workstream attempts diff ${shortId(group.groupId)} <#>`);
      return true;
    }
    const cand = resolveCandidate(group, candRef);
    if ('error' in cand) { ctx.print(cand.error); return true; }
    if (!cand.diff || !cand.diff.unifiedDiff.trim()) {
      ctx.print(`Attempt ${cand.attemptIndex + 1} has no viewable diff (${cand.state === 'failed' ? 'it failed' : 'its worktree was already cleaned'}).`);
      return true;
    }
    const { DiffPanel } = await import('../../panels/diff-panel.ts');
    const pm = requirePanelManager(ctx);
    let panel = pm.getAllOpen().find((p) => p.id === 'diff');
    if (!panel) { try { panel = pm.open('diff'); } catch { ctx.print('Could not open the diff panel.'); return true; } }
    pm.activateById('diff');
    if (!pm.isVisible()) pm.show();
    ctx.focusPanels?.();
    (panel as InstanceType<typeof DiffPanel>).loadRawDiff(cand.diff.unifiedDiff);
    ctx.print(`Showing attempt ${cand.attemptIndex + 1} ("${cand.title}") diff in the diff panel.`);
    ctx.renderRequest();
    return true;
  }

  if (action === 'pick') {
    const candRef = args[3];
    if (!candRef) { ctx.print(`Usage: /workstream attempts pick ${shortId(group.groupId)} <#>`); return true; }
    if (!group.ready) { ctx.print(`Group ${shortId(group.groupId)} is not ready — its siblings are still running. Wait until every attempt is terminal.`); return true; }
    const cand = resolveCandidate(group, candRef);
    if ('error' in cand) { ctx.print(cand.error); return true; }
    if (cand.state !== 'held-merge') { ctx.print(`Attempt ${cand.attemptIndex + 1} failed — only a held (pick-ready) candidate can win.`); return true; }

    const { DiffPanel } = await import('../../panels/diff-panel.ts');
    const pm = requirePanelManager(ctx);
    let panel = pm.getAllOpen().find((p) => p.id === 'diff');
    if (!panel) { try { panel = pm.open('diff'); } catch { ctx.print('Could not open the diff panel to confirm.'); return true; } }
    pm.activateById('diff');
    if (!pm.isVisible()) pm.show();
    ctx.focusPanels?.();
    const diffPanel = panel as InstanceType<typeof DiffPanel>;
    if (cand.diff?.unifiedDiff.trim()) diffPanel.loadRawDiff(cand.diff.unifiedDiff);
    else diffPanel.showDiff(cand.title, '@@ pick @@\n (no diff to preview for this candidate)');

    diffPanel.confirmOverlay.arm({
      id: `${group.groupId}:${cand.itemId}`,
      label: `Pick attempt ${cand.attemptIndex + 1} ("${cand.title}") — merge it, clean the ${group.candidates.length - 1} other worktree(s)`,
      verb: 'Pick',
      onConfirm: async () => {
        try {
          const result = await service.engine.pickAttemptWinner(group.groupId, cand.itemId);
          pm.close('diff');
          ctx.focusPrompt?.();
          ctx.print(renderPickReceipt(result));
        } catch (err) {
          pm.close('diff');
          ctx.focusPrompt?.();
          ctx.print(err instanceof AttemptError ? `Pick refused: ${err.message}` : `Pick failed: ${summarizeError(err)}`);
        }
        ctx.renderRequest();
      },
      onCancel: () => {
        pm.close('diff');
        ctx.focusPrompt?.();
        ctx.print('Pick cancelled — nothing merged, no worktree cleaned.');
        ctx.renderRequest();
      },
    });
    ctx.print(`Confirm the pick in the diff panel: Enter/y to merge attempt ${cand.attemptIndex + 1} and clean the losers, n/Esc to cancel.`);
    ctx.renderRequest();
    return true;
  }

  ctx.print(`Unknown attempts action "${action}". Use: list | diff <group> <#> | judge <group> | pick <group> <#>.`);
  return true;
}
