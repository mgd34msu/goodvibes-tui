import { type Line } from '../types/grid.ts';
import { UIFactory } from '../renderer/ui-factory.ts';
import type { PermissionCategory, PermissionRequestAnalysis } from '@pellux/goodvibes-sdk/platform/permissions';
import { buildPermissionApprovalBrief, getDisplayArg } from '@pellux/goodvibes-sdk/platform/permissions';
import { DIFF_TONES, UI_TONES } from '../renderer/ui-primitives.ts';
import { renderDiffView } from '../renderer/diff-view.ts';
import { wrapText } from '../utils/terminal-width.ts';
import type { HunkSelectionState } from './hunk-selection.ts';
import { readSandboxAskAnnotation } from './sandbox-exec-gate.ts';
export { buildPendingPermissionExtras } from './hunk-selection.ts';

import type { PermissionPromptRequest, PermissionPromptDecision, PermissionRequestHandler, PermissionRequest } from '@pellux/goodvibes-sdk/platform/permissions';
export type { PermissionPromptRequest, PermissionPromptDecision, PermissionRequestHandler, PermissionRequest };

/** Visible hunk rows before a "+N more" trailer kicks in (Risk 3). */
const MAX_VISIBLE_HUNKS = 8;

/** Path rows shown before collapsing to a "N files: a, b, +K more" line (2a). */
const MAX_PATH_ROWS = 3;

/** Diff rows shown for a write/edit ask before the "+N more" trailer. */
const MAX_DIFF_LINES = 10;

/** Field-label column width shared by every "   Label     : value" row. */
const FIELD_PREFIX_LEN = 16;

/**
 * View-only state the card renders beyond the request itself: the typed-reply
 * mode/draft (deny-with-reason, exec-prompt answer), the honest count of
 * OTHER broker asks still waiting, and the terminal width getPromptHeight
 * needs for wrap-dependent rows (createPromptLines takes width positionally).
 */
export interface PromptViewState {
  readonly replyMode?: 'deny-reason' | 'exec-answer' | undefined;
  readonly replyBuffer?: string | undefined;
  readonly queueCount?: number | undefined;
  readonly width?: number | undefined;
}

/** Trailing filename for compact display of a long/absolute path. */
function baseName(p: string): string {
  const cleaned = p.replace(/[/\\]+$/, '');
  const idx = Math.max(cleaned.lastIndexOf('/'), cleaned.lastIndexOf('\\'));
  return idx >= 0 ? cleaned.slice(idx + 1) : cleaned;
}

/** Make an absolute path relative to the working directory when it sits under it. */
function relativize(p: string, cwd?: string): string {
  if (!cwd || !p.startsWith('/')) return p;
  if (p === cwd) return '.';
  const prefix = cwd.endsWith('/') ? cwd : `${cwd}/`;
  return p.startsWith(prefix) ? p.slice(prefix.length) : p;
}

/** Collect string elements or `el[field]` strings from an array arg. */
function collectField(arr: unknown, field: string): string[] {
  if (!Array.isArray(arr)) return [];
  const out: string[] = [];
  for (const el of arr) {
    if (typeof el === 'string') out.push(el);
    else if (el && typeof el === 'object' && typeof (el as Record<string, unknown>)[field] === 'string') {
      out.push((el as Record<string, unknown>)[field] as string);
    }
  }
  return out;
}

/**
 * The real display target(s) of a tool invocation — the paths/commands/urls a
 * user needs to see, extracted from the actual arg shapes so a nested
 * `{files:[{path}]}` no longer falls through to a raw JSON blob. (2a.)
 * Returns [] when nothing recognisable is present (caller falls back).
 */
function cardTargets(args: Record<string, unknown>): string[] {
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
}

/** Short human verb for a permission category, for the condensed summary line. */
function categoryVerb(category: PermissionCategory): string {
  switch (category) {
    case 'write':    return 'write';
    case 'execute':  return 'run';
    case 'delegate': return 'delegate';
    default:         return 'read';
  }
}

