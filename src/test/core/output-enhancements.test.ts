import { describe, test, expect, beforeEach } from 'bun:test';
import { ConversationManager, parseDiffForApply, applyDiffContent } from '../../core/conversation';

describe('parseDiffForApply', () => {
  test('parses a valid unified diff', () => {
    const diff = [
      '--- a/src/foo.ts',
      '+++ b/src/foo.ts',
      '@@ -1,3 +1,3 @@',
      ' const x = 1;',
      '-const y = 2;',
      '+const y = 42;',
      ' const z = 3;',
    ].join('\n');

    const result = parseDiffForApply(diff);
    expect(result.filePath).toBe('src/foo.ts');
    expect(result.diffOriginal).toContain('const y = 2;');
    expect(result.diffUpdated).toContain('const y = 42;');
    // Context lines appear in both
    expect(result.diffOriginal).toContain('const x = 1;');
    expect(result.diffUpdated).toContain('const x = 1;');
  });

  test('returns undefined filePath when no +++ line', () => {
    const result = parseDiffForApply('some random content\nno diff here');
    expect(result.filePath).toBeUndefined();
  });

  test('handles partial diff: only additions', () => {
    const diff = [
      '--- a/src/bar.ts',
      '+++ b/src/bar.ts',
      '@@ -0,0 +1,2 @@',
      '+line one',
      '+line two',
    ].join('\n');

    const result = parseDiffForApply(diff);
    expect(result.filePath).toBe('src/bar.ts');
    expect(result.diffOriginal).toBe('');
    expect(result.diffUpdated).toContain('line one');
    expect(result.diffUpdated).toContain('line two');
  });

  test('handles +++ path without b/ prefix', () => {
    const diff = [
      '--- src/baz.ts',
      '+++ src/baz.ts (updated)',
      '@@ -1 +1 @@',
      '-old',
      '+new',
    ].join('\n');

    const result = parseDiffForApply(diff);
    expect(result.filePath).toBe('src/baz.ts');
  });
});

describe('ConversationManager: collapse state', () => {
  let cm: ConversationManager;

  beforeEach(() => {
    cm = new ConversationManager(() => 80);
  });

  test('tool results over threshold are auto-collapsed', () => {
    // Add a tool result with more than 30 lines (default threshold)
    const longContent = Array.from({ length: 35 }, (_, i) => `line ${i + 1}`).join('\n');
    cm.addUserMessage('run something');
    cm.addToolResults([{ callId: 'c1', success: true, output: longContent }]);
    cm.getDisplayBlocks(); // trigger render

    // The first block (index 0) should be auto-collapsed
    expect(cm.isCollapsed(0)).toBe(true);
  });

  test('toggleCollapseAtLine toggles collapse state and marks dirty', () => {
    const longContent = Array.from({ length: 35 }, (_, i) => `line ${i + 1}`).join('\n');
    cm.addUserMessage('run something');
    cm.addToolResults([{ callId: 'c1', success: true, output: longContent }]);
    cm.getDisplayBlocks(); // trigger render, auto-collapses block 0

    expect(cm.isCollapsed(0)).toBe(true);
    cm.toggleCollapseAtLine(0);
    expect(cm.isCollapsed(0)).toBe(false);
    cm.toggleCollapseAtLine(0);
    expect(cm.isCollapsed(0)).toBe(true);
  });

  test('toggleCollapseAtLine returns -1 when no blocks registered', () => {
    const result = cm.toggleCollapseAtLine(0);
    expect(result).toBe(-1);
  });

  test('short tool results are not auto-collapsed', () => {
    cm.addUserMessage('run something');
    cm.addToolResults([{ callId: 'c2', success: true, output: 'short result' }]);
    cm.getDisplayBlocks();

    expect(cm.isCollapsed(0)).toBe(false);
  });
});

describe('ConversationManager: getBlockContentAtLine / getDiffAtLine', () => {
  let cm: ConversationManager;

  beforeEach(() => {
    cm = new ConversationManager(() => 80);
  });

  test('getBlockContentAtLine returns null when no blocks', () => {
    expect(cm.getBlockContentAtLine(0)).toBeNull();
  });

  test('getBlockContentAtLine returns raw content of nearest block', () => {
    cm.addUserMessage('run something');
    cm.addToolResults([{ callId: 'c1', success: true, output: 'tool output here' }]);
    cm.getDisplayBlocks();

    const content = cm.getBlockContentAtLine(0);
    expect(content).toBe('tool output here');
  });

  test('getDiffAtLine returns null when no diff blocks', () => {
    cm.addUserMessage('run something');
    cm.addToolResults([{ callId: 'c1', success: true, output: 'plain text output' }]);
    cm.getDisplayBlocks();

    expect(cm.getDiffAtLine(0)).toBeNull();
  });

  test('getDiffAtLine returns diff data for a diff block', () => {
    const diff = [
      '--- a/src/foo.ts',
      '+++ b/src/foo.ts',
      '@@ -1,1 +1,1 @@',
      '-old line',
      '+new line',
    ].join('\n');

    cm.addUserMessage('run something');
    cm.addToolResults([{ callId: 'c1', success: true, output: diff }]);
    cm.getDisplayBlocks();

    const result = cm.getDiffAtLine(0);
    expect(result).not.toBeNull();
    expect(result!.filePath).toBe('src/foo.ts');
    expect(result!.original).toContain('old line');
    expect(result!.updated).toContain('new line');
  });
});

describe('applyDiffContent: occurrence counting', () => {
  test('applies diff when original appears exactly once', () => {
    const content = 'line one\nconst x = 1;\nline three';
    const result = applyDiffContent(content, 'const x = 1;', 'const x = 42;');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.content).toContain('const x = 42;');
      expect(result.content).not.toContain('const x = 1;');
    }
  });

  test('returns error when original appears more than once (ambiguous)', () => {
    const content = 'const x = 1;\nconst x = 1;\nsome other line';
    const result = applyDiffContent(content, 'const x = 1;', 'const x = 42;');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/ambiguous/);
      expect(result.error).toMatch(/2/);
    }
  });

  test('returns error when original is not found in file', () => {
    const content = 'const y = 99;\nsome line';
    const result = applyDiffContent(content, 'const x = 1;', 'const x = 42;');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/not found/);
    }
  });
});

describe('ConversationManager: diff detection (no false positives)', () => {
  let cm: ConversationManager;

  beforeEach(() => {
    cm = new ConversationManager(() => 80);
  });

  test('tool output containing diff-like strings mid-line is not a diff', () => {
    // This content has diff-like words but NOT at line start
    const fakeDiff = 'The file had --- changes and +++ additions and @@ markers inside strings';
    cm.addUserMessage('run something');
    cm.addToolResults([{ callId: 'c1', success: true, output: fakeDiff }]);
    cm.getDisplayBlocks();

    // getDiffAtLine should return null, it's not a real diff
    expect(cm.getDiffAtLine(0)).toBeNull();
  });

  test('real diff with headers at line start is recognized', () => {
    const realDiff = [
      '--- a/file.ts',
      '+++ b/file.ts',
      '@@ -1 +1 @@',
      '-old',
      '+new',
    ].join('\n');
    cm.addUserMessage('run something');
    cm.addToolResults([{ callId: 'c1', success: true, output: realDiff }]);
    cm.getDisplayBlocks();

    expect(cm.getDiffAtLine(0)).not.toBeNull();
  });
});
