import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderFilePickerOverlay } from '../../renderer/file-picker-overlay.ts';
import { FilePickerModal } from '../../input/file-picker.ts';
import { lineToString } from '../setup.ts';
import { activeTokens } from '../../renderer/theme.ts';

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

  test('sits on the composer: the ┃ bar at column 2, the fill from column 3, no frame', () => {
    const workingDirectory = makeWorkingDirectory();
    workingDirectories.push(workingDirectory);
    const picker = new FilePickerModal({ workingDirectory });
    picker.active = true;
    picker.results = ['src/app.ts'];

    const lines = renderFilePickerOverlay(picker, 80, 24);
    for (const line of lines) {
      expect(line[2]!.char).toBe('┃');
      expect(line[3]!.bg).not.toBe('');
      expect(lineToString(line)).not.toMatch(/[┌┐└┘│─]/);
    }
  });

  test('the typed query is always live: its row shows the query and the cursor', () => {
    const workingDirectory = makeWorkingDirectory();
    workingDirectories.push(workingDirectory);
    const picker = new FilePickerModal({ workingDirectory });
    picker.active = true;
    picker.query = 'app';
    picker.results = ['src/app.ts'];

    const text = renderFilePickerOverlay(picker, 80, 24).map(lineToString).join('\n');
    expect(text).toContain('@app▏');
    expect(text).toContain('1 file');
    expect(text).toContain('src/app.ts');
  });

  test('matched letters of the file name are drawn in the brand color', () => {
    const workingDirectory = makeWorkingDirectory();
    workingDirectories.push(workingDirectory);
    const picker = new FilePickerModal({ workingDirectory });
    picker.active = true;
    picker.query = 'ap';
    picker.results = ['src/other.ts', 'src/app.ts'];
    picker.selectedIndex = 0;

    const lines = renderFilePickerOverlay(picker, 80, 24);
    const row = lines.find((line) => lineToString(line).includes('src/app.ts'))!;
    const at = lineToString(row).indexOf('app.ts');
    expect(row[at]!.fg).toBe(activeTokens().brand);
    expect(row[at + 1]!.fg).toBe(activeTokens().brand);
    expect(row[at + 2]!.fg).not.toBe(activeTokens().brand);
  });
});
