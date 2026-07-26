/**
 * conversation-line-cache.ts — per-message Line[] production cache.
 *
 * The measured defect (perf baseline 2026-07-03, transcript.build_1k): appending
 * ONE message to an N-message conversation re-rendered all N messages
 * (45.5 ms p50 / 71.4 MB / 695 k objects per rebuild), because
 * ConversationManager.rebuildHistory() clears the buffer and calls
 * appendConversationMessages() over the entire snapshot on every dirty flag —
 * and markDirty() fires on every mutation. The marginal work for one appended
 * message is ~1/1000th of that.
 *
 * This module memoises the per-message render. Each message's rendered output is
 * a PURE function of its complete inputs:
 *   - message identity + content (via a content signature; snapshots are fresh
 *     structuredClone copies each call, so string content compares by value and
 *     array-valued fields — user ContentPart[] and assistant toolCalls — are
 *     serialised; a streaming assistant message mutates its content string in
 *     place, which changes the signature and invalidates the entry)
 *   - render width
 *   - the four display-config values the render reads (line-number mode,
 *     collapse threshold, showThinking, showReasoningSummary)
 *   - the block-registry base at message start (the code-block collapseKey embeds
 *     the GLOBAL block index — `code_${msgIdx}_${blockIdx}` — so a shift in an
 *     earlier message's block count changes this message's keys)
 *   - the absolute message index (embedded in every collapseKey and used for the
 *     system-message kind lookup)
 *   - the system-message kind (drives the error-navigation registry side effect)
 *   - this message's tool-group membership (see conversation-tool-groups.ts):
 *     whether it's folded under a group header, which member owns that header,
 *     and the group's honest tool/line counts — a group growing as new tool
 *     results stream in changes these for every existing member
 *   - the live values of every collapseState key the render READS (recorded via a
 *     proxy during a miss; a collapse toggle flips a recorded value and
 *     invalidates exactly the owning message)
 *
 * Invalidation is by comparison of those complete inputs — the file-preview
 * contentVersion precedent generalised: instead of a single version counter we
 * compare the full input tuple, which is provably complete (a from-scratch
 * rebuild reads nothing else).
 *
 * Correctness contract: a cache-served rebuild is BYTE-IDENTICAL to a cold
 * appendConversationMessages() rebuild. This is guaranteed by construction — a
 * miss renders through the exact same per-message render functions into an
 * isolated scratch context, and the captured lines / block metas / error lines
 * are replayed at the same buffer offsets a cold render would have produced.
 */

import { createEmptyLine, type Line } from '../types/grid.ts';
import type { BlockMeta } from './conversation-types.ts';
import type { ConversationRenderContext } from './conversation-rendering.ts';
import {
  renderConversationAssistantMessage,
  renderConversationSystemMessage,
  renderConversationToolCallNode,
  renderConversationToolMessage,
  renderConversationUserMessage,
  collectToolCallOutcomes,
  isTurnCollapsed,
  type ToolCallOutcome,
} from './conversation-rendering.ts';
import {
  buildRenderPlan,
  computeAssistantTurns,
  type AssistantTurnMembership,
  type RenderNode,
} from './conversation-turn-structure.ts';
import type { ConversationMessageSnapshot } from '@pellux/goodvibes-sdk/platform/core';
// SystemMessageKind imported from runtime directly to avoid a cycle, mirroring
// conversation-rendering.ts's own import.
import type { SystemMessageKind } from '@/runtime/index.ts';

type Message = ConversationMessageSnapshot;

/** The display-config values every message render depends on. */
interface RenderConfig {
  readonly lineNumberMode: 'all' | 'code' | 'off';
  readonly collapseThreshold: number;
  readonly showThinking: boolean;
  readonly showReasoningSummary: boolean;
}

/**
 * Content signature: the render-relevant fields of a message, captured so an
 * unchanged message is recognised without re-rendering. Array-valued fields are
 * pre-serialised to strings so equality is a value comparison.
 */
interface ContentSig {
  readonly role: Message['role'];
  /** String content, or JSON of ContentPart[] for array-valued user content. */
  readonly content: string;
  readonly cancelled?: boolean;
  readonly model?: string;
  readonly provider?: string;
  readonly reasoningContent?: string;
  readonly reasoningSummary?: string;
  readonly toolCallsJson?: string;
  readonly callId?: string;
  readonly toolName?: string;
}

