import { type Line } from '@pellux/goodvibes-sdk/platform/types';
import { BORDERS } from './layout.ts';
import { renderConversationNotice } from './conversation-surface.ts';
import { activeUiTones } from './theme.ts';

export function renderThinkingBlock(text: string, width: number): Line[] {
  // Thinking notices paint the ▌ marker and italic body on the TRANSPARENT
  // terminal background (renderConversationNotice passes no bodyBg), so both
  // colors resolve per-render through activeUiTones() to stay legible on a
  // light terminal. Dark values are byte-identical to the prior static reads
  // (state.reasoning for the accent, chrome.faint, which equals fg.dim, for
  // the body text).
  const t = activeUiTones();
  return renderConversationNotice(
    text,
    width,
    {
      accent: t.state.reasoning,
      text: t.chrome.faint,
      dim: true,
      italic: true,
    },
    BORDERS.THINKING.char,
  );
}
