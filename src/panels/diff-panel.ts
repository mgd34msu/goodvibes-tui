// ---------------------------------------------------------------------------
// DiffPanel — unified diff view of agent file changes
// ---------------------------------------------------------------------------

import type { Line } from '../types/grid.ts';
import { createStyledCell, createEmptyLine } from '../types/grid.ts';
import { truncateDisplay, getDisplayWidth } from '../utils/terminal-width.ts';
import { BasePanel } from './base-panel.ts';
import { UI_TONES } from '../renderer/ui-primitives.ts';
import {
  buildBodyText,
  buildEmptyState,
  buildPanelWorkspace,
  resolveScrollablePanelSection,
  buildStyledPanelLine,
  type PanelWorkspaceSection,
  DEFAULT_PANEL_PALETTE,
  extendPalette,
} from './polish.ts';

// ---------------------------------------------------------------------------
// Colour palette — dedicated diff-viewer scheme (like a mini syntax
// highlighter). Each hex literal is named once and reused for every role
// that shares it, including the workspace-chrome aliases (info/dim/value/
// empty) so the raw-hex count never grows. The title band itself is NOT
// overridden — buildPanelWorkspace always falls back to the canonical
// DEFAULT_PANEL_PALETTE.headerBg (WO-002: one title band everywhere).
// ---------------------------------------------------------------------------

const HUNK_BLUE = '#88aaff';
// Context rows and line-number gutter use the shared theme's muted/dim
// foreground tones rather than dedicated gray hex literals.
const CONTEXT_GRAY = UI_TONES.fg.muted;
const FILENAME_WHITE = '#ffffff';
const ADD_GREEN = '#00ff88';
const ADD_BG = '#001a0d';
const DEL_RED = '#ff4444';
const DEL_BG = '#1a0000';
const HUNK_BG = '#0a0a1a';
const MARKER_GRAY = '#aaaaaa';
const LINE_NUM_GRAY = UI_TONES.fg.dim;
const LINE_NUM_ADD = '#00aa55';
const LINE_NUM_DEL = '#aa2222';
const TAB_ACTIVE_BG = '#333333';
const TAB_INACTIVE_GRAY = '#666666';
const TAB_BG = '#222222';
const STATUS_BAR_BG = '#444444';

const COLOR = extendPalette(DEFAULT_PANEL_PALETTE, {
  // Workspace-chrome aliases (title band excluded — no headerBg override)
  info:  HUNK_BLUE,
  dim:   CONTEXT_GRAY,
  value: FILENAME_WHITE,
  empty: CONTEXT_GRAY,

  // Domain accents
  addition:    ADD_GREEN,
  additionBg:  ADD_BG,
  deletion:    DEL_RED,
  deletionBg:  DEL_BG,
  hunk:        HUNK_BLUE,
  hunkBg:      HUNK_BG,
  markerText:  MARKER_GRAY,
  lineNum:     LINE_NUM_GRAY,
  lineNumAdd:  LINE_NUM_ADD,
  lineNumDel:  LINE_NUM_DEL,
  filename:    FILENAME_WHITE,
  tabActive:   FILENAME_WHITE,
  tabActiveBg: TAB_ACTIVE_BG,
  tabInactive: TAB_INACTIVE_GRAY,
  tabBg:       TAB_BG,
  context:     CONTEXT_GRAY,
  statusBar:   STATUS_BAR_BG,
} as const);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface DiffEntry {
  filePath: string;
  raw: string;        // raw unified diff text
  lines: ParsedLine[];
  /** One-line semantic summary from computeSemanticDiff, if available. */
  semanticSummary?: string;
}

/** +added / -removed line counts for a parsed diff entry. */
function diffStat(entry: DiffEntry): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of entry.lines) {
    if (line.kind === 'addition') added++;
    else if (line.kind === 'deletion') removed++;
  }
  return { added, removed };
}

type LineKind = 'addition' | 'deletion' | 'context' | 'hunk' | 'header';