/**
 * Single source of truth for how many Line rows the hunk-list section
 * occupies: 1 header row + up to MAX_VISIBLE_HUNKS checkbox rows + 1 trailer
 * row (rendered as "+N more" when truncated, blank otherwise — always
 * present so the row count never depends on which branch fires). Both
 * getPromptHeight and createPromptLines call this SAME function, so they
 * cannot drift apart (Risk 2 — main.ts's render loop reserves viewport
 * space from getPromptHeight *before* the real render happens).
 */
/**
 * The optional sandbox model-judgment tier (see sandbox-judgment.ts in the
 * SDK) annotates an escalation ask by pushing one string — verbatim
 * "model judgment: looks safe because…" / "model judgment: flags risk
 * because…" — onto `analysis.reasons`, alongside the sandbox-boundary and
 * policy reasons. Pulled out here so it gets its own clearly-labeled row
 * instead of blending into the generic Review bullets, where the truncation
 * to 2 reasons could silently cut it (it is typically the LAST reason
 * pushed, after the boundary line and any policy reasons).
 */
const MODEL_JUDGMENT_PREFIX = 'model judgment:';

function extractModelJudgmentAnnotation(reasons: readonly string[]): { annotation: string | undefined; rest: string[] } {
  const idx = reasons.findIndex((r) => r.toLowerCase().startsWith(MODEL_JUDGMENT_PREFIX));
  if (idx === -1) return { annotation: undefined, rest: [...reasons] };
  return { annotation: reasons[idx], rest: [...reasons.slice(0, idx), ...reasons.slice(idx + 1)] };
}

function hunkListRowCount(hunkState: HunkSelectionState): number {
  return Math.min(hunkState.hunks.length, MAX_VISIBLE_HUNKS) + 2;
}

/**
 * PermissionPromptUI - Renders a permission prompt as Line[] fragments.
 *
 * Displayed as an overlay injected into the viewport during render.
 * The prompt blocks orchestrator execution until the user responds.
 *
 * Keys:
 *   y / Y  -> Allow once
 *   a / A  -> Allow always (this session)
 *   n / N  -> Deny
 *   Escape -> Deny
 */
export class PermissionPromptUI {
  private static fallbackAnalysis(request: PermissionPromptRequest): PermissionRequestAnalysis {
    return request.analysis ?? {
      classification: request.category,
      riskLevel: request.category === 'read' ? 'low' : request.category === 'write' ? 'medium' : 'high',
      summary: `Review ${request.tool} request`,
      reasons: ['Inspect the target and intent before approving this action.'],
      target: getDisplayArg(request.tool, request.args),
      targetKind: 'generic',
    };
  }

  /** The relativised display target(s) for the Path field, with a raw fallback. */
  private static resolvedTargets(request: PermissionPromptRequest): string[] {
    const cwd = request.workingDirectory;
    const targets = cardTargets(request.args).map((t) => relativize(t, cwd));
    return targets.length > 0 ? targets : [getDisplayArg(request.tool, request.args)];
  }

  /** Path-field row texts — one per target when few, a "N files:" summary when many. */
  private static pathRowTexts(targets: string[], maxLen: number): string[] {
    const clamp = (s: string): string => (s.length > maxLen ? `...${s.slice(-(maxLen - 3))}` : s);
    if (targets.length <= 1) return [clamp(targets[0] ?? '(unknown)')];
    if (targets.length <= MAX_PATH_ROWS) return targets.map(clamp);
    const shown = targets.slice(0, 2).map(baseName).join(', ');
    return [clamp(`${targets.length} files: ${shown}, +${targets.length - 2} more`)];
  }

  /**
   * A low-risk, project-local request is shown condensed (one summary line +
   * choices) unless the user expanded it with `d`. High/critical risk, external
   * scope, and hunk-selectable edits always show the full block. (2b.)
   */
  private static isCondensed(
    request: PermissionPromptRequest,
    hunkState: HunkSelectionState | undefined,
    detailsExpanded: boolean,
  ): boolean {
    if (hunkState || detailsExpanded) return false;
    // Shell execution, delegation and network requests always show the full
    // card — their action semantics (command, side effects, host, checklist)
    // warrant scrutiny even when the risk model rates them low. Only mundane
    // low-risk filesystem reads/writes condense. (2b.)
    if (request.category === 'execute' || request.category === 'delegate') return false;
    // Remember tiers are one-key choices that must be visible to be usable —
    // a request carrying rememberOptions always shows the full card.
    if (request.rememberOptions && request.rememberOptions.length > 0) return false;
    const analysis = this.fallbackAnalysis(request);
    if (analysis.riskLevel !== 'low') return false;
    const scope = analysis.blastRadius;
    return scope === undefined || scope === 'local' || scope === 'project';
  }

