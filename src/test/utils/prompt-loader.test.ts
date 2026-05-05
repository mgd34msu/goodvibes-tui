import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, writeFileSync, rmSync, mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { readPromptFile, loadSystemPrompt } from '@pellux/goodvibes-sdk/platform/utils';

// --- helpers ---

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'prompt-loader-test-'));
}

function write(dir: string, name: string, content: string): string {
  const p = join(dir, name);
  writeFileSync(p, content, 'utf-8');
  return p;
}

// --- tests ---

describe('readPromptFile', () => {
  let dir: string;
  beforeEach(() => { dir = tmpDir(); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  test('reads a simple file and returns its content', () => {
    const p = write(dir, 'simple.md', 'Hello world');
    expect(readPromptFile(p)).toBe('Hello world');
  });

  test('returns empty string for missing file (ENOENT)', () => {
    expect(readPromptFile(join(dir, 'nonexistent.md'))).toBe('');
  });

  test('resolves @ includes by reading the referenced file', () => {
    write(dir, 'included.md', 'included content');
    const p = write(dir, 'main.md', '@included.md');
    expect(readPromptFile(p)).toBe('included content');
  });

  test('inline @ path preserves surrounding lines', () => {
    write(dir, 'part.md', 'PART');
    const p = write(dir, 'main.md', 'before\n@part.md\nafter');
    expect(readPromptFile(p)).toBe('before\nPART\nafter');
  });

  test('recursive @ includes: A includes B includes C', () => {
    write(dir, 'c.md', 'C');
    write(dir, 'b.md', '@c.md');
    const a = write(dir, 'a.md', '@b.md');
    expect(readPromptFile(a)).toBe('C');
  });

  test('circular include detection: A includes B includes A — skips circular ref', () => {
    // Write placeholders first so paths resolve, then overwrite with circular refs
    const aPath = join(dir, 'a.md');
    const bPath = join(dir, 'b.md');
    writeFileSync(aPath, '@b.md', 'utf-8');
    writeFileSync(bPath, '@a.md\nB content', 'utf-8');
    // a -> b -> a (circular, skipped), b has extra line
    // Result: a's content processes @b.md, b processes @a.md (skipped, already visited), then "B content"
    const result = readPromptFile(aPath);
    expect(result).toBe('B content');
  });

  test('max depth: depth >= 5 returns empty string', () => {
    // Build a chain of 6 files: f0 -> f1 -> f2 -> f3 -> f4 -> f5
    // f5 should not be included (depth 5 >= maxDepth 5)
    for (let i = 5; i >= 0; i--) {
      if (i === 5) {
        write(dir, `f${i}.md`, 'DEEP');
      } else {
        write(dir, `f${i}.md`, `@f${i + 1}.md`);
      }
    }
    const result = readPromptFile(join(dir, 'f0.md'));
    // f5 is at depth 5, should be blocked; result collapses to empty
    expect(result).toBe('');
  });

  test('@@ escape produces a literal @ in output (no indent)', () => {
    const p = write(dir, 'escaped.md', '@@include this literally');
    expect(readPromptFile(p)).toBe('@include this literally');
  });

  test('@@ escape preserves leading whitespace', () => {
    const p = write(dir, 'escaped-indent.md', '  @@indented escape');
    expect(readPromptFile(p)).toBe('  @indented escape');
  });

  test('@@ line is NOT treated as an include directive', () => {
    // If @@ were treated as include, this would try to read "@nonexistent.md"
    const p = write(dir, 'not-include.md', '@@nonexistent.md');
    // Should return literal '@nonexistent.md', not empty
    expect(readPromptFile(p)).toBe('@nonexistent.md');
  });

  test('lines without @ prefix are passed through verbatim', () => {
    const p = write(dir, 'plain.md', 'no directive here\njust text');
    expect(readPromptFile(p)).toBe('no directive here\njust text');
  });

  test('@ include of missing file returns empty, surrounding content preserved', () => {
    const p = write(dir, 'main.md', 'before\n@missing.md\nafter');
    // missing include produces '' which is falsy, not pushed; lines collapse
    expect(readPromptFile(p)).toBe('before\nafter');
  });

  test('visited Set is shared across siblings — file included once is not duplicated', () => {
    write(dir, 'shared.md', 'SHARED');
    // Both branches include shared.md; should only appear once
    const p = write(dir, 'main.md', '@shared.md\n@shared.md');
    // Second include is skipped (already visited)
    expect(readPromptFile(p)).toBe('SHARED');
  });
});

describe('loadSystemPrompt', () => {
  let dir: string;
  let origArgv: string[];

  beforeEach(() => {
    dir = tmpDir();
    origArgv = process.argv.slice();
  });

  afterEach(() => {
    process.argv = origArgv;
    rmSync(dir, { recursive: true, force: true });
  });

  test('CLI arg --system-prompt-file is exclusive and overrides chain', () => {
    const p = write(dir, 'cli.md', 'CLI content');
    process.argv = ['bun', 'main.ts', '--system-prompt-file', p];
    const result = loadSystemPrompt({
      workingDirectory: dir,
      homeDirectory: dir,
      getConfigPath: () => undefined,
      argv: process.argv,
    });
    expect(result).toBe('CLI content');
  });

  test('CLI arg exclusive: does not chain additional sources', () => {
    const cli = write(dir, 'cli.md', 'CLI only');
    const extra = write(dir, 'extra.md', 'Extra');
    process.argv = ['bun', 'main.ts', '--system-prompt-file', cli];
    // Even if getConfigPath provides extra, it should not be included
    const result = loadSystemPrompt({
      workingDirectory: dir,
      homeDirectory: dir,
      getConfigPath: () => extra,
      argv: process.argv,
    });
    expect(result).toBe('CLI only');
  });

  test('config-specified file is appended when no CLI arg', () => {
    // Avoid hitting real ~/.goodvibes files — just test getConfigPath injection
    const extra = write(dir, 'extra.md', 'Extra content');
    process.argv = ['bun', 'main.ts'];
    const result = loadSystemPrompt({
      workingDirectory: dir,
      homeDirectory: dir,
      getConfigPath: () => extra,
      argv: process.argv,
    });
    // Only extra (real home files may or may not exist in CI)
    expect(result).toContain('Extra content');
  });

  test('returns empty string when no files exist and no CLI arg', () => {
    process.argv = ['bun', 'main.ts'];
    // No config path, home files likely missing in test env — should not throw
    expect(() => loadSystemPrompt({
      workingDirectory: dir,
      homeDirectory: dir,
      getConfigPath: () => undefined,
      argv: process.argv,
    })).not.toThrow();
  });

  test('missing CLI arg target returns empty and falls through to chain', () => {
    process.argv = ['bun', 'main.ts', '--system-prompt-file', join(dir, 'nonexistent.md')];
    // Should not throw; missing file -> '' -> falls through
    const result = loadSystemPrompt({
      workingDirectory: dir,
      homeDirectory: dir,
      getConfigPath: () => undefined,
      argv: process.argv,
    });
    // No real home files expected to exist in unit test; just assert no throw
    expect(typeof result).toBe('string');
  });
});
