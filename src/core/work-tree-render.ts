/**
 * work-tree-render.ts, drawing one TurnModel into transcript lines.
 *
 * Lays the turn's lanes out (lane-graph/layout.ts), paints every row
 * (lane-graph/paint.ts), opens bodies under their beads, and reports what the
 * rest of the transcript needs: the block registry entries (so copy, save,
 * bookmark, Tab and /expand work on beads), the line each message landed on,
 * the focusable rows, and the gutter a still-streaming answer continues with.
 *
 * Line numbers in the result are relative to the turn's first line.
 */

import { createEmptyLine, type Line } from '@pellux/goodvibes-sdk/platform/types';
import { parseDiffForApply } from '@pellux/goodvibes-sdk/platform/core';
import { MARKDOWN_TEXT_COL, renderMarkdown, renderMarkdownTracked } from '../renderer/markdown.ts';
import { renderSystemMessage } from '../renderer/system-message.ts';
import { renderThinkingBlock } from '../renderer/thinking.ts';
import { renderConversationFoldedRow } from '../renderer/conversation-surface.ts';
import { BORDERS } from '../renderer/layout.ts';
import { UIFactory } from '../renderer/ui-factory.ts';
import { activeTokens } from '../renderer/theme.ts';
import { laneGlyphs, type TreeGlyphSetName } from '../renderer/lane-graph/glyphs.ts';
import { layoutLaneGraph, SPINE, type GutterRow, type LaneEvent } from '../renderer/lane-graph/layout.ts';
import {
  applyFocus,
  laneColor,
  paintBeadRow,
  paintBody,
  paintFoldedRow,
  paintGutter,
  paintHeadRow,
  paintMergeRow,
  paintSpawnRow,
  shiftUnderGutter,
  textColumn,
  type GraphPaint,
} from '../renderer/lane-graph/paint.ts';
import { semanticSummaryFor } from '../renderer/lane-graph/semantic-memo.ts';
import type { BlockMeta } from './conversation-types.ts';
import { beadKeyOf, beadMoreKeyOf, type BeadModel, type LaneModel, type TurnModel, type TurnRow } from './work-tree-model.ts';

export interface TurnRenderOptions {
  readonly width: number;
  readonly glyphSet: TreeGlyphSetName;
  /** Focused row id, when the keyboard is in the work tree. */
  readonly focusId: string | null;
  readonly lineNumberMode: 'all' | 'code' | 'off';
  readonly collapseThreshold: number;
  /** Code blocks longer than the threshold start collapsed: their default is written here. */
  readonly collapseState: Map<string, boolean>;
  /** Whether a system message at this index is navigable (error navigation). */
  readonly isNavigableSystem: (messageIndex: number) => boolean;
  /** Spinner frame for running beads. */
  readonly frame: number;
}

export interface TurnRender {
  readonly lines: Line[];
  /** Block metas with startLine relative to the turn and blockIndex relative to the turn's first block. */
  readonly blocks: BlockMeta[];
  readonly errorLines: number[];
  /** absolute message index → first relative line. */
  readonly messageLines: ReadonlyMap<number, number>;
  readonly focusIds: ReadonlySet<string>;
  /** The gutter under the turn's last row and the turn's text column, for a streaming continuation. */
  readonly tail: { readonly gutter: GutterRow; readonly gutterWidth: number };
}

/** Focus ids: beads by bead id, lanes and turns by their collapse key. */
export function laneFocusId(lane: LaneModel): string {
  return lane.key;
}

function eventFor(row: TurnRow, folded: boolean): LaneEvent {
  switch (row.kind) {
    case 'head': return folded ? { kind: 'turn' } : { kind: 'head' };
    case 'prose': return { kind: 'row' };
    case 'bead': return { kind: 'bead', lane: row.bead.lane };
    case 'spawn': return { kind: 'spawn', parent: row.lane.parent, lane: row.lane.id };
    case 'merge': return { kind: 'merge', lane: row.lane.id };
    case 'folded': return { kind: 'folded', lane: row.lane.parent, child: row.lane.id };
    case 'answer': return { kind: 'answer' };
  }
}

