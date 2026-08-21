import type { Line } from '@pellux/goodvibes-sdk/platform/types';
import { createEmptyLine } from '@pellux/goodvibes-sdk/platform/types';
import { ScrollableListPanel } from './scrollable-list-panel.ts';
import {
  buildKeyboardHints,
  buildPanelWorkspace,
  resolveScrollablePanelSection,
} from './polish.ts';

// ---------------------------------------------------------------------------
// ExpandableListPanel<T>
// ---------------------------------------------------------------------------

/**
 * A list panel with a built-in master → detail drill-down.
 *
 * Encapsulates the collapse/expand + detail-view pattern that was previously
 * hand-rolled in git, tool-inspector, agent-inspector, approval, and wrfc
 * panels: a scrollable list where pressing Enter/→ on a row opens a scrollable
 * detail view for that item, and Esc/← returns to the list.
 *
 * Subclasses implement (in addition to the `ScrollableListPanel` contract):
 *   - `getDetailLines(item, width)`, the detail body for the expanded item.
 *
 * Optionally override:
 *   - `getDetailTitle(item)`, detail-view title (defaults to `this.name`).
 *   - `getListHints()` / `getDetailHints()`, footer keyboard hints per mode.
 *   - `renderListView(width, height)`, the list-mode body (defaults to
 *     `renderList` with the list hints footer).
 *
 * Do NOT override `render()`; it dispatches between list and detail modes.
 */
export abstract class ExpandableListPanel<T> extends ScrollableListPanel<T> {
  /** The item currently expanded into the detail view, or null in list mode. */
  protected expandedItem: T | null = null;
  /** First visible row of the detail view. */
  protected detailScroll = 0;

  /** Render the detail body lines for an expanded item. */
  protected abstract getDetailLines(item: T, width: number): readonly Line[];

  /** Title shown above the detail view. */
  protected getDetailTitle(_item: T): string {
    return this.name;
  }

  /** Keyboard hints shown in list mode. */
  protected getListHints(): ReadonlyArray<{ keys: string; label: string }> {
    return [
      { keys: '↑/↓', label: 'move' },
      { keys: 'Enter', label: 'open' },
    ];
  }

  /** Keyboard hints shown in detail mode. */
  protected getDetailHints(): ReadonlyArray<{ keys: string; label: string }> {
    return [
      { keys: '↑/↓', label: 'scroll' },
      { keys: 'Esc', label: 'back' },
    ];
  }

  protected isExpanded(): boolean {
    return this.expandedItem !== null;
  }

  /** Expand the currently selected item into the detail view. */
  protected expandSelected(): void {
    const items = this.getItems();
    const item = items[this.selectedIndex];
    if (item === undefined) return;
    this.expandedItem = item;
    this.detailScroll = 0;
    this.needsRender = true;
  }

  /** Collapse the detail view back to the list. */
  protected collapse(): void {
    if (this.expandedItem === null) return;
    this.expandedItem = null;
    this.detailScroll = 0;
    this.needsRender = true;
  }

  // -------------------------------------------------------------------------
  // Input
  // -------------------------------------------------------------------------

  handleInput(key: string): boolean {
    if (this.expandedItem !== null) {
      // Detail mode: scroll the detail body; Esc/← collapses.
      if (this.lastError !== null) this.clearError();
      switch (key) {
        case 'escape':
        case 'left':
        case 'h':
          this.collapse();
          return true;
        case 'up':
        case 'k':
          this.detailScroll = Math.max(0, this.detailScroll - 1);
          this.needsRender = true;
          return true;
        case 'down':
        case 'j':
          this.detailScroll += 1;
          this.needsRender = true;
          return true;
        case 'pageup':
          this.detailScroll = Math.max(0, this.detailScroll - this.getPageSize());
          this.needsRender = true;
          return true;
        case 'pagedown':
          this.detailScroll += this.getPageSize();
          this.needsRender = true;
          return true;
        case 'home':
        case 'g':
          this.detailScroll = 0;
          this.needsRender = true;
          return true;
        default:
          return false;
      }
    }

    // List mode: Enter/→ expands; everything else is list navigation.
    if (key === 'enter' || key === 'return' || key === 'right' || key === 'l') {
      if (this.getItems().length === 0) return false;
      this.expandSelected();
      return true;
    }
    return super.handleInput(key);
  }

  handleScroll(deltaRows: number): boolean {
    if (this.expandedItem !== null) {
      const rows = Math.trunc(deltaRows);
      if (rows === 0) return false;
      this.detailScroll = Math.max(0, this.detailScroll + rows);
      this.needsRender = true;
      return true;
    }
    return super.handleScroll(deltaRows);
  }

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  render(width: number, height: number): Line[] {
    if (this.expandedItem !== null) {
      return this.renderDetailView(width, height, this.expandedItem);
    }
    return this.renderListView(width, height);
  }

  /** List-mode body. Override for a custom header; defaults to renderList. */
  protected renderListView(width: number, height: number): Line[] {
    return this.renderList(width, height, { hints: this.getListHints() });
  }

  /** Detail-mode body, scrollable detail lines + standardized chrome. */
  protected renderDetailView(width: number, height: number, item: T): Line[] {
    this.needsRender = false;
    const palette = this.getPalette();
    const detailLines = [...this.getDetailLines(item, width)];
    const footer = buildKeyboardHints(width, this.getDetailHints(), palette);

    const resolved = resolveScrollablePanelSection(width, height, {
      palette,
      afterSections: [{ lines: [footer] }],
      section: {
        scrollableLines: detailLines,
        scrollOffset: this.detailScroll,
        appendWindowSummary: detailLines.length > 5 ? { dimColor: palette.dim } : undefined,
      },
    });
    this.detailScroll = resolved.scrollOffset;

    const lines = buildPanelWorkspace(width, height, {
      title: this.getDetailTitle(item),
      sections: [resolved.section, { lines: [footer] }],
      palette,
    });
    while (lines.length < height) lines.push(createEmptyLine(width));
    return lines.slice(0, height);
  }
}
