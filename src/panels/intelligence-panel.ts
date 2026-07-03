import type { Line } from '../types/grid.ts';
import { createEmptyLine } from '../types/grid.ts';
import { truncateDisplay } from '../utils/terminal-width.ts';
import { BasePanel } from './base-panel.ts';
import { FilePreviewPanel } from './file-preview-panel.ts';
import { SymbolOutlinePanel } from './symbol-outline-panel.ts';
import type { PanelIntegrationContext } from './types.ts';
import type { UiIntelligenceSnapshot, UiReadModel } from '../runtime/ui-read-models.ts';
import {
  buildEmptyState,
  buildGuidanceLine,
  buildKeyboardHints,
  buildKeyValueLine,
  buildPanelLine,
  buildPanelWorkspace,
  buildStatusPill,
  resolveStackedScrollableSections,
  DEFAULT_PANEL_PALETTE,
  type PanelWorkspaceSection,
  type StyledPanelSegment,
} from './polish.ts';

// Base chrome only — state colors and text tokens come straight from
// DEFAULT_PANEL_PALETTE (WO-002).
const C = DEFAULT_PANEL_PALETTE;

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

  /**
   * The diagnostic file under the cursor. This panel owns its own selection
   * state (`selectedIndex` navigates the `diagnosticFiles()` list directly), so
   * every selected-row read routes through this one accessor — indexing the
   * `diagnosticFiles()` list by the cursor directly is banned by the
   * no-raw-selectedindex-read architecture rule.
   */
  private selectedDiagnosticFile(): DiagnosticFile | undefined {
    return this.diagnosticFiles().at(this.selectedIndex);
  }

  private diagnosticsScrollOffset = 0;
  private findingsScrollOffset = 0;
  /** Set by handleInput('enter'); consumed by handlePanelIntegrationAction, which has the PanelManager reference needed to open the preview panel. */
  private _pendingOpenFile: { filePath: string; line: number } | null = null;
  /** Set by handleInput('s'); consumed by handlePanelIntegrationAction to open the file in preview AND sync the Symbols panel to it. */
  private _pendingSymbolsPivot: { filePath: string; line: number } | null = null;

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

  /** The most actionable finding in a file — error-first, matching the file sort. */
  private _firstFinding(file: DiagnosticFile): DiagnosticFile['diagnostics'][number] | undefined {
    if (file.diagnostics.length === 0) return undefined;
    return [...file.diagnostics].sort((a, b) => (a.severity === 'error' ? 0 : 1) - (b.severity === 'error' ? 0 : 1))[0];
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
    if (key === 'enter' || key === 'return') {
      const selected = this.selectedDiagnosticFile();
      const first = selected ? this._firstFinding(selected) : undefined;
      if (!selected || !first) return false;
      this._pendingOpenFile = { filePath: selected.filePath, line: first.line + 1 };
      return true;
    }
    if (key === 's') {
      const selected = this.selectedDiagnosticFile();
      const first = selected ? this._firstFinding(selected) : undefined;
      if (!selected || !first) return false;
      this._pendingSymbolsPivot = { filePath: selected.filePath, line: first.line + 1 };
      return true;
    }
    return false;
  }

  /**
   * Cross-panel integration hook. Enter opens the selected file in the
   * preview panel at its first (error-first) finding; 's' does the same and
   * also syncs the Symbols panel to that file, pivoting straight from a
   * diagnostic to its document symbols.
   */
  handlePanelIntegrationAction(_key: string, ctx: PanelIntegrationContext): boolean {
    if (this._pendingSymbolsPivot) {
      const target = this._pendingSymbolsPivot;
      this._pendingSymbolsPivot = null;
      const previewPanel = this._openPreviewAt(ctx.panelManager, target.filePath, target.line);
      if (!previewPanel) return false;
      const symbols = ctx.panelManager.open('symbols');
      if (symbols instanceof SymbolOutlinePanel) {
        const source = previewPanel.getSource();
        if (source !== null) symbols.loadFile(target.filePath, source);
      }
      return true;
    }
    if (this._pendingOpenFile) {
      const target = this._pendingOpenFile;
      this._pendingOpenFile = null;
      return this._openPreviewAt(ctx.panelManager, target.filePath, target.line) !== null;
    }
    return false;
  }

  /** Open (or focus) the shared preview panel and jump it to filePath:line — same open/focus bridge FileExplorerPanel/DiffPanel use. */
  private _openPreviewAt(panelManager: PanelIntegrationContext['panelManager'], filePath: string, line: number): FilePreviewPanel | null {
    let previewPanel = panelManager.getPanel('preview');
    if (previewPanel instanceof FilePreviewPanel) {
      const pane = panelManager.getPaneOf('preview');
      panelManager.activateById('preview');
      if (pane) panelManager.focusPane(pane);
    } else {
      const targetPane: 'top' | 'bottom' = panelManager.isBottomPaneVisible()
        ? (panelManager.getFocusedPane() === 'top' ? 'bottom' : 'top')
        : 'bottom';
      const opened = panelManager.open('preview', targetPane);
      panelManager.show();
      panelManager.focusPane(targetPane);
      previewPanel = opened instanceof FilePreviewPanel ? opened : null;
    }
    if (!(previewPanel instanceof FilePreviewPanel)) return null;
    if (previewPanel.getCurrentFilePath() !== filePath) {
      previewPanel.openFile(filePath);
    }
    previewPanel.goToLine(line);
    return previewPanel;
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
    const selectedFile = this.selectedDiagnosticFile();
    const sortedFindings = selectedFile
      ? [...selectedFile.diagnostics].sort((a, b) => (a.severity === 'error' ? 0 : 1) - (b.severity === 'error' ? 0 : 1))
      : [];

    const postureSection: PanelWorkspaceSection = {
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
    };

    // Diagnostics — the most actionable surface. Render as a selectable list so
    // the operator can drill into a specific file's findings. Windowed via
    // resolveStackedScrollableSections (WO-136) instead of a flat slice(0,6)
    // so the cursor tracks into view instead of being able to scroll off-screen.
    const diagnosticsLines: Line[] = diagnosticFiles.length > 0
      ? diagnosticFiles.map((entry, idx) => {
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

    // Findings for the selected file — fully scrollable (WO-136: no 3-cap).
    const findingsFixedLines: Line[] = selectedFile
      ? [buildKeyValueLine(width, [
          { label: 'file', value: truncateDisplay(selectedFile.filePath, Math.max(8, width - 34)), valueColor: C.value },
          { label: 'errors', value: String(selectedFile.errors), valueColor: selectedFile.errors > 0 ? C.bad : C.dim },
          { label: 'warnings', value: String(selectedFile.warnings), valueColor: selectedFile.warnings > 0 ? C.warn : C.dim },
        ], C)]
      : [];
    const findingsLines: Line[] = selectedFile
      ? (sortedFindings.length > 0
          ? sortedFindings.map((finding) => {
              const loc = `${finding.line + 1}:${finding.column + 1}`;
              const tag = finding.source ? `${finding.source}${finding.code ? `(${finding.code})` : ''}` : finding.severity;
              const prefix = ` ${loc} ${tag}: `;
              return buildPanelLine(width, [
                [prefix, finding.severity === 'error' ? C.bad : C.warn],
                [truncateDisplay(finding.message, Math.max(8, width - prefix.length - 1)), C.value],
              ]);
            })
          : [buildPanelLine(width, [[' No findings recorded for this file.', C.dim]])])
      : [buildPanelLine(width, [[' Select a file above to inspect its findings.', C.dim]])];

    // Recovery/Workflows collapse to a single contextual guidance line
    // (WO-136) instead of a static wall of signposts.
    const guidanceSection: PanelWorkspaceSection = degraded > 0
      ? {
          title: 'Recovery',
          lines: [buildGuidanceLine(
            width,
            '/intelligence repair',
            `${degraded} of 4 surfaces degraded (diagnostics/symbols/hover/completions) — run repair`,
            C,
          )],
        }
      : {
          title: 'Workflows',
          lines: [buildGuidanceLine(
            width,
            '/intelligence symbols <file>',
            'inspect document symbols for a file, or press s on a finding to pivot straight there',
            C,
          )],
        };

    const footerLines = diagnosticFiles.length > 0
      ? [buildKeyboardHints(width, [
          { keys: '↑/↓', label: 'select file' },
          { keys: 'Enter', label: 'open file at finding' },
          { keys: 's', label: 'pivot to symbols' },
          { keys: 'Home/End', label: 'jump' },
        ], C)]
      : [buildKeyboardHints(width, [
          { keys: '/intelligence diagnostics', label: 'review' },
          { keys: '/intelligence symbols <file>', label: 'inspect symbols' },
        ], C)];

    const [diagnosticsWindow, findingsWindow] = resolveStackedScrollableSections(width, height, {
      intro: 'Workspace intelligence posture across diagnostics, symbol search, hover, and completion readiness.',
      footerLines,
      palette: C,
      beforeSections: [postureSection],
      sections: [
        {
          title: `Diagnostics (${diagnosticFiles.length})`,
          scrollableLines: diagnosticsLines,
          selectedIndex: diagnosticFiles.length > 0 ? this.selectedIndex : undefined,
          scrollOffset: this.diagnosticsScrollOffset,
          minRows: 3,
          weight: 2,
          appendWindowSummary: diagnosticFiles.length > 0 ? {
            dimColor: C.dim,
            formatter: (window) => buildPanelLine(width, [[`  showing ${window.start + 1}-${window.end} of ${window.total} files`, C.dim]]),
          } : undefined,
        },
        {
          title: selectedFile ? `Findings — ${truncateDisplay(selectedFile.filePath, Math.max(8, width - 14))}` : 'Findings',
          fixedLines: findingsFixedLines,
          scrollableLines: findingsLines,
          scrollOffset: this.findingsScrollOffset,
          minRows: 2,
          weight: 1,
          appendWindowSummary: sortedFindings.length > 0 ? {
            dimColor: C.dim,
            formatter: (window) => buildPanelLine(width, [[`  showing ${window.start + 1}-${window.end} of ${window.total} findings`, C.dim]]),
          } : undefined,
        },
      ],
      afterSections: [guidanceSection],
    });
    this.diagnosticsScrollOffset = diagnosticsWindow?.scrollOffset ?? this.diagnosticsScrollOffset;
    this.findingsScrollOffset = findingsWindow?.scrollOffset ?? this.findingsScrollOffset;

    const sections: PanelWorkspaceSection[] = [
      postureSection,
      diagnosticsWindow?.section ?? { title: `Diagnostics (${diagnosticFiles.length})`, lines: diagnosticsLines },
      findingsWindow?.section ?? { title: 'Findings', lines: [...findingsFixedLines, ...findingsLines] },
      guidanceSection,
    ];

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