/** Prose at the text column: markdown rendered narrower and shifted, code blocks registered. */
function proseLines(
  content: string,
  messageIndex: number,
  p: GraphPaint,
  options: TurnRenderOptions,
  blocks: BlockMeta[],
  baseLine: number,
): Line[] {
  const shift = Math.max(0, textColumn(p) - MARKDOWN_TEXT_COL);
  const width = Math.max(20, p.width - shift);
  const numbered = options.lineNumberMode === 'all';
  const numWidth = numbered ? Math.max(3, String(content.split('\n').length).length) : 0;
  const gutter = numbered ? numWidth + 3 : 0;
  const { lines, codeBlocks } = renderMarkdownTracked(content, width - gutter, { codeBlockLineNumbers: options.lineNumberMode === 'code' });
  for (const cb of codeBlocks) {
    const collapseKey = `code_${messageIndex}_${cb.startOffset}`;
    if (cb.rawContent.split('\n').length > options.collapseThreshold && !options.collapseState.has(collapseKey)) {
      options.collapseState.set(collapseKey, true);
    }
    blocks.push({ blockIndex: blocks.length, collapseKey, type: 'code', startLine: baseLine + cb.startOffset, lineCount: cb.lineCount, rawContent: cb.rawContent });
  }
  if (!numbered) return lines;
  return lines.map((line, i) => {
    const out = createEmptyLine(width);
    const label = UIFactory.stringToLine(`${String(i + 1).padStart(numWidth)} │ `, gutter, { fg: activeTokens().textFaint });
    for (let c = 0; c < gutter; c++) out[MARKDOWN_TEXT_COL + c] = label[c] ?? out[MARKDOWN_TEXT_COL + c]!;
    for (let c = MARKDOWN_TEXT_COL; c < line.length && c + gutter < width; c++) out[c + gutter] = line[c]!;
    return out;
  });
}

function systemLines(content: string, p: GraphPaint): Line[] {
  const shift = Math.max(0, textColumn(p) - MARKDOWN_TEXT_COL);
  return renderSystemMessage(content, Math.max(20, p.width - shift));
}

function beadMeta(bead: BeadModel, startLine: number, lineCount: number, capped: boolean, laneKey: string | undefined): BlockMeta {
  const isDiff = bead.body?.kind === 'diff';
  const raw = bead.result ?? JSON.stringify(bead.call.arguments, null, 2);
  let meta: BlockMeta = {
    blockIndex: 0,
    collapseKey: beadKeyOf(bead.id),
    type: isDiff ? 'diff' : 'tool',
    startLine,
    lineCount,
    rawContent: isDiff && bead.body?.kind === 'diff' ? bead.body.diff : raw,
    toolName: bead.call.name,
    workTree: { kind: 'bead', id: bead.id, hasBody: bead.body !== null, open: bead.open, capped, moreKey: beadMoreKeyOf(bead.id), laneKey },
  };
  if (bead.body?.kind === 'diff' && bead.body.numbered) {
    const parsed = parseDiffForApply(bead.body.diff);
    if (parsed.filePath) meta = { ...meta, ...parsed };
  }
  return meta;
}

