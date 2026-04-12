import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Line, Cell } from '../types/grid.ts';
import { createStyledCell, createEmptyLine } from '../types/grid.ts';
import { BasePanel } from './base-panel.ts';
import { SyntaxHighlighter, type SyntaxToken } from '../renderer/syntax-highlighter.ts';
import { getDisplayWidth } from '../utils/terminal-width.ts';
import {
  buildEmptyState,
  buildPanelLine,
  buildPanelWorkspace,
  resolveScrollablePanelSection,
  DEFAULT_PANEL_PALETTE,
} from './polish.ts';

// ─── Constants ────────────────────────────────────────────────────────────────

const MAX_FILE_SIZE = 100 * 1024; // 100 KB
const BG = '#0d0d0d';
const HEADER_BG = '#1e1e1e';
const HEADER_FG = '#d4d4d4';
const HEADER_ACCENT = '#4ec9b0';
const LINE_NUM_FG = '238';
const WARNING_FG = '#f44747';
const EMPTY_FG = '244';

// ─── Language Detection (from file extension) ─────────────────────────────────

function extToFenceTag(filePath: string): string {
  const ext = path.extname(filePath).slice(1).toLowerCase();
  const map: Record<string, string> = {
    ts: 'ts', tsx: 'tsx', js: 'js', jsx: 'jsx',
    py: 'python', python: 'python',
    sh: 'bash', bash: 'bash', zsh: 'bash',
    json: 'json',
    yaml: 'yaml', yml: 'yaml',
    html: 'html', htm: 'html', xml: 'xml',
    css: 'css', scss: 'scss', less: 'less',
    rs: 'rust',
    go: 'go',
    c: 'c', cpp: 'cpp', cc: 'cpp', h: 'c',
    java: 'java',
    rb: 'ruby',
    md: 'markdown', mdx: 'markdown',
    toml: 'toml',
    lua: 'lua',
  };
  return map[ext] ?? '';
}

// ─── Panel ────────────────────────────────────────────────────────────────────

export class FilePreviewPanel extends BasePanel {
  private readonly syntaxHighlighter = new SyntaxHighlighter();
  private filePath: string | null = null;
  private fileLines: string[] = [];
  private fenceTag: string = '';
  private scrollOffset: number = 0;
  private oversized: boolean = false;

  /** Per-file scroll position memory: path -> scrollOffset */
  private readonly scrollMemory = new Map<string, number>();

  constructor() {
    super('preview', 'Preview', 'P', 'development');
  }

  // ─── Public API ─────────────────────────────────────────────────────────────

  /**
   * Load a file into the preview. Reads synchronously (small files only).
   * Files larger than 100 KB show a warning instead of content.
   */
  openFile(filePath: string): void {
    // Save scroll position for the current file before switching
    if (this.filePath !== null) {
      this.scrollMemory.set(this.filePath, this.scrollOffset);
    }

    this.filePath = filePath;
    this.oversized = false;
    this.fileLines = [];
    this.fenceTag = '';

    // Restore scroll position for this file, or start at top
    this.scrollOffset = this.scrollMemory.get(filePath) ?? 0;

    let stat: fs.Stats;
    try {
      stat = fs.statSync(filePath);
    } catch {
      this.fileLines = [`(cannot open: ${filePath})`];
      this.markDirty();
      return;
    }

    if (stat.size > MAX_FILE_SIZE) {
      this.oversized = true;
      this.markDirty();
      return;
    }

    let content: string;
    try {
      content = fs.readFileSync(filePath, 'utf-8');
    } catch {
      this.fileLines = [`(read error: ${filePath})`];
      this.markDirty();
      return;
    }

    this.fileLines = content.split('\n');
    // Strip trailing empty line from final newline
    if (this.fileLines.length > 0 && this.fileLines[this.fileLines.length - 1] === '') {
      this.fileLines.pop();
    }

    this.fenceTag = extToFenceTag(filePath);

    // Kick off async tree-sitter parse so subsequent renders get highlighting
    if (this.fenceTag) {
      this.syntaxHighlighter.highlight(content, this.fenceTag);
    }

    // Clamp scroll in case the new file is shorter
    this.clampScroll(0);
    this.markDirty();
  }

  getCurrentFilePath(): string | null {
    return this.filePath;
  }

  getSource(): string | null {
    if (this.filePath === null || this.oversized) return null;
    return this.fileLines.join('\n');
  }

