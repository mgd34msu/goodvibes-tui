/**
 * conversation-theme-rebuild.test.ts, the transcript follows a theme change.
 *
 * Transcript lines are built once and cached per message. main.ts registers
 * `registerThemeRefresh(() => conversation.clearLineCache())` so a theme or
 * mode change rebuilds them on the next paint (a full repaint alone only
 * re-diffs the screen); this test uses the same wiring. The line cache also
 * keys on the active token table, so a cache hit can never serve old colours.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import type { Line } from '@pellux/goodvibes-sdk/platform/types';
import { ConversationManager } from '../../core/conversation.ts';
import { activeTheme, registerThemeRefresh, setActiveThemeMode, setActiveThemeName } from '../../renderer/theme.ts';

afterEach(() => {
  setActiveThemeName('goodvibes');
  setActiveThemeMode('dark');
});

/** A conversation wired the way main.ts wires the real one. */
function wiredConversation(): ConversationManager {
  const cm = new ConversationManager(() => 80);
  registerThemeRefresh(() => cm.clearLineCache());
  return cm;
}

function fgs(lines: Line[]): Set<string> {
  const out = new Set<string>();
  for (const line of lines) for (const cell of line) if (cell.fg) out.add(cell.fg);
  return out;
}

describe('transcript rebuilds on a theme change', () => {
  test('a heading re-renders in the new theme without any other change', () => {
    const cm = wiredConversation();
    cm.addUserMessage('hi');
    cm.addAssistantMessage('# A heading\n\nBody text.');

    setActiveThemeName('goodvibes-neon');
    const neonHeading = activeTheme().heading1;
    expect(fgs(cm.getDisplayBlocks()).has(neonHeading)).toBe(true);

    setActiveThemeName('nord');
    const nordHeading = activeTheme().heading1;
    expect(nordHeading).not.toBe(neonHeading);
    const after = fgs(cm.getDisplayBlocks());
    expect(after.has(nordHeading)).toBe(true);
    expect(after.has(neonHeading)).toBe(false);
  });

  test('a mode flip rebuilds too', () => {
    const cm = wiredConversation();
    cm.addUserMessage('hi');
    cm.addAssistantMessage('# A heading');
    const dark = activeTheme().heading1;
    expect(fgs(cm.getDisplayBlocks()).has(dark)).toBe(true);
    setActiveThemeMode('light');
    const light = activeTheme().heading1;
    const after = fgs(cm.getDisplayBlocks());
    expect(after.has(light)).toBe(true);
    expect(after.has(dark)).toBe(false);
  });
});
