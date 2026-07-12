import type { CommandContext } from '../command-registry.ts';
import { VALID_REVIEW_STATES, VALID_SCOPES, isValidReviewState, isValidScope, temporalStatusLabel } from './recall-shared.ts';
import { getMemoryApi, getMemorySpine } from './recall-query.ts';
import { buildMainSessionTurnInjectionsText, buildTurnInjectionsText } from '../../renderer/turn-injection.ts';

export async function handleRecallQueue(args: string[], context: CommandContext): Promise<void> {
  const memory = getMemorySpine(context);
  if (!memory) {
    return;
  }

  // Extract optional --scope filter before parsing the positional limit argument.
  const scopeIdx = args.indexOf('--scope');
  let scopeFilter: string | undefined;
  let remainingArgs = args;
  if (scopeIdx !== -1 && args[scopeIdx + 1]) {
    const candidateScope = args[scopeIdx + 1];
    if (!isValidScope(candidateScope)) {
      context.print(`[recall] Unknown scope "${candidateScope}". Valid: ${VALID_SCOPES.join(', ')}`);
      return;
    }
    scopeFilter = candidateScope;
    remainingArgs = args.filter((_, i) => i !== scopeIdx && i !== scopeIdx + 1);
  }

  const limitRaw = remainingArgs.find((a) => !a.startsWith('--'));
  const limit = Math.max(1, parseInt(limitRaw ?? '10', 10) || 10);

  // When a scope filter is requested, fetch a larger pool then slice to the
  // requested limit so scope-sparse queues still return meaningful results.
  const fetchLimit = scopeFilter ? 1000 : limit;
  const rawQueue = await memory.reviewQueue(fetchLimit);
  const queue = scopeFilter
    ? rawQueue.filter((record) => record.scope === scopeFilter).slice(0, limit)
    : rawQueue;

  if (!queue.length) {
    context.print('[recall] Review queue is empty.');
    return;
  }
  context.print(`[recall] Review queue (${queue.length}):`);
  for (const record of queue) {
    const reason = record.staleReason ? ` — ${record.staleReason}` : '';
    context.print(`  ${record.id} [${record.scope}/${record.cls}] ${record.reviewState} ${record.confidence}%  ${record.summary}${reason}${temporalStatusLabel(record)}`);
  }
}

export async function handleRecallReview(args: string[], context: CommandContext): Promise<void> {
  const memory = getMemorySpine(context);
  if (!memory) {
    return;
  }

  const [id, stateRaw, ...rest] = args;
  if (!id || !stateRaw || !isValidReviewState(stateRaw)) {
    context.print(`[recall] Usage: /recall review <id> <${VALID_REVIEW_STATES.join('|')}> [--confidence <0-100>] [--by <name>] [--reason <text>]`);
    return;
  }

  const confidenceIdx = rest.indexOf('--confidence');
  const byIdx = rest.indexOf('--by');
  const reasonIdx = rest.indexOf('--reason');
  const confidence = confidenceIdx !== -1 ? parseInt(rest[confidenceIdx + 1] ?? '', 10) : undefined;
  const reviewedBy = byIdx !== -1 ? rest[byIdx + 1] : 'operator';
  const staleReason = reasonIdx !== -1 ? rest.slice(reasonIdx + 1).join(' ') : undefined;

  const record = await memory.updateReview(id, {
    state: stateRaw,
    confidence: Number.isFinite(confidence) ? confidence : undefined,
    reviewedBy,
    staleReason,
  });

  if (!record) {
    context.print(`[recall] Record not found: ${id}`);
    return;
  }
  context.print(`[recall] Reviewed ${record.id}: ${record.reviewState} ${record.confidence}%`);
}

export function handleRecallExplain(args: string[], context: CommandContext): void {
  const memory = getMemoryApi(context);
  if (!memory) {
    return;
  }
  const scopeIdx = args.indexOf('--scope');
  const scopeValues = scopeIdx !== -1 ? args.slice(scopeIdx + 1).filter((token) => !token.startsWith('--')) : [];
  const taskTokens = args.filter((token, index) => {
    if (token === '--scope') return false;
    if (scopeIdx !== -1 && index > scopeIdx) return false;
    return true;
  });
  const task = taskTokens.join(' ').trim();
  if (!task) {
    context.print('[recall] Usage: /recall explain <task description...> [--scope <write-scope> ...]');
    return;
  }
  const explanation = memory.explain(task, scopeValues);
  if (explanation.injections.length === 0) {
    context.print('[recall] No reviewed project knowledge was selected for that task.');
    return;
  }
  context.print(explanation.prompt ?? '[recall] No explainable project knowledge was selected.');
}

/**
 * Per-turn passive knowledge injection inspectability.
 *
 * With an explicit agent id, reads `AgentRecord.turnInjections`
 * via `context.ops.agentManager.exportState()` — the CommandContext-exposed
 * `ShellAgentManagerService` doesn't have a `getStatus`/`list` pair, but
 * `exportState()` returns the same full `AgentRecord[]` (it's what
 * compactConversation() already uses for the same reason).
 *
 * With NO agent id (wiring), renders the MAIN interactive session's own
 * per-turn injection ring — `Orchestrator.getTurnInjections()`, threaded onto
 * the command context as `session.getMainSessionTurnInjections`. As of the
 * main session DOES route through the passive-injection engine, so this is the
 * honest main-session default (previously there was no record source, so the
 * no-id path could only print a usage hint). When the accessor isn't wired
 * (headless/test contexts built without an orchestrator), the main-session
 * renderer's honest empty state stands in.
 */
export function handleRecallInjections(args: string[], context: CommandContext): void {
  const agentId = args[0];
  if (!agentId) {
    const mainSessionInjections = context.session.getMainSessionTurnInjections?.() ?? [];
    context.print(buildMainSessionTurnInjectionsText(mainSessionInjections));
    return;
  }
  const records = context.ops.agentManager?.exportState() ?? [];
  const record = records.find((candidate) => candidate.id === agentId);
  if (!record) {
    context.print(`[recall] Agent not found: ${agentId}`);
    return;
  }
  context.print(buildTurnInjectionsText(agentId, record.turnInjections ?? []));
}

export async function handleRecallPromote(args: string[], context: CommandContext): Promise<void> {
  const memory = getMemorySpine(context);
  if (!memory) {
    return;
  }
  const id = args[0];
  const scope = args[1];
  if (!id || !scope || !isValidScope(scope)) {
    context.print(`[recall] Usage: /recall promote <id> <${VALID_SCOPES.join('|')}>`);
    return;
  }
  const record = await memory.update(id, { scope });
  if (!record) {
    context.print(`[recall] Record not found: ${id}`);
    return;
  }
  context.print(`[recall] Promoted ${record.id} to ${record.scope} scope.`);
}
