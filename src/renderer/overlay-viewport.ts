import { getSurfaceContentRows } from './surface-layout.ts';

export interface OverlayViewportBudgetOptions {
  readonly chromeRows: number;
  readonly minContentRows?: number;
  readonly maxContentRows?: number;
  readonly targetRatio?: number;
  readonly minTotalRows?: number;
  readonly maxTotalRows?: number;
}

export function getOverlayContentBudget(
  viewportHeight: number,
  options: OverlayViewportBudgetOptions,
): number {
  const safeViewportHeight = Math.max(8, viewportHeight);
  const defaultTargetTotalRows = Math.max(12, Math.min(Math.max(12, safeViewportHeight - 2), Math.round(safeViewportHeight * (options.targetRatio ?? 0.45))));
  const minTotalRows = options.minTotalRows ?? defaultTargetTotalRows;
  const maxTotalRows = options.maxTotalRows ?? defaultTargetTotalRows;
  const targetTotalRows = Math.max(
    minTotalRows,
    Math.min(maxTotalRows, defaultTargetTotalRows),
  );
  return getSurfaceContentRows({
    viewportHeight,
    chromeRows: options.chromeRows,
    minContentRows: options.minContentRows,
    maxContentRows: options.maxContentRows,
    targetRatio: 1,
    minTotalRows: targetTotalRows,
    maxTotalRows: targetTotalRows,
  });
}

export function getOverlayMaxWidth(
  terminalWidth: number,
  margin: number,
  requestedMaxWidth: number,
): number {
  const safeRequested = Math.max(24, requestedMaxWidth);
  const reservedSideSpace = margin * 2;
  const viewportBounded = Math.max(24, terminalWidth - reservedSideSpace);
  return Math.min(safeRequested, viewportBounded);
}

export interface OverlaySurfaceMetricsOptions {
  readonly margin?: number;
  readonly maxWidth?: number;
  readonly chromeRows: number;
  readonly minContentRows?: number;
  readonly maxContentRows?: number;
  readonly targetRatio?: number;
  readonly minTotalRows?: number;
  readonly maxTotalRows?: number;
}

export interface OverlaySurfaceMetrics {
  readonly margin: number;
  readonly boxWidth: number;
  readonly contentWidth: number;
  readonly contentRows: number;
}

export function getStableOverlayContentRows(
  contentRows: number,
  minRows = 10,
): number {
  return Math.max(contentRows, minRows);
}

export function getOverlaySurfaceMetrics(
  viewportWidth: number,
  viewportHeight: number,
  options: OverlaySurfaceMetricsOptions,
): OverlaySurfaceMetrics {
  // Keep overlays comfortably inset from shell panels and avoid wide, low-information modals.
  const margin = options.margin ?? 6;
  const boxWidth = getOverlayMaxWidth(viewportWidth, margin, options.maxWidth ?? 68);
  const contentRows = getOverlayContentBudget(viewportHeight, {
    chromeRows: options.chromeRows,
    minContentRows: options.minContentRows ?? 8,
    maxContentRows: options.maxContentRows ?? 12,
    targetRatio: options.targetRatio ?? 0.45,
    minTotalRows: options.minTotalRows,
    maxTotalRows: options.maxTotalRows,
  });

  return {
    margin,
    boxWidth,
    contentWidth: Math.max(1, boxWidth - 4),
    contentRows,
  };
}
