/**
 * conversation-turn-structure.ts, turns the flat message array into the
 * structural render plan the transcript tree draws from.
 *
 * Three jobs, deliberately not conflated:
 *
 *  1. **Turn grouping.** Which assistant messages share one `● assistant`
 *     header (see computeAssistantTurns).
 *
 *  2. **Structural placement.** Where each row goes. A tool result is a child
 *     of the CALL that produced it, identified by callId, not a row appended
 *     wherever it happens to land in the message array. Two calls issued
 *     together run concurrently and settle in whatever order they finish; the
 *     later-finishing call's result must still render inside its own call's
 *     subtree, which is above any call issued afterwards. This is why the plan
 *     is a permutation of the message array rather than a walk of it.
 *
 *  3. **Connector geometry.** Each branch row's box-drawing connector and the
 *     `│` gutters of its still-open ancestors.
 *
 * ## Node identity
 *
 * Every planned row carries a stable string id, `m:<absIdx>` for a message,
 * `c:<absIdx>:<callIndex>` for one tool call, each prefixed by its scope (see
 * nesting below). Ids derive from append-only indices that are never
 * renumbered, so a row inserted in the middle does not change any other row's
 * id. The line cache keys on these ids (not on buffer position or plan order),
 * so an insertion above a row reuses that row's cached lines.
 *
 * ## Nesting is a render-layer concern, not a transcript-model one
 *
 * `ConversationMessageSnapshot` is flat and stays flat. Deeper nesting needs
 * no schema change: a subagent keeps its own ConversationManager, and
 * `AgentManager.getConversationSnapshot(agentId)` already exposes it live (the
 * same read `fleet-panel.ts` uses to draw an attached agent's transcript). So
 * when a tool call spawned an agent, the plan SPLICES that agent's own plan in
 * beneath the call, recursively, the identical operation to lifting a result
 * into its call's subtree, applied to a nested snapshot. The parent
 * transcript, the persisted format, and the message schema are untouched; only
 * the render plan nests.
 *
 * Because child snapshots are read at plan time on every rebuild, a child's
 * rows appear as they happen rather than when the child finishes, and a
 * child's late row inserts into its own subtree.
 *
 * Depth is unbounded in principle and bounded in practice by MAX_NEST_DEPTH
 * plus a per-path cycle guard, because a spawn graph that revisits an agent id
 * would otherwise recurse forever. Both guards report themselves on the node
 * (`truncated`) rather than silently dropping rows.
 *
 * ## Connector vocabulary
 *
 * Proper box drawing: `├` for a branch with siblings below it, `└` for the
 * last sibling, `│` carried down the gutter for every ancestor whose subtree
 * is still open. Connectors are a PURE FUNCTION of current structure,
 * recomputed from scratch on every plan build, never cached, so a row that
 * stops being last flips `└`→`├` on the next rebuild.
 *
 * That flip is one cell. Indentation width, content column, and row text are
 * all independent of sibling status by construction: `indentCols` depends only
 * on depth and width, and the connector occupies a column that exists whether
 * it holds `├` or `└`. So a sibling arriving repaints a connector cell and
 * moves no text. (The rejected alternative, a uniform glyph, cannot express
 * "this subtree continues past here", which is what makes a deep tree
 * scannable.)
 */

import type { ConversationMessageSnapshot } from '@pellux/goodvibes-sdk/platform/core';

type Message = ConversationMessageSnapshot;

/**
 * Hard ceiling on nesting depth. A spawn chain deeper than this renders its
 * ancestors and marks the deepest shown call as truncated rather than
 * recursing without bound.
 */
export const MAX_NEST_DEPTH = 8;

/** Connector drawn at a branch row's own indent column. */
export type TreeConnector = '├' | '└';