/** Non-content inputs that key the cache entry. */
interface KeyMeta {
  readonly role: Message['role'];
  readonly width: number;
  readonly lineNumberMode: 'all' | 'code' | 'off';
  readonly collapseThreshold: number;
  readonly showThinking: boolean;
  readonly showReasoningSummary: boolean;
  readonly blockBase: number;
  readonly kind: SystemMessageKind | undefined;
  /**
   * Per-call completion signature for an assistant message's tool calls (see
   * pendingToolKeyOf) — undefined when the message has none. Each call's id
   * is paired with whether it has a matching result yet, in call order, so a
   * SINGLE call finishing invalidates and re-renders that call's glyph from
   * ◌ to ✓ immediately. A prior aggregate boolean only flipped once EVERY
   * call in the message had completed, so in a multi-call turn the earlier
   * calls kept showing ◌ until the last result arrived.
   */
  readonly pendingToolKey: string | undefined;
  /**
   * Turn membership and tree-structure fields, flattened so a change
   * invalidates the entry like any other structural input.
   *
   * This is what makes connector glyphs safe to recompute rather than cache:
   * when a sibling arrives, the previously-last row's `connector` flips
   * `└`→`├`, that value differs from the cached one, and exactly that row
   * re-renders. Nothing else in the row changes, so the compositor repaints a
   * single connector cell.
   */
  readonly turnKey: string | undefined;
  readonly turnIsHead: boolean;
  readonly turnToolCount: number;
  readonly turnSharedLabel: string | undefined;
  readonly turnHasReasoning: boolean;
  /** Row depth and connector — both change when structure around a row changes. */
  readonly depth: number;
  readonly connector: string | undefined;
  /** Ancestor gutter pattern, flattened; a change repaints the row's gutters. */
  readonly openAncestors: string;
  /** Whether this row is followed by the blank separator. */
  readonly trailingBlank: boolean;
}

/**
 * Per-call completion signature for an assistant message's tool calls, in
 * call order — `id:0` or `id:1` per call, joined. Undefined for a message
 * with no tool calls at all (nothing to key). Comparing this instead of an
 * aggregate boolean lets exactly the calls whose completion status changed
 * invalidate the entry, rather than waiting for every call in the message to
 * complete before any of them re-renders as done.
 */
function pendingToolKeyOf(m: Message, outcomes: ReadonlyMap<string, ToolCallOutcome>): string | undefined {
  if (m.role !== 'assistant' || !m.toolCalls || m.toolCalls.length === 0) return undefined;
  // The OUTCOME, not merely ran/not-ran: a call whose result turns out to be a
  // failure must repaint its glyph from ◌ to ✗, which a boolean would miss.
  return m.toolCalls
    .map((tc) => `${tc.id ?? ''}:${(tc.id !== undefined && outcomes.get(tc.id)) || 'pending'}`)
    .join('|');
}

interface CacheEntry {
  readonly keyMeta: KeyMeta;
  readonly contentSig: ContentSig;
  /** Rendered lines for this message, INCLUDING the trailing blank line. */
  readonly lines: Line[];
  /** Block metas with startLine RELATIVE to the message's first line. */
  readonly blocks: BlockMeta[];
  /** Error-navigation line offsets, RELATIVE to the message's first line. */
  readonly errorRelLines: number[];
  /** [collapseKey, value] pairs the render read; a change invalidates the entry. */
  readonly collapseDeps: Array<[string, boolean | undefined]>;
  /** Memoised rebase of blocks/errors at appliedBase (avoids realloc when the
   *  message's buffer offset is unchanged across rebuilds — the common case). */
  appliedBase: number;
  appliedBlocks: BlockMeta[] | null;
  appliedErrors: number[] | null;
}

/** Build the content signature for a message. */
function contentSigOf(m: Message): ContentSig {
  if (m.role === 'user') {
    return {
      role: 'user',
      content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
      cancelled: m.cancelled,
    };
  }
  if (m.role === 'assistant') {
    return {
      role: 'assistant',
      content: m.content,
      model: m.model,
      provider: m.provider,
      reasoningContent: m.reasoningContent,
      reasoningSummary: m.reasoningSummary,
      toolCallsJson: m.toolCalls ? JSON.stringify(m.toolCalls) : undefined,
    };
  }
  if (m.role === 'system') {
    return { role: 'system', content: m.content };
  }
  return { role: 'tool', content: m.content, callId: m.callId, toolName: m.toolName };
}

/**
 * Compare a stored signature against a message WITHOUT allocating a new
 * signature object on the hot (unchanged string-content) path. Array-valued
 * fields fall back to JSON serialisation (rare).
 */
