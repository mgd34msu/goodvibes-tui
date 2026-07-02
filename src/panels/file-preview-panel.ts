import type { Stats, FSWatcher } from 'node:fs';
import { promises as fsPromises, readFileSync, statSync, watch } from 'node:fs';
import * as path from 'node:path';
import type { Line, Cell } from '../types/grid.ts';
import { createStyledCell, createEmptyLine } from '../types/grid.ts';
import { BasePanel } from './base-panel.ts';
import { SyntaxHighlighter, type SyntaxToken } from '../renderer/syntax-highlighter.ts';
import { getDisplayWidth } from '../utils/terminal-width.ts';
import {
  buildEmptyState,
  buildKeyboardHints,
  buildPanelLine,
  buildPanelWorkspace,
  resolveScrollablePanelSection,
  DEFAULT_PANEL_PALETTE,
} from './polish.ts';
import { summarizeError } from '@pellux/goodvibes-sdk/platform/utils';

// ─── Constants ────────────────────────────────────────────────────────────────

const MAX_FILE_SIZE = 100 * 1024; // 100 KB
const BG = '#0d0d0d';
const LINE_NUM_FG = '238';

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

  /**
   * 1-based line number to visibly highlight, set by goToLine() (e.g. a
   * symbol-outline jump). Cleared when a new file is opened.
   */
  private highlightedLine: number | null = null;

  /**
   * Monotonic counter bumped every time fileLines is replaced. Combined with
   * filePath/width/highlightedLine, forms the cache key for the built
   * preview lines so render() doesn't rebuild the whole file every frame.
   */
  private contentVersion = 0;
  private cachedPreviewLines: { key: string; lines: Line[] } | null = null;

  /** Set by the 'r' key; consumed by handlePanelIntegrationAction on the next
   *  dispatch, which awaits the reload before re-syncing the symbol outline
   *  (panel-integration-actions.ts owns the panelManager reference this
   *  panel doesn't have). */
  private pendingReload = false;

  /** Optional live-refresh watcher on the currently open file. */
  private watcher: FSWatcher | null = null;

  constructor() {
    super('preview', 'Preview', 'P', 'development');
  }

  // ─── Public API ─────────────────────────────────────────────────────────────

  /**
   * Load a file into the preview. Reads asynchronously.
   * Files larger than 100 KB show a warning instead of content.
   */
  openFile(filePath: string): void {
    // Save scroll position for the current file before switching
    if (this.filePath !== null) {
      this.scrollMemory.set(this.filePath, this.scrollOffset);
    }

    this.filePath = filePath;
    this.oversized = false;
    this.fenceTag = extToFenceTag(filePath);
    this.highlightedLine = null;

    // Restore scroll position for this file, or start at top
    this.scrollOffset = this.scrollMemory.get(filePath) ?? 0;

    // Synchronously pre-populate fileLines for small files so that callers
    // (e.g. syncSymbolOutlineFromPreview) can read getSource() immediately.
    try {
      const stat = statSync(filePath);
      if (stat.size <= MAX_FILE_SIZE) {
        const content = readFileSync(filePath, 'utf-8');
        this.fileLines = content.split('\n');
      } else {
        this.fileLines = [];
        this.oversized = true;
      }
    } catch {
      this.fileLines = [`(cannot open: ${filePath})`];
    }
    this.contentVersion++;

    this._startWatching(filePath);
    void this._loadFileAsync(filePath);
  }

  /**
   * Re-read the current file from disk (the 'r' reload key). Returns the
   * pending load's promise so callers can chain follow-up work (e.g.
   * re-syncing the symbol outline) after it settles, or null if there is no
   * open file or no reload was queued via the 'r' key.
   */
  consumePendingReload(): Promise<void> | null {
    if (!this.pendingReload) return null;
    this.pendingReload = false;
    if (this.filePath === null) return null;
    return this._loadFileAsync(this.filePath);
  }

  /**
   * Start (or restart) an optional fs.watch auto-refresh on the given file.
   * Best-effort: some filesystems/platforms don't support watch, so failures
   * are swallowed and auto-refresh is simply unavailable for this file — the
   * explicit 'r' reload key always still works.
   */
  private _startWatching(filePath: string): void {
    this._stopWatching();
    try {
      const watcher = watch(filePath, { persistent: false }, (eventType) => {
        if (eventType !== 'change' && eventType !== 'rename') return;
        if (this.filePath !== filePath) return; // stale watcher from a since-replaced file
        void this._loadFileAsync(filePath);
      });
      watcher.on('error', () => this._stopWatching());
      this.watcher = watcher;
    } catch {
      this.watcher = null;
    }
  }

  private _stopWatching(): void {
    if (this.watcher) {
      try { this.watcher.close(); } catch { /* already closed */ }
      this.watcher = null;
    }
  }

  private async _loadFileAsync(filePath: string): Promise<void> {
    try {
      await this.withLoading('Loading…', async () => {
        let stat: Stats;
        try {
          stat = await fsPromises.stat(filePath);
        } catch {
          this.fileLines = [`(cannot open: ${filePath})`];
          return;
        }

        if (stat.size > MAX_FILE_SIZE) {
          this.oversized = true;
          return;
        }

        let content: string;
        try {
          content = await fsPromises.readFile(filePath, 'utf-8');
        } catch {
          this.fileLines = [`(read error: ${filePath})`];
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
      });
    } catch (err) {
      this.setError(summarizeError(err));
    }
    this.contentVersion++;
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
    const target = Math.max(0, Math.min(Math.floor(line) - 1, Math.max(0, this.fileLines.length - 1)));
    this.scrollOffset = target;
    this.highlightedLine = target + 1;
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

  override onDestroy(): void {
    this._stopWatching();
    super.onDestroy();
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
      case 'r':
        if (this.filePath === null) return false;
        this.pendingReload = true;
        return true;
      case 'd':
        return this.filePath !== null;
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
      buildKeyboardHints(width, [
        { keys: '↑/↓', label: 'scroll' },
        { keys: 'PgUp/PgDn', label: 'page' },
        { keys: 'Home/End', label: 'top/bottom' },
      ], DEFAULT_PANEL_PALETTE),
    ];
    // Line-build cache keyed on (filePath, contentVersion, width, highlightedLine):
    // rebuilding every line on every frame showed up as an O(file-length)
    // cost per render even when nothing changed (e.g. while idly scrolling
    // within the same file). Only re-tokenize/re-render when the underlying
    // content, panel width, or highlighted row actually changes.
    const cacheKey = `${this.filePath ?? ''} ${this.contentVersion} ${width} ${this.highlightedLine ?? ''}`;
    let previewLines: Line[];
    if (this.cachedPreviewLines && this.cachedPreviewLines.key === cacheKey) {
      previewLines = this.cachedPreviewLines.lines;
    } else {
      const fullCode = this.fileLines.join('\n');
      const hlLines = this.fenceTag
        ? this.syntaxHighlighter.highlight(fullCode, this.fenceTag)
        : null;

      const lineNumW = String(this.fileLines.length).length;
      const contentX = lineNumW + 2; // "NNN | "
      const built: Line[] = [];
      for (let fileIdx = 0; fileIdx < this.fileLines.length; fileIdx++) {

        const rawLine = this.fileLines[fileIdx];
        const tokens: SyntaxToken[] =
          hlLines && fileIdx < hlLines.length && hlLines[fileIdx].length > 0
            ? (hlLines[fileIdx] as SyntaxToken[])
            : [{ text: rawLine, fg: '' }];

        const highlighted = this.highlightedLine !== null && fileIdx === this.highlightedLine - 1;
        built.push(this.renderCodeLine(fileIdx, lineNumW, contentX, tokens, width, highlighted));
      }
      previewLines = built;
      this.cachedPreviewLines = { key: cacheKey, lines: previewLines };
    }
    // Once a goToLine target is set, track it with a selectedIndex so the
    // scrollable-section window keeps that row visible (with guard rows)
    // the same way list-cursor panels do; plain free-scroll (no active
    // highlight) keeps using the scrollOffset-only window it always has.
    const previewSection = resolveScrollablePanelSection(width, height, {
      intro,
      footerLines,
      palette: DEFAULT_PANEL_PALETTE,
      beforeSections: [summarySection],
      section: {
        title: 'Preview',
        scrollableLines: previewLines,
        scrollOffset: this.scrollOffset,
        selectedIndex: this.highlightedLine !== null ? this.highlightedLine - 1 : undefined,
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
              ['   Viewing ', DEFAULT_PANEL_PALETTE.label],
              [`${window.start + 1}-${window.end}`, DEFAULT_PANEL_PALETTE.info],
              ['   Lang ', DEFAULT_PANEL_PALETTE.label],
              [this.fenceTag || 'text', this.fenceTag ? DEFAULT_PANEL_PALETTE.value : DEFAULT_PANEL_PALETTE.dim],
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
    highlighted = false,
  ): Line {
    // The goToLine target row (e.g. a symbol-outline jump) renders on the
    // theme's selection background instead of the plain code background so
    // it's visibly distinguishable from the rest of the file.
    const bg = highlighted ? DEFAULT_PANEL_PALETTE.selectBg : BG;
    const line: Cell[] = new Array(width).fill(null).map(() =>
      createStyledCell(' ', { bg }),
    );

    // Line number gutter
    const lineNum = String(fileIdx + 1).padStart(lineNumW);
    let cx = 0;
    for (const ch of lineNum) {
      if (cx >= lineNumW) break;
      line[cx++] = createStyledCell(ch, { fg: LINE_NUM_FG, bg, dim: true });
    }
    // Separator " | "
    line[cx++] = createStyledCell(' ', { bg });
    line[cx++] = createStyledCell('│', { fg: LINE_NUM_FG, bg, dim: true });
    line[cx++] = createStyledCell(' ', { bg });

    // Syntax tokens
    for (const token of tokens) {
      for (const ch of token.text) {
        if (cx >= width) break;
        const code = ch.charCodeAt(0);
        if (code < 32 || code === 127) { cx++; continue; }
        const cw = getDisplayWidth(ch);
        line[cx] = createStyledCell(ch, {
          fg: token.fg || '',
          bg,
          bold: token.bold,
          italic: token.italic,
        });
        if (cw === 2 && cx + 1 < width) line[cx + 1] = { ...line[cx], char: '' };
        cx += cw;
      }
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
