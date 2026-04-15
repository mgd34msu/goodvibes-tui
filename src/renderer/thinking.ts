import { type Line } from '@pellux/goodvibes-sdk/platform/types/grid';
import { BORDERS, COLORS } from './layout.ts';
import { renderConversationNotice } from './conversation-surface.ts';

export function renderThinkingBlock(text: string, width: number): Line[] {
  return renderConversationNotice(
    text,
    width,
    {
      accent: BORDERS.THINKING.color,
      text: COLORS.DIM_TEXT,
      dim: true,
      italic: true,
    },
    BORDERS.THINKING.char,
  );
}
