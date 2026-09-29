/**
 * prompt-card.ts, the permission dialog drawn with the modal surface kit.
 *
 *   ▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄ (amber: this needs you) ▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄
 *
 *     △ Run a command?                            engineer · 1 more waiting
 *
 *     ┌ element panel ─────────────────────────────────────────────────┐
 *       $ rm -rf dist && bun run build
 *     └────────────────────────────────────────────────────────────────┘
 *
 *      high risk   deletes files recursively        sandbox · network off
 *
 *      Allow once    Allow for session ▸    Deny                d details
 *
 *     ←→ choose   ⏎ confirm   y allow once   a session   n deny   d details
 *
 * The thing being approved is the whole card: the command itself (in full,
 * wrapped), or the target path(s). Risk shows as one colored chip. Edits show
 * the actual diff with tinted rows; hunk-selectable edits give every hunk its
 * own checkbox. Every other fact (directory, sandbox, policy judgment, review
 * reasons, the raw arguments) is one key away (d), wrapped in full. Choices are
 * buttons: arrows pick, Enter confirms, and y / a / n (and 1-9 for remember
 * tiers) still work. "Allow for session ▸" opens the remember tiers as a
 * submenu when the request offers them. Typing starts a denial with a reason.
 *
 * Pure rendering; the keys live in shell/blocking-input.ts, which shares
 * permissionButtons() with this file so the two can never disagree.
 */

import type { PermissionCategory, PermissionPromptRequest, PermissionRequestAnalysis } from '@pellux/goodvibes-sdk/platform/permissions';
import { buildPermissionApprovalBrief, getDisplayArg } from '@pellux/goodvibes-sdk/platform/permissions';
import { activeTokens } from '../renderer/theme.ts';
import {
  beginModal,
  finishModal,
  layoutHintRows,
  hintLayoutWidth,
  MODAL_PAD_X,
  modalInnerWidth,
  scrollCountText,
  standardModalWidth,
  wrapLines,
  type KitHint,
  type SurfaceLayer,
} from '../renderer/surface-kit.ts';
import { chip, button, buttonWidth } from '../renderer/surface-kit-parts.ts';
import { drawRow, measureRow, type KitRow, type KitSpan } from '../renderer/surface-kit-list.ts';
import type { HunkSelectionState } from './hunk-selection.ts';
import { readSandboxAskAnnotation } from './sandbox-exec-gate.ts';

/** Hunks listed before a "+N more hunks" trailer. */
export const MAX_VISIBLE_HUNKS = 8;
/** Diff rows shown for a whole-file write before a "+N more" trailer. */
const MAX_DIFF_LINES = 10;
/** Target rows listed before they collapse to an "N files: …" summary. */
const MAX_TARGET_ROWS = 3;
/** Diff rows shown under one hunk before a trailer. */
const MAX_HUNK_LINES = 6;

/** What the card shows beyond the request itself. */
export interface PermissionCardState {
  readonly hunkState?: HunkSelectionState | undefined;
  readonly detailsExpanded?: boolean | undefined;
  readonly requestedBy?: string | undefined;
  readonly replyMode?: 'deny-reason' | 'exec-answer' | undefined;
  readonly replyBuffer?: string | undefined;
  /** OTHER broker asks waiting behind this one. */
  readonly queueCount?: number | undefined;
  /** The chosen button (index into permissionButtons). */
  readonly choice?: number | undefined;
  /** The remember-tier submenu is open. */
  readonly submenuOpen?: boolean | undefined;
  readonly submenuIndex?: number | undefined;
  /** First body row shown when the card is taller than the screen. */
  readonly scroll?: number | undefined;
}

export type PermissionButtonId = 'allow' | 'session' | 'remember' | 'apply' | 'deny';

export interface PermissionButton {
  readonly id: PermissionButtonId;
  readonly label: string;
}

/** The card's buttons, in order (the safe answers are Allow once / Apply first, Deny last). */
export function permissionButtons(request: PermissionPromptRequest, state: Pick<PermissionCardState, 'hunkState' | 'replyMode'>): PermissionButton[] {
  if (state.replyMode === 'exec-answer') return [];
  if (state.hunkState) return [{ id: 'apply', label: 'Apply selected' }, { id: 'deny', label: 'Deny' }];
  const tiers = request.rememberOptions?.length ?? 0;
  return [
    { id: 'allow', label: 'Allow once' },
    tiers > 0 ? { id: 'remember', label: 'Allow for session ▸' } : { id: 'session', label: 'Allow for session' },
    { id: 'deny', label: 'Deny' },
  ];
}