  goToLine(line: number): void {
    if (!Number.isFinite(line)) return;
    this.scrollOffset = Math.max(0, Math.min(Math.floor(line) - 1, Math.max(0, this.fileLines.length - 1)));
    this.markDirty();
  }

  getScrollOffset(): number {
    return this.scrollOffset;
  }

  // ─── Lifecycle ───────────────────────────────────────────────────────────────

  override onActivate(): void {
    super.onActivate();
  }

  override onDeactivate(): void {
    // Persist current scroll position
    if (this.filePath !== null) {
      this.scrollMemory.set(this.filePath, this.scrollOffset);
    }
  }

  // ─── Input handling ──────────────────────────────────────────────────────────

  handleInput(key: string): boolean {
    switch (key) {
      case 'up':        return this.scroll(-1);
      case 'down':      return this.scroll(1);
      case 'pageup':    return this.scrollPage(-1);
      case 'pagedown':  return this.scrollPage(1);
      case 'home':      return this.scrollTo(0);
      case 'end':       return this.scrollTo(Infinity);
      default:          return false;
    }
  }

  // ─── Rendering ───────────────────────────────────────────────────────────────

  render(width: number, height: number): Line[] {
    const title = this.filePath === null
      ? ' Preview'
      : ` Preview / ${path.basename(this.filePath)}`;
    const intro = this.filePath
      ? `${this.filePath}${this.fenceTag ? `  [${this.fenceTag}]` : ''}`
      : 'Open a file to inspect its contents with line numbers and syntax highlighting.';

    if (this.filePath === null) {
      return buildPanelWorkspace(width, height, {
        title,
        intro,
        sections: [
          {
            lines: buildEmptyState(
              width,
              ' No file open',
              'Use the explorer or a file-targeting command to load a file into the preview surface.',
              [],
              DEFAULT_PANEL_PALETTE,
            ),
          },
        ],
        palette: DEFAULT_PANEL_PALETTE,
      });
    }

    if (this.oversized) {
      return buildPanelWorkspace(width, height, {
        title,
        intro,
        sections: [
          {
            lines: buildEmptyState(
              width,
              ` File too large to preview`,
              `The selected file exceeds the 100 KB preview limit: ${path.basename(this.filePath)}.`,
              [],
              DEFAULT_PANEL_PALETTE,
            ),
          },
        ],
        palette: DEFAULT_PANEL_PALETTE,
      });
    }

    if (this.fileLines.length === 0) {
      return buildPanelWorkspace(width, height, {
        title,
        intro,
        sections: [
          {
            lines: buildEmptyState(
              width,
              ' Empty file',
              'The selected file has no content.',
              [],
              DEFAULT_PANEL_PALETTE,
            ),
          },
        ],
        palette: DEFAULT_PANEL_PALETTE,
      });
    }

    const summarySection = {
      title: 'Summary',
      lines: [
        buildPanelLine(width, [
          [' Lines ', DEFAULT_PANEL_PALETTE.label],
          [String(this.fileLines.length), DEFAULT_PANEL_PALETTE.value],
        ]),
      ],
    } as const;
    const footerLines = [
      buildPanelLine(width, [[' Up/Down', DEFAULT_PANEL_PALETTE.info], [' scroll', DEFAULT_PANEL_PALETTE.dim], ['   PgUp/PgDn', DEFAULT_PANEL_PALETTE.info], [' page', DEFAULT_PANEL_PALETTE.dim], ['   Home/End', DEFAULT_PANEL_PALETTE.info], [' bounds', DEFAULT_PANEL_PALETTE.dim]]),
    ];
    const fullCode = this.fileLines.join('\n');
    const hlLines = this.fenceTag
      ? this.syntaxHighlighter.highlight(fullCode, this.fenceTag)
      : null;

    const lineNumW = String(this.fileLines.length).length;
    const contentX = lineNumW + 2; // "NNN | "
    const previewLines: Line[] = [];
    for (let fileIdx = 0; fileIdx < this.fileLines.length; fileIdx++) {

      const rawLine = this.fileLines[fileIdx];
      const tokens: SyntaxToken[] =
        hlLines && fileIdx < hlLines.length && hlLines[fileIdx].length > 0
          ? (hlLines[fileIdx] as SyntaxToken[])
          : [{ text: rawLine, fg: '' }];

      previewLines.push(this.renderCodeLine(fileIdx, lineNumW, contentX, tokens, width));
    }
    const previewSection = resolveScrollablePanelSection(width, height, {
      intro,
      footerLines,
      palette: DEFAULT_PANEL_PALETTE,
      beforeSections: [summarySection],
      section: {
        title: 'Preview',
        scrollableLines: previewLines,
        scrollOffset: this.scrollOffset,
        minRows: 8,
      },
    });
    this.scrollOffset = previewSection.scrollOffset;
    const window = previewSection.window;

    this.needsRender = false;
    return buildPanelWorkspace(width, height, {
      title,
      intro,
      sections: [
        {
          title: 'Summary',
          lines: [
            buildPanelLine(width, [
              [' Lines ', DEFAULT_PANEL_PALETTE.label],
              [String(this.fileLines.length), DEFAULT_PANEL_PALETTE.value],
              ['   Scroll ', DEFAULT_PANEL_PALETTE.label],
              [`${window.start + 1}-${window.end}`, DEFAULT_PANEL_PALETTE.info],
            ]),
          ],
        },
        {
          title: 'Preview',
          lines: previewSection.section.lines,
        },
      ],
      footerLines,
      palette: DEFAULT_PANEL_PALETTE,
    });
  }

