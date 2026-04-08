import type { Line } from '../types/grid.ts';
import { createEmptyLine } from '../types/grid.ts';
import { BasePanel } from './base-panel.ts';
import {
  buildEmptyState,
  buildGuidanceLine,
  buildKeyValueLine,
  buildPanelLine,
  buildPanelWorkspace,
  DEFAULT_PANEL_PALETTE,
  type PanelWorkspaceSection,
} from './polish.ts';
import type { RuntimeStore } from '../runtime/store/index.ts';

const C = {
  ...DEFAULT_PANEL_PALETTE,
  good: '#22c55e',
  warn: '#f59e0b',
  bad: '#ef4444',
  info: '#38bdf8',
  headerBg: '#1e293b',
} as const;

function statusColor(status: string): string {
  switch (status) {
    case 'ready':
      return C.good;
    case 'loading':
      return C.info;
    case 'degraded':
      return C.warn;
    case 'unavailable':
    default:
      return C.bad;
  }
}

export class IntelligencePanel extends BasePanel {
  public constructor(private readonly store?: RuntimeStore) {
    super('intelligence', 'Intelligence', 'J', 'development');
  }

  public render(width: number, height: number): Line[] {
    this.needsRender = false;
    if (!this.store) {
      const lines = buildPanelWorkspace(width, height, {
        title: 'Intelligence Control Room',
        intro: 'Workspace intelligence posture across diagnostics, symbols, completions, and hover readiness.',
        sections: [{
          lines: buildEmptyState(
            width,
            ' Intelligence runtime store unavailable.',
            'This surface needs the live runtime store so it can show diagnostics, symbol readiness, and recovery guidance.',
            [{ command: '/intelligence review', summary: 'review intelligence readiness from the command surface' }],
            C,
          ),
        }],
        palette: C,
      });
      while (lines.length < height) lines.push(createEmptyLine(width));
      return lines.slice(0, height);
    }

    const state = this.store.getState().intelligence;
    const degraded = [
      state.diagnosticsStatus,
      state.completionsStatus,
      state.symbolSearchStatus,
      state.hoverStatus,
    ].filter((status) => status !== 'ready').length;

    const sections: PanelWorkspaceSection[] = [
      {
        title: 'Summary',
        lines: [
          buildKeyValueLine(width, [
            { label: 'diagnostics', value: state.diagnosticsStatus, valueColor: statusColor(state.diagnosticsStatus) },
            { label: 'symbols', value: state.symbolSearchStatus, valueColor: statusColor(state.symbolSearchStatus) },
            { label: 'completions', value: state.completionsStatus, valueColor: statusColor(state.completionsStatus) },
            { label: 'hover', value: state.hoverStatus, valueColor: statusColor(state.hoverStatus) },
          ], C),
          buildKeyValueLine(width, [
            { label: 'errors', value: String(state.errorCount), valueColor: state.errorCount > 0 ? C.bad : C.dim },
            { label: 'warnings', value: String(state.warningCount), valueColor: state.warningCount > 0 ? C.warn : C.dim },
            { label: 'requests', value: String(state.totalRequests), valueColor: C.value },
            { label: 'avg latency', value: `${Math.round(state.avgLatencyMs)}ms`, valueColor: C.info },
          ], C),
        ],
      },
      {
        title: 'Readiness',
        lines: [
          buildPanelLine(width, [[` Diagnostics are ${state.diagnosticsStatus}. Symbol search is ${state.symbolSearchStatus}.`, state.diagnosticsStatus === 'ready' && state.symbolSearchStatus === 'ready' ? C.dim : C.warn]]),
          buildPanelLine(width, [[` Hover is ${state.hoverStatus}. Completions are ${state.completionsStatus}.`, state.hoverStatus === 'ready' && state.completionsStatus === 'ready' ? C.dim : C.warn]]),
          ...(state.hover.active && state.hover.filePath
            ? [buildPanelLine(width, [[` Active hover: ${state.hover.filePath}`, C.info]])]
            : []),
        ],
      },
    ];

    const diagnosticFiles = [...state.diagnostics.entries()]
      .map(([filePath, diagnostics]) => ({
        filePath,
        errors: diagnostics.filter((entry) => entry.severity === 'error').length,
        warnings: diagnostics.filter((entry) => entry.severity === 'warning').length,
      }))
      .sort((a, b) => (b.errors - a.errors) || (b.warnings - a.warnings) || a.filePath.localeCompare(b.filePath))
      .slice(0, 4);
    sections.push({
      title: 'Diagnostics',
      lines: diagnosticFiles.length > 0
        ? diagnosticFiles.map((entry) => buildPanelLine(width, [[
            ` ${entry.filePath}  errors=${entry.errors} warnings=${entry.warnings}`,
            entry.errors > 0 ? C.bad : entry.warnings > 0 ? C.warn : C.dim,
          ]]))
        : [buildPanelLine(width, [[' No tracked diagnostics yet.', C.dim]])],
    });

    sections.push({
      title: 'Workflows',
      lines: [
        buildGuidanceLine(width, '/intelligence symbols <file>', 'inspect document symbols for a file and verify symbol-surface readiness', C),
        buildGuidanceLine(width, '/intelligence outline <file>', 'review structural outline extraction without leaving the control room', C),
        buildGuidanceLine(width, '/intelligence definition <file> <line> <column>', 'check definition lookup for an exact source position', C),
        buildGuidanceLine(width, '/intelligence references <file> <line> <column>', 'review reference lookup for a symbol under the cursor', C),
        buildGuidanceLine(width, '/intelligence hover <file> <line> <column>', 'inspect hover/details posture for a specific source position', C),
      ],
    });

    if (degraded > 0) {
      sections.push({
        title: 'Recovery',
        lines: [
          buildPanelLine(width, [[' Workspace intelligence is not fully ready. Review LSP/tree-sitter setup and workspace language configuration.', C.warn]]),
          buildGuidanceLine(width, '/health review', 'check setup and readiness failures that could block diagnostics and symbol search', C),
          buildGuidanceLine(width, '/setup review', 'review startup and environment posture for intelligence dependencies', C),
          buildGuidanceLine(width, '/intelligence repair', 'show repair-oriented commands for diagnostics, symbols, hover, and completions', C),
          buildGuidanceLine(width, '/health repair intelligence', 'show repair commands plus post-repair verification for the intelligence domain', C),
        ],
      });
    } else {
      sections.push({
        title: 'Recovery',
        lines: [
          buildPanelLine(width, [[' Intelligence surfaces are healthy and ready for code-aware workflows.', C.dim]]),
          buildGuidanceLine(width, '/health intelligence', 'verify readiness posture after setup changes or dependency recovery', C),
        ],
      });
    }

    const lines = buildPanelWorkspace(width, height, {
      title: 'Intelligence Control Room',
      intro: 'Workspace intelligence posture across diagnostics, symbol search, hover, and completion readiness.',
      sections,
      footerLines: [buildPanelLine(width, [[' /symbols  /intelligence diagnostics  /intelligence symbols <file>  /intelligence definition <file> <line> <column> ', C.dim]])],
      palette: C,
    });
    while (lines.length < height) lines.push(createEmptyLine(width));
    return lines.slice(0, height);
  }
}
