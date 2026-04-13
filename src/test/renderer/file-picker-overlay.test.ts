import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderFilePickerOverlay } from '../../renderer/file-picker-overlay.ts';
import { FilePickerModal } from '../../input/file-picker.ts';
import { lineToString } from '../setup.ts';

function makeWorkingDirectory(): string {
  const dir = join(tmpdir(), `gv-file-picker-overlay-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

const workingDirectories: string[] = [];

afterEach(() => {
  while (workingDirectories.length > 0) {
    const dir = workingDirectories.pop();
    if (!dir) continue;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
});

describe('renderFilePickerOverlay', () => {
  test('handles wide-character queries and file names without breaking line width', () => {
    const workingDirectory = makeWorkingDirectory();
    workingDirectories.push(workingDirectory);
    const picker = new FilePickerModal({ workingDirectory });
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
    const workingDirectory = makeWorkingDirectory();
    workingDirectories.push(workingDirectory);
    const picker = new FilePickerModal({ workingDirectory });
    picker.active = true;
    picker.results = ['src/app.ts'];

    const lines = renderFilePickerOverlay(picker, 80, 24);
    expect(lineToString(lines[0]).startsWith('    ┌')).toBe(true);
  });

  test('shows a block cursor only when the search field is focused', () => {
    const workingDirectory = makeWorkingDirectory();
    workingDirectories.push(workingDirectory);
    const picker = new FilePickerModal({ workingDirectory });
    picker.active = true;
    picker.results = ['src/app.ts'];
    picker.searchFocused = false;

    const unfocused = lineToString(renderFilePickerOverlay(picker, 80, 24)[1]!);
    expect(unfocused).not.toContain('█');

    picker.searchFocused = true;
    const focused = lineToString(renderFilePickerOverlay(picker, 80, 24)[1]!);
    expect(focused).toContain('█');
  });
});