// ---------------------------------------------------------------------------
// Request facts
// ---------------------------------------------------------------------------

export function fallbackAnalysis(request: PermissionPromptRequest): PermissionRequestAnalysis {
  return request.analysis ?? {
    classification: request.category,
    riskLevel: request.category === 'read' ? 'low' : request.category === 'write' ? 'medium' : 'high',
    summary: `Review ${request.tool} request`,
    reasons: ['Inspect the target and intent before approving this action.'],
    target: getDisplayArg(request.tool, request.args),
    targetKind: 'generic',
  };
}

const MODEL_JUDGMENT_PREFIX = 'model judgment:';

/** The sandbox model-judgment annotation gets its own row so it is never cut from the reasons. */
export function extractModelJudgmentAnnotation(reasons: readonly string[]): { annotation: string | undefined; rest: string[] } {
  const idx = reasons.findIndex((r) => r.toLowerCase().startsWith(MODEL_JUDGMENT_PREFIX));
  if (idx === -1) return { annotation: undefined, rest: [...reasons] };
  return { annotation: reasons[idx], rest: [...reasons.slice(0, idx), ...reasons.slice(idx + 1)] };
}

function relativize(p: string, cwd?: string): string {
  if (!cwd || !p.startsWith('/')) return p;
  if (p === cwd) return '.';
  const prefix = cwd.endsWith('/') ? cwd : `${cwd}/`;
  return p.startsWith(prefix) ? p.slice(prefix.length) : p;
}

function collectField(arr: unknown, field: string): string[] {
  if (!Array.isArray(arr)) return [];
  const out: string[] = [];
  for (const el of arr) {
    if (typeof el === 'string') out.push(el);
    else if (el && typeof el === 'object' && typeof (el as Record<string, unknown>)[field] === 'string') out.push((el as Record<string, unknown>)[field] as string);
  }
  return out;
}

/** The real display target(s) of a tool call (paths, commands, urls), relativised; a fallback when none is recognisable. */
export function cardTargets(request: PermissionPromptRequest): string[] {
  const args = request.args ?? {};
  const pick = (): string[] => {
    const files = collectField(args.files, 'path');
    if (files.length) return files;
    if (typeof args.path === 'string') return [args.path];
    if (typeof args.file === 'string') return [args.file];
    const commands = collectField(args.commands, 'cmd');
    if (commands.length) return commands;
    if (typeof args.command === 'string') return [args.command];
    if (typeof args.cmd === 'string') return [args.cmd];
    if (typeof args.pattern === 'string') return [args.pattern];
    const urls = collectField(args.urls, 'url');
    if (urls.length) return urls;
    const queries = collectField(args.queries, 'query');
    if (queries.length) return queries;
    if (typeof args.query === 'string') return [args.query];
    if (typeof args.task === 'string') return [args.task];
    return [];
  };
  const targets = pick().map((t) => relativize(t, request.workingDirectory));
  return targets.length > 0 ? targets : [getDisplayArg(request.tool, args)];
}

function commandOf(request: PermissionPromptRequest): string {
  const args = request.args ?? {};
  return typeof args.command === 'string' ? args.command : typeof args.cmd === 'string' ? args.cmd : '';
}

/** The exact session rule "Allow for session" remembers (mirrors the SDK's approval key). */
export function rememberScopeKey(request: PermissionPromptRequest): string {
  const args = request.args ?? {};
  if (typeof args.path === 'string' && args.path.length > 0) return `${request.tool}:${args.path}`;
  if (typeof args.command === 'string' && args.command.length > 0) return `${request.tool}:${args.command}`;
  return request.tool;
}

function riskColor(level: PermissionRequestAnalysis['riskLevel']): string {
  const t = activeTokens();
  if (level === 'low') return t.success;
  if (level === 'medium') return t.warning;
  return t.error;
}

/** The request category, named on the title row. */
function categoryLabel(category: PermissionCategory): string {
  switch (category) {
    case 'write': return 'WRITE';
    case 'execute': return 'EXECUTE';
    case 'delegate': return 'DELEGATE';
    default: return 'PERMISSION';
  }
}

function titleGlyph(category: PermissionCategory): string {
  return category === 'read' ? '○' : '△';
}

// ---------------------------------------------------------------------------
// Body rows
// ---------------------------------------------------------------------------

