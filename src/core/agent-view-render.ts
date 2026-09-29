/**
 * agent-view-render.ts, one agent opened full screen.
 *
 * The agent becomes the session: its own transcript is the spine (drawn by
 * the same lane-graph path as main, conversation-rendering.ts), the agents
 * it spawned branch off it as lanes, and steers you sent that it has not
 * picked up yet sit at the bottom marked as queued. Its lanes are drawn with
 * the color base shifted (lane-graph/paint.ts withLaneColorBase) so its spine
 * keeps the color its lane has in main.
 *
 *   row 0     (blank)
 *   row 1     ◆ engineer · the task · started by main 2m 14s ago
 *   row 2     (blank)
 *   rows      the agent's transcript
 *
 * The thin bar down column 0 and the scroll window are the caller's
 * (shell/session-views.ts); this returns every line.
 */

import { createEmptyLine, type Line } from '@pellux/goodvibes-sdk/platform/types';
import type { ConversationMessageSnapshot } from '@pellux/goodvibes-sdk/platform/core';
import { appendConversationMessages, type ConversationRenderContext } from './conversation-rendering.ts';
import type { AgentLaneInfo, WorkTreeSources } from './work-tree-sources.ts';
import { laneColor, withLaneColorBase } from '../renderer/lane-graph/paint.ts';
import type { TreeGlyphSetName } from '../renderer/lane-graph/glyphs.ts';
import { UIFactory } from '../renderer/ui-factory.ts';
import { activeTokens } from '../renderer/theme.ts';
import { formatElapsed } from '../utils/format-elapsed.ts';
import { getDisplayWidth, truncateDisplay } from '../utils/terminal-width.ts';

export interface AgentViewInput {
  readonly width: number;
  readonly agent: AgentLaneInfo;
  /** The agent's transcript (its lane info carries none for a WRFC owner). */
  readonly messages: readonly ConversationMessageSnapshot[];
  /** The agent's lane color index in main. */
  readonly colorIndex: number;
  /** Who started it: "main" or the parent agent's name. */
  readonly parentName: string;
  /** Main's work-tree sources (timings, spawned agents, waiting calls). */
  readonly sources: WorkTreeSources;
  /** Fold state for this view's beads; kept by the caller across frames. */
  readonly collapse: Map<string, boolean>;
  readonly glyphSet: TreeGlyphSetName;
  readonly frame: number;
  readonly now: number;
  /** Steers sent from this view that the agent has not picked up yet, oldest first. */
  readonly queuedSteers: readonly string[];
}

const TEXT_X = 3;

function put(line: Line, x: number, endX: number, text: string, style: { fg: string; bold?: boolean }): number {
  let cx = x;
  for (const ch of text) {
    const w = getDisplayWidth(ch);
    if (w <= 0) continue;
    if (cx + w > endX || cx >= line.length) break;
    line[cx] = { char: ch, fg: style.fg, bg: '', bold: style.bold ?? false, dim: false, underline: false, italic: false, strikethrough: false };
    if (w === 2 && cx + 1 < line.length) line[cx + 1] = { ...line[cx]!, char: '' };
    cx += w;
  }
  return cx;
}

function stateText(agent: AgentLaneInfo, parentName: string, now: number): { text: string; tone: 'faint' | 'good' | 'bad' | 'warn' } {
  const started = agent.startedAt !== undefined ? `started by ${parentName} ${formatElapsed(Math.max(0, now - agent.startedAt))} ago` : `started by ${parentName}`;
  switch (agent.status) {
    case 'running': return { text: started, tone: 'faint' };
    case 'pending': return { text: `waiting to start · ${started}`, tone: 'faint' };
    case 'completed': {
      const took = agent.startedAt !== undefined && agent.completedAt !== undefined ? ` in ${formatElapsed(agent.completedAt - agent.startedAt)}` : '';
      return { text: `finished${took} · ${agent.toolCallCount} tool${agent.toolCallCount === 1 ? '' : 's'}`, tone: 'good' };
    }
    case 'failed': return { text: `failed${agent.error ? `: ${agent.error.split('\n')[0]}` : ''}`, tone: 'bad' };
    case 'cancelled': return { text: 'stopped', tone: 'warn' };
  }
}

/** The ◆ head row. */
function headRow(input: AgentViewInput): Line {
  const t = activeTokens();
  const line = createEmptyLine(input.width);
  for (const cell of line) cell.bg = '';
  const end = input.width - 3;
  const color = laneColor(input.colorIndex);
  let x = put(line, TEXT_X, end, '◆', { fg: color, bold: true });
  x = put(line, x + 1, end, input.agent.hostedLabel ?? input.agent.name, { fg: color, bold: true });
  const state = stateText(input.agent, input.parentName, input.now);
  const stateFg = state.tone === 'good' ? t.success : state.tone === 'bad' ? t.error : state.tone === 'warn' ? t.warning : t.textFaint;
  const task = input.agent.task.split('\n').find((l) => l.trim().length > 0)?.trim() ?? '';
  // The state is kept whole; the task yields its room first.
  const stateW = getDisplayWidth(state.text) + 3;
  const taskRoom = end - x - 3 - stateW;
  if (task && taskRoom >= 8) {
    x = put(line, x + 1, end, '·', { fg: t.textFaint });
    x = put(line, x + 1, end, truncateDisplay(task, taskRoom), { fg: t.textMuted });
  }
  x = put(line, x + 1, end, '·', { fg: t.textFaint });
  put(line, x + 1, end, truncateDisplay(state.text, Math.max(0, end - x - 1)), { fg: stateFg });
  return line;
}

/** Every line of the agent view, top to bottom. */
export function renderAgentView(input: AgentViewInput): Line[] {
  const t = activeTokens();
  const lines: Line[] = [createEmptyLine(input.width), headRow(input), createEmptyLine(input.width)];
  const running = input.agent.status === 'running' || input.agent.status === 'pending';
  const context: ConversationRenderContext = {
    history: { addLine: (l) => { lines.push(l); }, addLines: (ls) => { lines.push(...ls); }, getLineCount: () => lines.length },
    blockRegistry: [],
    collapseState: input.collapse,
    errorLineRegistry: [],
    messageKindRegistry: new Map(),
    configManager: null,
    splashOptions: {},
    // The agent's own turns are live while the agent runs, not while main does.
    workTreeSources: { ...input.sources, turnActive: () => running, turnTiming: undefined },
    treeGlyphSet: input.glyphSet,
    focusId: null,
    frame: input.frame,
  };
  withLaneColorBase(input.colorIndex, () => appendConversationMessages(context, [...input.messages], input.width, []));
  if (input.messages.length === 0) {
    const empty = createEmptyLine(input.width);
    for (const cell of empty) cell.bg = '';
    put(empty, TEXT_X + 2, input.width - 3, running ? 'No transcript yet: the agent has not taken a turn.' : 'This agent left no transcript.', { fg: t.textFaint });
    lines.push(empty);
  }
  for (const steer of input.queuedSteers) {
    lines.push(createEmptyLine(input.width));
    lines.push(...UIFactory.createMessageBar(input.width, steer));
    const note = createEmptyLine(input.width);
    for (const cell of note) cell.bg = '';
    put(note, TEXT_X + 2, input.width - 3, '⧗ queued · it arrives at the agent\'s next turn', { fg: t.textFaint });
    lines.push(note);
  }
  return lines;
}
