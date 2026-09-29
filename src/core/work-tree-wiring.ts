/**
 * work-tree-wiring.ts, connecting the conversation work tree to the live
 * runtime: the timing store fed by tool and turn events, agent lanes read
 * from the agent manager (WRFC chains from the chain controller, cost from
 * the fleet read model), the call a permission prompt is holding, and the
 * per-session fold state.
 *
 * One call from main.ts; everything the work tree reads at render time goes
 * through the WorkTreeSources this installs.
 */

import type { AgentManager } from '@pellux/goodvibes-sdk/platform/tools';
import type { WrfcChain } from '@pellux/goodvibes-sdk/platform/agents';
import type { ProcessNode } from '@pellux/goodvibes-sdk/platform/runtime/fleet';
import type { ConversationMessageSnapshot } from '@pellux/goodvibes-sdk/platform/core';
import type { UiRuntimeEvents } from '@/runtime/index.ts';
import type { ConversationManager } from './conversation.ts';
import { WorkTreeTimingStore, userMessageFingerprint, type AgentLaneInfo, type TurnOutcome, type WrfcPhaseInfo } from './work-tree-sources.ts';
import { loadWorkTreeFolds, loadWorkTreeTurnOutcomes, saveWorkTreeFolds, sweepOrphanWorkTreeFolds } from './work-tree-fold-store.ts';
import { onSemanticSummaryReady } from '../renderer/lane-graph/semantic-memo.ts';
import { onSyntaxHighlightReady } from '../renderer/code-block.ts';

type AgentRecord = ReturnType<AgentManager['list']>[number];

export interface WorkTreeWiringDeps {
  readonly conversation: ConversationManager;
  readonly events: UiRuntimeEvents;
  readonly agentManager: Pick<AgentManager, 'getStatus' | 'getConversationSnapshot'>;
  readonly listChains: () => readonly WrfcChain[];
  readonly fleetNodes: () => readonly ProcessNode[];
  /** The call id a permission prompt is holding, if any. */
  readonly pendingCallId: () => string | undefined;
  readonly turnActive: () => boolean;
  readonly sessionsDir: string;
  readonly sessionId: () => string;
  /** Repaint (a ◈ summary of an opened edit landed). */
  readonly requestRender: () => void;
}

function firstLines(text: string | undefined, n: number): string | undefined {
  if (!text) return undefined;
  const lines = text.split('\n').filter((l) => l.trim().length > 0).slice(0, n);
  return lines.length > 0 ? lines.join('\n') : undefined;
}

/** A finished agent's transcript never changes: read it once. */
interface SnapshotMemo { readonly stamp: string; readonly messages: readonly ConversationMessageSnapshot[] }