  /**
   * The exact session-scoped permission rule that pressing [A] ("Allow always
   * this session") will remember. Mirrors the SDK PermissionManager's
   * getApprovalKey (`<tool>:<path>` when a path arg exists, `<tool>:<command>`
   * for a command arg, else the bare `<tool>`), so the preview shown to the
   * user before they choose is the exact key that gets written. Kept in sync
   * with that SDK function by construction.
   */
  static rememberScopeKey(request: PermissionPromptRequest): string {
    const args = request.args ?? {};
    if (typeof args.path === 'string' && args.path.length > 0) return `${request.tool}:${args.path}`;
    if (typeof args.command === 'string' && args.command.length > 0) return `${request.tool}:${args.command}`;
    return request.tool;
  }

  /** The one-line preview text for what [A] remembers, truncated to the width. */
  private static rememberPreviewText(request: PermissionPromptRequest, width: number): string {
    const key = this.rememberScopeKey(request);
    const prefix = '   Remembers : [A] allows "';
    const suffix = '" for this session';
    const budget = Math.max(6, width - prefix.length - suffix.length);
    const shown = key.length > budget ? `...${key.slice(-(budget - 3))}` : key;
    return `${prefix}${shown}${suffix}`;
  }

  /**
   * The remember block's row texts: one row per SDK remember tier (numbered,
   * most specific first) when the request carries rememberOptions, else the
   * legacy single [A] session-preview row. Hunk mode has no whole-request
   * remember choice at all. Shared by getPromptHeight and createPromptLines.
   */
  private static rememberRowTexts(
    request: PermissionPromptRequest,
    hunkState: HunkSelectionState | undefined,
    width: number,
  ): string[] {
    if (hunkState) return [];
    const options = request.rememberOptions ?? [];
    if (options.length === 0) return [this.rememberPreviewText(request, width)];
    const clamp = (s: string): string => (s.length > width ? `${s.slice(0, Math.max(0, width - 3))}...` : s);
    return options.map((option, index) => {
      const labelCol = index === 0 ? 'Remember ' : ' '.repeat(9);
      return clamp(`   ${labelCol}: [${index + 1}] ${option.label} — ${option.detail}`);
    });
  }

  /**
   * The FULL command of an execute ask, wrapped across as many rows as it
   * needs — never truncated. Empty for non-execute asks and for asks without
   * a string command. Shared by getPromptHeight and createPromptLines.
   */
  private static commandRowTexts(request: PermissionPromptRequest, width: number): string[] {
    if (request.category !== 'execute') return [];
    // Exec-prompt asks render their command via execPromptRowTexts instead.
    if (request.attribution?.kind === 'exec-prompt') return [];
    const command = typeof request.args?.command === 'string'
      ? request.args.command
      : typeof request.args?.cmd === 'string'
        ? request.args.cmd
        : '';
    if (command.length === 0) return [];
    const budget = Math.max(10, width - FIELD_PREFIX_LEN);
    const wrapped = command.split('\n').flatMap((line) => (line.length > 0 ? wrapText(line, budget) : ['']));
    return wrapped.map((row, index) => (index === 0 ? `   Command   : ${row}` : `${' '.repeat(FIELD_PREFIX_LEN - 1)}${row}`));
  }

