import { type Line } from '../types/grid.ts';
import { UIFactory } from '../renderer/ui-factory.ts';
import type { PermissionCategory, PermissionRequestAnalysis } from './types.ts';

export interface PermissionPromptRequest {
  callId: string;
  tool: string;
  args: Record<string, unknown>;
  category: PermissionCategory;
  analysis: PermissionRequestAnalysis;
}

export interface PermissionPromptDecision {
  approved: boolean;
  remember?: boolean;
}

export type PermissionRequestHandler = (
  request: PermissionPromptRequest,
) => Promise<PermissionPromptDecision>;

export interface PermissionRequest extends PermissionPromptRequest {
  resolve: (approved: boolean, remember?: boolean) => void;
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
  private static getDecisionModeLabel(request: PermissionPromptRequest): string {
    const analysis = this.fallbackAnalysis(request);
    if (analysis.targetKind === 'url') return 'external-access';
    if (analysis.targetKind === 'path' && request.category === 'write') return 'file-mutation';
    if (request.category === 'execute') return 'shell-execution';
    if (request.category === 'delegate') return 'delegation';
    return 'permission-review';
  }

  private static getChecklist(request: PermissionPromptRequest): string {
    const analysis = this.fallbackAnalysis(request);
    if (analysis.targetKind === 'url') {
      return 'Confirm host trust, scope, and whether remote content should enter session context.';
    }
    if (analysis.targetKind === 'path' && request.category === 'write') {
      return 'Confirm target path, write intent, and whether the path could contain secrets or critical state.';
    }
    if (request.category === 'execute') {
      return 'Confirm shell side effects, network behavior, and whether command text exposes credentials.';
    }
    if (request.category === 'delegate') {
      return 'Confirm delegated scope, tool ceiling, and whether this work should fan out beyond the current step.';
    }
    return 'Confirm scope, target, and expected side effects before approving.';
  }

  private static fallbackAnalysis(request: PermissionPromptRequest): PermissionRequestAnalysis {
    return request.analysis ?? {
      classification: request.category,
      riskLevel: request.category === 'read' ? 'low' : request.category === 'write' ? 'medium' : 'high',
      summary: `Review ${request.tool} request`,
      reasons: ['Inspect the target and intent before approving this action.'],
      target: this.getDisplayArg(request.tool, request.args),
      targetKind: 'generic',
    };
  }

  static getPromptHeight(request: PermissionPromptRequest): number {
    const analysis = this.fallbackAnalysis(request);
    const reasonLines = Math.min(2, Math.max(1, analysis.reasons.length));
    const extraLines = analysis.host ? 1 : 0;
    return 12 + reasonLines + extraLines;
  }

  /** Returns the key argument to display for a given tool invocation. */
  static getDisplayArg(tool: string, args: Record<string, unknown>): string {
    if (typeof args['path'] === 'string') return args['path'];
    if (typeof args['command'] === 'string') return args['command'];
    if (typeof args['pattern'] === 'string') return args['pattern'];
    const first = Object.values(args)[0];
    return typeof first === 'string' ? first : JSON.stringify(args).slice(0, 60);
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
    const analysis = this.fallbackAnalysis(request);
    if (analysis.targetKind === 'url') return 'Network Access Approval';
    if (analysis.targetKind === 'path') return request.category === 'write' ? 'File Mutation Approval' : 'Filesystem Access Approval';
    if (request.category === 'execute') return 'Shell Execution Approval';
    if (request.category === 'delegate') return 'Agent Delegation Approval';
    return 'Permission Review';
  }

  static getSubjectLabel(request: PermissionPromptRequest): string {
    const analysis = this.fallbackAnalysis(request);
    switch (analysis.targetKind) {
      case 'command':
        return 'Command';
      case 'path':
        return 'Path';
      case 'url':
        return 'URL';
      case 'task':
        return 'Task';
      default:
        return 'Target';
    }
  }

  /**
   * createPromptLines - Renders the permission prompt as an array of Lines.
   * Injected into the viewport by the render function when a request is pending.
   */
  static createPromptLines(width: number, request: PermissionRequest): Line[] {
    const lines: Line[] = [];
    const { tool, args, category } = request;
    const analysis = this.fallbackAnalysis(request);
    const displayArg = this.getDisplayArg(tool, args);
    const { label, color } = this.getCategoryLabel(category);

    const ACCENT = '135'; // purple
    const WARN   = color;
    const TEXT   = '252';
    const DIM    = '244';

    // Top separator
    lines.push(UIFactory.stringToLine('─'.repeat(width), width, { fg: ACCENT, dim: true }));

    // Title bar: category badge + title
    const titleText = this.getPromptTitle(request);
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
    const argLine = `   ${this.getSubjectLabel(request).padEnd(9)}: ${truncatedArg}`;
    lines.push(UIFactory.stringToLine(argLine.padEnd(width), width, { fg: TEXT }));

    // Working directory row
    const cwd = process.cwd();
    const maxCwdLen = Math.max(10, width - 16);
    const truncatedCwd = cwd.length > maxCwdLen ? '...' + cwd.slice(-(maxCwdLen - 3)) : cwd;
    const cwdLine = `   Directory : ${truncatedCwd}`;
    lines.push(UIFactory.stringToLine(cwdLine.padEnd(width), width, { fg: DIM }));

    const riskLine = `   Risk      : ${analysis.riskLevel.toUpperCase()} (${analysis.classification})`;
    lines.push(UIFactory.stringToLine(riskLine.padEnd(width), width, { fg: WARN }));

    if (analysis.host) {
      const hostLine = `   Host      : ${analysis.host}`;
      lines.push(UIFactory.stringToLine(hostLine.padEnd(width), width, { fg: DIM }));
    }

    const summary = analysis.summary.length > width - 16
      ? `${analysis.summary.slice(0, Math.max(0, width - 19))}...`
      : analysis.summary;
    const summaryLine = `   Summary   : ${summary}`;
    lines.push(UIFactory.stringToLine(summaryLine.padEnd(width), width, { fg: TEXT }));

    const modeLine = `   Decision  : ${this.getDecisionModeLabel(request)}`;
    lines.push(UIFactory.stringToLine(modeLine.padEnd(width), width, { fg: DIM }));

    for (const reason of analysis.reasons.slice(0, 2)) {
      const maxReasonLen = Math.max(10, width - 16);
      const truncatedReason =
        reason.length > maxReasonLen ? `${reason.slice(0, maxReasonLen - 3)}...` : reason;
      const reasonLine = `   Review    : ${truncatedReason}`;
      lines.push(UIFactory.stringToLine(reasonLine.padEnd(width), width, { fg: DIM }));
    }

    const checklist = this.getChecklist(request);
    const maxChecklistLen = Math.max(10, width - 16);
    const truncatedChecklist =
      checklist.length > maxChecklistLen ? `${checklist.slice(0, maxChecklistLen - 3)}...` : checklist;
    const checklistLine = `   Checklist : ${truncatedChecklist}`;
    lines.push(UIFactory.stringToLine(checklistLine.padEnd(width), width, { fg: DIM }));

    // Blank spacer
    lines.push(UIFactory.stringToLine(' '.repeat(width), width));

    // Choices row
    const choicesLine = `   [Y] Allow once    [A] Allow always (session)    [N] Deny`;
    lines.push(UIFactory.stringToLine(choicesLine.padEnd(width), width, { fg: ACCENT, bold: true }));

    // Bottom separator
    lines.push(UIFactory.stringToLine('─'.repeat(width), width, { fg: ACCENT, dim: true }));

    return lines;
  }
}
