import { type Line } from '../types/grid.ts';
import { UIFactory } from '../renderer/ui-factory.ts';
import type { PermissionCategory } from './manager.ts';

export interface PermissionPromptRequest {
  callId: string;
  tool: string;
  args: Record<string, unknown>;
  category: PermissionCategory;
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

  /**
   * createPromptLines - Renders the permission prompt as an array of Lines.
   * Injected into the viewport by the render function when a request is pending.
   */
  static createPromptLines(width: number, request: PermissionRequest): Line[] {
    const lines: Line[] = [];
    const { tool, args, category } = request;
    const displayArg = this.getDisplayArg(tool, args);
    const { label, color } = this.getCategoryLabel(category);

    const ACCENT = '135'; // purple
    const WARN   = color;
    const TEXT   = '252';
    const DIM    = '244';

    // Top separator
    lines.push(UIFactory.stringToLine('─'.repeat(width), width, { fg: ACCENT, dim: true }));

    // Title bar: category badge + title
    const titleLine = ` [${label}] Permission Required `;
    lines.push(UIFactory.stringToLine(titleLine.padEnd(width), width, { fg: WARN, bold: true }));

    // Tool name row
    const toolLine = `   Tool      : ${tool}`;
    lines.push(UIFactory.stringToLine(toolLine.padEnd(width), width, { fg: TEXT }));

    // Key argument row - truncate if too long
    const maxArgLen = Math.max(10, width - 16);
    const truncatedArg = displayArg.length > maxArgLen
      ? '...' + displayArg.slice(-(maxArgLen - 3))
      : displayArg;
    const argLine = `   Argument  : ${truncatedArg}`;
    lines.push(UIFactory.stringToLine(argLine.padEnd(width), width, { fg: TEXT }));

    // Working directory row
    const cwd = process.cwd();
    const maxCwdLen = Math.max(10, width - 16);
    const truncatedCwd = cwd.length > maxCwdLen ? '...' + cwd.slice(-(maxCwdLen - 3)) : cwd;
    const cwdLine = `   Directory : ${truncatedCwd}`;
    lines.push(UIFactory.stringToLine(cwdLine.padEnd(width), width, { fg: DIM }));

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
