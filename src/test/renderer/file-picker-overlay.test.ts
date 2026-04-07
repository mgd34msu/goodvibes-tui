import { describe, expect, test } from 'bun:test';
import { renderFilePickerOverlay } from '../../renderer/file-picker-overlay.ts';
import { FilePickerModal } from '../../input/file-picker.ts';
import { lineToString } from '../setup.ts';

describe('renderFilePickerOverlay', () => {
  test('handles wide-character queries and file names without breaking line width', () => {
    const picker = new FilePickerModal();
    picker.active = true;
    picker.query = '界🙂query';
    picker.results = ['src/界🙂-component.tsx', 'docs/normal-file.md'];
    picker.selectedIndex = 0;

    const width = 72;
    const lines = renderFilePickerOverlay(picker, width);
    for (const line of lines) {
      expect(line.length).toBe(width);
    }
  });

  test('uses the shared overlay inset instead of hugging terminal edges', () => {
    const picker = new FilePickerModal();
    picker.active = true;
    picker.results = ['src/app.ts'];

    const lines = renderFilePickerOverlay(picker, 80, 24);
    expect(lineToString(lines[0]).startsWith('      ┌')).toBe(true);
  });
});
