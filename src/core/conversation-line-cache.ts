/**
 * conversation-line-cache.ts, per-unit Line[] production cache.
 *
 * The measured defect (perf baseline 2026-07-03, transcript.build_1k): appending
 * ONE message to an N-message conversation re-rendered all N messages, because
 * ConversationManager.rebuildHistory() clears the buffer and renders the whole
 * snapshot on every dirty flag. The marginal work for one appended message is a
 * tiny fraction of that.
 *
 * This module memoises the render of each transcript UNIT (see
 * work-tree-model.ts transcriptUnits): a user message, a standalone system
 * message, or one assistant turn with its whole work tree. A unit's lines are a
 * pure function of its complete inputs:
 *
 *   message unit: the message's render-relevant fields, the width, the display
 *     config the render reads, the theme's token table (identity), the
 *     system-message kind, and the live value of every collapse key it read.
 *
 *   turn unit: the turn's model signature (work-tree-model.ts turnSignature:
 *     every row's status, text, time, fold and open state, and the content of
 *     its prose and opened bodies), the width, the display config, the theme,
 *     the glyph set, the collapse keys the draw read (code blocks, thinking),
 *     the focused row when it is one of this turn's rows, the spinner frame
 *     while the turn has something live, and the semantic-summary generation
 *     while it draws an opened diff.
 *
 * The turn MODEL is rebuilt every pass (it is cheap: it reads messages and the
 * live sources); the DRAW (markdown, lane layout, painting) is what the cache
 * saves.
 *
 * Correctness contract: a cache-served rebuild is BYTE-IDENTICAL to a cold
 * appendConversationMessages() rebuild. A miss renders through the same
 * functions into an isolated scratch context, and the captured lines, block
 * metas and error lines are replayed at the same buffer offsets.
 */

import { createEmptyLine, type Line } from '@pellux/goodvibes-sdk/platform/types';
import type { BlockMeta } from './conversation-types.ts';
import {
  buildConversationTurnModel,
  drawConversationTurn,
  renderConversationMessageUnit,
  type ConversationRenderContext,
} from './conversation-rendering.ts';
import { activeTokens } from '../renderer/theme.ts';
import { semanticSummaryGeneration } from '../renderer/lane-graph/semantic-memo.ts';
import { syntaxHighlightGeneration, syntaxHighlightMisses } from '../renderer/code-block.ts';
import type { GutterRow } from '../renderer/lane-graph/layout.ts';
import { transcriptUnits, turnHasOpenDiff, turnSignature, type TranscriptUnit } from './work-tree-model.ts';
import type { ConversationMessageSnapshot } from '@pellux/goodvibes-sdk/platform/core';
// SystemMessageKind imported from runtime directly to avoid a cycle, mirroring
// conversation-rendering.ts's own import.
import type { SystemMessageKind } from '@/runtime/index.ts';

type Message = ConversationMessageSnapshot;
type Part = string | number | boolean | undefined | null | object;

/** The gutter a streaming continuation of the last turn draws with. */
export interface TurnTail {
  readonly gutter: GutterRow;
  readonly gutterWidth: number;
}

interface CacheEntry {
  /** Every input the unit's lines depend on, compared element by element. */
  readonly key: readonly Part[];
  /** [collapseKey, value] pairs the render read; a change invalidates the entry. */
  readonly collapseDeps: ReadonlyArray<readonly [string, boolean | undefined]>;
  /** Focusable row ids this unit drew (a focus change re-renders only units that hold it). */
  readonly focusIds: ReadonlySet<string>;
  /** The focus id this entry was drawn with, when it is one of its own rows. */
  readonly focusDrawn: string | null;
  /** Rendered lines, INCLUDING the trailing blank line. */
  readonly lines: Line[];
  /** Block metas with startLine relative to the unit. */
  readonly blocks: BlockMeta[];
  /** Error-navigation line offsets relative to the unit. */
  readonly errorRelLines: number[];
  /** absolute message index → relative line (every message the unit covers). */
  readonly messageLines: ReadonlyMap<number, number>;
  readonly tail: TurnTail | null;
  /**
   * Set when the unit drew code with the regex placeholder while its
   * tree-sitter parse was on its way: the highlighter generation it saw. The
   * entry is stale once a parse lands (the generation moves on), so the next
   * build draws the real highlighting instead of keeping the placeholder.
   */
  readonly highlightGeneration?: number | undefined;
}