export function renderTurn(model: TurnModel, options: TurnRenderOptions): TurnRender {
  const glyphs = laneGlyphs(options.glyphSet);
  const folded = model.folded;
  // A turn with nothing for its header to say and no calls or agents is plain
  // prose: no spine, no header row, the text at the text column.
  const bare = model.headerText === '' && model.toolCount === 0 && model.agentCount === 0;
  // A folded turn is its header plus its answer; nothing else draws.
  const rows = bare ? model.rows.filter((r) => r.kind !== 'head') : folded ? model.rows.filter((r) => r.kind === 'head' || r.kind === 'answer') : model.rows;
  const layout = layoutLaneGraph(rows.map((r) => ((folded || bare) && (r.kind === 'answer' || r.kind === 'prose') ? { kind: 'row' } as const : eventFor(r, folded))));
  const p: GraphPaint = { width: options.width, gutterWidth: layout.gutterWidth, glyphs, frame: options.frame };

  const lines: Line[] = [];
  const blocks: BlockMeta[] = [];
  const errorLines: number[] = [];
  const messageLines = new Map<number, number>();
  const focusIds = new Set<string>();
  const laneOfBead = new Map<string, string>();
  const noteMessage = (index: number | undefined, line: number): void => {
    if (index !== undefined && index >= 0 && !messageLines.has(index)) messageLines.set(index, line);
  };
  const focusIf = (line: Line, id: string): void => {
    focusIds.add(id);
    if (options.focusId === id) applyFocus(line, options.width, glyphs);
  };

  const resultMembers: Array<{ index: number; key: string }> = [];
  for (const row of model.rows) {
    const bead = row.kind === 'bead' || row.kind === 'spawn' || row.kind === 'folded' ? row.bead : undefined;
    if (bead?.resultIndex !== undefined) resultMembers.push({ index: bead.resultIndex, key: beadKeyOf(bead.id) });
  }

  rows.forEach((row, i) => {
    const gutter = layout.rows[i]!;
    const cont = layout.cont[i]!;
    // Two prose blocks in a row keep a blank row between them, lanes running past it.
    if ((row.kind === 'prose' || row.kind === 'answer') && rows[i - 1]?.kind === 'prose') {
      const blank = createEmptyLine(options.width);
      if (!folded && !bare) paintGutter(blank, layout.cont[i - 1]!, p);
      lines.push(blank);
    }
    const start = lines.length;
    switch (row.kind) {
      case 'head': {
        const line = paintHeadRow(gutter, model.headerText, folded, p);
        focusIf(line, model.turnKey);
        lines.push(line);
        noteMessage(model.headIndex, start);
        blocks.push({
          blockIndex: 0,
          collapseKey: model.turnKey,
          type: 'assistant_turn',
          startLine: start,
          lineCount: 1,
          rawContent: `assistant turn: ${model.headerText}`,
          // Result messages behind closed beads, paired with the bead keys that reveal them.
          groupMemberIndexes: resultMembers.map((m) => m.index),
          groupMemberKeys: resultMembers.map((m) => m.key),
          workTree: { kind: 'turn', id: model.turnKey, hasBody: true, open: !folded, capped: false },
        });
        break;
      }
      case 'prose': {
        if (row.role === 'thinking' || row.role === 'summary') {
          const shift = Math.max(0, textColumn(p) - MARKDOWN_TEXT_COL);
          const width = Math.max(20, p.width - shift);
          let body: Line[];
          if (row.role === 'thinking') {
            // Collapsed by default: one row naming the size; the text stays behind the toggle.
            const collapseKey = `msg_${row.messageIndex}_thinking`;
            if (!options.collapseState.has(collapseKey)) options.collapseState.set(collapseKey, true);
            const collapsed = options.collapseState.get(collapseKey) === true;
            const count = row.content.split('\n').length;
            body = collapsed
              ? [renderConversationFoldedRow(width, {
                marker: BORDERS.THINKING.char,
                markerFg: activeTokens().reasoning,
                label: 'thinking',
                labelFg: activeTokens().reasoning,
                detailFg: activeTokens().textMuted,
              }, [{ text: ` ${glyphs.closed} ${count} line${count === 1 ? '' : 's'} `, fg: activeTokens().textFaint }], '')]
              : renderThinkingBlock(row.content, width);
            blocks.push({ blockIndex: 0, collapseKey, type: 'thinking', startLine: start, lineCount: body.length, rawContent: row.content });
          } else {
            body = renderThinkingBlock(row.content, width);
          }
          for (const source of body) lines.push(shiftUnderGutter(source, shift, cont, p));
          break;
        }
        const body = row.role === 'assistant' ? proseLines(row.content, row.messageIndex, p, options, blocks, start) : systemLines(row.content, p);
        const shift = Math.max(0, textColumn(p) - MARKDOWN_TEXT_COL);
        for (const source of body) lines.push(shiftUnderGutter(source, shift, cont, p));
        if (row.role === 'system' && options.isNavigableSystem(row.messageIndex)) errorLines.push(start);
        noteMessage(row.messageIndex, start);
        break;
      }
      case 'answer': {
        const shift = Math.max(0, textColumn(p) - MARKDOWN_TEXT_COL);
        const body = proseLines(row.content, row.messageIndex, p, options, blocks, start);
        const first = Math.max(0, body.findIndex((l) => l.some((c) => c.char !== ' ' && c.char !== '')));
        body.forEach((source, k) => {
          const before = i > 0 ? layout.cont[i - 1]! : cont;
          const g = folded || bare ? null : k === first ? gutter : k < first ? before : cont;
          lines.push(shiftUnderGutter(source, shift, g, p));
        });
        noteMessage(row.messageIndex, start);
        break;
      }
      case 'bead': {
        const bead = row.bead;
        const color = laneColor(layout.laneColor.get(bead.lane) ?? 0);
        const line = paintBeadRow(gutter, {
          status: bead.status,
          name: bead.name,
          arg: bead.arg,
          summary: bead.summary,
          time: bead.time,
          laneColor: color,
          hasBody: bead.body !== null,
          open: bead.open,
          answers: bead.answers,
        }, p);
        focusIf(line, bead.id);
        lines.push(line);
        let capped = false;
        if (bead.open && bead.body) {
          const semantic = bead.body.kind === 'diff' ? semanticSummaryFor(bead.body.diff, bead.body.path) : undefined;
          const drawn = paintBody(bead.body, p, { expanded: bead.expanded, semantic });
          capped = drawn.capped;
          for (const bodyLine of drawn.lines) {
            paintGutter(bodyLine, cont, p);
            lines.push(bodyLine);
          }
        }
        const laneKey = bead.lane === SPINE ? undefined : laneOfBead.get(bead.lane);
        blocks.push(beadMeta(bead, start, lines.length - start, capped || (bead.open && bead.expanded), laneKey));
        noteMessage(bead.scope === '' ? bead.messageIndex : undefined, start);
        noteMessage(bead.resultIndex, start);
        break;
      }
      case 'spawn':
      case 'folded': {
        const lane = row.lane;
        laneOfBead.set(lane.id, lane.key);
        const color = laneColor(layout.laneColor.get(lane.id) ?? 0);
        const line = row.kind === 'spawn'
          ? paintSpawnRow(gutter, { name: lane.name, arg: lane.arg, laneColor: color }, p)
          : paintFoldedRow(gutter, { name: lane.name, arg: lane.arg, laneColor: color, outcome: lane.outcome, summary: lane.foldSummary, time: lane.time }, p);
        focusIf(line, laneFocusId(lane));
        lines.push(line);
        blocks.push({
          blockIndex: 0,
          collapseKey: lane.key,
          type: 'tool',
          startLine: start,
          lineCount: 1,
          rawContent: `${lane.name}: ${lane.arg}\n${lane.mergeText}`,
          toolName: row.bead.call.name,
          workTree: { kind: 'lane', id: laneFocusId(lane), hasBody: true, open: row.kind === 'spawn', capped: false, finished: lane.outcome !== 'run', laneKey: lane.key },
        });
        noteMessage(row.bead.scope === '' ? row.bead.messageIndex : undefined, start);
        noteMessage(row.bead.resultIndex, start);
        break;
      }
      case 'merge': {
        lines.push(paintMergeRow(gutter, row.lane.mergeText, row.lane.outcome === 'warn' || row.lane.outcome === 'err', p));
        break;
      }
    }
  });

  blocks.forEach((b, k) => { b.blockIndex = k; });
  return {
    lines,
    blocks,
    errorLines,
    messageLines,
    focusIds,
    tail: { gutter: layout.cont[layout.cont.length - 1] ?? [], gutterWidth: layout.gutterWidth },
  };
}

