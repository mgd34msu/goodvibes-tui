/**
 * Permission dialog layout: the dialog is a kit modal stamped over the
 * dimmed screen, so it no longer reserves viewport rows (the old
 * getPromptHeight / createPromptLines parity contract is gone with the row
 * splicing it protected). What must hold instead:
 *
 *  - every card shape fits the screen it is drawn on, with its buttons in view;
 *  - the hunk under the cursor is always visible, whatever the cursor;
 *  - the subject shows the real path(s), never a JSON blob; many files
 *    collapse to an "N files: …" summary; the raw args stay in the details;
 *  - details are one key (d) away, and the requester and the exact rule
 *    "Allow for session" remembers are shown.
 */
import { describe, expect, test } from 'bun:test';
import { PermissionPromptUI, type PermissionPromptRequest } from '../../permissions/prompt.ts';
import { analyzePermissionRequest } from '@pellux/goodvibes-sdk/platform/permissions';
import type { HunkSelectionState } from '../../permissions/hunk-selection.ts';
import { promptCardLines, promptCardText } from '../helpers/permission-card.ts';

const WIDTH = 80;

function makeRequest(editCount: number): PermissionPromptRequest & { resolve: (approved: boolean) => void } {
  const edits = Array.from({ length: editCount }, (_, i) => ({
    path: `file${i}.ts`,
    find: `needle${i}`,
    replace: `replacement${i}`,
  }));
  return {
    callId: 'layout-test',
    tool: 'edit',
    args: { edits },
    category: 'write',
    analysis: analyzePermissionRequest('edit', { edits }, 'write'),
    resolve: (_approved: boolean) => {},
  };
}

function makeHunkState(count: number, cursor = 0): HunkSelectionState {
  return {
    hunks: Array.from({ length: count }, (_, i) => ({
      path: `file${i}.ts`,
      find: `needle${i}`,
      replace: `replacement${i}`,
    })),
    cursor,
    selected: new Set(Array.from({ length: count }, (_, i) => i)),
  };
}

function makeFilesRequest(
  tool: string,
  category: 'read' | 'write' | 'execute',
  paths: string[],
): PermissionPromptRequest & { resolve: (approved: boolean) => void } {
  const args = { files: paths.map((path) => ({ path })) };
  return { callId: 'files-test', tool, args, category, analysis: analyzePermissionRequest(tool, args, category), resolve: () => {} };
}

function expectFits(lines: ReturnType<typeof promptCardLines>, width: number, height: number): void {
  expect(lines).toHaveLength(height);
  for (const line of lines) expect(line).toHaveLength(width);
}