export interface RenderNode {
  /** Stable identity, survives insertions above it. Scope-prefixed. */
  readonly id: string;
  readonly kind: 'message' | 'toolcall';
  /** Index of the message within ITS OWN snapshot array. */
  readonly absIdx: number;
  /** Position within the owning assistant message's toolCalls, 'toolcall' only. */
  readonly callIndex?: number;
  /** 0 = flush; >=1 = branch depth. */
  readonly depth: number;
  /** The resolved message this row renders (root or nested snapshot). */
  readonly message: Message;
  /**
   * Scope prefix identifying which snapshot `absIdx` indexes into. Empty for
   * the root transcript, so root collapse keys stay byte-identical to what
   * they were before nesting existed.
   */
  readonly scope: string;
  /** Agent whose snapshot this row came from, when nested. */
  readonly agentId?: string;
  /** Connector for this row; undefined at depth 0. */
  readonly connector?: TreeConnector;
  /**
   * Ancestor depths (1-based) whose subtree continues below this row, so the
   * renderer draws `│` in those gutters. Excludes this row's own depth.
   */
  readonly openAncestorDepths: readonly number[];
  /** Set when recursion stopped here (depth ceiling or cycle), surfaced honestly. */
  readonly truncated?: 'depth' | 'cycle';
}

/**
 * Which assistant messages share one header, and what that header must say.
 * Keyed by the absolute index of every assistant message in the run.
 */
export interface AssistantTurnMembership {
  readonly turnKey: string;
  readonly headIdx: number;
  readonly isHead: boolean;
  readonly toolCallCount: number;
  readonly sharedToolLabel: string | undefined;
  readonly hasReasoning: boolean;
  readonly memberIndexes: readonly number[];
  readonly resultIndexes: readonly number[];
}

/** True when an assistant message carries prose the user is meant to read. */
export function hasUserFacingProse(message: Message): boolean {
  return message.role === 'assistant'
    && typeof message.content === 'string'
    && message.content.trim().length > 0;
}

function modelKeyOf(message: Extract<Message, { role: 'assistant' }>): string {
  if (!message.model && !message.provider) return '';
  return `${message.model ?? ''}|${message.provider ?? ''}`;
}

/**
 * True when `message` must start a fresh `● assistant` header.
 *
 * A new header starts when there is no open run (a user message intervened),
 * when the message carries user-facing prose (prose closes the current group
 * and whatever follows begins a fresh one), or when the model/provider
 * changed (a mid-run model switch is real information and stays visible).
 *
 * A system message does NOT break a run: operational status noise interleaves
 * freely with tool activity, and breaking on it would fragment nearly every
 * group back into the per-message headers this change removes.
 */
function startsNewTurn(
  message: Extract<Message, { role: 'assistant' }>,
  run: { readonly modelKey: string } | null,
): boolean {
  if (run === null) return true;
  if (hasUserFacingProse(message)) return true;
  const key = modelKeyOf(message);
  return key !== '' && run.modelKey !== '' && key !== run.modelKey;
}

interface OpenRun {
  headIdx: number;
  modelKey: string;
  members: number[];
  toolLabels: string[];
  resultIndexes: number[];
  hasReasoning: boolean;
}

export function computeAssistantTurns(
  messages: readonly Message[],
  indexOffset = 0,
): ReadonlyMap<number, AssistantTurnMembership> {
  const runs: OpenRun[] = [];
  let open: OpenRun | null = null;
  const callOwner = new Map<string, OpenRun>();

  for (let i = 0; i < messages.length; i++) {
    const message = messages[i]!;
    const absIdx = indexOffset + i;

    if (message.role === 'user') { open = null; continue; }
    if (message.role === 'system') continue;

    if (message.role === 'tool') {
      const owner = message.callId ? callOwner.get(message.callId) : undefined;
      if (owner) owner.resultIndexes.push(absIdx);
      continue;
    }

    if (startsNewTurn(message, open)) {
      open = { headIdx: absIdx, modelKey: modelKeyOf(message), members: [], toolLabels: [], resultIndexes: [], hasReasoning: false };
      runs.push(open);
    }
    open!.members.push(absIdx);
    if (open!.modelKey === '') open!.modelKey = modelKeyOf(message);
    if (message.reasoningContent || message.reasoningSummary) open!.hasReasoning = true;
    for (const call of message.toolCalls ?? []) {
      open!.toolLabels.push(call.name);
      if (call.id !== undefined) callOwner.set(call.id, open!);
    }
  }

  const membership = new Map<number, AssistantTurnMembership>();
  for (const run of runs) {
    const distinct = new Set(run.toolLabels);
    const shared = distinct.size === 1 && run.toolLabels.length >= 2 ? run.toolLabels[0] : undefined;
    const base = {
      turnKey: `turn_${run.headIdx}`,
      headIdx: run.headIdx,
      toolCallCount: run.toolLabels.length,
      sharedToolLabel: shared,
      hasReasoning: run.hasReasoning,
      memberIndexes: run.members,
      resultIndexes: run.resultIndexes,
    } as const;
    for (const absIdx of run.members) membership.set(absIdx, { ...base, isHead: absIdx === run.headIdx });
    for (const absIdx of run.resultIndexes) membership.set(absIdx, { ...base, isHead: false });
  }
  return membership;
}