function contentUnchanged(sig: ContentSig, m: Message): boolean {
  if (sig.role !== m.role) return false;
  switch (m.role) {
    case 'user':
      return (
        sig.content === (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)) &&
        sig.cancelled === m.cancelled
      );
    case 'assistant':
      return (
        sig.content === m.content &&
        sig.model === m.model &&
        sig.provider === m.provider &&
        sig.reasoningContent === m.reasoningContent &&
        sig.reasoningSummary === m.reasoningSummary &&
        sig.toolCallsJson === (m.toolCalls ? JSON.stringify(m.toolCalls) : undefined)
      );
    case 'system':
      return sig.content === m.content;
    case 'tool':
      return sig.content === m.content && sig.callId === m.callId && sig.toolName === m.toolName;
    default:
      return false;
  }
}

/**
 * Wrap the real collapseState so reads (.get/.has) are recorded while writes
 * (.set — the auto-collapse default) pass straight through to the real map, so
 * the persistent collapse defaults are established exactly as a cold render
 * would establish them.
 */
function makeRecordingCollapseState(
  real: Map<string, boolean>,
  readKeys: Set<string>,
): Map<string, boolean> {
  return new Proxy(real, {
    get(target, prop, receiver) {
      if (prop === 'get') {
        return (key: string): boolean | undefined => {
          readKeys.add(key);
          return target.get(key);
        };
      }
      if (prop === 'has') {
        return (key: string): boolean => {
          readKeys.add(key);
          return target.has(key);
        };
      }
      void receiver;
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

/** Dispatch a single planned row to its render function. */
function renderOne(
  ctx: ConversationRenderContext,
  node: RenderNode,
  width: number,
  cfg: RenderConfig,
): void {
  if (node.kind === 'toolcall') {
    renderConversationToolCallNode(ctx, node, width);
    return;
  }
  const message = node.message;
  if (message.role === 'user') {
    renderConversationUserMessage(ctx, message, width, node.absIdx);
  } else if (message.role === 'assistant') {
    renderConversationAssistantMessage(ctx, message, width, cfg.lineNumberMode, cfg.collapseThreshold, node.absIdx);
  } else if (message.role === 'system') {
    renderConversationSystemMessage(ctx, message, width, node.absIdx);
  } else if (message.role === 'tool') {
    renderConversationToolMessage(ctx, message, width, node.absIdx, node);
  }
}

/**
 * MessageLineCache — per-message Line[] memoisation for ConversationManager.
 *
 * Keyed by absolute message index; each entry validates its COMPLETE input tuple
 * before serving. A rebuild that reuses entries is byte-identical to a cold
 * rebuild; the cache is a pure memoisation with no observable behaviour of its
 * own beyond speed and reduced allocation churn.
 */
export class MessageLineCache {
  private entries: Map<string, CacheEntry> = new Map();

  /** Drop all cached entries (wholesale message replacement / reset). */
  public clear(): void {
    this.entries.clear();
  }

  /** Number of retained entries (for tests / diagnostics). */
  public get size(): number {
    return this.entries.size;
  }

  /**
   * Render `messages` into `context`, reusing cached lines for unchanged
   * messages. Mirrors appendConversationMessages exactly on a cold cache; a warm
   * cache replays identical bytes at identical offsets.
   *
   * @param context               the live render context (real history buffer,
   *                              block/error registries, collapse state, config).
   * @param messages              the visible message slice to render.
   * @param width                 render width.
   * @param messageLineRegistry   absolute-index → first-line map, written here.
   * @param msgIndexOffset        absolute index of messages[0] (post-clearDisplay slice).
   * @param streamingPlaceholderAbsIdx  absolute index of the in-progress streaming
   *                              placeholder to leave uncached (-1 when not streaming);
   *                              the incremental streaming path owns its content.
   */
  public renderInto(
    context: ConversationRenderContext,
    messages: Message[],
    width: number,
    messageLineRegistry: number[],
    msgIndexOffset: number,
    streamingPlaceholderAbsIdx: number,
  ): void {
    const cfg: RenderConfig = {
      lineNumberMode: context.configManager?.get('display.lineNumbers') ?? 'off',
      collapseThreshold: context.configManager?.get('display.collapseThreshold') ?? 30,
      showThinking: context.configManager?.get('display.showThinking') ?? false,
      showReasoningSummary: context.configManager?.get('display.showReasoningSummary') ?? false,
    };

    // Tool calls with no matching tool-result message are still pending; the
    // render context and the cache key both depend on this. (item 2c.)
    const toolCallOutcomes = collectToolCallOutcomes(messages);
    const completedToolCallIds = new Set(toolCallOutcomes.keys());
    const assistantTurns = computeAssistantTurns(messages, msgIndexOffset);
    // Structural plan: a permutation of the slice (results lifted under their
    // calls, spawned agents spliced under the call that spawned them), rebuilt
    // every pass so connectors and nesting always reflect live structure.
    const plan = buildRenderPlan(messages, msgIndexOffset, {
      resolveAgentSnapshot: context.resolveAgentSnapshot,
    });
    const renderContext: ConversationRenderContext = { ...context, completedToolCallIds, toolCallOutcomes, assistantTurns };

    const touched = new Set<string>();
    const turnHeaderLines = new Map<string, number>();

    for (let i = 0; i < plan.length; i++) {
      const node = plan[i]!;
      const base = context.history.getLineCount();
      const blockBase = context.blockRegistry.length;
      const isRoot = node.scope === '';
      const turn = assistantTurns.get(node.absIdx);

      if (node.kind === 'message') {
        if (turn?.isHead) turnHeaderLines.set(turn.turnKey, base);
        // Nested rows index into their own agent's snapshot and must not write
        // the root transcript's registry.
        if (isRoot) {
          messageLineRegistry[node.absIdx] = turn && isTurnCollapsed(turn, context.collapseState)
            ? (turnHeaderLines.get(turn.turnKey) ?? base)
            : base;
        }
      }

      const next = plan[i + 1];
      const trailingBlank = !next || next.depth === 0;
      const uncacheable = isRoot && node.kind === 'message' && node.absIdx === streamingPlaceholderAbsIdx;
      const kind = isRoot ? context.messageKindRegistry.get(node.absIdx) : undefined;
      const pendingToolKey = pendingToolKeyOf(node.message, toolCallOutcomes);

      if (!uncacheable) {
        const existing = this.entries.get(node.id);
        if (existing && this.isValid(existing, node, width, cfg, blockBase, kind, pendingToolKey, turn, trailingBlank, context.collapseState)) {
          this.applyEntry(context, existing, base);
          touched.add(node.id);
          continue;
        }
      }

      const entry = this.renderScratch(renderContext, node, width, cfg, blockBase, kind, pendingToolKey, turn, trailingBlank);
      this.applyEntry(context, entry, base);
      if (!uncacheable) {
        this.entries.set(node.id, entry);
        touched.add(node.id);
      }
    }

    // Mark-and-sweep: a full rebuild plans every currently-visible row, so any
    // entry not touched this pass is gone (off-screen, or a row whose structure
    // no longer exists) and is dropped to bound memory to the visible set.
    if (this.entries.size > touched.size) {
      for (const key of this.entries.keys()) {
        if (!touched.has(key)) this.entries.delete(key);
      }
    }
  }

  /** Validate a cached entry against the row's current complete inputs. */
  private isValid(
    entry: CacheEntry,
    node: RenderNode,
    width: number,
    cfg: RenderConfig,
    blockBase: number,
    kind: SystemMessageKind | undefined,
    pendingToolKey: string | undefined,
    turn: AssistantTurnMembership | undefined,
    trailingBlank: boolean,
    collapseState: Map<string, boolean>,
  ): boolean {
    const k = entry.keyMeta;
    if (
      k.role !== node.message.role ||
      k.width !== width ||
      k.lineNumberMode !== cfg.lineNumberMode ||
      k.collapseThreshold !== cfg.collapseThreshold ||
      k.showThinking !== cfg.showThinking ||
      k.showReasoningSummary !== cfg.showReasoningSummary ||
      k.blockBase !== blockBase ||
      k.kind !== kind ||
      k.pendingToolKey !== pendingToolKey ||
      k.turnKey !== turn?.turnKey ||
      k.turnIsHead !== (turn?.isHead ?? false) ||
      k.turnToolCount !== (turn?.toolCallCount ?? 0) ||
      k.turnSharedLabel !== turn?.sharedToolLabel ||
      k.turnHasReasoning !== (turn?.hasReasoning ?? false) ||
      k.depth !== node.depth ||
      k.connector !== node.connector ||
      k.openAncestors !== node.openAncestorDepths.join(',') ||
      k.trailingBlank !== trailingBlank
    ) {
      return false;
    }
    if (!contentUnchanged(entry.contentSig, node.message)) return false;
    for (const [key, value] of entry.collapseDeps) {
      if (collapseState.get(key) !== value) return false;
    }
    return true;
  }

  /**
   * Render a single planned row into an isolated scratch context, capturing its
   * lines, block metas (row-relative), error-line offsets (row-relative), and
   * the collapse-state reads it depends on. Collapse-default WRITES pass
   * through to the real collapseState so persistent defaults match a cold render.
   */
  private renderScratch(
    context: ConversationRenderContext,
    node: RenderNode,
    width: number,
    cfg: RenderConfig,
    blockBase: number,
    kind: SystemMessageKind | undefined,
    pendingToolKey: string | undefined,
    turn: AssistantTurnMembership | undefined,
    trailingBlank: boolean,
  ): CacheEntry {
    const scratchLines: Line[] = [];
    const scratchHistory = {
      addLine: (line: Line): void => { scratchLines.push(line); },
      addLines: (lines: Line[]): void => { for (const line of lines) scratchLines.push(line); },
      getLineCount: (): number => scratchLines.length,
    };
    const scratchBlocks: BlockMeta[] = new Array(blockBase);
    const scratchErrors: number[] = [];
    const readKeys = new Set<string>();
    const recordingCollapse = makeRecordingCollapseState(context.collapseState, readKeys);

    const scratchCtx: ConversationRenderContext = {
      history: scratchHistory,
      blockRegistry: scratchBlocks,
      collapseState: recordingCollapse,
      errorLineRegistry: scratchErrors,
      messageKindRegistry: context.messageKindRegistry,
      configManager: context.configManager,
      splashOptions: context.splashOptions,
      completedToolCallIds: context.completedToolCallIds,
      toolCallOutcomes: context.toolCallOutcomes,
      assistantTurns: context.assistantTurns,
      resolveAgentSnapshot: context.resolveAgentSnapshot,
    };

    renderOne(scratchCtx, node, width, cfg);
    // A row that rendered nothing (hidden by a collapsed turn) gets no
    // separator either; otherwise the blank lands only after the last row of a
    // top-level unit, so a turn's subtree reads as one block.
    if (scratchLines.length > 0 && trailingBlank) {
      scratchLines.push(createEmptyLine(width));
    }

    const collapseDeps: Array<[string, boolean | undefined]> = [];
    for (const key of readKeys) collapseDeps.push([key, context.collapseState.get(key)]);

    return {
      keyMeta: {
        role: node.message.role,
        width,
        lineNumberMode: cfg.lineNumberMode,
        collapseThreshold: cfg.collapseThreshold,
        showThinking: cfg.showThinking,
        showReasoningSummary: cfg.showReasoningSummary,
        blockBase,
        kind,
        pendingToolKey,
        turnKey: turn?.turnKey,
        turnIsHead: turn?.isHead ?? false,
        turnToolCount: turn?.toolCallCount ?? 0,
        turnSharedLabel: turn?.sharedToolLabel,
        turnHasReasoning: turn?.hasReasoning ?? false,
        depth: node.depth,
        connector: node.connector,
        openAncestors: node.openAncestorDepths.join(','),
        trailingBlank,
      },
      contentSig: contentSigOf(node.message),
      lines: scratchLines,
      blocks: scratchBlocks.slice(blockBase),
      errorRelLines: scratchErrors,
      collapseDeps,
      appliedBase: -1,
      appliedBlocks: null,
      appliedErrors: null,
    };
  }

  /**
   * Replay an entry into the live context at buffer offset `base`. Line objects
   * are shared (never mutated post-production — the compositor reads them into a
   * separate back-buffer). Block/error rebasing is memoised per base so an
   * unchanged message pays zero allocation across rebuilds.
   */
  private applyEntry(context: ConversationRenderContext, entry: CacheEntry, base: number): void {
    context.history.addLines(entry.lines);

    if (entry.appliedBase !== base || entry.appliedBlocks === null || entry.appliedErrors === null) {
      entry.appliedBlocks = entry.blocks.map((b) => ({ ...b, startLine: b.startLine + base }));
      entry.appliedErrors = entry.errorRelLines.map((e) => e + base);
      entry.appliedBase = base;
    }

    const registry = context.blockRegistry;
    for (const block of entry.appliedBlocks) registry.push(block);
    const errors = context.errorLineRegistry;
    for (const line of entry.appliedErrors) errors.push(line);
  }
}