/** One visual row of the card body. */
interface CardRow {
  readonly spans: readonly KitSpan[];
  /** Fill the row as part of an element panel (bg), with this tint instead when set. */
  readonly panel?: boolean;
  readonly tint?: string;
  readonly right?: { readonly text: string; readonly fg: string };
  /** The hunk cursor row (drawn as the selected row). */
  readonly cursor?: boolean;
}

/** Wrap code keeping its leading indentation on every wrapped line. */
function wrapCode(line: string, width: number): string[] {
  const indent = /^\s*/.exec(line)?.[0] ?? '';
  const room = Math.max(4, width - indent.length);
  return wrapLines(line.slice(indent.length), room).map((part) => `${indent}${part}`);
}

function textRows(text: string, width: number, span: Omit<KitSpan, 'text'>, indent = ''): CardRow[] {
  return text.split('\n').flatMap((para) => wrapLines(para, Math.max(1, width - indent.length)))
    .map((line, i) => ({ spans: [{ ...span, text: `${i === 0 ? '' : indent}${line}` }] }));
}

function panelRows(rows: CardRow[]): CardRow[] {
  const blank: CardRow = { spans: [], panel: true };
  return [blank, ...rows.map((r) => ({ ...r, panel: true })), blank];
}

function labelled(label: string, value: string, width: number, fg: string): CardRow[] {
  const t = activeTokens();
  const pad = 12;
  const lines = value.split('\n').flatMap((para) => wrapLines(para, Math.max(8, width - pad)));
  return lines.map((line, i) => ({
    spans: i === 0
      ? [{ text: label.padEnd(pad), fg: t.textMuted }, { text: line, fg }]
      : [{ text: `${' '.repeat(pad)}${line}`, fg }],
  }));
}

function diffRows(lines: readonly string[], width: number): CardRow[] {
  const t = activeTokens();
  const rows: CardRow[] = [];
  for (const raw of lines) {
    const sign = raw.startsWith('+') ? '+' : raw.startsWith('-') ? '-' : raw.startsWith('@@') ? '@' : ' ';
    const body = sign === '@' || sign === ' ' ? raw : raw.slice(1);
    const tint = sign === '+' ? t.diffAddedBg : sign === '-' ? t.diffRemovedBg : undefined;
    const fg = sign === '@' ? t.info : sign === ' ' ? t.textFaint : t.text;
    const signFg = sign === '+' ? t.success : sign === '-' ? t.error : t.textFaint;
    wrapCode(body, Math.max(4, width - 2)).forEach((part, i) => {
      rows.push({
        spans: sign === '@' || sign === ' '
          ? [{ text: part, fg }]
          : [{ text: i === 0 ? `${sign} ` : '  ', fg: signFg }, { text: part, fg }],
        panel: true,
        tint,
      });
    });
  }
  return rows;
}

/** Unified-diff text for a whole-file write or an edit list (not hunk mode), capped with an honest trailer. */
export function writeDiffLines(request: PermissionPromptRequest, hunkState: HunkSelectionState | undefined): string[] | null {
  if (hunkState || request.category !== 'write') return null;
  const args = request.args ?? {};
  const target = typeof args.path === 'string' ? args.path : typeof args.file === 'string' ? args.file : '';
  const out: string[] = [];
  if (typeof args.content === 'string') {
    const contentLines = args.content.split('\n');
    out.push(`@@ ${target || '(new content)'} @@`);
    for (const line of contentLines.slice(0, MAX_DIFF_LINES)) out.push(`+${line}`);
    if (contentLines.length > MAX_DIFF_LINES) out.push(` … +${contentLines.length - MAX_DIFF_LINES} more lines`);
    return out;
  }
  if (Array.isArray(args.edits)) {
    let budget = MAX_DIFF_LINES;
    let hidden = 0;
    for (const edit of args.edits) {
      if (!edit || typeof edit !== 'object') continue;
      const e = edit as { path?: unknown; find?: unknown; replace?: unknown };
      if (typeof e.find !== 'string' || typeof e.replace !== 'string') continue;
      const findLines = e.find.split('\n');
      const replaceLines = e.replace.split('\n');
      const need = 1 + findLines.length + replaceLines.length;
      if (budget < need) {
        hidden += 1;
        continue;
      }
      out.push(`@@ ${typeof e.path === 'string' ? e.path : target} @@`);
      for (const line of findLines) out.push(`-${line}`);
      for (const line of replaceLines) out.push(`+${line}`);
      budget -= need;
    }
    if (out.length === 0) return null;
    if (hidden > 0) out.push(` … +${hidden} more edits`);
    return out;
  }
  return null;
}