/** Resolve a spawned agent's live snapshot; return null when unavailable. */
export type AgentSnapshotResolver = (agentId: string) => readonly Message[] | null;

export interface RenderPlanOptions {
  readonly resolveAgentSnapshot?: AgentSnapshotResolver | undefined;
  readonly maxDepth?: number | undefined;
}

/**
 * The agent id a tool call spawned, when it spawned one.
 *
 * Read from the call's own result payload first (the spawn tool reports the id
 * it allocated, see AgentInput.agentId in the SDK's agent schema), falling
 * back to an explicit `agentId` argument on the call. Returns undefined for
 * every ordinary tool call, which is the overwhelmingly common case, so this
 * stays a cheap check.
 */
function spawnedAgentIdOf(
  call: { readonly name: string; readonly arguments: Record<string, unknown> },
  results: readonly Message[],
): string | undefined {
  for (const result of results) {
    if (result.role !== 'tool') continue;
    const raw = result.content;
    if (typeof raw !== 'string' || !raw.includes('agentId')) continue;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        const id = (parsed as Record<string, unknown>).agentId;
        if (typeof id === 'string' && id.length > 0) return id;
      }
    } catch {
      // Non-JSON result, fall through to the argument check.
    }
  }
  const argId = call.arguments.agentId;
  return typeof argId === 'string' && argId.length > 0 ? argId : undefined;
}

/** Internal tree node; flattened into RenderNode[] once sibling counts are known. */
interface TreeNode {
  id: string;
  kind: 'message' | 'toolcall';
  absIdx: number;
  callIndex?: number;
  message: Message;
  scope: string;
  agentId?: string;
  truncated?: 'depth' | 'cycle';
  children: TreeNode[];
}

/**
 * Build the subtree for one snapshot (root transcript or a nested agent's).
 * Returns the top-level nodes, each already carrying its own children.
 */
function buildScopeNodes(
  messages: readonly Message[],
  indexOffset: number,
  scope: string,
  agentId: string | undefined,
  depth: number,
  opts: RenderPlanOptions,
  ancestorAgentIds: readonly string[],
): TreeNode[] {
  const maxDepth = opts.maxDepth ?? MAX_NEST_DEPTH;

  const resultsByCallId = new Map<string, number[]>();
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i]!;
    if (message.role !== 'tool' || !message.callId) continue;
    const bucket = resultsByCallId.get(message.callId);
    if (bucket) bucket.push(indexOffset + i);
    else resultsByCallId.set(message.callId, [indexOffset + i]);
  }

  const nodes: TreeNode[] = [];
  const placed = new Set<number>();
  const messageAt = (absIdx: number): Message => messages[absIdx - indexOffset]!;
  // Calls issued by later messages of the SAME run attach to the run's head
  // node, because the head owns the only visible header, that is what makes
  // them siblings of each other rather than only children of their own
  // (headerless) message, and therefore what makes ├/└ resolve correctly
  // across a merged turn.
  const turns = computeAssistantTurns(messages, indexOffset);
  const headNodes = new Map<string, TreeNode>();

  for (let i = 0; i < messages.length; i++) {
    const message = messages[i]!;
    const absIdx = indexOffset + i;

    if (message.role === 'tool') {
      if (placed.has(absIdx)) continue;
      nodes.push({ id: `${scope}m:${absIdx}`, kind: 'message', absIdx, message, scope, agentId, children: [] });
      continue;
    }

    if (message.role !== 'assistant') {
      nodes.push({ id: `${scope}m:${absIdx}`, kind: 'message', absIdx, message, scope, agentId, children: [] });
      continue;
    }

    const head: TreeNode = { id: `${scope}m:${absIdx}`, kind: 'message', absIdx, message, scope, agentId, children: [] };
    nodes.push(head);

    const turn = turns.get(absIdx);
    if (turn?.isHead) headNodes.set(turn.turnKey, head);
    // Non-head members hang their calls off the run's head so the whole turn's
    // activity is one sibling list under one header.
    const callParent = turn ? (headNodes.get(turn.turnKey) ?? head) : head;

    const calls = message.toolCalls ?? [];
    for (let k = 0; k < calls.length; k++) {
      const call = calls[k]!;
      const callNode: TreeNode = {
        id: `${scope}c:${absIdx}:${k}`,
        kind: 'toolcall',
        absIdx,
        callIndex: k,
        message,
        scope,
        agentId,
        children: [],
      };
      callParent.children.push(callNode);

      const resultIdxs = call.id === undefined ? [] : (resultsByCallId.get(call.id) ?? []);
      const resultMessages: Message[] = [];
      for (const resultIdx of resultIdxs) {
        if (placed.has(resultIdx)) continue;
        placed.add(resultIdx);
        const resultMessage = messageAt(resultIdx);
        resultMessages.push(resultMessage);
        callNode.children.push({
          id: `${scope}m:${resultIdx}`,
          kind: 'message',
          absIdx: resultIdx,
          message: resultMessage,
          scope,
          agentId,
          children: [],
        });
      }

      // Splice a spawned agent's own plan in beneath the call that spawned it.
      const childAgentId = opts.resolveAgentSnapshot
        ? spawnedAgentIdOf(call, resultMessages)
        : undefined;
      if (!childAgentId) continue;
      if (ancestorAgentIds.includes(childAgentId)) {
        callNode.truncated = 'cycle';
        continue;
      }
      // A spliced child scope's own rows start two levels below this call
      // (head, then its calls, then their results), so the deepest row it can
      // contribute sits at depth+4. Guard on that, not on the base, or the
      // ceiling is overshot by exactly those two levels.
      if (depth + 4 > maxDepth) {
        callNode.truncated = 'depth';
        continue;
      }
      const childMessages = opts.resolveAgentSnapshot!(childAgentId);
      if (!childMessages || childMessages.length === 0) continue;
      const childScope = `${scope}a:${childAgentId}/`;
      callNode.children.push(
        ...buildScopeNodes(childMessages, 0, childScope, childAgentId, depth + 2, opts, [...ancestorAgentIds, childAgentId]),
      );
    }
  }

  return nodes;
}

