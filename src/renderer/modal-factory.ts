import type { Line, Cell } from '@pellux/goodvibes-sdk/platform/types';
import { createStyledCell } from '@pellux/goodvibes-sdk/platform/types';
import { fitDisplay, getDisplayWidth, truncateDisplay, wrapText } from '../utils/terminal-width.ts';
import {
  createOverlayBorderLine,
  createOverlayBoxLayout,
  createOverlayContentLine,
  putOverlayText,
} from './overlay-box.ts';
import { getOverlayMaxWidth } from './overlay-viewport.ts';
import { GLYPHS } from './ui-primitives.ts';
import { activeUiTones, registerThemeRefresh } from './theme.ts';
import { HINT_SEPARATOR } from './hint-grammar.ts';

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Truncate a string to fit within maxWidth display columns.
 * Handles wide characters (CJK, emoji) correctly via getDisplayWidth.
 */
function truncateToWidth(text: string, maxWidth: number): string {
  return truncateDisplay(text, maxWidth, '');
}

// ── Types ────────────────────────────────────────────────────────────────────

export interface ModalSectionStyle {
  fg?: string;
  bg?: string;
  bold?: boolean;
  dim?: boolean;
}

export interface ModalSection {
  type: 'text' | 'list' | 'input' | 'separator' | 'title' | 'spacer';
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
  accentFg?: string;
  titleRowFg?: string;
  titleBg?: string;
  sectionBg?: string;
  inputBg?: string;
  surfaceBg?: string;
}

export interface ModalTab {
  label: string;
  active?: boolean;
}

export interface ModalHelperRow {
  label?: string;
  content: string;
  accent?: boolean;
}

export interface ModalConfig {
  title: string;
  /** Box width including borders. Default: 72. */
  width?: number;
  /** Horizontal margin (spaces on left). Default: 4. */
  margin?: number;
  tabs?: ModalTab[];
  search?: string;
  sections: ModalSection[];
  targetContentRows?: number;
  helpers?: ModalHelperRow[];
  /** Footer hint string. If omitted, no bottom hint text is inlined. */
  footer?: string;
  /** Keyboard hint strings to join with spaces in the footer border. */
  hints?: string[];
  style?: ModalStyle;
}

// ── Defaults ─────────────────────────────────────────────────────────────────

// DEFAULT_STYLE is built from the mode-resolved chrome tones (activeUiTones) and
// rebuilt IN PLACE on a mode flip via the registered refresher. createModal reads
// it per call via `{ ...DEFAULT_STYLE, ...config.style }`, so the in-place rebuild
// reaches every modal — see theme.ts's active-mode runtime note.
function buildDefaultModalStyle(): Required<ModalStyle> {
  const t = activeUiTones();
  return {
    titleFg: t.fg.primary,
    borderFg: t.fg.dim,
    hintFg: t.fg.muted,
    selectedFg: t.fg.primary,
    selectedBg: t.bg.selected,
    textFg: t.fg.primary,
    accentFg: t.state.info,
    titleRowFg: t.fg.secondary,
    titleBg: t.bg.title,
    sectionBg: t.bg.section,
    inputBg: t.bg.input,
    surfaceBg: t.bg.surface,
  };
}