function subjectRows(request: PermissionPromptRequest, width: number): CardRow[] {
  const t = activeTokens();
  const attribution = request.attribution;
  if (attribution?.kind === 'exec-prompt') {
    const rows: CardRow[] = [];
    if (typeof attribution.command === 'string' && attribution.command.length > 0) rows.push(...labelled('Running', attribution.command, width, t.text));
    if (typeof attribution.prompt === 'string' && attribution.prompt.length > 0) rows.push(...labelled('Asks', attribution.prompt, width, t.warning));
    return rows;
  }
  const command = request.category === 'execute' ? commandOf(request) : '';
  if (command) {
    // The FULL command, wrapped, never truncated.
    return command.split('\n').flatMap((para, p) => wrapCode(para, Math.max(4, width - 2)).map((line, i) => ({
      spans: [{ text: p === 0 && i === 0 ? '$ ' : '  ', fg: t.textFaint }, { text: line, fg: t.text }],
    })));
  }
  const brief = buildPermissionApprovalBrief(request);
  const targets = cardTargets(request);
  // Up to three targets are listed in full; more collapse to a summary (the
  // complete list stays in the details' Args row).
  if (targets.length > MAX_TARGET_ROWS) {
    const base = (p: string): string => p.replace(/[/\\]+$/, '').split(/[/\\]/).pop() ?? p;
    return labelled(brief.subjectLabel, `${targets.length} files: ${targets.slice(0, 2).map(base).join(', ')}, +${targets.length - 2} more`, width, t.text);
  }
  return targets.flatMap((target, i) => labelled(i === 0 ? brief.subjectLabel : '', target, width, t.text));
}

function hunkRows(hunkState: HunkSelectionState, width: number): CardRow[] {
  const t = activeTokens();
  const rows: CardRow[] = [];
  const { hunks, cursor, selected } = hunkState;
  rows.push(...textRows(`${selected.size} of ${hunks.length} hunks selected`, width + 4, { fg: t.textMuted }));
  hunks.slice(0, MAX_VISIBLE_HUNKS).forEach((hunk, i) => {
    const on = selected.has(i);
    wrapLines(`${i + 1}. ${hunk.path}`, Math.max(4, width)).forEach((part, k) => rows.push({
      spans: [{ text: k === 0 ? (on ? '[x] ' : '[ ] ') : '    ', fg: on ? t.success : t.textFaint, bold: true }, { text: part, fg: on ? t.text : t.textMuted }],
      cursor: i === cursor,
    }));
    const lines = [...hunk.find.split('\n').map((l) => `-${l}`), ...hunk.replace.split('\n').map((l) => `+${l}`)];
    const shown = diffRows(lines.slice(0, MAX_HUNK_LINES), width);
    rows.push(...panelRows(lines.length > MAX_HUNK_LINES
      ? [...shown, { spans: [{ text: `+${lines.length - MAX_HUNK_LINES} more lines`, fg: t.textFaint }] }]
      : shown));
  });
  if (hunks.length > MAX_VISIBLE_HUNKS) rows.push({ spans: [{ text: `+${hunks.length - MAX_VISIBLE_HUNKS} more hunks`, fg: t.textFaint }] });
  return rows;
}

