import { type Line, type Cell } from '../types/grid.ts';
import { UIFactory } from './ui-factory.ts';
import { getDisplayWidth } from '../utils/terminal-width.ts';

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Truncate a string to fit within maxWidth display columns.
 * Handles wide characters (CJK, emoji) correctly via getDisplayWidth.
 */
function truncateToWidth(text: string, maxWidth: number): string {
  let width = 0;
  let i = 0;
  for (const char of text) {
    const cw = getDisplayWidth(char);
    if (width + cw > maxWidth) break;
    width += cw;
    i += char.length;
  }
  return text.slice(0, i);
}

// ── Types ────────────────────────────────────────────────────────────────────

export interface ModalSectionStyle {
  fg?: string;
  bg?: string;
  bold?: boolean;
  dim?: boolean;
}

export interface ModalSection {
  type: 'text' | 'list' | 'input' | 'separator';
  /** Text content for 'text' and 'input' types. */
  content?: string;
  /** Items for 'list' type. Each item: { label, selected?, style? } */
  items?: ModalListItem[];
  style?: ModalSectionStyle;
}

export interface ModalListItem {
  label: string;
  selected?: boolean;
  style?: ModalSectionStyle;
}

export interface ModalStyle {
  titleFg?: string;
  borderFg?: string;
  hintFg?: string;
  selectedFg?: string;
  selectedBg?: string;
  textFg?: string;
}

export interface ModalConfig {
  title: string;
  /** Box width including borders. Default: 72. */
  width?: number;
  /** Horizontal margin (spaces on left). Default: 4. */
  margin?: number;
  sections: ModalSection[];
  /** Footer hint string. If omitted, no bottom hint text is inlined. */
  footer?: string;
  /** Keyboard hint strings to join with spaces in the footer border. */
  hints?: string[];
  style?: ModalStyle;
}

// ── Defaults ─────────────────────────────────────────────────────────────────

const DEFAULT_STYLE: Required<ModalStyle> = {
  titleFg: '#00ffff',
  borderFg: '240',
  hintFg: '240',
  selectedFg: '#00ffff',
  selectedBg: '#1a2a3a',
  textFg: '252',
};

// ── ModalFactory ─────────────────────────────────────────────────────────────

/**
 * ModalFactory — unified modal rendering for goodvibes-tui.
 *
 * Renders modals as Line[] (Cell arrays) consistent with the compositor
 * overlay pipeline. All existing modals (file-picker, model-picker,
 * selection-modal) can be expressed via createModal().
 *
 * Helper methods are also exported so callers can compose custom modals
 * without going through the full config object.
 */
export class ModalFactory {
  /**
   * Render a complete modal box as Line[].
   *
   * @param config  Modal configuration.
   * @param terminalWidth  Full terminal width (used to size/pad output lines).
   */
  static createModal(config: ModalConfig, terminalWidth: number): Line[] {
    const margin = config.margin ?? 4;
    const maxBoxW = config.width ?? 72;
    const boxW = Math.max(4, Math.min(terminalWidth - margin * 2, maxBoxW));
    const style = { ...DEFAULT_STYLE, ...(config.style ?? {}) };
    const lines: Line[] = [];

    // Title bar
    lines.push(ModalFactory.renderTitle(boxW, margin, config.title, terminalWidth, style));

    // Sections
    for (const section of config.sections) {
      switch (section.type) {
        case 'text':
          lines.push(...ModalFactory._renderTextSection(section, boxW, margin, terminalWidth, style));
          break;
        case 'list':
          lines.push(...ModalFactory._renderListSection(section, boxW, margin, terminalWidth, style));
          break;
        case 'input':
          lines.push(...ModalFactory._renderInputSection(section, boxW, margin, terminalWidth, style));
          break;
        case 'separator':
          lines.push(ModalFactory._renderSeparatorLine(boxW, margin, terminalWidth, style));
          break;
      }
    }

    // Footer / hint bar
    const hintStr = config.hints
      ? config.hints.join('  ')
      : (config.footer ?? '');
    lines.push(ModalFactory.renderHints(boxW, margin, hintStr, terminalWidth, style));

    return lines;
  }

  // ── Public helpers ──────────────────────────────────────────────────────────

  /**
   * Wrap content lines in a top/bottom border box.
   * Content lines are expected to already be full-width Lines.
   */
  static renderBox(
    boxW: number,
    margin: number,
    content: Line[],
    terminalWidth: number,
    style: Partial<ModalStyle> = {},
  ): Line[] {
    const s = { ...DEFAULT_STYLE, ...style };
    const pad = ' '.repeat(margin);
    const top = pad + '\u250c' + '\u2500'.repeat(boxW - 2) + '\u2510';
    const bottom = pad + '\u2514' + '\u2500'.repeat(boxW - 2) + '\u2518';
    return [
      UIFactory.stringToLine(top, terminalWidth, { fg: s.borderFg }),
      ...content,
      UIFactory.stringToLine(bottom, terminalWidth, { fg: s.borderFg }),
    ];
  }

  /**
   * Render a title bar line: ┌─ Title ─────┐
   */
  static renderTitle(
    boxW: number,
    margin: number,
    title: string,
    terminalWidth: number,
    style: Partial<ModalStyle> = {},
  ): Line {
    const s = { ...DEFAULT_STYLE, ...style };
    const pad = ' '.repeat(margin);
    const titleText = '\u2500 ' + title + ' ';
    const fill = Math.max(0, boxW - 2 - getDisplayWidth(titleText));
    const text = pad + '\u250c' + titleText + '\u2500'.repeat(fill) + '\u2510';
    return UIFactory.stringToLine(text, terminalWidth, { fg: s.titleFg });
  }

