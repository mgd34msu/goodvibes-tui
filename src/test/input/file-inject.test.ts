import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FilePickerModal } from '../../input/file-picker.ts';
import { expandPrompt } from '../../input/handler-content-actions.ts';
import type { ContentPart } from '@pellux/goodvibes-sdk/platform/providers';

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

describe('FilePickerModal: inject mode', () => {
  test('open() with injectMode=true sets injectMode flag', () => {
    const picker = new FilePickerModal({ workingDirectory: tmpDir });
    picker.open(0, true);
    expect(picker.injectMode).toBe(true);
    expect(picker.active).toBe(true);
  });

  test('open() with injectMode=false (default) does not set injectMode', () => {
    const picker = new FilePickerModal({ workingDirectory: tmpDir });
    picker.open(5);
    expect(picker.injectMode).toBe(false);
  });

  test('close() resets injectMode to false', () => {
    const picker = new FilePickerModal({ workingDirectory: tmpDir });
    picker.open(0, true);
    picker.close();
    expect(picker.injectMode).toBe(false);
    expect(picker.active).toBe(false);
  });

  test('insertPos is stored correctly', () => {
    const picker = new FilePickerModal({ workingDirectory: tmpDir });
    picker.open(42, true);
    expect(picker.insertPos).toBe(42);
  });

  test('query is empty after open()', () => {
    const picker = new FilePickerModal({ workingDirectory: tmpDir });
    picker.open(0, true);
    expect(picker.query).toBe('');
  });

  test('selectedIndex resets to 0 after open()', () => {
    const picker = new FilePickerModal({ workingDirectory: tmpDir });
    // Mutate then re-open
    picker.open(0);
    picker.selectedIndex = 5;
    picker.open(0, true);
    expect(picker.selectedIndex).toBe(0);
  });
});

describe('!@ expansion through expandPrompt', () => {
  const expand = (text: string): string | ContentPart[] => expandPrompt(new Map(), new Map(), text, tmpDir);

  test('replaces a !@path marker with the file content', () => {
    writeFileSync(join(tmpDir, 'inject_target.txt'), 'file content here');
    expect(expand('prefix !@inject_target.txt suffix')).toBe('prefix file content here suffix');
  });

  test('leaves the marker in place when the file cannot be read', () => {
    expect(expand('prefix !@does_not_exist.txt suffix')).toBe('prefix !@does_not_exist.txt suffix');
  });

  test('does not expand !@ in the middle of a word', () => {
    writeFileSync(join(tmpDir, 'bar'), 'SHOULD-NOT-APPEAR');
    expect(expand('foo!@bar baz')).toBe('foo!@bar baz');
  });

  test('expands !@ at the start of the prompt and after whitespace', () => {
    writeFileSync(join(tmpDir, 'a.ts'), 'AAA');
    writeFileSync(join(tmpDir, 'b.ts'), 'BBB');
    expect(expand('!@a.ts then !@b.ts')).toBe('AAA then BBB');
  });
});