const DEFAULT_STYLE: Required<ModalStyle> = buildDefaultModalStyle();
registerThemeRefresh(() => Object.assign(DEFAULT_STYLE, buildDefaultModalStyle()));

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
    const boxW = Math.max(24, getOverlayMaxWidth(terminalWidth, margin, maxBoxW));
    const style = { ...DEFAULT_STYLE, ...(config.style ?? {}) };
    const lines: Line[] = [];

    // Title bar
    lines.push(ModalFactory.renderTitle(boxW, margin, config.title, terminalWidth, style));

    // Sections
    const sectionLines: Line[] = [];
    if (config.tabs && config.tabs.length > 0) {
      lines.push(ModalFactory._renderTabsRow(boxW, margin, terminalWidth, config.tabs, style));
    }
    if (typeof config.search === 'string') {
      lines.push(...ModalFactory._renderInputSection({ type: 'input', content: config.search }, boxW, margin, terminalWidth, style));
    }

    for (const section of config.sections) {
      switch (section.type) {
        case 'text':
          sectionLines.push(...ModalFactory._renderTextSection(section, boxW, margin, terminalWidth, style));
          break;
        case 'list':
          sectionLines.push(...ModalFactory._renderListSection(section, boxW, margin, terminalWidth, style));
          break;
        case 'input':
          sectionLines.push(...ModalFactory._renderInputSection(section, boxW, margin, terminalWidth, style));
          break;
        case 'separator':
          sectionLines.push(ModalFactory._renderSeparatorLine(boxW, margin, terminalWidth, style));
          break;
        case 'title':
          sectionLines.push(ModalFactory._renderSectionTitle(section, boxW, margin, terminalWidth, style));
          break;
        case 'spacer':
          sectionLines.push(ModalFactory._renderEmptyRow(boxW, margin, terminalWidth, style));
          break;
      }
    }

    if (typeof config.targetContentRows === 'number' && config.targetContentRows > 0) {
      const bounded = sectionLines.slice(0, config.targetContentRows);
      while (bounded.length < config.targetContentRows) {
        bounded.push(ModalFactory._renderEmptyRow(boxW, margin, terminalWidth, style));
      }
      lines.push(...bounded);
    } else {
      lines.push(...sectionLines);
    }

    if (config.helpers && config.helpers.length > 0) {
      for (const helper of config.helpers) {
        lines.push(ModalFactory._renderHelperRow(boxW, margin, terminalWidth, helper, style));
      }
    }

    // Footer / hint bar. Hint segments join with the shared middle-dot grammar
    // separator so every modal footer reads as one dialect.
    const hintStr = config.hints
      ? config.hints.join(HINT_SEPARATOR)
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
    const layout = createOverlayBoxLayout(terminalWidth, margin, boxW);
    return [
      createOverlayBorderLine(terminalWidth, layout, '┌', '─', '┐', s.borderFg),
      ...content,
      createOverlayBorderLine(terminalWidth, layout, '└', '─', '┘', s.borderFg),
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
    const layout = createOverlayBoxLayout(terminalWidth, margin, boxW);
    const line = createOverlayBorderLine(terminalWidth, layout, GLYPHS.frame.topLeft, GLYPHS.frame.horizontal, GLYPHS.frame.topRight, s.borderFg);
    for (let x = layout.margin + 1; x < layout.margin + layout.width - 1; x++) {
      line[x] = createStyledCell(GLYPHS.frame.horizontal, { fg: s.borderFg, bg: s.titleBg });
    }
    putOverlayText(line, layout.margin + 2, layout.width - 4, title, { fg: s.titleFg, bg: s.titleBg, bold: true });
    return line;
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
    const layout = createOverlayBoxLayout(terminalWidth, margin, boxW);
    const line = createOverlayBorderLine(terminalWidth, layout, GLYPHS.frame.bottomLeft, GLYPHS.frame.horizontal, GLYPHS.frame.bottomRight, s.borderFg);
    if (hints.length > 0) {
      putOverlayText(line, layout.margin + 2, layout.width - 4, truncateDisplay(hints, layout.width - 4), {
        fg: s.hintFg,
        dim: true,
      });
    }
    return line;
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
    const layout = createOverlayBoxLayout(terminalWidth, margin, boxW);
    const contentW = layout.innerWidth;
    const indicator = selected ? '▸ ' : '  ';
    const displayText = getDisplayWidth(text) > contentW - 2
      ? truncateDisplay(text, contentW - 2)
      : text;
    const padded = fitDisplay(displayText, contentW - 2);
    const row = createOverlayContentLine(terminalWidth, layout, s.borderFg, selected ? s.selectedBg : s.surfaceBg);
    const cellStyle: Partial<Cell> = selected ? { fg: s.selectedFg, bg: s.selectedBg, bold: true } : { fg: s.textFg };
    putOverlayText(row, layout.margin + 2, contentW, indicator + padded, {
      fg: cellStyle.fg ?? s.textFg,
      bg: cellStyle.bg ?? s.surfaceBg,
      bold: cellStyle.bold ?? false,
    });
    return row;
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
    const text = section.content ?? '';
    const fg = section.style?.fg ?? style.textFg;
    const bg = section.style?.bg ?? '';
    const bold = section.style?.bold ?? false;
    const dim = section.style?.dim ?? false;

    const wrappedLines = wrapText(text, Math.max(8, contentW));
    return wrappedLines.map((wrappedLine) => {
      const truncated = getDisplayWidth(wrappedLine) > contentW
        ? truncateDisplay(wrappedLine, contentW)
        : wrappedLine;
      const padded = fitDisplay(truncated, contentW);
      const layout = createOverlayBoxLayout(terminalWidth, margin, boxW);
      const row = createOverlayContentLine(terminalWidth, layout, style.borderFg, bg || style.surfaceBg);
      putOverlayText(row, layout.margin + 2, contentW, padded, { fg, bg, bold, dim });
      return row;
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
    const contentW = boxW - 4;
    const rows: Line[] = [];
    for (const item of items) {
      const itemStyle = {
        ...style,
        ...(item.style ? {
          selectedFg: item.style.fg ?? style.selectedFg,
          textFg: item.style.fg ?? style.textFg,
        } : {}),
      };
      const wrapped = wrapText(item.label, Math.max(8, contentW - 2));
      const displayLines = wrapped.length > 0 ? wrapped : [''];
      for (let i = 0; i < displayLines.length; i++) {
        const isFirst = i === 0;
        const indicator = isFirst
          ? (item.selected ? `${GLYPHS.navigation.selected} ` : '  ')
          : '  ';
        const row = createOverlayContentLine(
          terminalWidth,
          createOverlayBoxLayout(terminalWidth, margin, boxW),
          itemStyle.borderFg,
          item.selected ? itemStyle.selectedBg : itemStyle.surfaceBg,
        );
        const padded = fitDisplay(truncateToWidth(`${indicator}${displayLines[i] ?? ''}`, contentW), contentW);
        putOverlayText(row, margin + 2, contentW, padded, {
          fg: item.selected ? itemStyle.selectedFg : itemStyle.textFg,
          bg: item.selected ? itemStyle.selectedBg : itemStyle.surfaceBg,
          bold: item.selected && isFirst,
        });
        rows.push(row);
      }
    }
    return rows;
  }

  private static _renderInputSection(
    section: ModalSection,
    boxW: number,
    margin: number,
    terminalWidth: number,
    style: Required<ModalStyle>,
  ): Line[] {
    const contentW = boxW - 4;
    const query = section.content ?? '';
    const cursor = GLYPHS.surface.cursor;
    const displayQuery = getDisplayWidth(query) > contentW - 4
      ? truncateDisplay(query, contentW - 4)
      : query;
    const layout = createOverlayBoxLayout(terminalWidth, margin, boxW);
    const row = createOverlayContentLine(terminalWidth, layout, style.borderFg, style.inputBg);
    const text = fitDisplay(`/ ${displayQuery}${cursor}`, contentW);
    putOverlayText(row, layout.margin + 2, contentW, text, { fg: style.textFg, bg: style.inputBg, bold: true });
    return [row];
  }

  private static _renderTabsRow(
    boxW: number,
    margin: number,
    terminalWidth: number,
    tabs: readonly ModalTab[],
    style: Required<ModalStyle>,
  ): Line {
    const layout = createOverlayBoxLayout(terminalWidth, margin, boxW);
    const row = createOverlayContentLine(terminalWidth, layout, style.borderFg, style.sectionBg);
    const active = tabs.find((tab) => tab.active);
    const inactive = tabs.filter((tab) => !tab.active);
    const text = [
      ...(active ? [`[${active.label.toUpperCase()}]`] : []),
      ...inactive.map((tab) => tab.label),
    ].join('  ');
    putOverlayText(row, layout.margin + 2, layout.innerWidth, fitDisplay(text, layout.innerWidth), {
      fg: style.accentFg,
      bg: style.sectionBg,
      bold: true,
    });
    return row;
  }

  private static _renderSectionTitle(
    section: ModalSection,
    boxW: number,
    margin: number,
    terminalWidth: number,
    style: Required<ModalStyle>,
  ): Line {
    const layout = createOverlayBoxLayout(terminalWidth, margin, boxW);
    const row = createOverlayContentLine(terminalWidth, layout, style.borderFg, section.style?.bg ?? style.sectionBg);
    const text = fitDisplay(truncateToWidth(section.content ?? '', layout.innerWidth), layout.innerWidth);
    putOverlayText(row, layout.margin + 2, layout.innerWidth, text, {
      fg: section.style?.fg ?? style.titleRowFg,
      bg: section.style?.bg ?? style.sectionBg,
      bold: section.style?.bold ?? true,
      dim: section.style?.dim ?? false,
    });
    return row;
  }

  private static _renderHelperRow(
    boxW: number,
    margin: number,
    terminalWidth: number,
    helper: ModalHelperRow,
    style: Required<ModalStyle>,
  ): Line {
    const layout = createOverlayBoxLayout(terminalWidth, margin, boxW);
    const row = createOverlayContentLine(terminalWidth, layout, style.borderFg, style.surfaceBg);
    const prefix = helper.label ? `${helper.label}  ` : '';
    const helperText = fitDisplay(`${prefix}${helper.content}`, layout.innerWidth);
    putOverlayText(row, layout.margin + 2, layout.innerWidth, helperText, {
      fg: helper.accent ? style.accentFg : style.hintFg,
      dim: !helper.accent,
    });
    return row;
  }

  private static _renderSeparatorLine(
    boxW: number,
    margin: number,
    terminalWidth: number,
    style: Required<ModalStyle>,
  ): Line {
    const layout = createOverlayBoxLayout(terminalWidth, margin, boxW);
    const line = createOverlayBorderLine(terminalWidth, layout, GLYPHS.frame.teeLeft, GLYPHS.frame.horizontal, GLYPHS.frame.teeRight, style.borderFg);
    for (let x = layout.margin + 1; x < layout.margin + layout.width - 1; x++) {
      line[x] = createStyledCell(GLYPHS.frame.horizontal, { fg: style.borderFg, bg: style.sectionBg });
    }
    return line;
  }

  private static _renderEmptyRow(
    boxW: number,
    margin: number,
    terminalWidth: number,
    style: Required<ModalStyle>,
  ): Line {
    const layout = createOverlayBoxLayout(terminalWidth, margin, boxW);
    return createOverlayContentLine(terminalWidth, layout, style.borderFg, style.surfaceBg);
  }
}
