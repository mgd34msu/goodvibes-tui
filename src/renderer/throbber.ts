/**
 * throbber.ts, the one row above the input area that says what the main
 * session is doing right now. It shows only while main is working (a turn
 * runs, or the conversation is being compacted) and is gone at rest.
 *
 *   col 3        the spinner (brand gradient on the glyph only)
 *   col 5..w-4   what is happening, then its elapsed time
 *
 * It is its own surface: never inside the input area, and never on the
 * status line, which keeps session state (mode, cost, context bar) and the
 * keys (esc interrupt).
 *
 * What it names, first match wins:
 *   - a permission prompt waiting on you:  Waiting for your approval · bash · npm test · 12s
 *   - a compaction:                       Compacting the conversation · 4s
 *   - a running tool:                     Running bash · npm test · 3s
 *   - the model (the honest waiting phrase from the SDK): Thinking... · 12s · first token 1.2s · 40 tok/s
 *
 * Inside an agent or process view the row keeps main in sight the same way,
 * led by "main ·" so it is never read as the view's own activity.
 */

import { type Line, createEmptyLine } from '@pellux/goodvibes-sdk/platform/types';
import type { ToolCall } from '@pellux/goodvibes-sdk/platform/types';
import { getDisplayWidth, interpolateColor, truncateDisplay } from '../utils/terminal-width.ts';
import { formatElapsed } from '../utils/format-elapsed.ts';
import { beadArgument, beadName } from './lane-graph/bead.ts';
import { activeTokens } from './theme.ts';

/** Column of the spinner (the input area's first fill column). */
const THROBBER_SPINNER_X = 3;
/** First text column (the input area's text column). */
const THROBBER_TEXT_X = 5;
/** The most a tool's argument takes before it is cut, so the elapsed time stays on the row. */
const ARGUMENT_MAX = 60;
const SEP = ' · ';

/** What the main session is doing, as the throbber names it. */
export type ThrobberActivity =
  | { readonly kind: 'approval'; readonly tool: string; readonly argument: string; readonly elapsedMs?: number }
  | { readonly kind: 'compacting'; readonly elapsedMs?: number }
  | { readonly kind: 'tool'; readonly tool: string; readonly argument: string; readonly elapsedMs?: number }
  | { readonly kind: 'model'; readonly phrase: string; readonly elapsedMs?: number; readonly ttftMs?: number; readonly tokenSpeed?: number };

/** One frame of the throbber. */
export interface ThrobberState {
  /** The spinner glyph for this frame. */
  readonly spinner: string;
  /** Animation frame, used for the spinner's gradient position. */
  readonly frame: number;
  readonly activity: ThrobberActivity;
  /** Set inside an agent or process view: whose activity this is ("main"). */
  readonly owner?: string;
}

/** A tool call as the throbber needs it: its name and arguments. */
export interface ThrobberToolCall {
  readonly name: string;
  readonly args?: Record<string, unknown>;
}

export interface ThrobberActivityInput {
  /** A main turn is running. */
  readonly turnActive: boolean;
  /** A compaction of the main conversation is running (inside a turn or not). */
  readonly compacting: boolean;
  /** When the running compaction started (epoch ms), once known. */
  readonly compactingSinceMs?: number;
  /** The permission prompt the turn is blocked on. */
  readonly pendingApproval?: ThrobberToolCall | null;
  /** The tool the turn is executing now, and when it started (epoch ms). */
  readonly activeTool?: (ThrobberToolCall & { readonly startedAtMs?: number }) | null;
  /** The model's honest waiting phrase (UIFactory.busyPhrase). */
  readonly modelPhrase: string;
  /** When the turn's current stream started (epoch ms); 0 or undefined when unknown. */
  readonly turnStartMs?: number;
  readonly ttftMs?: number;
  readonly tokenSpeed?: number;
  readonly now: number;
}

/** "bash", "npm test": a call's short name and key argument, the way its bead names it. */
function describeToolCall(call: ThrobberToolCall): { tool: string; argument: string } {
  const asCall = { id: '', name: call.name, arguments: call.args ?? {} } as ToolCall;
  let argument = '';
  try { argument = beadArgument(asCall); } catch { argument = ''; }
  return { tool: beadName(asCall), argument: truncateDisplay(argument, ARGUMENT_MAX) };
}