export function wireWorkTree(deps: WorkTreeWiringDeps): { readonly timings: WorkTreeTimingStore; readonly unsubs: Array<() => void> } {
  const timings = new WorkTreeTimingStore();
  const unsubs: Array<() => void> = [];
  const { conversation, events } = deps;

  unsubs.push(events.tools.on('TOOL_EXECUTING', (ev) => timings.callStarted(ev.callId, ev.startedAt)));
  unsubs.push(events.tools.on('TOOL_SUCCEEDED', (ev) => timings.callSettled(ev.callId, ev.durationMs, Date.now())));
  unsubs.push(events.tools.on('TOOL_FAILED', (ev) => timings.callSettled(ev.callId, ev.durationMs, Date.now())));
  unsubs.push(events.tools.on('TOOL_CANCELLED', (ev) => timings.callSettled(ev.callId, undefined, Date.now())));
  // Everything the session sidecar keeps: fold decisions and failed/cancelled turn endings.
  const persistView = (): void => saveWorkTreeFolds(deps.sessionsDir, deps.sessionId(), conversation.workTree.foldState(), conversation.workTree.turnOutcomes());

  unsubs.push(events.turns.on('TURN_SUBMITTED', () => {
    const snapshot = conversation.getMessageSnapshot();
    for (let i = snapshot.length - 1; i >= 0; i--) {
      if (snapshot[i]!.role === 'user') { timings.turnStarted(i, Date.now(), userMessageFingerprint(snapshot[i])); break; }
    }
  }));
  const endTurn = (outcome: TurnOutcome): void => {
    const ended = timings.turnEnded(Date.now(), outcome);
    // The header drops "working" and states a failure on the next build.
    conversation.workTree.invalidate();
    if (!ended || ended.timing.fingerprint === undefined) return;
    if (conversation.workTree.recordTurnOutcome({ index: ended.index, fingerprint: ended.timing.fingerprint, outcome })) persistView();
  };
  unsubs.push(events.turns.on('TURN_COMPLETED', (ev) => endTurn(ev.stopReason === 'empty_response' ? 'failed' : 'completed')));
  unsubs.push(events.turns.on('TURN_ERROR', () => endTurn('failed')));
  unsubs.push(events.turns.on('TURN_CANCEL', () => endTurn('cancelled')));
  unsubs.push(events.turns.on('PREFLIGHT_FAIL', () => endTurn('failed')));
  // A new or resumed transcript: turn timings are keyed by message index and belong to the old one.
  unsubs.push(conversation.workTree.onReset(() => timings.clear()));

  const snapshots = new Map<string, SnapshotMemo>();
  const messagesOf = (record: AgentRecord): readonly ConversationMessageSnapshot[] => {
    const finished = record.status !== 'running' && record.status !== 'pending';
    const stamp = `${record.status}:${record.completedAt ?? ''}:${record.toolCallCount}`;
    const memo = snapshots.get(record.id);
    if (finished && memo && memo.stamp === stamp) return memo.messages;
    const messages = deps.agentManager.getConversationSnapshot(record.id);
    if (finished) snapshots.set(record.id, { stamp, messages });
    return messages;
  };

  const costOf = (agentId: string): number | undefined => {
    const node = deps.fleetNodes().find((n) => n.id === agentId);
    // Only a real reading: an unpriced node has no cost to state.
    return node && node.costState !== 'unpriced' && typeof node.costUsd === 'number' ? node.costUsd : undefined;
  };

  const wrfcPhases = (record: AgentRecord): { phases: WrfcPhaseInfo[]; passed: boolean | undefined } | undefined => {
    const chain = deps.listChains().find((c) => c.ownerAgentId === record.id || (c.engineerAgentId === record.id && c.ownerAgentId === c.engineerAgentId));
    if (!chain) return undefined;
    const phases: WrfcPhaseInfo[] = [];
    for (const id of chain.allAgentIds) {
      if (id === chain.ownerAgentId && id !== chain.engineerAgentId) continue;
      const phase = deps.agentManager.getStatus(id);
      if (!phase) continue;
      const role = (phase.wrfcRole ?? (id === chain.engineerAgentId ? 'engineer' : id === chain.reviewerAgentId ? 'reviewer' : id === chain.fixerAgentId ? 'fixer' : 'engineer')) as WrfcPhaseInfo['role'];
      const latestReview = role === 'reviewer' && id === chain.reviewerAgentId ? chain.reviewerReport : undefined;
      phases.push({
        agentId: id,
        role,
        task: phase.task,
        status: phase.status,
        startedAt: phase.startedAt,
        completedAt: phase.completedAt,
        findings: latestReview?.issues.map((issue) => issue.description),
        passed: latestReview ? (chain.lastReviewVerdict?.passed ?? latestReview.passed) : undefined,
        output: firstLines(phase.fullOutput, 6),
      });
    }
    phases.sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0));
    const passed = chain.state === 'passed' ? true : chain.state === 'failed' ? false : undefined;
    return { phases, passed };
  };

  const agent = (agentId: string): AgentLaneInfo | null => {
    const record = deps.agentManager.getStatus(agentId);
    if (!record) return null;
    const wrfc = wrfcPhases(record);
    return {
      id: record.id,
      name: record.template,
      task: record.task,
      status: record.status,
      startedAt: record.startedAt,
      completedAt: record.completedAt,
      toolCallCount: record.toolCallCount,
      costUsd: costOf(record.id),
      error: record.error,
      messages: wrfc ? [] : messagesOf(record),
      wrfcPhases: wrfc?.phases,
      wrfcPassed: wrfc?.passed,
    };
  };

  conversation.setWorkTreeSources({
    callTiming: (callId) => timings.callTiming(callId),
    turnTiming: (index) => timings.turnTiming(index),
    agent,
    waitingCallIds: () => {
      const id = deps.pendingCallId();
      return id ? new Set([id]) : new Set<string>();
    },
    turnActive: deps.turnActive,
    turnOutcome: (index) => conversation.workTree.turnOutcome(index),
    now: () => Date.now(),
  });

  // Fold decisions persist per session, beside the session file.
  conversation.workTree.onFoldChange(persistView);
  sweepOrphanWorkTreeFolds(deps.sessionsDir);
  unsubs.push(onSemanticSummaryReady(() => { conversation.workTree.invalidate(); deps.requestRender(); }));
  // A tree-sitter parse landed: code drawn with the regex placeholder is redrawn with it.
  unsubs.push(onSyntaxHighlightReady(() => { conversation.workTree.invalidate(); deps.requestRender(); }));
  return { timings, unsubs };
}

/**
 * Restore a resumed session's fold decisions and failed/cancelled turn
 * endings (called by the resume routine, after the transcript is restored).
 */
export function restoreWorkTreeFolds(conversation: ConversationManager, sessionsDir: string, sessionId: string): number {
  const entries = loadWorkTreeFolds(sessionsDir, sessionId);
  conversation.workTree.restoreFoldState(entries);
  conversation.workTree.restoreTurnOutcomes(loadWorkTreeTurnOutcomes(sessionsDir, sessionId));
  return entries.length;
}