function detailRows(request: PermissionPromptRequest, state: PermissionCardState, width: number): CardRow[] {
  const t = activeTokens();
  const analysis = fallbackAnalysis(request);
  const brief = buildPermissionApprovalBrief(request);
  const { rest: reasons } = extractModelJudgmentAnnotation(analysis.reasons);
  const rows: CardRow[] = [];
  rows.push(...labelled('Tool', request.tool, width, t.text));
  rows.push(...labelled('Directory', request.workingDirectory ?? '(unknown)', width, t.textMuted));
  rows.push(...labelled('Risk', `${analysis.riskLevel} (${analysis.classification})`, width, riskColor(analysis.riskLevel)));
  if (analysis.surface || analysis.blastRadius) rows.push(...labelled('Surface', `${analysis.surface ?? 'generic'}${analysis.blastRadius ? ` · radius ${analysis.blastRadius}` : ''}`, width, t.textMuted));
  if (analysis.host) rows.push(...labelled('Host', analysis.host, width, t.textMuted));
  const sandbox = readSandboxAskAnnotation(request);
  if (sandbox && sandbox.sandboxEscalations.length > 0) rows.push(...labelled('Sandbox', sandbox.sandboxEscalations.join('; '), width, t.warning));
  rows.push(...labelled('Decision', brief.decisionModeLabel, width, t.textMuted));
  if (analysis.sideEffects && analysis.sideEffects.length > 0) rows.push(...labelled('Effects', analysis.sideEffects.join(', '), width, t.textMuted));
  reasons.forEach((reason, i) => rows.push(...labelled(i === 0 ? 'Review' : '', reason, width, t.textMuted)));
  rows.push(...labelled('Checklist', brief.checklist, width, t.textMuted));
  if (!state.hunkState) rows.push(...labelled('Remembers', `"Allow for session" remembers ${rememberScopeKey(request)}`, width, t.textMuted));
  rows.push(...labelled('Args', JSON.stringify(request.args ?? {}), width, t.textFaint));
  return rows;
}

function bodyRows(request: PermissionPromptRequest, state: PermissionCardState, width: number): CardRow[] {
  const t = activeTokens();
  const analysis = fallbackAnalysis(request);
  const rows: CardRow[] = [];
  rows.push(...panelRows(subjectRows(request, width - 4)));
  rows.push({ spans: [] });
  // Risk chip + summary; the model judgment on its own row so it is never cut.
  const summary = wrapLines(analysis.summary, Math.max(8, width - 14));
  summary.forEach((line, i) => rows.push({
    spans: i === 0
      ? [{ text: `\u0000${analysis.riskLevel} risk`, fg: riskColor(analysis.riskLevel) }, { text: `  ${line}`, fg: t.textMuted }]
      : [{ text: `${' '.repeat(analysis.riskLevel.length + 9)}${line}`, fg: t.textMuted }],
  }));
  const { annotation } = extractModelJudgmentAnnotation(analysis.reasons);
  if (annotation) rows.push(...labelled('Judgment', annotation, width, t.accent));
  const diff = writeDiffLines(request, state.hunkState);
  if (diff) {
    rows.push({ spans: [] });
    rows.push(...panelRows(diffRows(diff, width - 4)));
  }
  if (state.hunkState) {
    rows.push({ spans: [] });
    rows.push(...hunkRows(state.hunkState, width - 4));
  }
  if (state.detailsExpanded) {
    rows.push({ spans: [] });
    rows.push(...detailRows(request, state, width));
  }
  if (state.replyMode) {
    const label = state.replyMode === 'exec-answer' ? 'Answer' : 'Reason';
    rows.push({ spans: [] });
    rows.push(...panelRows(labelled(label, `${state.replyBuffer ?? ''}▏`, width - 4, t.text)));
  }
  return rows;
}

function cardHints(request: PermissionPromptRequest, state: PermissionCardState): KitHint[] {
  if (state.replyMode === 'exec-answer') return [['⏎', 'send answer'], ['esc', (state.replyBuffer ?? '').length > 0 ? 'clear' : 'decline'], ['ctrl+c', 'abort turn']];
  if (state.replyMode === 'deny-reason') return [['⏎', 'deny with this reason'], ['esc', 'back'], ['ctrl+c', 'abort turn']];
  if (state.submenuOpen) return [['↑↓', 'tier'], ['⏎', 'allow and remember'], ['esc', 'back']];
  if (state.hunkState) return [['↑↓', 'hunk'], ['space', 'toggle'], ['a', 'all'], ['←→', 'choose'], ['⏎', 'confirm'], ['n', 'deny']];
  const tiers = request.rememberOptions?.length ?? 0;
  return [
    ['←→', 'choose'], ['⏎', 'confirm'], ['y', 'allow once'],
    tiers > 0 ? [tiers > 1 ? `1-${tiers}` : '1', 'remember'] : ['a', 'allow for session'],
    ['n', 'deny'], ['type', 'a reason to deny'],
  ];
}

// ---------------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------------