/** What main is doing now, or null at rest (the throbber is not drawn). */
export function resolveThrobberActivity(input: ThrobberActivityInput): ThrobberActivity | null {
  if (!input.turnActive && !input.compacting) return null;
  const since = (start: number | undefined): number | undefined => (start !== undefined && start > 0 ? Math.max(0, input.now - start) : undefined);
  const turnElapsed = since(input.turnStartMs);
  if (input.turnActive && input.pendingApproval) {
    return { kind: 'approval', ...describeToolCall(input.pendingApproval), elapsedMs: turnElapsed };
  }
  if (input.compacting) return { kind: 'compacting', elapsedMs: since(input.compactingSinceMs) };
  if (input.activeTool) {
    return { kind: 'tool', ...describeToolCall(input.activeTool), elapsedMs: since(input.activeTool.startedAtMs) ?? turnElapsed };
  }
  return {
    kind: 'model',
    phrase: input.modelPhrase,
    elapsedMs: turnElapsed,
    ttftMs: input.ttftMs !== undefined && input.ttftMs > 0 ? input.ttftMs : undefined,
    tokenSpeed: input.tokenSpeed !== undefined && input.tokenSpeed > 0 ? input.tokenSpeed : undefined,
  };
}

interface ThrobberText {
  readonly label: string;
  readonly subject: string;
  readonly tail: readonly string[];
}

function textOf(activity: ThrobberActivity): ThrobberText {
  const elapsed = activity.elapsedMs !== undefined ? [formatElapsed(activity.elapsedMs)] : [];
  switch (activity.kind) {
    case 'approval':
      return { label: 'Waiting for your approval', subject: [activity.tool, activity.argument].filter(Boolean).join(SEP), tail: elapsed };
    case 'compacting':
      return { label: 'Compacting the conversation', subject: '', tail: elapsed };
    case 'tool':
      return { label: `Running ${activity.tool}`, subject: activity.argument, tail: elapsed };
    case 'model': {
      const tail = [...elapsed];
      if (activity.ttftMs !== undefined) tail.push(`first token ${formatElapsed(activity.ttftMs)}`);
      if (activity.tokenSpeed !== undefined) tail.push(`${Math.round(activity.tokenSpeed)} tok/s`);
      return { label: activity.phrase, subject: '', tail };
    }
  }
}

function put(line: Line, x: number, endX: number, text: string, fg: string, bold = false): number {
  let cx = x;
  for (const ch of text) {
    const w = getDisplayWidth(ch);
    if (w <= 0) continue;
    if (cx + w > endX) break;
    line[cx] = { char: ch, fg, bg: '', bold, dim: false, underline: false, italic: false, strikethrough: false };
    if (w === 2 && cx + 1 < line.length) line[cx + 1] = { ...line[cx]!, char: '' };
    cx += w;
  }
  return cx;
}

/**
 * Draw the throbber row. The text ends at width-4 or earlier. When the row is
 * short the elapsed pieces go first, then the subject is cut, then the label.
 */
export function renderThrobberLine(width: number, state: ThrobberState): Line {
  const t = activeTokens();
  const line = createEmptyLine(width);
  for (const cell of line) cell.bg = '';
  const endX = Math.max(THROBBER_TEXT_X, width - 3); // exclusive: the last text column is width-4
  if (width <= THROBBER_TEXT_X) return line;
  const glyphFg = interpolateColor(t.brand, t.brandEnd, (Math.sin(state.frame / 6) + 1) / 2);
  put(line, THROBBER_SPINNER_X, endX, state.spinner, glyphFg, true);

  const { label, subject, tail } = textOf(state.activity);
  const room = endX - THROBBER_TEXT_X;
  const owner = state.owner ? `${state.owner}${SEP}` : '';
  const head = owner + label;
  const tailText = tail.length > 0 ? SEP + tail.join(SEP) : '';
  const subjectText = subject ? SEP + subject : '';
  let x = THROBBER_TEXT_X;
  const fits = (w: number): boolean => w <= room;
  const headW = getDisplayWidth(head);
  const subjectW = getDisplayWidth(subjectText);
  const tailW = getDisplayWidth(tailText);
  // The label stays whole as long as it can; its trailing dots go before a letter does.
  const bare = head.replace(/(\.\.\.|…)$/, '');
  const headShown = fits(headW) ? head : fits(getDisplayWidth(bare)) ? bare : truncateDisplay(head, room);
  if (owner && headShown.startsWith(owner)) {
    x = put(line, x, endX, owner, t.textFaint);
    x = put(line, x, endX, headShown.slice(owner.length), t.textMuted);
  } else {
    x = put(line, x, endX, headShown, t.textMuted);
  }
  const showTail = fits(headW + subjectW + tailW) || (subject === '' && fits(headW + tailW));
  const subjectRoom = endX - x - (showTail ? tailW : 0);
  if (subjectText && subjectRoom > getDisplayWidth(SEP) + 1) {
    x = put(line, x, endX, truncateDisplay(subjectText, subjectRoom), t.text);
  }
  if (showTail && x + tailW <= endX) put(line, x, endX, tailText, t.textFaint);
  return line;
}
