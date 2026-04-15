import type { Line } from '@pellux/goodvibes-sdk/platform/types/grid';
import type { InputHandler } from '../input/handler.ts';
import type { PanelManager } from '../panels/panel-manager.ts';
import type { PanelCompositeData } from './compositor.ts';
import { createSplitPaneLayout } from './layout-engine.ts';
import { renderPanelTabBar } from './panel-tab-bar.ts';
import { renderPanelWorkspaceBar } from './panel-workspace-bar.ts';

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
    topContent = topActivePanel ? topActivePanel.render(panelWidth, topH) : [];

    const bottomActivePanel = bottomPane.panels[bottomPane.activeIndex] ?? null;
    bottomTabBar = renderPanelTabBar(
      bottomPane.panels,
      bottomPane.activeIndex,
      panelWidth,
      input.panelFocused && focusedPane === 'bottom',
      'bottom',
    );
    bottomContent = bottomActivePanel ? bottomActivePanel.render(panelWidth, bottomH) : [];
  } else {
    const topH = Math.max(0, panelHeight - 1);
    topContent = topActivePanel ? topActivePanel.render(panelWidth, topH) : [];
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
