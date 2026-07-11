import { type Line } from '../types/grid.ts';
import { UIFactory } from '../renderer/ui-factory.ts';
import type { PermissionCategory, PermissionRequestAnalysis } from '@pellux/goodvibes-sdk/platform/permissions';
import { buildPermissionApprovalBrief, getDisplayArg } from '@pellux/goodvibes-sdk/platform/permissions';
import { DIFF_TONES, UI_TONES } from '../renderer/ui-primitives.ts';
import type { HunkSelectionState } from './hunk-selection.ts';
import { readSandboxAskAnnotation } from './sandbox-exec-gate.ts';
export { buildPendingPermissionExtras } from './hunk-selection.ts';

import type { PermissionPromptRequest, PermissionPromptDecision, PermissionRequestHandler, PermissionRequest } from '@pellux/goodvibes-sdk/platform/permissions';
export type { PermissionPromptRequest, PermissionPromptDecision, PermissionRequestHandler, PermissionRequest };

/** Visible hunk rows before a "+N more" trailer kicks in (Risk 3). */
const MAX_VISIBLE_HUNKS = 8;

/** Path rows shown before collapsing to a "N files: a, b, +K more" line (UX-B 2a). */
const MAX_PATH_ROWS = 3;

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
 * `{files:[{path}]}` no longer falls through to a raw JSON blob. (UX-B 2a.)
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
   * scope, and hunk-selectable edits always show the full block. (UX-B 2b.)
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
    // low-risk filesystem reads/writes condense. (UX-B 2b.)
    if (request.category === 'execute' || request.category === 'delegate') return false;
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

  static getPromptHeight(
    request: PermissionPromptRequest,
    hunkState?: HunkSelectionState,
    detailsExpanded = false,
    requestedBy?: string,
  ): number {
    // Attribution line (only when known) + the always-present remember-scope
    // preview line are added to BOTH card shapes; keep in sync with
    // createPromptLines. A hunk-selection prompt has no single [A] remember key,
    // so the preview line is suppressed there (see createPromptLines).
    const attributionLines = requestedBy ? 1 : 0;
    const previewLines = hunkState ? 0 : 1;
    // Condensed low-risk card: top separator, title, [attribution], [preview],
    // summary, choices, bottom separator — see createPromptLines' condensed branch.
    if (this.isCondensed(request, hunkState, detailsExpanded)) return 5 + attributionLines + previewLines;
    const analysis = this.fallbackAnalysis(request);
    const { annotation: judgmentAnnotation, rest: reasonsMinusJudgment } = extractModelJudgmentAnnotation(analysis.reasons);
    const reasonLines = Math.min(2, Math.max(1, reasonsMinusJudgment.length));
    const extraLines = (analysis.host ? 1 : 0) + (analysis.surface ? 1 : 0) + (analysis.sideEffects && analysis.sideEffects.length > 0 ? 1 : 0) + (readSandboxAskAnnotation(request) ? 1 : 0) + (judgmentAnnotation ? 1 : 0);
    const hunkLines = hunkState ? hunkListRowCount(hunkState) : 0;
    // Base 12 counted a single arg line; the Path field now spans `pathRows`
    // lines and the full card adds one raw-args row (2a reachability), so the
    // arg allotment becomes pathRows + 1 → base 12 + pathRows (12 already
    // included one of those). See createPromptLines' full branch.
    const pathRows = this.pathRowTexts(this.resolvedTargets(request), 999).length;
    return 12 + pathRows + reasonLines + extraLines + hunkLines + attributionLines + previewLines;
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

    // Attribution line (which agent/process is asking) and the remember-scope
    // preview line ([A] writes exactly this key). Both are shared by the
    // condensed and full cards; the preview is suppressed for a hunk-selection
    // prompt, which has no single whole-request [A] remember key.
    const pushAttribution = (): void => {
      if (!requestedBy) return;
      lines.push(UIFactory.stringToLine(`   Requested by: ${requestedBy}`.padEnd(width), width, { fg: DIM }));
    };
    const pushRememberPreview = (): void => {
      if (hunkState) return;
      lines.push(UIFactory.stringToLine(this.rememberPreviewText(request, width).padEnd(width), width, { fg: DIM }));
    };

    const maxArgLen = Math.max(10, width - 16);
    const pathRows = this.pathRowTexts(this.resolvedTargets(request), maxArgLen);

    // Condensed low-risk / project-local card: one summary line (verb → target
    // (scope)) plus the choices. Full block is one `d` away. (UX-B 2b.)
    if (this.isCondensed(request, hunkState, detailsExpanded)) {
      lines.push(UIFactory.stringToLine('─'.repeat(width), width, { fg: ACCENT, dim: true }));
      lines.push(UIFactory.stringToLine(` [${label}] ${brief.title} `.padEnd(width), width, { fg: WARN, bold: true }));
      pushAttribution();
      const scopeText = analysis.blastRadius ? ` (${analysis.blastRadius})` : '';
      const summaryLine = `   ${categoryVerb(category)} → ${pathRows[0]}${scopeText}`;
      lines.push(UIFactory.stringToLine(summaryLine.padEnd(width), width, { fg: TEXT }));
      pushRememberPreview();
      lines.push(UIFactory.stringToLine(
        `   [Y] Allow once    [A] Allow always (session)    [N] Deny    [d] details`.padEnd(width),
        width, { fg: ACCENT, bold: true }));
      lines.push(UIFactory.stringToLine('─'.repeat(width), width, { fg: ACCENT, dim: true }));
      return lines;
    }

    // Top separator
    lines.push(UIFactory.stringToLine('─'.repeat(width), width, { fg: ACCENT, dim: true }));

    // Title bar: category badge + title
    const titleText = brief.title;
    const titleLine = ` [${label}] ${titleText} `;
    lines.push(UIFactory.stringToLine(titleLine.padEnd(width), width, { fg: WARN, bold: true }));

    // Requester attribution (which agent/process raised this request).
    pushAttribution();

    // Tool name row
    const toolLine = `   Tool      : ${tool}`;
    lines.push(UIFactory.stringToLine(toolLine.padEnd(width), width, { fg: TEXT }));

    // Path/subject row(s): actual target path(s), one per line when few, a
    // "N files: a, b, +K more" summary when many. Raw args move to the Args row
    // below so this field never shows a truncated JSON blob. (UX-B 2a.)
    pathRows.forEach((rowText, i) => {
      const labelCol = i === 0 ? brief.subjectLabel.padEnd(9) : ' '.repeat(9);
      lines.push(UIFactory.stringToLine(`   ${labelCol}: ${rowText}`.padEnd(width), width, { fg: TEXT }));
    });

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

    // Remember-scope preview: exactly what [A] will write (omitted for hunk mode).
    pushRememberPreview();

    // Choices row. A condensable card shown in full is the expanded form, so it
    // offers `[d]` to collapse back; other full cards omit the details toggle.
    const collapseHint = this.isCondensed(request, hunkState, false) ? '    [d] hide details' : '';
    const choicesLine = hunkState
      ? `   [j/k] Navigate  [Space] Toggle  [A] All  [Enter] Apply selected  [N] Deny`
      : `   [Y] Allow once    [A] Allow always (session)    [N] Deny${collapseHint}`;
    lines.push(UIFactory.stringToLine(choicesLine.padEnd(width), width, { fg: ACCENT, bold: true }));

    // Bottom separator
    lines.push(UIFactory.stringToLine('─'.repeat(width), width, { fg: ACCENT, dim: true }));

    return lines;
  }
}
