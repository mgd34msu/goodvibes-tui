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
  renderConversationToolMessage,
  renderConversationUserMessage,
  collectCompletedToolCallIds,
} from './conversation-rendering.ts';
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
   * True when this (assistant) message has a tool call with no result yet — it
   * renders as pending rather than done. Keyed so the entry invalidates and
   * re-renders ✓ once the tool result arrives. (item 2c.)
   */
  readonly hasPendingTool: boolean;
}

/** Whether an assistant message has any tool call still awaiting a result. */
function hasPendingToolCall(m: Message, completed: ReadonlySet<string>): boolean {
  if (m.role !== 'assistant' || !m.toolCalls) return false;
  return m.toolCalls.some((tc) => tc.id === undefined || !completed.has(tc.id));
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

/** Dispatch a single message to its render function. */
function renderOne(
  ctx: ConversationRenderContext,
  message: Message,
  width: number,
  absoluteIdx: number,
  cfg: RenderConfig,
): void {
  if (message.role === 'user') {
    renderConversationUserMessage(ctx, message, width, absoluteIdx);
  } else if (message.role === 'assistant') {
    renderConversationAssistantMessage(ctx, message, width, cfg.lineNumberMode, cfg.collapseThreshold, absoluteIdx);
  } else if (message.role === 'system') {
    renderConversationSystemMessage(ctx, message, width, absoluteIdx);
  } else if (message.role === 'tool') {
    renderConversationToolMessage(ctx, message, width, absoluteIdx);
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
  private entries: Map<number, CacheEntry> = new Map();

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
    const completedToolCallIds = collectCompletedToolCallIds(messages);
    const renderContext: ConversationRenderContext = { ...context, completedToolCallIds };

    const touched = new Set<number>();

    for (let i = 0; i < messages.length; i++) {
      const message = messages[i]!;
      const absoluteIdx = msgIndexOffset + i;
      const base = context.history.getLineCount();
      const blockBase = context.blockRegistry.length;
      messageLineRegistry[absoluteIdx] = base;

      const uncacheable = absoluteIdx === streamingPlaceholderAbsIdx;
      const kind = context.messageKindRegistry.get(absoluteIdx);
      const hasPendingTool = hasPendingToolCall(message, completedToolCallIds);

      if (!uncacheable) {
        const existing = this.entries.get(absoluteIdx);
        if (existing && this.isValid(existing, message, width, cfg, blockBase, kind, hasPendingTool, context.collapseState)) {
          this.applyEntry(context, existing, base);
          touched.add(absoluteIdx);
          continue;
        }
      }

      const entry = this.renderScratch(renderContext, message, width, absoluteIdx, cfg, blockBase, kind, hasPendingTool);
      this.applyEntry(context, entry, base);
      if (!uncacheable) {
        this.entries.set(absoluteIdx, entry);
        touched.add(absoluteIdx);
      }
    }

    // Mark-and-sweep: a full rebuild renders every currently-visible message, so
    // any entry not touched this pass is off-screen (or evicted by a shrink) and
    // is dropped to bound memory to the visible set.
    if (this.entries.size > touched.size) {
      for (const key of this.entries.keys()) {
        if (!touched.has(key)) this.entries.delete(key);
      }
    }
  }

  /** Validate a cached entry against the message's current complete inputs. */
  private isValid(
    entry: CacheEntry,
    message: Message,
    width: number,
    cfg: RenderConfig,
    blockBase: number,
    kind: SystemMessageKind | undefined,
    hasPendingTool: boolean,
    collapseState: Map<string, boolean>,
  ): boolean {
    const k = entry.keyMeta;
    if (
      k.role !== message.role ||
      k.width !== width ||
      k.lineNumberMode !== cfg.lineNumberMode ||
      k.collapseThreshold !== cfg.collapseThreshold ||
      k.showThinking !== cfg.showThinking ||
      k.showReasoningSummary !== cfg.showReasoningSummary ||
      k.blockBase !== blockBase ||
      k.kind !== kind ||
      k.hasPendingTool !== hasPendingTool
    ) {
      return false;
    }
    if (!contentUnchanged(entry.contentSig, message)) return false;
    for (const [key, value] of entry.collapseDeps) {
      if (collapseState.get(key) !== value) return false;
    }
    return true;
  }

  /**
   * Render a single message into an isolated scratch context, capturing its
   * lines, block metas (message-relative), error-line offsets (message-relative),
   * and the collapse-state reads it depends on. Collapse-default WRITES pass
   * through to the real collapseState so persistent defaults match a cold render.
   */
  private renderScratch(
    context: ConversationRenderContext,
    message: Message,
    width: number,
    absoluteIdx: number,
    cfg: RenderConfig,
    blockBase: number,
    kind: SystemMessageKind | undefined,
    hasPendingTool: boolean,
  ): CacheEntry {
    const scratchLines: Line[] = [];
    const scratchHistory = {
      addLine: (line: Line): void => { scratchLines.push(line); },
      addLines: (lines: Line[]): void => { for (const line of lines) scratchLines.push(line); },
      getLineCount: (): number => scratchLines.length,
    };
    // Pre-size to blockBase so blockRegistry.length (the global block index the
    // collapseKey embeds) matches the live registry; slice(blockBase) recovers
    // only this message's blocks afterwards.
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
    };

    renderOne(scratchCtx, message, width, absoluteIdx, cfg);
    // Trailing blank line, exactly as appendConversationMessages appends per message.
    scratchLines.push(createEmptyLine(width));

    const collapseDeps: Array<[string, boolean | undefined]> = [];
    for (const key of readKeys) collapseDeps.push([key, context.collapseState.get(key)]);

    return {
      keyMeta: {
        role: message.role,
        width,
        lineNumberMode: cfg.lineNumberMode,
        collapseThreshold: cfg.collapseThreshold,
        showThinking: cfg.showThinking,
        showReasoningSummary: cfg.showReasoningSummary,
        blockBase,
        kind,
        hasPendingTool,
      },
      contentSig: contentSigOf(message),
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
