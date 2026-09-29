/**
 * renderBlockActionsMenu, the block-actions menu (Enter on an empty composer)
 * as a small centered kit dialog: the target block's summary wrapped in full,
 * then one kit row per action with its key right-aligned, the selected action
 * as the gradient row, and keycap hints. Each action's key fires it directly.
 */

import type { BlockActionsMenu } from './block-actions.ts';
import { describeBlockForReceipt } from '../input/handler-content-actions.ts';
import { activeTokens } from './theme.ts';
import { beginModal, finishModal, type KitHint, type SurfaceLayer } from './surface-kit.ts';
import { drawList, type KitRow } from './surface-kit-list.ts';
import { drawTextBlock, listHeight, modalHeightFor, modalTextWidth, textBlockHeight, type TextLine } from './surface-kit-extra.ts';

const HINTS: readonly KitHint[] = [['↑↓', 'move'], ['⏎', 'select']];
/** Preferred width: a menu, not a workspace. */
const MENU_WIDTH = 72;

export function renderBlockActionsMenu(
  menu: BlockActionsMenu,
  screenWidth: number,
  screenHeight = 24,
): SurfaceLayer | null {
  if (!menu.active || !menu.block) return null;
  const t = activeTokens();

  const target: TextLine[] = [{ text: `Target: ${describeBlockForReceipt(menu.block)}`, style: { fg: t.textMuted } }];
  const rows: KitRow[] = menu.actions.map((action, i) => ({
    label: action.label,
    right: action.key === 'Tab' ? 'tab' : action.key,
    selected: i === menu.selectedIndex,
  }));
  const width = modalTextWidth(screenWidth, screenHeight, MENU_WIDTH);
  const body = textBlockHeight(target, width) + 1 + listHeight(rows, 0, width - 1);
  const height = modalHeightFor(screenWidth, screenHeight, { width: MENU_WIDTH, hints: HINTS }, body);

  const f = beginModal(screenWidth, screenHeight, { title: 'Block actions', hints: HINTS, width: MENU_WIDTH, height, center: true });
  const y = drawTextBlock(f.canvas, f.l, f.top, f.r - f.l + 1, target, f.bottom) + 1;
  drawList(f.canvas, { rows, top: y, bottom: f.bottom, x0: f.l, x1: f.r });
  return finishModal(f);
}
