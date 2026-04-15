import { getDisplayWidth, truncateDisplay, wrapText } from '@pellux/goodvibes-sdk/platform/utils/terminal-width';

export function wrapWithHangingIndent(
  text: string,
  width: number,
  indent: string,
  maxLines?: number,
): string[] {
  const safeWidth = Math.max(1, width);
  const indentWidth = getDisplayWidth(indent);
  const wrapped = wrapText(text, safeWidth);
  const lines = wrapped.map((line, index) => {
    if (index === 0) return truncateDisplay(line, safeWidth);
    return `${indent}${truncateDisplay(line, Math.max(1, safeWidth - indentWidth))}`;
  });
  return typeof maxLines === 'number' ? lines.slice(0, maxLines) : lines;
}

export function fitLabelDetailColumns(
  label: string,
  detail: string,
  totalWidth: number,
  labelRatio = 0.55,
): { labelWidth: number; detailWidth: number } {
  const safeWidth = Math.max(8, totalWidth);
  const labelWidth = Math.max(10, Math.min(safeWidth - 2, Math.floor(safeWidth * labelRatio)));
  return {
    labelWidth,
    detailWidth: Math.max(0, safeWidth - labelWidth - 2),
  };
}