describe('permission dialog layout', () => {
  test('a plain edit card fits 80x24 with its buttons', () => {
    const lines = promptCardLines(WIDTH, makeRequest(1), undefined, false, undefined, undefined, 24);
    expectFits(lines, WIDTH, 24);
    expect(lines.map((l) => l.map((c) => c.char).join('')).join('\n')).toContain(' Deny ');
  });

  for (const hunkCount of [1, 3, 8, 20]) {
    test(`hunk mode with ${hunkCount} hunks fits 80x24, buttons in view`, () => {
      const lines = promptCardLines(WIDTH, makeRequest(hunkCount), makeHunkState(hunkCount), false, undefined, undefined, 24);
      expectFits(lines, WIDTH, 24);
      const text = lines.map((l) => l.map((c) => c.char).join('')).join('\n');
      expect(text).toContain(' Apply selected ');
      expect(text).toContain(' Deny ');
    });
  }

  test('the hunk under the cursor is always visible', () => {
    for (const cursor of [0, 4, 7]) {
      const text = promptCardText(WIDTH, makeRequest(8), makeHunkState(8, cursor), false, undefined, undefined, 24).join('\n');
      expect(text).toContain(`${cursor + 1}. file${cursor}.ts`);
    }
  });

  test('more than eight hunks are counted, not dropped', () => {
    const text = promptCardText(WIDTH, makeRequest(20), makeHunkState(20)).join('\n');
    expect(text).toContain('+12 more hunks');
  });

  test('partial selection is shown on the checkboxes and the count', () => {
    const text = promptCardText(WIDTH, makeRequest(5), { ...makeHunkState(5), selected: new Set([0, 2]) }).join('\n');
    expect(text).toContain('2 of 5 hunks selected');
    expect(text).toContain('[x] 1. file0.ts');
    expect(text).toContain('[ ] 2. file1.ts');
  });

  for (const tool of [{ name: 'read', cat: 'read' as const }, { name: 'write', cat: 'write' as const }]) {
    for (const fileCount of [1, 2, 3, 5]) {
      for (const expanded of [false, true]) {
        test(`${tool.name} with ${fileCount} file(s), details ${expanded ? 'open' : 'closed'}: fits 80x24 and names the target`, () => {
          const request = makeFilesRequest(tool.name, tool.cat, Array.from({ length: fileCount }, (_, i) => `dir/file${i}.ts`));
          const lines = promptCardLines(WIDTH, request, undefined, expanded, undefined, undefined, 24);
          expectFits(lines, WIDTH, 24);
          expect(lines.map((l) => l.map((c) => c.char).join('')).join('\n')).toContain('file0.ts');
        });
      }
    }
  }

  test('a nested {files:[{path}]} arg shows the real path in the subject, raw JSON only in Args', () => {
    const rows = promptCardText(WIDTH, makeFilesRequest('write', 'write', ['notes/haiku.txt']), undefined, true);
    const subject = rows.find((r) => /^\s*(Path|Target|File)/.test(r) && r.includes('notes/haiku.txt'));
    expect(subject).toBeDefined();
    expect(subject!).not.toContain('{"files"');
    const argsRow = rows.find((r) => r.trimStart().startsWith('Args'));
    expect(argsRow!).toContain('{"files"');
  });

  test('many files collapse to an "N files: …" summary', () => {
    const text = promptCardText(WIDTH, makeFilesRequest('write', 'write', Array.from({ length: 6 }, (_, i) => `f${i}.ts`)), undefined, false).join('\n');
    expect(text).toContain('6 files: f0.ts, f1.ts, +4 more');
  });

  test('details are one key away: closed by default, opened with d', () => {
    const request = makeFilesRequest('read', 'read', ['src/foo.ts']);
    const closed = promptCardText(WIDTH, request, undefined, false).join('\n');
    const open = promptCardText(WIDTH, request, undefined, true).join('\n');
    expect(closed).toContain('foo.ts');
    expect(closed).toContain('d details');
    expect(closed).not.toMatch(/Tool +read/);
    expect(open).toMatch(/Tool +read/);
    expect(open).toContain('d hide details');
  });
});

describe('PermissionPromptUI: attribution + remember-scope preview (Item 3 b/c)', () => {
  function req(tool: string, args: Record<string, unknown>, category: 'read' | 'write' | 'execute'): PermissionPromptRequest & { resolve: (approved: boolean) => void } {
    return { callId: 'c', tool, args, category, analysis: analyzePermissionRequest(tool, args, category), resolve: () => {} };
  }

  test('rememberScopeKey mirrors the SDK getApprovalKey: path, then command, then tool-only', () => {
    expect(PermissionPromptUI.rememberScopeKey(req('edit', { path: 'src/a.ts' }, 'write'))).toBe('edit:src/a.ts');
    expect(PermissionPromptUI.rememberScopeKey(req('bash', { command: 'npm test' }, 'execute'))).toBe('bash:npm test');
    expect(PermissionPromptUI.rememberScopeKey(req('list', {}, 'read'))).toBe('list');
  });

  test('the details show the exact rule "Allow for session" will remember, before it is written', () => {
    const text = promptCardText(80, req('bash', { command: 'rm build' }, 'execute'), undefined, true).join('\n');
    expect(text).toContain('Remembers');
    expect(text).toContain('bash:rm build');
  });

  test('the title row names the requesting agent/process when known, and omits it when not', () => {
    const withWho = promptCardText(80, req('bash', { command: 'ls' }, 'execute'), undefined, false, 'agent 1a2b3c4d').join('\n');
    expect(withWho).toContain('agent 1a2b3c4d');
    const without = promptCardText(80, req('bash', { command: 'ls' }, 'execute'), undefined, false).join('\n');
    expect(without).not.toContain('agent 1a2b3c4d');
  });
});