  /**
   * Render a bottom border line with optional keyboard hints inlined.
   * ┘ side chars fill remaining width.
   */
  static renderHints(
    boxW: number,
    margin: number,
    hints: string,
    terminalWidth: number,
    style: Partial<ModalStyle> = {},
  ): Line {
    const s = { ...DEFAULT_STYLE, ...style };
    const pad = ' '.repeat(margin);
    const hintPadded = hints.length > 0 ? ' ' + hints + ' ' : '';
    const fill = Math.max(0, boxW - 2 - getDisplayWidth(hintPadded));
    const text = pad + '\u2514' + hintPadded + '\u2500'.repeat(fill) + '\u2518';
    return UIFactory.stringToLine(text, terminalWidth, { fg: s.hintFg });
  }

  /**
   * Render a single selectable list item row.
   * ┤ text ├  — bordered left/right, with optional selection highlight.
   */
  static renderListItem(
    boxW: number,
    margin: number,
    text: string,
    selected: boolean,
    terminalWidth: number,
    style: Partial<ModalStyle> = {},
  ): Line {
    const s = { ...DEFAULT_STYLE, ...style };
    const contentW = boxW - 4;
    const pad = ' '.repeat(margin);
    const indicator = selected ? '\u25b6 ' : '  ';
    const displayText = getDisplayWidth(text) > contentW - 2
      ? truncateToWidth(text, contentW - 3) + '\u2026'
      : text;
    const padded = displayText + ' '.repeat(Math.max(0, contentW - 2 - getDisplayWidth(displayText)));
    const row = pad + '\u2502 ' + indicator + padded + '\u2502';
    const cellStyle: Partial<Cell> = selected
      ? { fg: s.selectedFg, bg: s.selectedBg, bold: true }
      : { fg: s.textFg };
    return UIFactory.stringToLine(row, terminalWidth, cellStyle);
  }

  // ── Private section renderers ────────────────────────────────────────────────

  private static _renderTextSection(
    section: ModalSection,
    boxW: number,
    margin: number,
    terminalWidth: number,
    style: Required<ModalStyle>,
  ): Line[] {
    const contentW = boxW - 4;
    const pad = ' '.repeat(margin);
    const text = section.content ?? '';
    const fg = section.style?.fg ?? style.textFg;
    const bg = section.style?.bg ?? '';
    const bold = section.style?.bold ?? false;
    const dim = section.style?.dim ?? false;

    // Word-wrap: split on \n first, then truncate
    const rawLines = text.split('\n');
    return rawLines.map((rawLine) => {
      const truncated = getDisplayWidth(rawLine) > contentW
        ? truncateToWidth(rawLine, contentW - 1) + '\u2026'
        : rawLine;
      const padded = truncated + ' '.repeat(Math.max(0, contentW - getDisplayWidth(truncated)));
      const row = pad + '\u2502 ' + padded + ' \u2502';
      return UIFactory.stringToLine(row, terminalWidth, { fg, bg, bold, dim });
    });
  }

  private static _renderListSection(
    section: ModalSection,
    boxW: number,
    margin: number,
    terminalWidth: number,
    style: Required<ModalStyle>,
  ): Line[] {
    const items = section.items ?? [];
    if (items.length === 0) {
      return [ModalFactory._renderEmptyRow(boxW, margin, terminalWidth, style)];
    }
    return items.map((item) =>
      ModalFactory.renderListItem(boxW, margin, item.label, item.selected ?? false, terminalWidth, {
        ...style,
        ...(item.style ? {
          selectedFg: item.style.fg ?? style.selectedFg,
          textFg: item.style.fg ?? style.textFg,
        } : {}),
      }),
    );
  }

  private static _renderInputSection(
    section: ModalSection,
    boxW: number,
    margin: number,
    terminalWidth: number,
    style: Required<ModalStyle>,
  ): Line[] {
    const contentW = boxW - 4;
    const pad = ' '.repeat(margin);
    const query = section.content ?? '';
    const cursor = '\u2588'; // block cursor
    const displayQuery = getDisplayWidth(query) > contentW - 4
      ? truncateToWidth(query, contentW - 5) + '\u2026'
      : query;
    const trailing = ' '.repeat(Math.max(0, contentW - getDisplayWidth(displayQuery) - 3));
    const row = pad + '\u2502 \u2315 ' + displayQuery + cursor + trailing + '\u2502';
    return [UIFactory.stringToLine(row, terminalWidth, { fg: style.textFg })];
  }

  private static _renderSeparatorLine(
    boxW: number,
    margin: number,
    terminalWidth: number,
    style: Required<ModalStyle>,
  ): Line {
    const pad = ' '.repeat(margin);
    const text = pad + '\u251c' + '\u2500'.repeat(boxW - 2) + '\u2524';
    return UIFactory.stringToLine(text, terminalWidth, { fg: style.borderFg });
  }

  private static _renderEmptyRow(
    boxW: number,
    margin: number,
    terminalWidth: number,
    style: Required<ModalStyle>,
  ): Line {
    const pad = ' '.repeat(margin);
    const text = pad + '\u2502' + ' '.repeat(boxW - 2) + '\u2502';
    return UIFactory.stringToLine(text, terminalWidth, { fg: style.borderFg });
  }
}