  /**
   * Unified-diff text lines for a write/edit ask (real colored rendering via
   * renderDiffView), capped at MAX_DIFF_LINES with a context trailer naming
   * how much is hidden. Null when the ask carries nothing diffable. Hunk-mode
   * asks render the interactive hunk list instead. Shared by getPromptHeight
   * and createPromptLines.
   */
  private static writeDiffLines(request: PermissionPromptRequest, hunkState: HunkSelectionState | undefined): string[] | null {
    if (hunkState || request.category !== 'write') return null;
    const args = request.args ?? {};
    const target = typeof args.path === 'string' ? args.path : typeof args.file === 'string' ? args.file : '';
    const out: string[] = [];
    if (typeof args.content === 'string') {
      const contentLines = args.content.split('\n');
      out.push(`+++ ${target || '(new content)'}`);
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

  /**
   * Rows for an exec-prompt ask (a running command waiting on stdin): the
   * command and the terminal prompt text, both wrapped in full. Shared by
   * getPromptHeight and createPromptLines.
   */
  private static execPromptRowTexts(request: PermissionPromptRequest, width: number): string[] {
    const attribution = request.attribution;
    if (attribution?.kind !== 'exec-prompt') return [];
    const budget = Math.max(10, width - FIELD_PREFIX_LEN);
    const rows: string[] = [];
    const pushWrapped = (label: string, text: string): void => {
      const wrapped = text.split('\n').flatMap((line) => (line.length > 0 ? wrapText(line, budget) : ['']));
      wrapped.forEach((row, index) => {
        rows.push(index === 0 ? `   ${label.padEnd(9)}: ${row}` : `${' '.repeat(FIELD_PREFIX_LEN - 1)}${row}`);
      });
    };
    if (typeof attribution.command === 'string' && attribution.command.length > 0) pushWrapped('Running', attribution.command);
    if (typeof attribution.prompt === 'string' && attribution.prompt.length > 0) pushWrapped('Asks', attribution.prompt);
    return rows;
  }

  /** The typed-reply input row text (deny reason / exec answer), or null when no reply mode is active. */
  private static replyRowText(view: PromptViewState | undefined, width: number): string | null {
    if (!view?.replyMode) return null;
    const label = view.replyMode === 'exec-answer' ? 'Answer   ' : 'Reason   ';
    const draft = view.replyBuffer ?? '';
    const budget = Math.max(6, width - FIELD_PREFIX_LEN - 1);
    const shown = draft.length > budget ? `...${draft.slice(-(budget - 3))}` : draft;
    return `   ${label}: ${shown}█`;
  }

  /**
   * Assemble the card's view state from the pending-permission slot and the
   * broker's live queue (the honest count of OTHER pending asks — coalesced
   * asks share one record, so they are never double-counted). One helper so
   * main.ts passes identical state to getPromptHeight and createPromptLines.
   */
  static promptViewState(
    pending: { readonly callId: string; readonly replyMode?: 'deny-reason' | 'exec-answer' | undefined; readonly replyBuffer?: string | undefined },
    width: number,
    broker?: { listApprovals(limit?: number): ReadonlyArray<{ readonly callId: string; readonly status: string }> } | null,
  ): PromptViewState {
    let queueCount = 0;
    try {
      queueCount = broker?.listApprovals().filter((record) => record.status === 'pending' && record.callId !== pending.callId).length ?? 0;
    } catch {
      queueCount = 0; // an unreadable broker never blocks the card
    }
    return { replyMode: pending.replyMode, replyBuffer: pending.replyBuffer, queueCount, width };
  }

  static getPromptHeight(
    request: PermissionPromptRequest,
    hunkState?: HunkSelectionState,
    detailsExpanded = false,
    requestedBy?: string,
    view?: PromptViewState,
  ): number {
    const width = view?.width ?? 80;
    // Attribution line (only when known) + the remember block (tier rows when
    // the request carries rememberOptions, else the legacy one-line preview)
    // are added to BOTH card shapes; keep in sync with createPromptLines.
    const attributionLines = requestedBy ? 1 : 0;
    const rememberLines = this.rememberRowTexts(request, hunkState, width).length;
    // Condensed low-risk card: top separator, title, [attribution], [preview],
    // summary, choices, bottom separator — see createPromptLines' condensed branch.
    if (this.isCondensed(request, hunkState, detailsExpanded)) return 5 + attributionLines + rememberLines;
    const analysis = this.fallbackAnalysis(request);
    const { annotation: judgmentAnnotation, rest: reasonsMinusJudgment } = extractModelJudgmentAnnotation(analysis.reasons);
    const reasonLines = Math.min(2, Math.max(1, reasonsMinusJudgment.length));
    const extraLines = (analysis.host ? 1 : 0) + (analysis.surface ? 1 : 0) + (analysis.sideEffects && analysis.sideEffects.length > 0 ? 1 : 0) + (readSandboxAskAnnotation(request) ? 1 : 0) + (judgmentAnnotation ? 1 : 0);
    const hunkLines = hunkState ? hunkListRowCount(hunkState) : 0;
    // Item-adopted blocks, each computed by the SAME helper createPromptLines
    // renders from, so the two functions cannot drift: the full wrapped
    // command (execute), the colored diff (write), the exec-prompt rows, and
    // the typed-reply input row.
    const commandLines = this.commandRowTexts(request, width).length;
    const diffLines = this.writeDiffLines(request, hunkState)?.length ?? 0;
    const execPromptLines = this.execPromptRowTexts(request, width).length;
    const replyLines = this.replyRowText(view, width) ? 1 : 0;
    // Base 12 counted a single arg line; the Path field now spans `pathRows`
    // lines and the full card adds one raw-args row (2a reachability), so the
    // arg allotment becomes pathRows + 1 → base 12 + pathRows (12 already
    // included one of those). See createPromptLines' full branch.
    const pathRows = this.pathRowTexts(this.resolvedTargets(request), 999).length;
    return 12 + pathRows + reasonLines + extraLines + hunkLines + attributionLines + rememberLines
      + commandLines + diffLines + execPromptLines + replyLines;
  }

  /** Returns the key argument to display for a given tool invocation. */
  static getDisplayArg(tool: string, args: Record<string, unknown>): string {
    return getDisplayArg(tool, args);
  }

  /** Returns the category label and ANSI 256-color code for display. */
  static getCategoryLabel(category: PermissionCategory): { label: string; color: string } {
    switch (category) {
      case 'write':    return { label: 'WRITE',    color: '220' }; // yellow
      case 'execute':  return { label: 'EXECUTE',  color: '196' }; // red
      case 'delegate': return { label: 'DELEGATE', color: '208' }; // orange
      default:         return { label: 'PERMISSION', color: '244' };
    }
  }

  static getPromptTitle(request: PermissionPromptRequest): string {
    return buildPermissionApprovalBrief(request).title;
  }

  static getSubjectLabel(request: PermissionPromptRequest): string {
    return buildPermissionApprovalBrief(request).subjectLabel;
  }

  /**
   * createPromptLines - Renders the permission prompt as an array of Lines.
   * Injected into the viewport by the render function when a request is pending.
   */
  static createPromptLines(
    width: number,
    request: PermissionRequest,
    hunkState?: HunkSelectionState,
    detailsExpanded = false,
    requestedBy?: string,
    view?: PromptViewState,
  ): Line[] {
    const lines: Line[] = [];
    const { tool, args, category } = request;
    const analysis = this.fallbackAnalysis(request);
    const brief = buildPermissionApprovalBrief(request);
    const { label, color } = this.getCategoryLabel(category);

    const ACCENT = '135'; // purple
    const WARN   = color;
    const TEXT   = '252';
    const DIM    = '244';

    // Honest queue: how many OTHER broker asks are waiting behind this one.
    // They surface in turn as each is answered; the count keeps that visible.
    const queueSuffix = view?.queueCount && view.queueCount > 0
      ? ` — ${view.queueCount} more waiting`
      : '';

    // Attribution line (which agent/process is asking) and the remember block
    // (numbered tier rows from the SDK's rememberOptions, or the legacy [A]
    // session-preview row). Both are shared by the condensed and full cards;
    // the remember block is suppressed for a hunk-selection prompt, which has
    // no single whole-request remember key.
    const pushAttribution = (): void => {
      if (!requestedBy) return;
      lines.push(UIFactory.stringToLine(`   Requested by: ${requestedBy}`.padEnd(width), width, { fg: DIM }));
    };
    const pushRememberBlock = (): void => {
      for (const rowText of this.rememberRowTexts(request, hunkState, width)) {
        lines.push(UIFactory.stringToLine(rowText.padEnd(width), width, { fg: DIM }));
      }
    };

    const maxArgLen = Math.max(10, width - 16);
    const pathRows = this.pathRowTexts(this.resolvedTargets(request), maxArgLen);

    // Condensed low-risk / project-local card: one summary line (verb → target
    // (scope)) plus the choices. Full block is one `d` away. (2b.)
    if (this.isCondensed(request, hunkState, detailsExpanded)) {
      lines.push(UIFactory.stringToLine('─'.repeat(width), width, { fg: ACCENT, dim: true }));
      lines.push(UIFactory.stringToLine(` [${label}] ${brief.title}${queueSuffix} `.padEnd(width), width, { fg: WARN, bold: true }));
      pushAttribution();
      const scopeText = analysis.blastRadius ? ` (${analysis.blastRadius})` : '';
      const summaryLine = `   ${categoryVerb(category)} → ${pathRows[0]}${scopeText}`;
      lines.push(UIFactory.stringToLine(summaryLine.padEnd(width), width, { fg: TEXT }));
      pushRememberBlock();
      lines.push(UIFactory.stringToLine(
        `   [Y] Allow once    [A] Allow always (session)    [N] Deny    [d] details`.padEnd(width),
        width, { fg: ACCENT, bold: true }));
      lines.push(UIFactory.stringToLine('─'.repeat(width), width, { fg: ACCENT, dim: true }));
      return lines;
    }

    // Top separator
    lines.push(UIFactory.stringToLine('─'.repeat(width), width, { fg: ACCENT, dim: true }));

    // Title bar: category badge + title (+ honest waiting count)
    const titleText = brief.title;
    const titleLine = ` [${label}] ${titleText}${queueSuffix} `;
    lines.push(UIFactory.stringToLine(titleLine.padEnd(width), width, { fg: WARN, bold: true }));

    // Requester attribution (which agent/process raised this request).
    pushAttribution();

    // Tool name row
    const toolLine = `   Tool      : ${tool}`;
    lines.push(UIFactory.stringToLine(toolLine.padEnd(width), width, { fg: TEXT }));

    // Path/subject row(s): actual target path(s), one per line when few, a
    // "N files: a, b, +K more" summary when many. Raw args move to the Args row
    // below so this field never shows a truncated JSON blob. (2a.)
    pathRows.forEach((rowText, i) => {
      const labelCol = i === 0 ? brief.subjectLabel.padEnd(9) : ' '.repeat(9);
      lines.push(UIFactory.stringToLine(`   ${labelCol}: ${rowText}`.padEnd(width), width, { fg: TEXT }));
    });

    // The FULL command of an execute ask, wrapped — never truncated. The Path
    // row above stays as the one-line subject; this block is the whole truth.
    for (const rowText of this.commandRowTexts(request, width)) {
      lines.push(UIFactory.stringToLine(rowText.padEnd(width), width, { fg: TEXT }));
    }

    // Exec-prompt attribution: the running command and the terminal prompt it
    // is stuck on, wrapped in full — the typed answer feeds this run's stdin.
    for (const rowText of this.execPromptRowTexts(request, width)) {
      lines.push(UIFactory.stringToLine(rowText.padEnd(width), width, { fg: WARN }));
    }

    // Working directory row
    const cwd = request.workingDirectory ?? '(unknown)';
    const maxCwdLen = Math.max(10, width - 16);
    const truncatedCwd = cwd.length > maxCwdLen ? '...' + cwd.slice(-(maxCwdLen - 3)) : cwd;
    const cwdLine = `   Directory : ${truncatedCwd}`;
    lines.push(UIFactory.stringToLine(cwdLine.padEnd(width), width, { fg: DIM }));

    const riskLine = `   Risk      : ${analysis.riskLevel.toUpperCase()} (${analysis.classification})`;
    lines.push(UIFactory.stringToLine(riskLine.padEnd(width), width, { fg: WARN }));

    if (analysis.surface || analysis.blastRadius) {
      const surfaceLine = `   Surface   : ${analysis.surface ?? 'generic'}${analysis.blastRadius ? `  radius=${analysis.blastRadius}` : ''}`;
      lines.push(UIFactory.stringToLine(surfaceLine.padEnd(width), width, { fg: DIM }));
    }

    if (analysis.host) {
      const hostLine = `   Host      : ${analysis.host}`;
      lines.push(UIFactory.stringToLine(hostLine.padEnd(width), width, { fg: DIM }));
    }

    // Sandbox escalation row: when the sandbox-aware exec gate turned an
    // auto-allow into an ask because the boundary-safe command still needs host
    // access, name what it wants ("wants network …"). The escalation text is the
    // SDK policy's, verbatim — this row only surfaces it.
    const sandboxAnnotation = readSandboxAskAnnotation(request);
    if (sandboxAnnotation && sandboxAnnotation.sandboxEscalations.length > 0) {
      const escalations = sandboxAnnotation.sandboxEscalations.join('; ');
      const maxSandboxLen = Math.max(10, width - 16);
      const truncatedSandbox =
        escalations.length > maxSandboxLen ? `${escalations.slice(0, maxSandboxLen - 3)}...` : escalations;
      const sandboxLine = `   Sandbox   : ${truncatedSandbox}`;
      lines.push(UIFactory.stringToLine(sandboxLine.padEnd(width), width, { fg: WARN }));
    }

    const summary = analysis.summary.length > width - 16
      ? `${analysis.summary.slice(0, Math.max(0, width - 19))}...`
      : analysis.summary;
    const summaryLine = `   Summary   : ${summary}`;
    lines.push(UIFactory.stringToLine(summaryLine.padEnd(width), width, { fg: TEXT }));

    const modeLine = `   Decision  : ${brief.decisionModeLabel}`;
    lines.push(UIFactory.stringToLine(modeLine.padEnd(width), width, { fg: DIM }));

    if (analysis.sideEffects && analysis.sideEffects.length > 0) {
      const effects = analysis.sideEffects.join(', ');
      const maxEffectsLen = Math.max(10, width - 16);
      const truncatedEffects =
        effects.length > maxEffectsLen ? `${effects.slice(0, maxEffectsLen - 3)}...` : effects;
      const effectsLine = `   Effects   : ${truncatedEffects}`;
      lines.push(UIFactory.stringToLine(effectsLine.padEnd(width), width, { fg: DIM }));
    }

    // Model-judgment annotation: gets its own clearly-labeled row (never
    // subject to the Review truncation below) so a `sandbox-model-judgment`
    // verdict — "model judgment: looks safe because…" / "flags risk because…"
    // — is never silently cut. See extractModelJudgmentAnnotation.
    const { annotation: judgmentAnnotation, rest: reasonsMinusJudgment } = extractModelJudgmentAnnotation(analysis.reasons);
    if (judgmentAnnotation) {
      const maxJudgmentLen = Math.max(10, width - 16);
      const truncatedJudgment =
        judgmentAnnotation.length > maxJudgmentLen ? `${judgmentAnnotation.slice(0, maxJudgmentLen - 3)}...` : judgmentAnnotation;
      const judgmentLine = `   Judgment  : ${truncatedJudgment}`;
      lines.push(UIFactory.stringToLine(judgmentLine.padEnd(width), width, { fg: ACCENT, bold: true }));
    }

    for (const reason of reasonsMinusJudgment.slice(0, 2)) {
      const maxReasonLen = Math.max(10, width - 16);
      const truncatedReason =
        reason.length > maxReasonLen ? `${reason.slice(0, maxReasonLen - 3)}...` : reason;
      const reasonLine = `   Review    : ${truncatedReason}`;
      lines.push(UIFactory.stringToLine(reasonLine.padEnd(width), width, { fg: DIM }));
    }

    const checklist = brief.checklist;
    const maxChecklistLen = Math.max(10, width - 16);
    const truncatedChecklist =
      checklist.length > maxChecklistLen ? `${checklist.slice(0, maxChecklistLen - 3)}...` : checklist;
    const checklistLine = `   Checklist : ${truncatedChecklist}`;
    lines.push(UIFactory.stringToLine(checklistLine.padEnd(width), width, { fg: DIM }));

    // Raw args row — the full tool arguments live here in the details view so
    // the Path field above can render clean path(s), never a JSON blob. (2a.)
    const rawArgs = JSON.stringify(args);
    const maxRawLen = Math.max(10, width - 16);
    const truncatedRaw = rawArgs.length > maxRawLen ? `${rawArgs.slice(0, maxRawLen - 3)}...` : rawArgs;
    lines.push(UIFactory.stringToLine(`   Args      : ${truncatedRaw}`.padEnd(width), width, { fg: DIM }));

    // Blank spacer
    lines.push(UIFactory.stringToLine(' '.repeat(width), width));

    // Real colored diff for a write/edit ask (adds green, removals red, hunk
    // headers blue — the same diff-view machinery the transcript uses).
    const diffTextLines = this.writeDiffLines(request, hunkState);
    if (diffTextLines) {
      lines.push(...renderDiffView(diffTextLines.join('\n'), width));
    }

    if (hunkState) {
      // Hunk list — see hunkListRowCount() for the row-count contract this
      // block must match exactly (Risk 2: getPromptHeight/createPromptLines
      // parity is what keeps main.ts's render loop from clipping the
      // viewport).
      const { hunks, cursor, selected } = hunkState;
      const headerLine = `   Hunks (${selected.size}/${hunks.length} selected):`;
      lines.push(UIFactory.stringToLine(headerLine.padEnd(width), width, { fg: TEXT, bold: true }));

      const visible = hunks.slice(0, MAX_VISIBLE_HUNKS);
      const maxPreviewLen = Math.max(6, Math.floor((width - 20) / 2));
      for (let i = 0; i < visible.length; i++) {
        const hunk = visible[i]!;
        const box = selected.has(i) ? '[x]' : '[ ]';
        const findPreview = hunk.find.replace(/\n/g, '⏎').slice(0, maxPreviewLen);
        const replacePreview = hunk.replace.replace(/\n/g, '⏎').slice(0, maxPreviewLen);
        const rowText = `   ${box} ${i + 1}. ${hunk.path} — "${findPreview}" -> "${replacePreview}"`;
        const isCursor = i === cursor;
        lines.push(UIFactory.stringToLine(
          rowText.padEnd(width),
          width,
          {
            fg: selected.has(i) ? DIFF_TONES.add : DIFF_TONES.del,
            bg: isCursor ? UI_TONES.bg.selected : undefined,
            bold: isCursor,
          },
        ));
      }

      const hiddenCount = hunks.length - visible.length;
      const trailerLine = hiddenCount > 0 ? `   +${hiddenCount} more` : '';
      lines.push(UIFactory.stringToLine(trailerLine.padEnd(width), width, { fg: DIM }));
    }

    // Remember block: numbered tier rows (rememberOptions) or the legacy [A]
    // session preview (omitted for hunk mode).
    pushRememberBlock();

    // Typed-reply input row: the deny reason (Enter denies with it as
    // feedback) or the exec-prompt answer (Enter feeds the running command).
    const replyRow = this.replyRowText(view, width);
    if (replyRow) {
      lines.push(UIFactory.stringToLine(replyRow.padEnd(width), width, { fg: TEXT, bold: true }));
    }

    // Choices row. A condensable card shown in full is the expanded form, so it
    // offers `[d]` to collapse back; other full cards omit the details toggle.
    const collapseHint = this.isCondensed(request, hunkState, false) ? '    [d] hide details' : '';
    const tierCount = hunkState ? 0 : (request.rememberOptions?.length ?? 0);
    const rememberHint = tierCount > 0
      ? `    [1${tierCount > 1 ? `-${tierCount}` : ''}] Allow + remember`
      : '    [A] Allow always (session)';
    const choicesLine = view?.replyMode === 'exec-answer'
      ? `   [Enter] Send answer    [Esc] ${((view.replyBuffer ?? '').length > 0) ? 'Clear' : 'Decline'}    [Ctrl+C] Abort turn`
      : view?.replyMode === 'deny-reason'
        ? `   [Enter] Deny with this reason    [Esc] Back    [Ctrl+C] Abort turn`
        : hunkState
          ? `   [j/k] Navigate  [Space] Toggle  [A] All  [Enter] Apply selected  [N] Deny`
          : `   [Y] Allow once${rememberHint}    [N] Deny    type a reason to deny${collapseHint}`;
    lines.push(UIFactory.stringToLine(choicesLine.padEnd(width), width, { fg: ACCENT, bold: true }));

    // Bottom separator
    lines.push(UIFactory.stringToLine('─'.repeat(width), width, { fg: ACCENT, dim: true }));

    return lines;
  }
}
