import { describe, expect, test } from 'bun:test';
import { renderPanelWorkspaceBar } from '../../renderer/panel-workspace-bar.ts';
import type { WorkspaceTab } from '../../panels/panel-manager.ts';
import { lineToString } from '../setup.ts';

describe('panel navigation chrome', () => {
  test('workspace bar renders open tabs across panes', () => {
    const tabs: WorkspaceTab[] = [
      { id: 'system', name: 'System Messages', icon: 'J', pane: 'top', active: true, focused: true },
      { id: 'wrfc', name: 'WRFC', icon: 'W', pane: 'bottom', active: false, focused: false },
    ];
    const line = renderPanelWorkspaceBar(tabs, 100, true);
    const text = lineToString(line);
    expect(text).toContain('PANELS');
    // A14: pane marker is ▲/▼ (not ^/v, which read as a Ctrl caret), and each of
    // the first nine tabs shows its real Alt+N jump index as ⌥N. ⌥ (U+2325) is a
    // width-2 glyph, so its second display cell reconstructs as a space here
    // (it renders as one 2-column glyph in the terminal).
    expect(text).toContain('▲ ⌥ 1 J System Messages');
    expect(text).toContain('▼ ⌥ 2 W WRFC');
  });
});
