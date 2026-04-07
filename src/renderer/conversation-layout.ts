import type { Line } from '../types/grid.ts';
import { createEmptyLine } from '../types/grid.ts';
import type { ConversationManager } from '../core/conversation.ts';

export interface ConversationViewportRequest {
  readonly conversation: ConversationManager;
  readonly width: number;
  readonly viewportHeight: number;
  readonly scrollTop: number;
  readonly scrollLocked: boolean;
  readonly overlayRows?: number;
}

export interface ConversationViewportResult {
  readonly effectiveHeight: number;
  readonly maxScroll: number;
  readonly nextScrollTop: number;
  readonly viewport: Line[];
}

export function buildConversationViewport(
  request: ConversationViewportRequest,
): ConversationViewportResult {
  const overlayRows = request.overlayRows ?? 0;
  const effectiveHeight = Math.max(0, request.viewportHeight - overlayRows);
  const lineCount = request.conversation.history.getLineCount();
  const maxScroll = Math.max(0, lineCount - effectiveHeight);
  const nextScrollTop = request.scrollLocked
    ? maxScroll
    : Math.max(0, Math.min(request.scrollTop, maxScroll));
  const viewport = request.conversation.history.getSnapshot(nextScrollTop, effectiveHeight, request.width);

  return {
    effectiveHeight,
    maxScroll,
    nextScrollTop,
    viewport,
  };
}

export function overlayViewportBottom(
  viewport: readonly Line[],
  overlay: readonly Line[],
  width: number,
  viewportHeight: number,
): Line[] {
  if (overlay.length === 0) return [...viewport];
  const next = [...viewport];
  const targetStart = Math.max(0, viewportHeight - overlay.length);
  next.length = Math.min(next.length, targetStart);
  while (next.length < targetStart) next.push(createEmptyLine(width));
  next.push(...overlay);
  return next;
}

export function replaceViewportWithOverlay(
  overlay: readonly Line[],
  width: number,
  viewportHeight: number,
): Line[] {
  const next: Line[] = [];
  const pad = Math.max(0, viewportHeight - overlay.length);
  for (let i = 0; i < pad; i++) next.push(createEmptyLine(width));
  next.push(...overlay);
  return next;
}
