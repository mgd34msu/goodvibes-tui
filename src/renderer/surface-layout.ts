export interface SurfaceViewportRequest {
  readonly viewportHeight: number;
  readonly chromeRows: number;
  readonly minContentRows?: number;
  readonly maxContentRows?: number;
  readonly targetRatio?: number;
  readonly minTotalRows?: number;
  readonly maxTotalRows?: number;
}

export interface VisibleWindow {
  readonly start: number;
  readonly end: number;
  readonly count: number;
  readonly total: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function getSurfaceContentRows(request: SurfaceViewportRequest): number {
  const targetRatio = request.targetRatio ?? 0.48;
  const minTotalRows = request.minTotalRows ?? 10;
  const maxTotalRows = request.maxTotalRows ?? 14;
  const minContentRows = request.minContentRows ?? 5;
  const maxContentRows = request.maxContentRows ?? 8;

  const safeViewportHeight = Math.max(8, request.viewportHeight);
  const targetTotalRows = clamp(
    Math.round(safeViewportHeight * targetRatio),
    minTotalRows,
    Math.min(safeViewportHeight, maxTotalRows),
  );

  return clamp(
    targetTotalRows - request.chromeRows,
    minContentRows,
    Math.max(minContentRows, maxContentRows),
  );
}

export function getVisibleWindow(
  total: number,
  selectedIndex: number,
  visibleCount: number,
): VisibleWindow {
  if (total <= 0 || visibleCount <= 0) {
    return { start: 0, end: 0, count: 0, total };
  }

  if (total <= visibleCount) {
    return { start: 0, end: total, count: total, total };
  }

  const clampedSelected = clamp(selectedIndex, 0, total - 1);
  const half = Math.floor(visibleCount / 2);
  const start = clamp(clampedSelected - half, 0, total - visibleCount);
  const end = Math.min(total, start + visibleCount);
  return { start, end, count: end - start, total };
}

export function getTrackedVisibleWindow(
  total: number,
  selectedIndex: number,
  visibleCount: number,
  previousStart: number,
  guardRows: number = 1,
): VisibleWindow {
  if (total <= 0 || visibleCount <= 0) {
    return { start: 0, end: 0, count: 0, total };
  }
  if (total <= visibleCount) {
    return { start: 0, end: total, count: total, total };
  }
  const clampedSelected = clamp(selectedIndex, 0, total - 1);
  const clampedStart = clamp(previousStart, 0, total - visibleCount);
  const guard = clamp(guardRows, 0, Math.max(0, visibleCount - 1));
  let start = clampedStart;
  let end = start + visibleCount;
  if (clampedSelected < start + guard) {
    start = clamp(clampedSelected - guard, 0, total - visibleCount);
    end = start + visibleCount;
  } else if (clampedSelected >= end - guard) {
    start = clamp(clampedSelected - visibleCount + guard + 1, 0, total - visibleCount);
    end = start + visibleCount;
  }
  return { start, end, count: end - start, total };
}

export function sliceVisibleWindow<T>(
  items: readonly T[],
  selectedIndex: number,
  visibleCount: number,
): { readonly items: readonly T[]; readonly window: VisibleWindow } {
  const window = getVisibleWindow(items.length, selectedIndex, visibleCount);
  return {
    items: items.slice(window.start, window.end),
    window,
  };
}