  private renderCodeLine(
    fileIdx: number,
    lineNumW: number,
    contentX: number,
    tokens: SyntaxToken[],
    width: number,
  ): Line {
    const line: Cell[] = new Array(width).fill(null).map(() =>
      createStyledCell(' ', { bg: BG }),
    );

    // Line number gutter
    const lineNum = String(fileIdx + 1).padStart(lineNumW);
    let cx = 0;
    for (const ch of lineNum) {
      if (cx >= lineNumW) break;
      line[cx++] = createStyledCell(ch, { fg: LINE_NUM_FG, bg: BG, dim: true });
    }
    // Separator " | "
    line[cx++] = createStyledCell(' ', { bg: BG });
    line[cx++] = createStyledCell('│', { fg: LINE_NUM_FG, bg: BG, dim: true });
    line[cx++] = createStyledCell(' ', { bg: BG });

    // Syntax tokens
    for (const token of tokens) {
      for (const ch of token.text) {
        if (cx >= width) break;
        const code = ch.charCodeAt(0);
        if (code < 32 || code === 127) { cx++; continue; }
        const cw = getDisplayWidth(ch);
        line[cx] = createStyledCell(ch, {
          fg: token.fg || '',
          bg: BG,
          bold: token.bold,
          italic: token.italic,
        });
        if (cw === 2 && cx + 1 < width) line[cx + 1] = { ...line[cx], char: '' };
        cx += cw;
      }
    }

    return line;
  }

  private renderEmpty(width: number, height: number, message: string): Line[] {
    const lines: Line[] = [];
    const msgLine = createEmptyLine(width);
    const isWarning = message.startsWith('File too large');
    const fg = isWarning ? WARNING_FG : EMPTY_FG;
    let cx = 2;
    for (const ch of message) {
      if (cx >= width - 1) break;
      msgLine[cx++] = createStyledCell(ch, { fg, bg: BG });
    }
    lines.push(msgLine);
    for (let i = 1; i < height; i++) {
      lines.push(this.renderBgLine(width));
    }
    return lines;
  }

  private renderBgLine(width: number): Line {
    const line = createEmptyLine(width);
    for (let x = 0; x < width; x++) {
      line[x] = createStyledCell(' ', { bg: BG });
    }
    return line;
  }

  private scroll(delta: number): boolean {
    const before = this.scrollOffset;
    this.scrollOffset = Math.max(0, this.scrollOffset + delta);
    if (this.scrollOffset !== before) this.markDirty();
    return true;
  }

  private scrollPage(direction: -1 | 1): boolean {
    // Page size is approximate — clamp happens in render()
    const pageSize = Math.max(1, this.fileLines.length > 0 ? 20 : 1);
    return this.scroll(direction * pageSize);
  }

  private scrollTo(target: number): boolean {
    const before = this.scrollOffset;
    this.scrollOffset = target === Infinity
      ? Math.max(0, this.fileLines.length - 1)
      : Math.max(0, target);
    if (this.scrollOffset !== before) this.markDirty();
    return true;
  }

  /** Clamp scrollOffset so content doesn't scroll past the last line. */
  private clampScroll(contentHeight: number): void {
    const maxScroll = Math.max(0, this.fileLines.length - Math.max(1, contentHeight));
    if (this.scrollOffset > maxScroll) {
      this.scrollOffset = maxScroll;
    }
  }
}