/**
 * Flatten the tree depth-first, resolving each row's connector and the `│`
 * gutters of ancestors whose subtrees are still open.
 *
 * `openAncestorDepths` is computed from live structure on every call, so a row
 * that stops being last flips `└`→`├` on the next rebuild with no cached state
 * to go stale.
 */
function flatten(
  nodes: readonly TreeNode[],
  depth: number,
  openAncestorDepths: readonly number[],
  out: RenderNode[],
): void {
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i]!;
    const isLast = i === nodes.length - 1;
    const connector: TreeConnector | undefined = depth === 0 ? undefined : (isLast ? '└' : '├');

    out.push({
      id: node.id,
      kind: node.kind,
      absIdx: node.absIdx,
      callIndex: node.callIndex,
      depth,
      message: node.message,
      scope: node.scope,
      agentId: node.agentId,
      connector,
      openAncestorDepths,
      truncated: node.truncated,
    });

    if (node.children.length === 0) continue;
    // This row's subtree continues below it only when it is NOT the last
    // sibling; that is exactly when descendants must draw `│` in this depth's
    // gutter to show the parent chain is still open.
    const childOpen = depth === 0 || isLast ? openAncestorDepths : [...openAncestorDepths, depth];
    flatten(node.children, depth + 1, childOpen, out);
  }
}

/**
 * Build the ordered render plan for a message slice.
 *
 * Every message appears exactly once, plus one node per tool call, plus the
 * spliced-in nodes of any agent a call spawned.
 */
export function buildRenderPlan(
  messages: readonly Message[],
  indexOffset = 0,
  opts: RenderPlanOptions = {},
): RenderNode[] {
  const tree = buildScopeNodes(messages, indexOffset, '', undefined, 0, opts, []);
  const plan: RenderNode[] = [];
  flatten(tree, 0, [], plan);
  return plan;
}

/** Collapse key for a planned row, scope-aware. Root scope keys are unchanged. */
export function collapseKeyForNode(node: RenderNode): string {
  return `msg_${node.scope}${node.absIdx}`;
}

/** Collapse key for an entire spawned-agent subtree. */
export function agentSubtreeCollapseKey(agentId: string): string {
  return `agent_${agentId}`;
}
