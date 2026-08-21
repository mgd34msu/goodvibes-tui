// ---------------------------------------------------------------------------
// panel-mouse-geometry.ts
//
// Pure mouse-geometry helpers for the panel workspace, extracted from
// handler-feed-routes.ts so that file stays under the 800-line architecture
// cap once the focus verbs and the paste-flood guard both live in
// it. These map a terminal (row, col) onto the panel/pane/workspace-tab under
// the cursor. No dependency on the feed-route state types, so no import cycle.
// ---------------------------------------------------------------------------

import type { PanelManager } from '../panels/panel-manager.ts';
import { renderPanelWorkspaceBar } from '../renderer/panel-workspace-bar.ts';
import type { TabHitRegion } from '../renderer/tab-strip.ts';

/** Screen rectangle the panel workspace occupies, plus its vertical split. */
export type PanelMouseLayout = {
  x: number;
  y: number;
  width: number;
  height: number;
  hasBottomPane: boolean;
  verticalSplitRatio: number;
};

function clampRatio(value: number): number {
  return Math.max(0.2, Math.min(0.8, value));
}

export function getActivePanelInPane(panelManager: PanelManager, pane: 'top' | 'bottom') {
  const target = pane === 'top' ? panelManager.getTopPane() : panelManager.getBottomPane();
  return target.panels[target.activeIndex] ?? null;
}

export function getPanelUnderMouse(
  panelManager: PanelManager,
  layout: PanelMouseLayout | null,
  row: number,
  col: number,
) {
  if (
    layout === null
    || !panelManager.isVisible()
    || panelManager.getAllOpen().length === 0
    || col < layout.x
    || col >= layout.x + layout.width
    || row < layout.y
    || row >= layout.y + layout.height
  ) {
    return null;
  }

  const panelRow = row - layout.y;
  if (!layout.hasBottomPane) {
    return getActivePanelInPane(panelManager, 'top');
  }

  // Single consolidated workspace bar (row 0) + h-separator; the rest splits
  // between the two panes' content.
  const panelAreaRows = Math.max(0, layout.height - 1);
  const contentRows = Math.max(0, panelAreaRows - 1);
  const topContentRows = contentRows <= 1
    ? contentRows
    : Math.max(1, Math.floor(contentRows * clampRatio(layout.verticalSplitRatio)));
  // panelRow 0 = workspace bar; rows 1..topContentRows = top pane; rest = bottom.
  return panelRow <= topContentRows
    ? getActivePanelInPane(panelManager, 'top')
    : getActivePanelInPane(panelManager, 'bottom');
}

/**
 * If the mouse is over the consolidated workspace tab bar (the first panel
 * row), return the index of the tab under the cursor, else null. Recomputes the
 * tab hit regions by rendering the bar with a layout callback, cheap and keeps
 * the click geometry in lockstep with what was drawn.
 */
export function workspaceTabAtMouse(
  panelManager: PanelManager,
  layout: PanelMouseLayout | null,
  row: number,
  col: number,
): number | null {
  if (
    layout === null
    || !panelManager.isVisible()
    || panelManager.getAllOpen().length === 0
    || row !== layout.y // workspace bar is the first panel row
    || col < layout.x
    || col >= layout.x + layout.width
  ) {
    return null;
  }
  let regions: readonly TabHitRegion[] = [];
  renderPanelWorkspaceBar(panelManager.getWorkspaceTabs(), layout.width, true, (r) => { regions = r; });
  const relCol = col - layout.x;
  const hit = regions.find((rg) => relCol >= rg.startCol && relCol < rg.endCol);
  return hit ? hit.index : null;
}