function sameParts(a: readonly Part[], b: readonly Part[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function messageParts(m: Message): Part[] {
  switch (m.role) {
    case 'user': return ['user', typeof m.content === 'string' ? m.content : JSON.stringify(m.content), m.cancelled];
    case 'system': return ['system', m.content];
    case 'tool': return ['tool', m.content, m.callId, m.toolName];
    case 'assistant': return ['assistant', m.content];
  }
}

/**
 * Wrap the real collapseState so reads (.get/.has) are recorded while writes
 * (defaults such as a long code block starting collapsed) pass straight through
 * to the real map, exactly as a cold render would establish them.
 */
function makeRecordingCollapseState(real: Map<string, boolean>, readKeys: Set<string>): Map<string, boolean> {
  return new Proxy(real, {
    get(target, prop) {
      if (prop === 'get') {
        return (key: string): boolean | undefined => { readKeys.add(key); return target.get(key); };
      }
      if (prop === 'has') {
        return (key: string): boolean => { readKeys.add(key); return target.has(key); };
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

function unitId(unit: TranscriptUnit): string {
  return unit.kind === 'turn' ? `t:${unit.headIndex}` : `m:${unit.index}`;
}

/**
 * MessageLineCache, per-unit Line[] memoisation for ConversationManager.
 * A rebuild that reuses entries is byte-identical to a cold rebuild.
 */
export class MessageLineCache {
  private entries: Map<string, CacheEntry> = new Map();
  private _lastTail: TurnTail | null = null;
  private _live = false;

  /** Drop all cached entries (wholesale message replacement / reset). */
  public clear(): void {
    this.entries.clear();
  }

  /** Number of retained entries (for tests / diagnostics). */
  public get size(): number {
    return this.entries.size;
  }

  /** The gutter under the last rendered unit, when that unit is a turn. */
  public get lastTail(): TurnTail | null {
    return this._lastTail;
  }

  /** Whether the last pass drew anything live (a running bead or lane, a working turn). */
  public get live(): boolean {
    return this._live;
  }

  /**
   * Render `messages` into `context`, reusing cached lines for unchanged units.
   *
   * @param msgIndexOffset        absolute index of messages[0] (post-clearDisplay slice).
   * @param streamingPlaceholderAbsIdx  absolute index of the in-progress streaming
   *                              placeholder (-1 when not streaming); its prose is drawn
   *                              by the incremental streaming path.
   */
  public renderInto(
    context: ConversationRenderContext,
    messages: Message[],
    width: number,
    messageLineRegistry: number[],
    msgIndexOffset: number,
    streamingPlaceholderAbsIdx: number,
  ): void {
    const config = context.configManager;
    const common: Part[] = [
      width,
      config?.get('display.lineNumbers') ?? 'off',
      config?.get('display.collapseThreshold') ?? 30,
      config?.get('display.showThinking') ?? false,
      config?.get('display.showReasoningSummary') ?? false,
      activeTokens(),
      context.treeGlyphSet ?? 'rounded',
    ];
    const focus = context.focusId ?? null;
    const touched = new Set<string>();
    this._lastTail = null;
    this._live = false;

    for (const unit of transcriptUnits(messages, msgIndexOffset)) {
      const id = unitId(unit);
      const base = context.history.getLineCount();
      const readKeys = new Set<string>();
      const scratchCollapse = makeRecordingCollapseState(context.collapseState, readKeys);
      const scratchContext: ConversationRenderContext = { ...context, collapseState: scratchCollapse };

      // The turn still streaming ends without its blank row: the streamed text continues under its spine.
      const streaming = unit.kind === 'turn' && streamingPlaceholderAbsIdx >= unit.start && streamingPlaceholderAbsIdx <= unit.end;
      let key: Part[];
      let turnModel: ReturnType<typeof buildConversationTurnModel> | undefined;
      if (unit.kind === 'turn') {
        turnModel = buildConversationTurnModel(scratchContext, messages, msgIndexOffset, unit, streamingPlaceholderAbsIdx);
        if (turnModel.live) this._live = true;
        key = [
          'turn', ...common, streaming,
          turnModel.live ? context.frame ?? 0 : null,
          turnHasOpenDiff(turnModel) ? semanticSummaryGeneration() : null,
          ...turnSignature(turnModel),
        ];
      } else {
        const message = messages[unit.index - msgIndexOffset]!;
        const kind: SystemMessageKind | undefined = context.messageKindRegistry.get(unit.index);
        key = ['message', ...common, unit.index, kind, ...messageParts(message)];
      }

      const existing = this.entries.get(id);
      if (existing && this.isValid(existing, key, focus, context.collapseState)) {
        this.apply(context, existing, base, messageLineRegistry);
        touched.add(id);
        continue;
      }

      const missesBefore = syntaxHighlightMisses();
      const drawn = this.renderScratch(scratchContext, unit, turnModel, messages, msgIndexOffset, width, key, readKeys, focus, streaming);
      const entry: CacheEntry = syntaxHighlightMisses() !== missesBefore ? { ...drawn, highlightGeneration: syntaxHighlightGeneration() } : drawn;
      this.apply(context, entry, base, messageLineRegistry);
      this.entries.set(id, entry);
      touched.add(id);
    }

    // Mark-and-sweep: a full rebuild plans every visible unit, so an entry not
    // touched this pass is gone and is dropped to bound memory.
    if (this.entries.size > touched.size) {
      for (const id of this.entries.keys()) if (!touched.has(id)) this.entries.delete(id);
    }
  }

  private isValid(entry: CacheEntry, key: readonly Part[], focus: string | null, collapseState: Map<string, boolean>): boolean {
    if (!sameParts(entry.key, key)) return false;
    if (entry.highlightGeneration !== undefined && entry.highlightGeneration !== syntaxHighlightGeneration()) return false;
    const focusHere = focus !== null && entry.focusIds.has(focus) ? focus : null;
    if (focusHere !== entry.focusDrawn) return false;
    for (const [k, value] of entry.collapseDeps) if (collapseState.get(k) !== value) return false;
    return true;
  }

  private renderScratch(
    context: ConversationRenderContext,
    unit: TranscriptUnit,
    turnModel: ReturnType<typeof buildConversationTurnModel> | undefined,
    messages: readonly Message[],
    offset: number,
    width: number,
    key: Part[],
    readKeys: Set<string>,
    focus: string | null,
    streaming: boolean,
  ): CacheEntry {
    const lines: Line[] = [];
    const blocks: BlockMeta[] = [];
    const errors: number[] = [];
    const messageLines = new Map<number, number>();
    let focusIds: ReadonlySet<string> = new Set();
    let tail: TurnTail | null = null;

    if (unit.kind === 'turn' && turnModel) {
      const render = drawConversationTurn(context, turnModel, width);
      lines.push(...render.lines);
      blocks.push(...render.blocks);
      errors.push(...render.errorLines);
      for (const [index, line] of render.messageLines) messageLines.set(index, line);
      for (let index = unit.start; index <= unit.end; index++) if (!messageLines.has(index)) messageLines.set(index, 0);
      focusIds = render.focusIds;
      tail = render.tail;
    } else if (unit.kind === 'message') {
      const scratch: ConversationRenderContext = {
        ...context,
        history: {
          addLine: (line: Line): void => { lines.push(line); },
          addLines: (more: Line[]): void => { for (const line of more) lines.push(line); },
          getLineCount: (): number => lines.length,
        },
        blockRegistry: blocks,
        errorLineRegistry: errors,
      };
      renderConversationMessageUnit(scratch, messages[unit.index - offset]!, width, unit.index);
      messageLines.set(unit.index, 0);
    }
    if (lines.length > 0 && !streaming) lines.push(createEmptyLine(width));

    const collapseDeps: Array<readonly [string, boolean | undefined]> = [];
    for (const k of readKeys) collapseDeps.push([k, context.collapseState.get(k)]);
    return {
      key,
      collapseDeps,
      focusIds,
      focusDrawn: focus !== null && focusIds.has(focus) ? focus : null,
      lines,
      blocks,
      errorRelLines: errors,
      messageLines,
      tail,
    };
  }

  /**
   * Replay an entry into the live context at buffer offset `base`. Line objects
   * are shared (never mutated after production).
   */
  private apply(context: ConversationRenderContext, entry: CacheEntry, base: number, messageLineRegistry: number[]): void {
    context.history.addLines(entry.lines);
    const registry = context.blockRegistry;
    for (const block of entry.blocks) registry.push({ ...block, blockIndex: registry.length, startLine: block.startLine + base });
    for (const line of entry.errorRelLines) context.errorLineRegistry.push(line + base);
    for (const [index, line] of entry.messageLines) messageLineRegistry[index] = base + line;
    this._lastTail = entry.tail;
  }
}
