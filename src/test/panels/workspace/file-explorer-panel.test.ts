import { describe, expect, test } from 'bun:test';
import { FileExplorerPanel } from '../../../panels/file-explorer-panel.ts';
import { linesText } from './_shared.ts';

describe('workspace panel migrations', () => {
  test('FileExplorerPanel renders shared workspace surface cleanly', async () => {
    const panel = new FileExplorerPanel('/definitely/not/a/real/path', '/tmp/goodvibes-test');
    const lines = panel.render(80, 20);
    expect(lines).toHaveLength(20);
    expect(lines.every((line) => line.length === 80)).toBe(true);
    expect(linesText(lines)).toContain('Explorer');
  });

  test('FileExplorerPanel supports explicit search focus from top navigation', async () => {
    const panel = new FileExplorerPanel('/definitely/not/a/real/path', '/tmp/goodvibes-test');
    panel.handleInput('up');
    panel.handleInput('r');
    const text = linesText(panel.render(80, 20));
    expect(text).toContain('/ r█');
  });
});
