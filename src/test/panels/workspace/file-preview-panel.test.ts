import { describe, expect, test } from 'bun:test';
import { FilePreviewPanel } from '../../../panels/file-preview-panel.ts';
import { linesText } from './_shared.ts';

describe('workspace panel migrations', () => {
  test('FilePreviewPanel renders shared workspace empty state cleanly', async () => {
    const panel = new FilePreviewPanel();
    const lines = panel.render(80, 20);
    expect(lines).toHaveLength(20);
    expect(lines.every((line) => line.length === 80)).toBe(true);
    expect(linesText(lines)).toContain('Preview');
    expect(linesText(lines)).toContain('No file open');
  });
});
