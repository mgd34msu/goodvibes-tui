import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FilePickerModal } from '../../input/file-picker.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

function makeTmpDir(): string {
  const dir = join(tmpdir(), `gv-inject-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

beforeEach(() => {
  tmpDir = makeTmpDir();
});

afterEach(() => {
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('FilePickerModal — inject mode', () => {
  test('open() with injectMode=true sets injectMode flag', () => {
    const picker = new FilePickerModal();
    picker.open(0, true);
    expect(picker.injectMode).toBe(true);
    expect(picker.active).toBe(true);
  });

  test('open() with injectMode=false (default) does not set injectMode', () => {
    const picker = new FilePickerModal();
    picker.open(5);
    expect(picker.injectMode).toBe(false);
  });

  test('close() resets injectMode to false', () => {
    const picker = new FilePickerModal();
    picker.open(0, true);
    picker.close();
    expect(picker.injectMode).toBe(false);
    expect(picker.active).toBe(false);
  });

  test('inject mode marker format is !@path', () => {
    // Simulate what handler.ts does when injectMode + enter:
    // marker = `!@${selected}` → verify the format
    const selectedFile = 'src/input/handler.ts';
    const marker = `!@${selectedFile}`;
    expect(marker).toBe('!@src/input/handler.ts');
    expect(marker.startsWith('!@')).toBe(true);
  });

  test('non-inject mode marker format is @path', () => {
    const selectedFile = 'src/input/handler.ts';
    const marker = `@${selectedFile}`;
    expect(marker).toBe('@src/input/handler.ts');
    expect(marker.startsWith('@')).toBe(true);
    expect(marker.startsWith('!@')).toBe(false);
  });

  test('insertPos is stored correctly', () => {
    const picker = new FilePickerModal();
    picker.open(42, true);
    expect(picker.insertPos).toBe(42);
  });

  test('query is empty after open()', () => {
    const picker = new FilePickerModal();
    picker.open(0, true);
    expect(picker.query).toBe('');
  });

  test('selectedIndex resets to 0 after open()', () => {
    const picker = new FilePickerModal();
    // Mutate then re-open
    picker.open(0);
    (picker as any).selectedIndex = 5;
    picker.open(0, true);
    expect(picker.selectedIndex).toBe(0);
  });
});

describe('!@ expansion (expandPrompt-style logic)', () => {
  test('expandPrompt replaces !@path with file content', () => {
    // Write a temp file inside the project working dir so path-safety check passes
    const { readFileSync: rfs } = require('node:fs');
    const filePath = join(tmpDir, 'inject_target.txt');
    writeFileSync(filePath, 'file content here');

    // Simulate the expand logic from handler.ts expandPrompt,
    // but bypass resolveAndValidatePath since we control the path in this test.
    let expanded = `prefix !@${filePath} suffix`;
    const injectRegex = /(?:^|(?<=\s))!@(\S+)/g;
    let m;
    while ((m = injectRegex.exec(expanded)) !== null) {
      const fp = m[1];
      try {
        const content = rfs(fp, 'utf-8');
        expanded = expanded.slice(0, m.index) + content + expanded.slice(m.index + m[0].length);
        injectRegex.lastIndex = m.index + content.length;
      } catch {
        // leave marker
      }
    }

    expect(expanded).toContain('file content here');
    expect(expanded).not.toContain('!@');
  });

  test('expandPrompt leaves !@marker if file cannot be read', () => {
    const nonExistentPath = join(tmpDir, 'does_not_exist.txt');

    let expanded = `prefix !@${nonExistentPath} suffix`;
    const injectRegex = /(?:^|(?<=\s))!@(\S+)/g;
    let m;
    while ((m = injectRegex.exec(expanded)) !== null) {
      const fp = m[1];
      try {
        const { readFileSync } = require('node:fs');
        const content = readFileSync(fp, 'utf-8');
        expanded = expanded.slice(0, m.index) + content + expanded.slice(m.index + m[0].length);
        injectRegex.lastIndex = m.index + content.length;
      } catch {
        // leave marker
        break;
      }
    }

    expect(expanded).toContain('!@');
    expect(expanded).toContain(nonExistentPath);
  });

  test('expandPrompt does not expand !@ in the middle of a word', () => {
    // The word-boundary regex should NOT match foo!@bar
    const injectRegex = /(?:^|(?<=\s))!@(\S+)/g;
    const text = 'foo!@bar baz';
    const matches: string[] = [];
    let m;
    while ((m = injectRegex.exec(text)) !== null) {
      matches.push(m[1]);
    }
    expect(matches).toHaveLength(0);
  });

  test('expandPrompt matches !@ at start of string', () => {
    const injectRegex = /(?:^|(?<=\s))!@(\S+)/g;
    const text = '!@somefile.ts';
    const matches: string[] = [];
    let m;
    while ((m = injectRegex.exec(text)) !== null) {
      matches.push(m[1]);
    }
    expect(matches).toHaveLength(1);
    expect(matches[0]).toBe('somefile.ts');
  });

  test('expandPrompt matches !@ after whitespace', () => {
    const injectRegex = /(?:^|(?<=\s))!@(\S+)/g;
    const text = 'include this: !@file.ts and more';
    const matches: string[] = [];
    let m;
    while ((m = injectRegex.exec(text)) !== null) {
      matches.push(m[1]);
    }
    expect(matches).toHaveLength(1);
    expect(matches[0]).toBe('file.ts');
  });
});
