import type { Line } from '../types/grid.ts';
import { createEmptyLine } from '../types/grid.ts';
import { truncateDisplay } from '../utils/terminal-width.ts';
import { BasePanel } from './base-panel.ts';
import type { UiIntelligenceSnapshot, UiReadModel } from '../runtime/ui-read-models.ts';
import {
  buildDetailBlock,
  buildEmptyState,
  buildGuidanceLine,
  buildKeyboardHints,
  buildKeyValueLine,
  buildPanelLine,
  buildPanelWorkspace,
  buildStatusPill,
  DEFAULT_PANEL_PALETTE,
  type PanelWorkspaceSection,
  type StyledPanelSegment,
} from './polish.ts';

const C = {
  ...DEFAULT_PANEL_PALETTE,
  good: '#22c55e',
  warn: '#f59e0b',
  bad: '#ef4444',
  info: '#38bdf8',
  headerBg: '#1e293b',
} as const;

interface DiagnosticFile {
  readonly filePath: string;
  readonly errors: number;
  readonly warnings: number;
  readonly diagnostics: ReadonlyArray<{
    readonly line: number;
    readonly column: number;
    readonly severity: string;
    readonly message: string;
    readonly source?: string | undefined;
    readonly code?: string | undefined;
  }>;
}

/** Map an intelligence-surface status string to a status-pill segment. */
function postureSegments(label: string, status: string): StyledPanelSegment[] {
  const state = status === 'ready' ? 'good' : status === 'degraded' ? 'warn' : status === 'loading' ? 'info' : 'bad';
  return buildStatusPill(state, `${label} ${status}`);
}

export class IntelligencePanel extends BasePanel {
  private readonly unsub: (() => void) | null;
  private selectedIndex = 0;

  public constructor(private readonly readModel?: UiReadModel<UiIntelligenceSnapshot>) {
    super('intelligence', 'Intelligence', 'J', 'development');
    this.unsub = readModel ? readModel.subscribe(() => this.markDirty()) : null;
  }

  public override onDestroy(): void {
    this.unsub?.();
  }

  /** Diagnostic files sorted error-first so the most actionable file is first. */
  private diagnosticFiles(): DiagnosticFile[] {
    if (!this.readModel) return [];
    const state = this.readModel.getSnapshot();
    return [...state.diagnostics.entries()]
      .map(([filePath, diagnostics]) => ({
        filePath,
        errors: diagnostics.filter((entry) => entry.severity === 'error').length,
        warnings: diagnostics.filter((entry) => entry.severity === 'warning').length,
        diagnostics: diagnostics.map((entry) => ({
          line: entry.line,
          column: entry.column,
          severity: entry.severity,
          message: entry.message,
          source: entry.source,
          code: entry.code,
        })),
      }))
      .sort((a, b) => (b.errors - a.errors) || (b.warnings - a.warnings) || a.filePath.localeCompare(b.filePath));
  }

  public handleInput(key: string): boolean {
    const files = this.diagnosticFiles();
    if (files.length === 0) return false;
    if (key === 'up' || key === 'k') {
      this.selectedIndex = Math.max(0, this.selectedIndex - 1);
      this.markDirty();
      return true;
    }
    if (key === 'down' || key === 'j') {
      this.selectedIndex = Math.min(files.length - 1, this.selectedIndex + 1);
      this.markDirty();
      return true;
    }
    if (key === 'home' || key === 'g') {
      this.selectedIndex = 0;
      this.markDirty();
      return true;
    }
    if (key === 'end' || key === 'G') {
      this.selectedIndex = files.length - 1;
      this.markDirty();
      return true;
    }
    return false;
  }