/**
 * Text still streaming into the latest turn: at that turn's text column, with
 * the lanes live under its last row running down the gutter beside it.
 */
export function renderStreamingContinuation(
  content: string,
  width: number,
  tail: { readonly gutter: GutterRow; readonly gutterWidth: number },
  glyphSet: TreeGlyphSetName,
): Line[] {
  const p: GraphPaint = { width, gutterWidth: tail.gutterWidth, glyphs: laneGlyphs(glyphSet), frame: 0 };
  const shift = Math.max(0, textColumn(p) - MARKDOWN_TEXT_COL);
  return renderMarkdown(content, Math.max(20, width - shift), { isStreaming: true }).map((line) => shiftUnderGutter(line, shift, tail.gutter, p));
}

/** One bead with no turn around it (a result whose call is outside the slice). */
export function renderSingleBead(bead: BeadModel, options: TurnRenderOptions): TurnRender {
  const glyphs = laneGlyphs(options.glyphSet);
  const p: GraphPaint = { width: options.width, gutterWidth: 6, glyphs, frame: options.frame };
  const lines: Line[] = [paintBeadRow([{ role: 'bead', color: 0 }], {
    status: bead.status, name: bead.name, arg: bead.arg, summary: bead.summary, time: bead.time,
    laneColor: laneColor(0), hasBody: bead.body !== null, open: bead.open,
  }, p)];
  const focusIds = new Set([bead.id]);
  if (options.focusId === bead.id) applyFocus(lines[0]!, options.width, glyphs);
  let capped = false;
  if (bead.open && bead.body) {
    const drawn = paintBody(bead.body, p, { expanded: bead.expanded, semantic: bead.body.kind === 'diff' ? semanticSummaryFor(bead.body.diff, bead.body.path) : undefined });
    capped = drawn.capped;
    lines.push(...drawn.lines);
  }
  return { lines, blocks: [beadMeta(bead, 0, lines.length, capped, undefined)], errorLines: [], messageLines: new Map(), focusIds, tail: { gutter: [], gutterWidth: 6 } };
}
