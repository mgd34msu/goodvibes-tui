export interface ShellLayoutRequest {
  readonly width: number;
  readonly height: number;
  readonly headerHeight: number;
  readonly footerHeight: number;
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
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/** The screen's rows: header, the conversation body (full width), footer. */
export function createShellLayout(request: ShellLayoutRequest): ShellLayout {
  const width = Math.max(1, request.width);
  const height = Math.max(1, request.height);
  const headerHeight = clamp(request.headerHeight, 0, height);
  const footerHeight = clamp(request.footerHeight, 0, Math.max(0, height - headerHeight));
  const bodyHeight = Math.max(0, height - headerHeight - footerHeight);

  return {
    screen: { x: 0, y: 0, width, height },
    header: { x: 0, y: 0, width, height: headerHeight },
    body: { x: 0, y: headerHeight, width, height: bodyHeight },
    footer: { x: 0, y: headerHeight + bodyHeight, width, height: footerHeight },
    conversation: { x: 0, y: headerHeight, width, height: bodyHeight },
  };
}