  public render(width: number, height: number): Line[] {
    this.needsRender = false;
    if (!this.readModel) {
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

    const state = this.readModel.getSnapshot();
    const degraded = [
      state.diagnosticsStatus,
      state.completionsStatus,
      state.symbolSearchStatus,
      state.hoverStatus,
    ].filter((status) => status !== 'ready').length;

    const diagnosticFiles = this.diagnosticFiles();
    this.selectedIndex = Math.max(0, Math.min(this.selectedIndex, Math.max(0, diagnosticFiles.length - 1)));

    const sections: PanelWorkspaceSection[] = [
      {
        title: 'Intelligence posture',
        lines: [
          buildPanelLine(width, [
            { text: ' ', fg: C.dim },
            ...postureSegments('diagnostics', state.diagnosticsStatus),
            { text: '   ', fg: C.dim },
            ...postureSegments('symbols', state.symbolSearchStatus),
          ]),
          buildPanelLine(width, [
            { text: ' ', fg: C.dim },
            ...postureSegments('completions', state.completionsStatus),
            { text: '   ', fg: C.dim },
            ...postureSegments('hover', state.hoverStatus),
          ]),
          buildKeyValueLine(width, [
            { label: 'errors', value: String(state.errorCount), valueColor: state.errorCount > 0 ? C.bad : C.dim },
            { label: 'warnings', value: String(state.warningCount), valueColor: state.warningCount > 0 ? C.warn : C.dim },
            { label: 'requests', value: String(state.totalRequests), valueColor: C.value },
            { label: 'avg latency', value: `${Math.round(state.avgLatencyMs)}ms`, valueColor: C.info },
          ], C),
        ],
      },
    ];

    // Diagnostics — the most actionable surface. Render as a selectable list so
    // the operator can drill into a specific file's findings.
    const visibleFiles = diagnosticFiles.slice(0, 6);
    const diagnosticsLines: Line[] = diagnosticFiles.length > 0
      ? visibleFiles.map((entry, idx) => {
          const selected = idx === this.selectedIndex;
          const tone = entry.errors > 0 ? C.bad : entry.warnings > 0 ? C.warn : C.dim;
          const counts = `  ${entry.errors} err  ${entry.warnings} warn`;
          const pathBudget = Math.max(8, width - counts.length - 4);
          return buildPanelLine(width, [
            [selected ? ' ▸ ' : '   ', selected ? C.info : C.dim, selected ? C.headerBg : undefined],
            [truncateDisplay(entry.filePath, pathBudget), selected ? C.value : C.label, selected ? C.headerBg : undefined],
            [counts, tone, selected ? C.headerBg : undefined],
          ]);
        })
      : [buildPanelLine(width, [[' No tracked diagnostics. Symbol/diagnostic surfaces are clear.', C.dim]])];
    if (diagnosticFiles.length > visibleFiles.length) {
      diagnosticsLines.push(buildPanelLine(width, [[`   +${diagnosticFiles.length - visibleFiles.length} more files`, C.dim]]));
    }
    sections.push({ title: `Diagnostics (${diagnosticFiles.length})`, lines: diagnosticsLines });

    // Drill-down detail for the selected diagnostic file.
    const selectedFile = diagnosticFiles[this.selectedIndex];
    if (selectedFile) {
      const detailRows: Line[] = [
        buildKeyValueLine(width, [
          { label: 'errors', value: String(selectedFile.errors), valueColor: selectedFile.errors > 0 ? C.bad : C.dim },
          { label: 'warnings', value: String(selectedFile.warnings), valueColor: selectedFile.warnings > 0 ? C.warn : C.dim },
        ], C),
      ];
      const topFindings = [...selectedFile.diagnostics]
        .sort((a, b) => (a.severity === 'error' ? 0 : 1) - (b.severity === 'error' ? 0 : 1))
        .slice(0, 3);
      for (const finding of topFindings) {
        const loc = `${finding.line + 1}:${finding.column + 1}`;
        const tag = finding.source ? `${finding.source}${finding.code ? `(${finding.code})` : ''}` : finding.severity;
        const prefix = ` ${loc} ${tag}: `;
        detailRows.push(buildPanelLine(width, [
          [prefix, finding.severity === 'error' ? C.bad : C.warn],
          [truncateDisplay(finding.message, Math.max(8, width - prefix.length - 1)), C.value],
        ]));
      }
      if (selectedFile.diagnostics.length > topFindings.length) {
        detailRows.push(buildPanelLine(width, [[`  +${selectedFile.diagnostics.length - topFindings.length} more findings`, C.dim]]));
      }
      detailRows.push(buildGuidanceLine(width, `/intelligence diagnostics ${selectedFile.filePath}`, 'open the full diagnostic list for this file', C));
      sections.push({ lines: buildDetailBlock(width, truncateDisplay(selectedFile.filePath, Math.max(8, width - 4)), detailRows, C) });
    }

    if (degraded > 0) {
      sections.push({
        title: 'Recovery',
        lines: [
          buildPanelLine(width, [[' Workspace intelligence is not fully ready. Review LSP/tree-sitter setup and language configuration.', C.warn]]),
          buildGuidanceLine(width, '/intelligence repair', 'show repair commands for diagnostics, symbols, hover, and completions', C),
          buildGuidanceLine(width, '/health repair intelligence', 'show repair commands plus post-repair verification', C),
        ],
      });
    } else {
      sections.push({
        title: 'Workflows',
        lines: [
          buildGuidanceLine(width, '/intelligence symbols <file>', 'inspect document symbols and verify symbol-surface readiness', C),
          buildGuidanceLine(width, '/intelligence definition <file> <line> <column>', 'check definition lookup for an exact source position', C),
          buildGuidanceLine(width, '/intelligence hover <file> <line> <column>', 'inspect hover/details posture for a source position', C),
        ],
      });
    }

    const footerLines = diagnosticFiles.length > 0
      ? [buildKeyboardHints(width, [
          { keys: '↑/↓', label: 'select file' },
          { keys: 'Home/End', label: 'jump' },
          { keys: '/intelligence', label: 'commands' },
        ], C)]
      : [buildKeyboardHints(width, [
          { keys: '/intelligence diagnostics', label: 'review' },
          { keys: '/intelligence symbols <file>', label: 'inspect symbols' },
        ], C)];

    const lines = buildPanelWorkspace(width, height, {
      title: 'Intelligence Control Room',
      intro: 'Workspace intelligence posture across diagnostics, symbol search, hover, and completion readiness.',
      sections,
      footerLines,
      palette: C,
    });
    while (lines.length < height) lines.push(createEmptyLine(width));
    return lines.slice(0, height);
  }
}
