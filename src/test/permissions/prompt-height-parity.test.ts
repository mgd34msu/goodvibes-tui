/**
 * PermissionPromptUI.getPromptHeight(request, hunkState) must equal the
 * actual number of Line rows PermissionPromptUI.createPromptLines(width,
 * request, hunkState) returns — main.ts's render loop reserves viewport
 * space from getPromptHeight *before* the real render happens (see
 * src/main.ts's overlayRows computation), so any drift between the two
 * clips or misplaces the conversation viewport. This is the single
 * highest-value regression test for the hunk-selection feature
 * (Risk 2 in the work order brief).
 */
import { describe, expect, test } from 'bun:test';
import { PermissionPromptUI, type PermissionPromptRequest } from '../../permissions/prompt.ts';
import { analyzePermissionRequest } from '@pellux/goodvibes-sdk/platform/permissions';
import type { HunkSelectionState } from '../../permissions/hunk-selection.ts';

const WIDTH = 80;

function makeRequest(editCount: number): PermissionPromptRequest & { resolve: (approved: boolean) => void } {
  const edits = Array.from({ length: editCount }, (_, i) => ({
    path: `file${i}.ts`,
    find: `needle${i}`,
    replace: `replacement${i}`,
  }));
  return {
    callId: 'parity-test',
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

describe('PermissionPromptUI.getPromptHeight / createPromptLines parity', () => {
  test('non-hunk-mode baseline (hunkState omitted): height matches exactly, unaffected by this feature', () => {
    const request = makeRequest(0);
    const height = PermissionPromptUI.getPromptHeight(request);
    const lines = PermissionPromptUI.createPromptLines(WIDTH, request);
    expect(lines.length).toBe(height);
  });

  for (const hunkCount of [1, 3, 8, 20]) {
    test(`hunk-mode with ${hunkCount} hunks: height matches exactly`, () => {
      const request = makeRequest(hunkCount);
      const hunkState = makeHunkState(hunkCount);
      const height = PermissionPromptUI.getPromptHeight(request, hunkState);
      const lines = PermissionPromptUI.createPromptLines(WIDTH, request, hunkState);
      expect(lines.length).toBe(height);
    });
  }

  test('cursor position does not change the row count', () => {
    const request = makeRequest(8);
    const hunkState = makeHunkState(8, 5);
    const height = PermissionPromptUI.getPromptHeight(request, hunkState);
    const lines = PermissionPromptUI.createPromptLines(WIDTH, request, hunkState);
    expect(lines.length).toBe(height);
  });

  test('partial selection does not change the row count', () => {
    const request = makeRequest(5);
    const hunkState: HunkSelectionState = { ...makeHunkState(5), selected: new Set([0, 2]) };
    const height = PermissionPromptUI.getPromptHeight(request, hunkState);
    const lines = PermissionPromptUI.createPromptLines(WIDTH, request, hunkState);
    expect(lines.length).toBe(height);
  });

  // item 2a/2b: condensed low-risk cards, multi-path fields, and the `d`
  // details toggle must all keep getPromptHeight and createPromptLines in sync,
  // or the render loop clips the viewport.
  function makeFilesRequest(
    tool: string,
    category: 'read' | 'write' | 'execute',
    paths: string[],
  ): PermissionPromptRequest & { resolve: (approved: boolean) => void } {
    const args = { files: paths.map((path) => ({ path })) };
    return {
      callId: 'files-test',
      tool,
      args,
      category,
      analysis: analyzePermissionRequest(tool, args, category),
      resolve: () => {},
    };
  }

  for (const tool of [
    { name: 'read', cat: 'read' as const },
    { name: 'write', cat: 'write' as const },
  ]) {
    for (const fileCount of [1, 2, 3, 5]) {
      for (const expanded of [false, true]) {
        test(`${tool.name} with ${fileCount} file(s), expanded=${expanded}: height matches`, () => {
          const request = makeFilesRequest(tool.name, tool.cat, Array.from({ length: fileCount }, (_, i) => `dir/file${i}.ts`));
          const height = PermissionPromptUI.getPromptHeight(request, undefined, expanded);
          const lines = PermissionPromptUI.createPromptLines(WIDTH, request, undefined, expanded);
          expect(lines.length).toBe(height);
        });
      }
    }
  }

  const lineText = (line: { char: string }[]): string => line.map((c) => c.char).join('');

  test('2a — a nested {files:[{path}]} arg renders the real path in the Path field, raw JSON only in Args', () => {
    const request = makeFilesRequest('write', 'write', ['notes/haiku.txt']);
    const rows = PermissionPromptUI.createPromptLines(WIDTH, request, undefined, true).map(lineText);
    const pathRow = rows.find((r) => r.trimStart().startsWith('Path'));
    expect(pathRow).toBeDefined();
    expect(pathRow!).toContain('notes/haiku.txt');
    expect(pathRow!).not.toContain('{"files"'); // never a JSON blob in the Path field
    // Raw args stay reachable in the dedicated Args row (behind the details view).
    const argsRow = rows.find((r) => r.trimStart().startsWith('Args'));
    expect(argsRow!).toContain('{"files"');
  });

  test('2a — many files collapse to a "N files: …" summary line', () => {
    const request = makeFilesRequest('write', 'write', Array.from({ length: 6 }, (_, i) => `f${i}.ts`));
    const text = PermissionPromptUI.createPromptLines(WIDTH, request, undefined, true).map(lineText).join('\n');
    expect(text).toContain('6 files:');
  });

  test('2b — a low-risk local read is condensed by default and expands with details', () => {
    const request = makeFilesRequest('read', 'read', ['src/foo.ts']);
    const collapsedHeight = PermissionPromptUI.getPromptHeight(request, undefined, false);
    const expandedHeight = PermissionPromptUI.getPromptHeight(request, undefined, true);
    // Condensed cards are much shorter; expanding reveals the full block.
    expect(expandedHeight).toBeGreaterThan(collapsedHeight);
    const collapsed = PermissionPromptUI.createPromptLines(WIDTH, request, undefined, false);
    expect(collapsed.length).toBe(collapsedHeight);
    // The condensed card still names the file and offers the details toggle.
    const text = collapsed.map(lineText).join('\n');
    expect(text).toContain('foo.ts');
    expect(text).toContain('[d] details');
  });

  // Item 3 (b/c): attribution + remember-scope preview must keep height in sync
  // in BOTH card shapes, with and without a known requester.
  for (const requestedBy of [undefined, 'session abc12345']) {
    for (const expanded of [false, true]) {
      test(`full-card parity with requestedBy=${requestedBy}, expanded=${expanded}`, () => {
        const request = makeFilesRequest('write', 'write', ['dir/a.ts']);
        const height = PermissionPromptUI.getPromptHeight(request, undefined, expanded, requestedBy);
        const lines = PermissionPromptUI.createPromptLines(WIDTH, request, undefined, expanded, requestedBy);
        expect(lines.length).toBe(height);
      });
      test(`condensed-card parity with requestedBy=${requestedBy}`, () => {
        const request = makeFilesRequest('read', 'read', ['src/foo.ts']);
        const height = PermissionPromptUI.getPromptHeight(request, undefined, false, requestedBy);
        const lines = PermissionPromptUI.createPromptLines(WIDTH, request, undefined, false, requestedBy);
        expect(lines.length).toBe(height);
      });
    }
  }

  test('hunk-mode parity is unaffected by requestedBy (no whole-request remember key)', () => {
    const request = makeRequest(3);
    const hunkState = makeHunkState(3);
    const height = PermissionPromptUI.getPromptHeight(request, hunkState, false, 'session abc12345');
    const lines = PermissionPromptUI.createPromptLines(WIDTH, request, hunkState, false, 'session abc12345');
    expect(lines.length).toBe(height);
  });
});

describe('PermissionPromptUI — attribution + remember-scope preview (Item 3 b/c)', () => {
  const lineText = (line: { char: string }[]): string => line.map((c) => c.char).join('');

  function req(tool: string, args: Record<string, unknown>, category: 'read' | 'write' | 'execute'): PermissionPromptRequest & { resolve: (approved: boolean) => void } {
    return { callId: 'c', tool, args, category, analysis: analyzePermissionRequest(tool, args, category), resolve: () => {} };
  }

  test('rememberScopeKey mirrors the SDK getApprovalKey: path, then command, then tool-only', () => {
    expect(PermissionPromptUI.rememberScopeKey(req('edit', { path: 'src/a.ts' }, 'write'))).toBe('edit:src/a.ts');
    expect(PermissionPromptUI.rememberScopeKey(req('bash', { command: 'npm test' }, 'execute'))).toBe('bash:npm test');
    expect(PermissionPromptUI.rememberScopeKey(req('list', {}, 'read'))).toBe('list');
  });

  test('the prompt shows the exact rule [A] will remember, before it is written', () => {
    const text = PermissionPromptUI.createPromptLines(80, req('bash', { command: 'rm build' }, 'execute')).map(lineText).join('\n');
    expect(text).toContain('Remembers');
    expect(text).toContain('bash:rm build');
  });

  test('the prompt names the requesting agent/process when known, and omits the line when not', () => {
    const withWho = PermissionPromptUI.createPromptLines(80, req('bash', { command: 'ls' }, 'execute'), undefined, false, 'agent 1a2b3c4d').map(lineText).join('\n');
    expect(withWho).toContain('Requested by: agent 1a2b3c4d');
    const without = PermissionPromptUI.createPromptLines(80, req('bash', { command: 'ls' }, 'execute')).map(lineText).join('\n');
    expect(without).not.toContain('Requested by');
  });
});
