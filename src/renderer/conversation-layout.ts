import type { Line } from '@pellux/goodvibes-sdk/platform/types';
import { createEmptyLine } from '@pellux/goodvibes-sdk/platform/types';
import type { ConversationManager } from '../core/conversation';

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

/**
 * Absolute history-line index of the bottom-most visible row of the
 * conversation viewport. The buffer bottom-aligns content shorter than the
 * viewport (InfiniteBuffer.getSnapshot pads with blank lines at the TOP, not
 * the bottom, see history.ts), so the naive `scrollTop + viewportHeight - 1`
 * overshoots past the real last line whenever the whole transcript already
 * fits on screen. Clamping to `lineCount - 1` handles both cases with one
 * formula: when scrollLocked at the true bottom (the common case), this is
 * exactly the last rendered content line, the block the user is actually
 * looking at, not whatever sits at the TOP of the viewport (scrollTop alone).
 */
export function getViewportBottomLine(scrollTop: number, viewportHeight: number, lineCount: number): number {
  if (lineCount <= 0) return 0;
  return Math.max(0, Math.min(scrollTop + viewportHeight - 1, lineCount - 1));
}

export function overlayViewportBottom(
  viewport: readonly Line[],
  overlay: readonly Line[],
  width: number,
  viewportHeight: number,
  bottomInset: number = 0,
): Line[] {
  if (overlay.length === 0) return [...viewport];
  const next = [...viewport];
  const targetStart = Math.max(0, viewportHeight - bottomInset - overlay.length);
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

/**
 * Center the non-blank rows of a viewport vertically (the home splash). A
 * body that already fills the height is returned unchanged.
 */
export function centerViewportContent(viewport: readonly Line[], height: number, width: number): Line[] {
  const isBlank = (line: Line): boolean => line.every((cell) => cell.char === ' ' || cell.char === '');
  const first = viewport.findIndex((line) => !isBlank(line));
  if (first < 0) return [...viewport];
  let last = viewport.length - 1;
  while (last > first && isBlank(viewport[last]!)) last--;
  const body = viewport.slice(first, last + 1);
  if (body.length >= height) return [...viewport];
  const top = Math.floor((height - body.length) / 2);
  const out: Line[] = [];
  for (let i = 0; i < top; i++) out.push(createEmptyLine(width));
  out.push(...body);
  while (out.length < height) out.push(createEmptyLine(width));
  return out;
}
