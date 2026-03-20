// ---------------------------------------------------------------------------
// DiffPanel — unified diff view of agent file changes
// ---------------------------------------------------------------------------

import { spawnSync } from 'node:child_process';
import type { Line } from '../types/grid.ts';
import { createStyledCell, createEmptyLine } from '../types/grid.ts';
import { BasePanel } from './base-panel.ts';

// ---------------------------------------------------------------------------
// Colour palette
// ---------------------------------------------------------------------------

const COLOR = {
  addition:    '#00ff88',
  deletion:    '#ff4444',
  hunk:        '#88aaff',
  header:      '#aaaaaa',
  lineNum:     '#555555',
  lineNumAdd:  '#00aa55',
  lineNumDel:  '#aa2222',
  filename:    '#ffffff',
  tabActive:   '#ffffff',
  tabInactive: '#666666',
  tabBg:       '#222222',
  context:     '#888888',
  statusBar:   '#444444',
} as const;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface DiffEntry {
  filePath: string;
  raw: string;        // raw unified diff text
  lines: ParsedLine[];
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
  const cells: Line = [];

  // Left line number (5 chars + space)
  const LEFT_W = 5;
  const padLeft = leftNum.padStart(LEFT_W);
  for (const ch of padLeft) {
    cells.push(createStyledCell(ch, { fg: numFg, bg, dim: true }));
  }
  cells.push(createStyledCell(' ', { fg: '', bg }));

  // Right line number (5 chars + space)
  const padRight = rightNum.padStart(LEFT_W);
  for (const ch of padRight) {
    cells.push(createStyledCell(ch, { fg: numFg, bg, dim: true }));
  }
  cells.push(createStyledCell(' ', { fg: '', bg }));

  // Separator
  cells.push(createStyledCell('|', { fg: COLOR.lineNum, bg }));
  cells.push(createStyledCell(' ', { fg: '', bg }));

  // Content — truncate/pad to remaining width
  const usedForNums = LEFT_W + 1 + LEFT_W + 1 + 2; // 14
  const contentWidth = Math.max(0, width - usedForNums);
  const truncated = content.length > contentWidth
    ? content.slice(0, contentWidth)
    : content;

  for (const ch of truncated) {
    cells.push(createStyledCell(ch, { fg, bg, bold }));
  }

  // Pad remainder
  while (cells.length < width) {
    cells.push(createStyledCell(' ', { fg: '', bg }));
  }

  return cells.slice(0, width);
}

function renderText(width: number, text: string, fg: string, bg: string, bold = false): Line {
  const cells: Line = [];
  const truncated = text.length > width ? text.slice(0, width) : text;
  for (const ch of truncated) {
    cells.push(createStyledCell(ch, { fg, bg, bold }));
  }
  while (cells.length < width) {
    cells.push(createStyledCell(' ', { fg: '', bg }));
  }
  return cells.slice(0, width);
}

// ---------------------------------------------------------------------------
// DiffPanel
// ---------------------------------------------------------------------------

export class DiffPanel extends BasePanel {
  public override isTransient = true;

  private entries: DiffEntry[] = [];
  private selectedFile = 0;
  private scrollOffset = 0;