interface ParsedLine {
  kind: LineKind;
  text: string;
  beforeNum: number | null;  // line number in original file
  afterNum:  number | null;  // line number in new file
}

// ---------------------------------------------------------------------------
// Diff parser
// ---------------------------------------------------------------------------

function parseDiff(raw: string): ParsedLine[] {
  const result: ParsedLine[] = [];
  let before = 0;
  let after  = 0;

  for (const line of raw.split('\n')) {
    // Hunk header: @@ -a,b +c,d @@
    const hunkMatch = line.match(/^@@\s+-([0-9]+)(?:,[0-9]+)?\s+\+([0-9]+)(?:,[0-9]+)?\s+@@/);
    if (hunkMatch) {
      before = parseInt(hunkMatch[1]!, 10);
      after  = parseInt(hunkMatch[2]!, 10);
      result.push({ kind: 'hunk', text: line, beforeNum: null, afterNum: null });
      continue;
    }

    if (line.startsWith('+++') || line.startsWith('---') ||
        line.startsWith('diff ') || line.startsWith('index ') ||
        line.startsWith('new file') || line.startsWith('old file') ||
        line.startsWith('Binary')) {
      result.push({ kind: 'header', text: line, beforeNum: null, afterNum: null });
      continue;
    }

    if (line.startsWith('+')) {
      result.push({ kind: 'addition', text: line.slice(1), beforeNum: null, afterNum: after });
      after++;
    } else if (line.startsWith('-')) {
      result.push({ kind: 'deletion', text: line.slice(1), beforeNum: before, afterNum: null });
      before++;
    } else if (line.startsWith('\\')) {
      // "No newline at end of file" note — treat as header
      result.push({ kind: 'header', text: line, beforeNum: null, afterNum: null });
    } else {
      // context line (starts with space, or empty for blank context)
      const text = line.startsWith(' ') ? line.slice(1) : line;
      result.push({ kind: 'context', text, beforeNum: before, afterNum: after });
      before++;
      after++;
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Split a full `git diff` output into per-file entries
// ---------------------------------------------------------------------------

function splitIntoDiffEntries(raw: string): DiffEntry[] {
  const entries: DiffEntry[] = [];
  // Split on "diff --git" lines
  const chunks = raw.split(/(?=^diff --git )/m);
  for (const chunk of chunks) {
    const trimmed = chunk.trim();
    if (!trimmed) continue;

    // Extract file path from "diff --git a/foo b/foo"
    const match = trimmed.match(/^diff --git a\/.+? b\/(.+)$/m);
    const filePath = match ? match[1]! : 'unknown';

    entries.push({
      filePath,
      raw: chunk,
      lines: parseDiff(chunk),
    });
  }
  return entries;
}

// ---------------------------------------------------------------------------
// Rendering helpers
// ---------------------------------------------------------------------------

function makeLine(
  width:    number,
  leftNum:  string,
  rightNum: string,
  content:  string,
  fg:       string,
  bg:       string,
  numFg:    string,
  bold:     boolean = false,
): Line {
  // Left line number (5 chars + space)
  const LEFT_W = 5;
  const usedForNums = LEFT_W + 1 + LEFT_W + 1 + 2; // 14
  const contentWidth = Math.max(0, width - usedForNums);
  const truncated = truncateDisplay(content, contentWidth);
  return buildStyledPanelLine(width, [
    { text: leftNum.padStart(LEFT_W), fg: numFg, bg, dim: true },
    { text: ' ', fg: '', bg },
    { text: rightNum.padStart(LEFT_W), fg: numFg, bg, dim: true },
    { text: ' ', fg: '', bg },
    { text: '| ', fg: COLOR.lineNum, bg },
    { text: truncated, fg, bg, bold },
  ]);
}

function renderText(width: number, text: string, fg: string, bg: string, bold = false): Line {
  return buildStyledPanelLine(width, [{ text: truncateDisplay(text, width), fg, bg, bold }]);
}

// ---------------------------------------------------------------------------
// DiffPanel
// ---------------------------------------------------------------------------

export class DiffPanel extends BasePanel {
  public override isTransient = true;

  private readonly workingDirectory: string;
  private entries: DiffEntry[] = [];
  private selectedFile = 0;
  private scrollOffset = 0;

  constructor(workingDirectory: string) {
    super('diff', 'Diff', 'D', 'development');
    this.workingDirectory = workingDirectory;
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /** Show a unified diff for a specific file. Adds or replaces the entry. */
  showDiff(filePath: string, diff: string): void {
    const idx = this.entries.findIndex(e => e.filePath === filePath);
    const entry: DiffEntry = { filePath, raw: diff, lines: parseDiff(diff), semanticSummary: this.entries[idx]?.semanticSummary };
    if (idx >= 0) {
      this.entries[idx] = entry;
      // Stay on this file if it was already selected
      if (this.selectedFile !== idx) {
        this.selectedFile = idx;
        this.scrollOffset = 0;
      }
    } else {
      this.entries.push(entry);
      this.selectedFile = this.entries.length - 1;
      this.scrollOffset = 0;
    }
    this.markDirty();
  }

  /** Load a raw multi-file unified diff string directly. */
  loadRawDiff(raw: string): void {
    this.entries = splitIntoDiffEntries(raw);
    this.selectedFile = 0;
    this.scrollOffset = 0;
    this.markDirty();
  }

  /** Run `git diff` against specific files and populate entries. */
  async showFileDiffs(files: string[], ref?: string): Promise<void> {
    const args = ['diff', ...(ref ? [ref] : []), '--', ...files];
    const proc = Bun.spawn(['git', ...args], { stdout: 'pipe', cwd: this.workingDirectory });
    const raw = await new Response(proc.stdout).text();
    await proc.exited;
    this.loadRawDiff(raw);
  }

  /** Run `git diff` and populate all changed files. */
  async showGitDiff(ref?: string): Promise<void> {
    const args = ['diff', ...(ref ? [ref] : [])];
    const proc = Bun.spawn(['git', ...args], { stdout: 'pipe', stderr: 'pipe', cwd: this.workingDirectory });
    const [raw, errText] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      const errorText = errText.trim() || 'git diff failed';
      this.showDiff('(error)', `--- error\n+++ error\n@@ -0,0 +1,1 @@\n+${errorText}`);
      return;
    }
    if (!raw.trim()) {
      this.showDiff('(no changes)', '@@ -0,0 +0,0 @@\n No changes in working tree.');
      return;
    }
    const newEntries = splitIntoDiffEntries(raw);
    // Merge: update existing, append new
    for (const entry of newEntries) {
      const idx = this.entries.findIndex(e => e.filePath === entry.filePath);
      if (idx >= 0) {
        this.entries[idx] = { ...entry, semanticSummary: this.entries[idx]!.semanticSummary };
      } else {
        this.entries.push(entry);
      }
    }
    this.selectedFile = Math.min(this.selectedFile, Math.max(0, this.entries.length - 1));
    this.scrollOffset = 0;
    this.markDirty();
  }

  /**
   * Attach or update the semantic diff summary for a file entry.
   * No-op if the file isn't currently loaded. Safe to call from an async
   * callback after the entry has already been replaced.
   */
  setSemanticSummary(filePath: string, summary: string): void {
    const entry = this.entries.find(e => e.filePath === filePath);
    if (entry) {
      entry.semanticSummary = summary;
      this.markDirty();
    }
  }

  /** Clear all diff entries. */
  clear(): void {
    this.entries = [];
    this.selectedFile = 0;
    this.scrollOffset = 0;
    this.markDirty();
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  override onActivate(): void {
    this.needsRender = true;
  }

  // -------------------------------------------------------------------------
  // Input
  // -------------------------------------------------------------------------

  handleInput(key: string): boolean {
    switch (key) {
      case 'up':    this.scrollUp();   return true;
      case 'down':  this.scrollDown(); return true;
      case 'tab':   this.nextFile();   return true;
      case 'pageup':   this.scrollPageUp();   return true;
      case 'pagedown': this.scrollPageDown(); return true;
      default: return false;
    }
  }

  private scrollUp(): void {
    if (this.scrollOffset > 0) {
      this.scrollOffset--;
      this.markDirty();
    }
  }

  private scrollDown(): void {
    const entry = this.currentEntry();
    if (!entry) return;
    const max = Math.max(0, entry.lines.length - 1);
    if (this.scrollOffset < max) {
      this.scrollOffset++;
      this.markDirty();
    }
  }

  private scrollPageUp(): void {
    this.scrollOffset = Math.max(0, this.scrollOffset - 20);
    this.markDirty();
  }

  private scrollPageDown(): void {
    const entry = this.currentEntry();
    if (!entry) return;
    const max = Math.max(0, entry.lines.length - 1);
    this.scrollOffset = Math.min(max, this.scrollOffset + 20);
    this.markDirty();
  }

  private nextFile(): void {
    if (this.entries.length === 0) return;
    this.selectedFile = (this.selectedFile + 1) % this.entries.length;
    this.scrollOffset = 0;
    this.markDirty();
  }

  private currentEntry(): DiffEntry | null {
    return this.entries[this.selectedFile] ?? null;
  }

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  render(width: number, height: number): Line[] {
    return this.trackedRender(() => {
    if (height <= 0 || width <= 0) return [];

    if (this.entries.length === 0) {
      return buildPanelWorkspace(width, height, {
        title: 'Diff Workspace',
        palette: COLOR,
        sections: [{
          title: 'Diff',
          lines: buildEmptyState(
            width,
            ' No diff to display.',
            'Load a git diff or select a changed file to populate the workspace.',
            [{ command: '/git diff', summary: 'load the current working-tree diff into the diff workspace' }],
            COLOR,
          ),
        }],
      });
    }

    const entry = this.currentEntry();
    if (!entry) {
      return Array.from({ length: height }, () => createEmptyLine(width));
    }

    const compact = height <= 12;
    const summaryLines = entry.semanticSummary
      ? buildBodyText(width, `Semantic summary: ${entry.semanticSummary}`, COLOR, COLOR.context)
      : [];
    const previewSection = resolveScrollablePanelSection(width, height, {
      palette: COLOR,
      footerLines: [this.renderStatusBar(width, entry)],
      beforeSections: [
        {
          title: compact ? undefined : 'Files',
          lines: [
            this.renderTabBar(width),
            ...summaryLines,
          ],
        },
      ],
      section: {
        title: compact ? undefined : 'Changes',
        scrollableLines: entry.lines.map((pl) => this.renderParsedLine(pl, width)),
        scrollOffset: this.scrollOffset,
        minRows: 1,
      },
    });
    this.scrollOffset = previewSection.scrollOffset;

    const sections: PanelWorkspaceSection[] = [
      {
        title: compact ? undefined : 'Files',
        lines: [
          this.renderTabBar(width),
          ...summaryLines,
        ],
      },
      {
        title: previewSection.section.title,
        lines: previewSection.section.lines,
      },
    ];
    return buildPanelWorkspace(width, height, {
      title: 'Diff Workspace',
      palette: COLOR,
      sections,
      footerLines: [this.renderStatusBar(width, entry)],
    });
    });
  }

  // ── Tab bar ──────────────────────────────────────────────────────────────

  private renderTabBar(width: number): Line {
    const cells: Line = [];
    const push = (ch: string, fg: string, bg: string, bold = false): void => {
      const cw = getDisplayWidth(ch);
      if (cells.length + cw > width) return;
      cells.push(createStyledCell(ch, { fg, bg, bold }));
      if (cw === 2 && cells.length < width) cells.push(createStyledCell('', { fg, bg }));
    };

    for (let i = 0; i < this.entries.length; i++) {
      const entry = this.entries[i]!;
      const active = i === this.selectedFile;
      const stat = diffStat(entry);
      const fg = active ? COLOR.tabActive : COLOR.tabInactive;
      const bg = active ? COLOR.tabActiveBg : COLOR.tabBg;
      // Active file gets a leading marker; every tab shows +adds/-dels at a glance.
      const marker = active ? '▸ ' : '  ';
      const label = `${marker}${basename(entry.filePath)} `;
      for (const ch of label) push(ch, fg, bg, active);
      if (stat.added > 0) for (const ch of `+${stat.added}`) push(ch, COLOR.addition, bg, active);
      if (stat.added > 0 && stat.removed > 0) push(' ', fg, bg);
      if (stat.removed > 0) for (const ch of `-${stat.removed}`) push(ch, COLOR.deletion, bg, active);
      push(' ', fg, bg);
      push('│', COLOR.lineNum, COLOR.tabBg);
    }

    while (cells.length < width) {
      cells.push(createStyledCell(' ', { fg: '', bg: COLOR.tabBg }));
    }
    return cells.slice(0, width);
  }

  // ── Status bar ───────────────────────────────────────────────────────────

  private renderStatusBar(width: number, entry: DiffEntry | null): Line {
    if (!entry) {
      return buildStyledPanelLine(width, [{ text: ' No file', fg: COLOR.tabInactive, bg: COLOR.statusBar }], { fillBg: COLOR.statusBar });
    }
    const stat = diffStat(entry);
    // Keep the file path display-width-aware so a long/wide path can't overflow.
    const pathBudget = Math.max(8, Math.floor(width / 2));
    const fileInfo = truncateDisplay(entry.filePath, pathBudget);
    const segments: Array<{ text: string; fg: string; bg?: string; bold?: boolean }> = [
      { text: ` ${fileInfo} `, fg: COLOR.filename, bg: COLOR.statusBar, bold: true },
      { text: `[${this.selectedFile + 1}/${this.entries.length}]`, fg: COLOR.tabInactive, bg: COLOR.statusBar },
      { text: '  +', fg: COLOR.tabInactive, bg: COLOR.statusBar },
      { text: String(stat.added), fg: COLOR.addition, bg: COLOR.statusBar },
      { text: ' -', fg: COLOR.tabInactive, bg: COLOR.statusBar },
      { text: String(stat.removed), fg: COLOR.deletion, bg: COLOR.statusBar },
      { text: `  L${this.scrollOffset + 1}/${entry.lines.length}`, fg: COLOR.tabInactive, bg: COLOR.statusBar },
      { text: '  Tab next  ↑/↓ scroll', fg: COLOR.context, bg: COLOR.statusBar },
    ];
    if (entry.semanticSummary) {
      segments.push({ text: `  ◈ ${entry.semanticSummary}`, fg: COLOR.hunk, bg: COLOR.statusBar });
    }
    return buildStyledPanelLine(width, segments, { fillBg: COLOR.statusBar });
  }

  // ── Parsed line ──────────────────────────────────────────────────────────

  private renderParsedLine(pl: ParsedLine, width: number): Line {
    const left  = pl.beforeNum !== null ? String(pl.beforeNum) : '';
    const right = pl.afterNum  !== null ? String(pl.afterNum)  : '';

    switch (pl.kind) {
      case 'addition':
        return makeLine(width, left, right, `+ ${pl.text}`, COLOR.addition, COLOR.additionBg, COLOR.lineNumAdd, true);
      case 'deletion':
        return makeLine(width, left, right, `- ${pl.text}`, COLOR.deletion, COLOR.deletionBg, COLOR.lineNumDel, false);
      case 'hunk':
        return renderText(width, pl.text, COLOR.hunk, COLOR.hunkBg, false);
      case 'header':
        return renderText(width, pl.text, COLOR.markerText, '', false);
      case 'context':
      default:
        return makeLine(width, left, right, `  ${pl.text}`, COLOR.context, '', COLOR.lineNum, false);
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function basename(p: string): string {
  const parts = p.replace(/\\/g, '/').split('/');
  return parts[parts.length - 1] ?? p;
}
