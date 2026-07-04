import { type Line } from '../types/grid.ts';
import { UIFactory } from '../renderer/ui-factory.ts';
import type { PermissionCategory, PermissionRequestAnalysis } from '@pellux/goodvibes-sdk/platform/permissions';
import { buildPermissionApprovalBrief, getDisplayArg } from '@pellux/goodvibes-sdk/platform/permissions';
import { DIFF_TONES, UI_TONES } from '../renderer/ui-primitives.ts';
import type { HunkSelectionState } from './hunk-selection.ts';
export { buildPendingPermissionExtras } from './hunk-selection.ts';

import type { PermissionPromptRequest, PermissionPromptDecision, PermissionRequestHandler, PermissionRequest } from '@pellux/goodvibes-sdk/platform/permissions';
export type { PermissionPromptRequest, PermissionPromptDecision, PermissionRequestHandler, PermissionRequest };

/** Visible hunk rows before a "+N more" trailer kicks in (Risk 3). */
const MAX_VISIBLE_HUNKS = 8;

/**
 * Single source of truth for how many Line rows the hunk-list section
 * occupies: 1 header row + up to MAX_VISIBLE_HUNKS checkbox rows + 1 trailer
 * row (rendered as "+N more" when truncated, blank otherwise — always
 * present so the row count never depends on which branch fires). Both
 * getPromptHeight and createPromptLines call this SAME function, so they
 * cannot drift apart (Risk 2 — main.ts's render loop reserves viewport
 * space from getPromptHeight *before* the real render happens).
 */
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

  static getPromptHeight(request: PermissionPromptRequest, hunkState?: HunkSelectionState): number {
    const analysis = this.fallbackAnalysis(request);
    const reasonLines = Math.min(2, Math.max(1, analysis.reasons.length));
    const extraLines = (analysis.host ? 1 : 0) + (analysis.surface ? 1 : 0) + (analysis.sideEffects && analysis.sideEffects.length > 0 ? 1 : 0);
    const hunkLines = hunkState ? hunkListRowCount(hunkState) : 0;
    return 12 + reasonLines + extraLines + hunkLines;
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
  static createPromptLines(width: number, request: PermissionRequest, hunkState?: HunkSelectionState): Line[] {
    const lines: Line[] = [];
    const { tool, args, category } = request;
    const analysis = this.fallbackAnalysis(request);
    const brief = buildPermissionApprovalBrief(request);
    const displayArg = this.getDisplayArg(tool, args);
    const { label, color } = this.getCategoryLabel(category);

    const ACCENT = '135'; // purple
    const WARN   = color;
    const TEXT   = '252';
    const DIM    = '244';

    // Top separator
    lines.push(UIFactory.stringToLine('─'.repeat(width), width, { fg: ACCENT, dim: true }));

    // Title bar: category badge + title
    const titleText = brief.title;
    const titleLine = ` [${label}] ${titleText} `;
    lines.push(UIFactory.stringToLine(titleLine.padEnd(width), width, { fg: WARN, bold: true }));

    // Tool name row
    const toolLine = `   Tool      : ${tool}`;
    lines.push(UIFactory.stringToLine(toolLine.padEnd(width), width, { fg: TEXT }));

    // Key argument row - truncate if too long
    const maxArgLen = Math.max(10, width - 16);
    const truncatedArg = displayArg.length > maxArgLen
      ? '...' + displayArg.slice(-(maxArgLen - 3))
      : displayArg;
    const argLine = `   ${brief.subjectLabel.padEnd(9)}: ${truncatedArg}`;
    lines.push(UIFactory.stringToLine(argLine.padEnd(width), width, { fg: TEXT }));

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

    for (const reason of analysis.reasons.slice(0, 2)) {
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

    // Choices row
    const choicesLine = hunkState
      ? `   [j/k] Navigate  [Space] Toggle  [A] All  [Enter] Apply selected  [N] Deny`
      : `   [Y] Allow once    [A] Allow always (session)    [N] Deny`;
    lines.push(UIFactory.stringToLine(choicesLine.padEnd(width), width, { fg: ACCENT, bold: true }));

    // Bottom separator
    lines.push(UIFactory.stringToLine('─'.repeat(width), width, { fg: ACCENT, dim: true }));

    return lines;
  }
}
