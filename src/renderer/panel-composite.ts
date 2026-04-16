import type { Line } from '../types/grid.ts';
import type { Panel } from '../panels/types.ts';
import type { InputHandler } from '../input/handler.ts';
import type { PanelManager } from '../panels/panel-manager.ts';
import type { PanelCompositeData } from './compositor.ts';
import { createSplitPaneLayout } from './layout-engine.ts';
import { renderPanelTabBar } from './panel-tab-bar.ts';
import { renderPanelWorkspaceBar } from './panel-workspace-bar.ts';

/**
 * R2: Per-panel render cache for dirty-flag skipping.
 *
 * Maintainability hazard — mid-render invalidation race:
 *
 * If an event listener (e.g. a runtime-bus subscriber) fires DURING a panel's
 * `render()` call and mutates state such that `needsRender = true`, the
 * trailing `panel.markRendered()` below will clobber that invalidation back
 * to `false`, causing the next frame to serve stale cached output until
 * something else invalidates the panel.
 *
 * In practice this is rare because `render()` is synchronous and short, and
 * runtime-bus listeners that mutate panel state typically run outside the
 * render pass. Panels that DO expect to mutate from within their own render
 * path (e.g. deferred lazy-load) should call `this.invalidate()` AFTER the
 * trailing work so the next frame picks it up.
 *
 * If this becomes a real bug, the fix is to snapshot `needsRender` before
 * calling `render()` and only `markRendered()` if the snapshot was true —
 * preserving any concurrent invalidation. Deferred pending more evidence.
 */
interface PanelRenderCache {
  lines: Line[];
  width: number;
  height: number;
}
const panelRenderCache = new WeakMap<Panel, PanelRenderCache>();

/** R2: Render a panel, skipping if nothing changed. Returns cached lines on a skip. */
function renderPanel(panel: Panel, width: number, height: number): Line[] {
  const cached = panelRenderCache.get(panel);
  if (cached && !panel.needsRender && cached.width === width && cached.height === height) {
    return cached.lines;
  }
  const lines = panel.render(width, height);
  panel.markRendered();
  panelRenderCache.set(panel, { lines, width, height });
  return lines;
}

export interface PanelCompositeBuildResult {
  readonly panelData?: PanelCompositeData;
  readonly panelWidth?: number;
}

export function buildPanelCompositeData(
  panelManager: PanelManager,
  input: InputHandler,
  panelWidth: number,
  panelHeight: number,
): PanelCompositeBuildResult {
  if (!panelManager.isVisible() || panelManager.getAllOpen().length === 0 || panelWidth <= 0) {
    return {};
  }

  const topPane = panelManager.getTopPane();
  const bottomPane = panelManager.getBottomPane();
  const focusedPane = panelManager.getFocusedPane();
  const workspaceTabs = panelManager.getWorkspaceTabs();
  const verticalSplitRatio = panelManager.getVerticalSplitRatio();
  const hasBottom = panelManager.isBottomPaneVisible() && bottomPane.panels.length > 0;
  const workspaceBar = renderPanelWorkspaceBar(workspaceTabs, panelWidth, input.panelFocused);

  let topContent: Line[];
  let topTabBar: Line | undefined;
  let bottomTabBar: Line | undefined;
  let bottomContent: Line[] | undefined;

  const topActivePanel = topPane.panels[topPane.activeIndex] ?? null;

  if (hasBottom) {
    topTabBar = renderPanelTabBar(
      topPane.panels,
      topPane.activeIndex,
      panelWidth,
      input.panelFocused && focusedPane === 'top',
      'top',
    );
    const paneLayout = createSplitPaneLayout(Math.max(0, panelHeight - 1), verticalSplitRatio);
    const topH = paneLayout.topContentRows;
    const bottomH = paneLayout.bottomContentRows;
    topContent = topActivePanel ? renderPanel(topActivePanel, panelWidth, topH) : [];

    const bottomActivePanel = bottomPane.panels[bottomPane.activeIndex] ?? null;
    bottomTabBar = renderPanelTabBar(
      bottomPane.panels,
      bottomPane.activeIndex,
      panelWidth,
      input.panelFocused && focusedPane === 'bottom',
      'bottom',
    );
    bottomContent = bottomActivePanel ? renderPanel(bottomActivePanel, panelWidth, bottomH) : [];
  } else {
    const topH = Math.max(0, panelHeight - 1);
    topContent = topActivePanel ? renderPanel(topActivePanel, panelWidth, topH) : [];
  }

  return {
    panelData: {
      workspaceBar,
      topTabBar,
      topContent,
      topFocused: input.panelFocused && focusedPane === 'top',
      bottomTabBar,
      bottomContent,
      bottomFocused: input.panelFocused && focusedPane === 'bottom',
      separator: true,
      verticalSplitRatio,
    },
    panelWidth,
  };
}