export function renderPermissionCard(request: PermissionPromptRequest, state: PermissionCardState, screenWidth: number, screenHeight: number): SurfaceLayer {
  const t = activeTokens();
  const width = standardModalWidth(screenWidth);
  const inner = modalInnerWidth(width);
  const hints = cardHints(request, state);
  const hintRows = layoutHintRows(hints, hintLayoutWidth(inner)).length;
  const body = bodyRows(request, state, inner);
  const buttons = permissionButtons(request, state);
  const tiers = state.submenuOpen ? (request.rememberOptions ?? []) : [];
  const submenuIndex = Math.max(0, Math.min(state.submenuIndex ?? 0, tiers.length - 1));
  const tierRows = tiers.map((tier, i): KitRow => ({ label: `${i + 1}. ${tier.label}`, desc: tier.detail, selected: i === submenuIndex }));
  // The submenu is indented 2 columns under the buttons it belongs to.
  const tierX0 = MODAL_PAD_X + 2;
  const tierX1 = width - MODAL_PAD_X - 1;
  const tierHeight = tierRows.reduce((sum, row) => sum + measureRow(row, tierX0, tierX1), 0);
  // Pinned under the scrolling body: blank, buttons row, then the submenu.
  const pinned = (buttons.length > 0 ? 2 : 0) + (tierRows.length > 0 ? tierHeight + 1 : 0);
  // Fill rows: padding, title, blank, body..., pinned, blank, hints, empty last row.
  const f = beginModal(screenWidth, screenHeight, {
    title: buildPermissionApprovalBrief(request).title,
    titleGlyph: { char: titleGlyph(request.category), fg: t.warning },
    width,
    height: body.length + pinned + hintRows + 5,
    center: true,
    cap: 'warning',
    escKey: false,
    hints,
  });

  const right = [categoryLabel(request.category), state.requestedBy, state.queueCount && state.queueCount > 0 ? `${state.queueCount} more waiting` : ''].filter(Boolean).join(' · ');
  if (right) f.canvas.right(f.r, f.t, right, { fg: t.textFaint });

  const scrollBottom = f.bottom - pinned;
  const capacity = Math.max(1, scrollBottom - f.top + 1);
  const maxScroll = Math.max(0, body.length - capacity);
  let scroll = Math.max(0, Math.min(state.scroll ?? 0, maxScroll));
  // Keep the hunk cursor in view.
  const cursorRow = body.findIndex((r) => r.cursor);
  if (cursorRow >= 0) {
    if (cursorRow < scroll) scroll = cursorRow;
    else if (cursorRow >= scroll + capacity) scroll = cursorRow - capacity + 1;
  }
  for (let i = 0; i < capacity && scroll + i < body.length; i++) {
    const row = body[scroll + i]!;
    const y = f.top + i;
    if (row.panel) f.canvas.fill(f.l - 2, y, f.r - f.l + 5, 1, row.tint ?? t.backgroundElement);
    if (row.cursor) {
      drawRow(f.canvas, y, { spans: row.spans.map((s) => ({ ...s, fg: undefined })), selected: true }, f.l, f.r);
      continue;
    }
    let x = row.panel ? f.l : f.l;
    for (const span of row.spans) {
      if (span.text.startsWith('\u0000')) {
        x = chip(f.canvas, x, y, span.text.slice(1), span.fg ?? t.warning);
        continue;
      }
      x = f.canvas.put(x, y, span.text, { fg: span.fg ?? t.text, bold: span.bold });
    }
    if (row.right) f.canvas.right(f.r, y, row.right.text, { fg: row.right.fg });
  }
  if (body.length > capacity) f.hintRight = scrollCountText(scroll, Math.max(0, body.length - scroll - capacity));

  let y = scrollBottom + 1;
  if (buttons.length > 0) {
    y++;
    const choice = Math.max(0, Math.min(state.choice ?? 0, buttons.length - 1));
    let bx = f.l;
    buttons.forEach((b, i) => {
      if (bx + buttonWidth(b.label) - 1 > f.r) return;
      bx = button(f.canvas, bx, y, b.label, i === choice, b.id === 'deny' ? 'danger' : 'warning') + 2;
    });
    const detailsHint = state.detailsExpanded ? 'hide details' : 'details';
    if (!state.hunkState && bx + detailsHint.length + 4 <= f.r) {
      const start = f.canvas.right(f.r, y, detailsHint, { fg: t.textFaint });
      f.canvas.put(start - 2, y, 'd', { fg: t.text, bold: true });
    }
    y++;
  }
  if (tierRows.length > 0) {
    y++;
    for (const row of tierRows) {
      if (y > f.bottom) break;
      y += drawRow(f.canvas, y, row, tierX0, tierX1, f.bottom);
    }
  }
  return finishModal(f);
}
