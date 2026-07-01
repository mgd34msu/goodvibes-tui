import { describe, expect, test } from 'bun:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionManager } from '@pellux/goodvibes-sdk/platform/sessions';
import { SessionBrowserPanel } from '../../../panels/session-browser-panel.ts';
import { linesText } from './_shared.ts';

describe('workspace panel migrations', () => {
  test('SessionBrowserPanel renders shared workspace empty state cleanly', async () => {
    const panel = new SessionBrowserPanel(new SessionManager(join(tmpdir(), 'gv-workspace-migration'), { surfaceRoot: 'tui' }));
    const lines = panel.render(80, 20);
    expect(lines).toHaveLength(20);
    expect(lines.every((line) => line.length === 80)).toBe(true);
    expect(linesText(lines)).toContain('Sessions');
    expect(linesText(lines)).toContain('No sessions found');
  });

  test('SessionBrowserPanel supports explicit search focus from top navigation', async () => {
    const panel = new SessionBrowserPanel(new SessionManager(join(tmpdir(), 'gv-workspace-migration'), { surfaceRoot: 'tui' }));
    panel.handleInput('up');
    panel.handleInput('r');
    const text = linesText(panel.render(80, 20));
    expect(text).toContain('Search: r█');
    expect(text).not.toContain('refresh');
  });
});