  constructor() {
    super('diff', 'Diff', 'D', 'development');
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /** Show a unified diff for a specific file. Adds or replaces the entry. */
  showDiff(filePath: string, diff: string): void {
    const idx = this.entries.findIndex(e => e.filePath === filePath);
    const entry: DiffEntry = { filePath, raw: diff, lines: parseDiff(diff) };
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

  /** Run `git diff` and populate all changed files. */
  async showGitDiff(): Promise<void> {
    const result = spawnSync('git', ['diff'], { encoding: 'utf8', cwd: process.cwd() });
    if (result.error || result.status !== 0) {
      // Show error as a single entry
      const errorText = result.error?.message ?? result.stderr ?? 'git diff failed';
      this.showDiff('(error)', `--- error\n+++ error\n@@ -0,0 +1,1 @@\n+${errorText}`);
      return;
    }
    const raw = result.stdout ?? '';
    if (!raw.trim()) {
      this.showDiff('(no changes)', '@@ -0,0 +0,0 @@\n No changes in working tree.');
      return;
    }
    const newEntries = splitIntoDiffEntries(raw);
    // Merge: update existing, append new
    for (const entry of newEntries) {
      const idx = this.entries.findIndex(e => e.filePath === entry.filePath);
      if (idx >= 0) {
        this.entries[idx] = entry;
      } else {
        this.entries.push(entry);
      }
    }
    this.selectedFile = Math.min(this.selectedFile, Math.max(0, this.entries.length - 1));
    this.scrollOffset = 0;
    this.markDirty();
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
    const lines: Line[] = [];
    if (height <= 0 || width <= 0) return lines;

    // ── Empty state ────────────────────────────────────────────────────────
    if (this.entries.length === 0) {
      lines.push(renderText(width, ' No diff to display. Press Tab to open git diff.', COLOR.context, ''));
      while (lines.length < height) lines.push(createEmptyLine(width));
      return lines.slice(0, height);
    }

    // ── File tab bar ───────────────────────────────────────────────────────
    // Row 1: tab bar
    const tabLine = this.renderTabBar(width);
    lines.push(tabLine);

    // ── Diff content ───────────────────────────────────────────────────────
    const contentHeight = height - 1 - 1; // minus tab bar, minus status bar
    const entry = this.currentEntry();

    if (!entry || contentHeight <= 0) {
      while (lines.length < height - 1) lines.push(createEmptyLine(width));
      lines.push(this.renderStatusBar(width, entry));
      return lines.slice(0, height);
    }

    const visibleLines = entry.lines.slice(this.scrollOffset, this.scrollOffset + contentHeight);

    for (const pl of visibleLines) {
      lines.push(this.renderParsedLine(pl, width));
    }

    // Pad short diffs with empty lines
    while (lines.length < height - 1) {
      lines.push(createEmptyLine(width));
    }

    // ── Status bar ─────────────────────────────────────────────────────────
    lines.push(this.renderStatusBar(width, entry));

    return lines.slice(0, height);
  }

  // ── Tab bar ──────────────────────────────────────────────────────────────

  private renderTabBar(width: number): Line {
    const cells: Line = [];

    for (let i = 0; i < this.entries.length; i++) {
      const entry = this.entries[i]!;
      const active = i === this.selectedFile;
      const label = ` ${basename(entry.filePath)} `;
      const fg = active ? COLOR.tabActive : COLOR.tabInactive;
      const bg = active ? '#333333' : COLOR.tabBg;

      for (const ch of label) {
        if (cells.length >= width) break;
        cells.push(createStyledCell(ch, { fg, bg, bold: active }));
      }

      if (cells.length < width) {
        cells.push(createStyledCell('|', { fg: COLOR.lineNum, bg: COLOR.tabBg }));
      }
    }

    // Fill remaining
    while (cells.length < width) {
      cells.push(createStyledCell(' ', { fg: '', bg: COLOR.tabBg }));
    }

    return cells.slice(0, width);
  }

  // ── Status bar ───────────────────────────────────────────────────────────

  private renderStatusBar(width: number, entry: DiffEntry | null): Line {
    const fileInfo = entry
      ? `${entry.filePath} [${this.selectedFile + 1}/${this.entries.length}]`
      : 'No file';
    const scroll = entry
      ? `  L${this.scrollOffset + 1}/${entry.lines.length}  Tab: next file  ↑↓: scroll`
      : '';
    const text = ` ${fileInfo}${scroll}`;
    return renderText(width, text, COLOR.tabActive, COLOR.statusBar);
  }

  // ── Parsed line ──────────────────────────────────────────────────────────

  private renderParsedLine(pl: ParsedLine, width: number): Line {
    const left  = pl.beforeNum !== null ? String(pl.beforeNum) : '';
    const right = pl.afterNum  !== null ? String(pl.afterNum)  : '';

    switch (pl.kind) {
      case 'addition':
        return makeLine(width, left, right, `+ ${pl.text}`, COLOR.addition, '#001a0d', COLOR.lineNumAdd, true);
      case 'deletion':
        return makeLine(width, left, right, `- ${pl.text}`, COLOR.deletion, '#1a0000', COLOR.lineNumDel, false);
      case 'hunk':
        return renderText(width, pl.text, COLOR.hunk, '#0a0a1a', false);
      case 'header':
        return renderText(width, pl.text, COLOR.header, '', false);
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
