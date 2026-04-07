export interface ShellLayoutRequest {
  readonly width: number;
  readonly height: number;
  readonly headerHeight: number;
  readonly footerHeight: number;
  readonly panelWidth?: number;
}

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface ShellLayout {
  readonly screen: Rect;
  readonly header: Rect;
  readonly body: Rect;
  readonly footer: Rect;
  readonly conversation: Rect;
  readonly panel?: Rect;
  readonly separatorX?: number;
}

export interface SplitPaneLayout {
  readonly totalRows: number;
  readonly topTabRows: number;
  readonly bottomTabRows: number;
  readonly separatorRows: number;
  readonly topContentRows: number;
  readonly bottomContentRows: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function createShellLayout(request: ShellLayoutRequest): ShellLayout {
  const width = Math.max(1, request.width);
  const height = Math.max(1, request.height);
  const headerHeight = clamp(request.headerHeight, 0, height);
  const footerHeight = clamp(request.footerHeight, 0, Math.max(0, height - headerHeight));
  const bodyHeight = Math.max(0, height - headerHeight - footerHeight);

  const hasPanel = typeof request.panelWidth === 'number' && request.panelWidth > 0;
  const safePanelWidth = hasPanel
    ? clamp(request.panelWidth as number, 1, Math.max(1, width - 2))
    : 0;
  const separatorWidth = hasPanel ? 1 : 0;
  const conversationWidth = hasPanel ? Math.max(1, width - safePanelWidth - separatorWidth) : width;

  return {
    screen: { x: 0, y: 0, width, height },
    header: { x: 0, y: 0, width, height: headerHeight },
    body: { x: 0, y: headerHeight, width, height: bodyHeight },
    footer: { x: 0, y: headerHeight + bodyHeight, width, height: footerHeight },
    conversation: { x: 0, y: headerHeight, width: conversationWidth, height: bodyHeight },
    panel: hasPanel
      ? {
          x: conversationWidth + separatorWidth,
          y: headerHeight,
          width: safePanelWidth,
          height: bodyHeight,
        }
      : undefined,
    separatorX: hasPanel ? conversationWidth : undefined,
  };
}

export function createSplitPaneLayout(
  totalRows: number,
  ratio: number,
  options: {
    readonly topTabRows?: number;
    readonly bottomTabRows?: number;
    readonly separatorRows?: number;
  } = {},
): SplitPaneLayout {
  const topTabRows = options.topTabRows ?? 1;
  const bottomTabRows = options.bottomTabRows ?? 1;
  const separatorRows = options.separatorRows ?? 1;
  const chromeRows = topTabRows + bottomTabRows + separatorRows;
  const contentRows = Math.max(0, totalRows - chromeRows);
  const normalizedRatio = clamp(ratio, 0.2, 0.8);
  const topContentRows = contentRows <= 1 ? contentRows : Math.max(1, Math.floor(contentRows * normalizedRatio));
  const bottomContentRows = contentRows <= 1 ? 0 : Math.max(1, contentRows - topContentRows);

  return {
    totalRows,
    topTabRows,
    bottomTabRows,
    separatorRows,
    topContentRows,
    bottomContentRows,
  };
}
