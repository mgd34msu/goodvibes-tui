/**
 * footer-targets.ts, which footer rows open a view when clicked.
 *
 * The status line (the row carrying the context bar and cost) opens the
 * Usage modal on a click. The footer builder tags those Line arrays with a symbol-keyed
 * property (invisible to rendering, iteration and golden frames); the shell
 * turns the tags into screen rows each frame and the mouse route reads them.
 */

import type { Line } from '@pellux/goodvibes-sdk/platform/types';

/** What a clickable footer row opens. */
export type FooterTarget = 'usage';

const FOOTER_TARGET = Symbol('footer-target');

type TaggedLine = Line & { [FOOTER_TARGET]?: FooterTarget };

/** Mark a footer row as opening `target` when clicked; returns the same line. */
export function tagFooterLine(line: Line, target: FooterTarget): Line {
  (line as TaggedLine)[FOOTER_TARGET] = target;
  return line;
}

/** The target a footer row opens, or undefined. */
function footerTargetOf(line: Line): FooterTarget | undefined {
  return (line as TaggedLine)[FOOTER_TARGET];
}

/** Screen row → target for a footer drawn with its first row at `startRow`. */
export function footerTargetRows(footer: readonly Line[], startRow: number): ReadonlyMap<number, FooterTarget> {
  const rows = new Map<number, FooterTarget>();
  footer.forEach((line, index) => {
    const target = footerTargetOf(line);
    if (target) rows.set(startRow + index, target);
  });
  return rows;
}
