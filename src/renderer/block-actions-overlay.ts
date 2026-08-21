/**
 * renderBlockActionsMenu, renders the BlockActionsMenu (src/renderer/block-actions.ts)
 * as a docked overlay, so opening it via Enter-on-an-empty-composer actually
 * shows something. Follows the established docked-overlay pattern (see
 * selection-modal-overlay.ts / bookmark-modal.ts): ModalFactory sizes the box
 * to its content, and every text section wraps rather than clips, so the
 * block summary and action list are always shown in full.
 */

import { type Line } from '@pellux/goodvibes-sdk/platform/types';
import { ModalFactory, type ModalSection } from './modal-factory.ts';
import type { BlockActionsMenu } from './block-actions.ts';
import { describeBlockForReceipt } from '../input/handler-content-actions.ts';
import { getOverlaySurfaceMetrics } from './overlay-viewport.ts';
import { formatHints } from './hint-grammar.ts';

export function renderBlockActionsMenu(
  menu: BlockActionsMenu,
  width: number,
  viewportHeight = 24,
): Line[] {
  if (!menu.active || !menu.block) return [];

  const summary = describeBlockForReceipt(menu.block);
  const metrics = getOverlaySurfaceMetrics(width, viewportHeight, {
    margin: 4,
    maxWidth: 64,
    chromeRows: 5,
    minContentRows: 3,
    maxContentRows: Math.max(6, viewportHeight - 8),
  });

  const sections: ModalSection[] = [
    { type: 'text', content: `Target: ${summary}`, style: { dim: true } },
    { type: 'separator' },
    {
      type: 'list',
      items: menu.actions.map((action, i) => ({
        label: `[${action.key}] ${action.label}`,
        selected: i === menu.selectedIndex,
      })),
    },
  ];

  return ModalFactory.createModal(
    {
      title: 'Block Actions',
      width: metrics.boxWidth,
      margin: metrics.margin,
      sections,
      hints: [formatHints([
        { key: 'Up/Down', verb: 'Navigate' },
        { key: 'Enter', verb: 'Select' },
        { key: 'Esc', verb: 'Close' },
      ])],
    },
    width,
  );
}
