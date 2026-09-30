/**
 * Drawn code does not depend on what was highlighted before.
 *
 * The first draw of a code line uses the regex placeholder and schedules a
 * tree-sitter parse on a process-wide highlighter; the parse lands later. The
 * transcript's line cache used to keep the placeholder lines (nothing in their
 * cache key moved), so the same diff showed different colours depending on
 * whether that code had been parsed earlier, and a golden frame depended on
 * which test file ran before it in the same `bun test` process.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Line } from '@pellux/goodvibes-sdk/platform/types';
import { ConversationManager } from '../../core/conversation.ts';
import { renderCodeBlock, settleSyntaxHighlighting, syntaxHighlightGeneration, syntaxHighlightMisses } from '../../renderer/code-block.ts';
import { SyntaxHighlighter } from '../../renderer/syntax-highlighter.ts';

const grammar = existsSync(join(process.cwd(), 'node_modules', 'web-tree-sitter', 'web-tree-sitter.wasm'))
  && existsSync(join(process.cwd(), 'node_modules', 'tree-sitter-typescript', 'tree-sitter-typescript.wasm'));

const styles = (lines: readonly Line[]): string => lines.map((l) => l.map((c) => `${c.char}${c.fg ?? ''}`).join('')).join('\n');

/** A snippet no other test parses (its cache key is unique to this call). */
function uniqueCode(tag: string): string[] {
  return [`// syntax-highlight-settle ${tag} ${Math.random()}`, 'export function add(a: number, b: number): number {', '  return a + b;', '}'];
}

describe('syntax highlighting settles the same way whatever drew first', () => {
  test.skipIf(!grammar)('a transcript that drew the placeholder redraws the real highlighting once the parse lands', async () => {
    const code = uniqueCode('transcript');
    const cm = new ConversationManager(() => 100);
    cm.addUserMessage('show me');
    cm.addAssistantMessage(`Here:\n\n\`\`\`ts\n${code.join('\n')}\n\`\`\`\n`, { model: 'm1' });
    const missesBefore = syntaxHighlightMisses();
    const first = styles(cm.getDisplayBlocks());
    expect(syntaxHighlightMisses()).toBeGreaterThan(missesBefore);
    const generation = syntaxHighlightGeneration();
    await settleSyntaxHighlighting();
    expect(syntaxHighlightGeneration()).toBeGreaterThan(generation);
    // What the app does when a parse lands (work-tree-wiring's onSyntaxHighlightReady).
    cm.workTree.invalidate();
    const redrawn = styles(cm.getDisplayBlocks());
    expect(redrawn).not.toBe(first);

    // A fresh transcript drawing the now-parsed code draws exactly the same.
    const fresh = new ConversationManager(() => 100);
    fresh.addUserMessage('show me');
    fresh.addAssistantMessage(`Here:\n\n\`\`\`ts\n${code.join('\n')}\n\`\`\`\n`, { model: 'm1' });
    expect(styles(fresh.getDisplayBlocks())).toBe(redrawn);
  }, 10_000);

  test.skipIf(!grammar)('a settled frame is identical whether the code was parsed before or not', async () => {
    const code = uniqueCode('order');
    // Cold: nothing parsed this snippet yet.
    renderCodeBlock(code, 'ts', 80);
    await settleSyntaxHighlighting();
    const cold = styles(renderCodeBlock(code, 'ts', 80));
    // Warm: drawn again after the cache already holds it.
    renderCodeBlock(code, 'ts', 80);
    await settleSyntaxHighlighting();
    expect(styles(renderCodeBlock(code, 'ts', 80))).toBe(cold);
  }, 10_000);

  test('a language with no grammar is not reparsed on every draw', async () => {
    const lines = ['a := 1', 'b := 2'];
    renderCodeBlock(lines, 'no-such-language-xyz', 80);
    await settleSyntaxHighlighting();
    const before = syntaxHighlightMisses();
    renderCodeBlock(lines, 'no-such-language-xyz', 80);
    expect(syntaxHighlightMisses()).toBe(before);
  });
});

describe('parses in flight together never share a tree', () => {
  // The highlighter used one virtual path for every parse, and the tree-sitter
  // service deletes the previous tree of a path when that path is parsed
  // again. Two blocks highlighted back to back (two code fences in one frame,
  // or a test file leaving a parse running when the next one starts) had the
  // second parse free the first one's tree before it was walked, and the
  // first block kept colours read from freed memory.
  const codeA = [
    'export interface RetryOptions {',
    '  attempts: number;',
    '  baseDelayMs: number;',
    '}',
    `export const tagA = ${JSON.stringify(String(Math.random()))};`,
  ];
  const codeB = [
    'import { sleep } from "./sleep.ts";',
    'export async function withRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {',
    '  for (let i = 0; i < attempts; i++) { try { return await fn(); } catch { await sleep(100 * 2 ** i); } }',
    '  throw new Error("unreachable");',
    '}',
    `export const tagB = ${JSON.stringify(String(Math.random()))};`,
  ];

  async function alone(code: string[]): Promise<unknown> {
    const hl = new SyntaxHighlighter();
    hl.highlight(code.join('\n'), 'ts');
    await hl.settle();
    return hl.highlight(code.join('\n'), 'ts');
  }

  test.skipIf(!grammar)('blocks highlighted together get the tokens each gets alone', async () => {
    // Many blocks in flight at once, as a transcript with several fences (or
    // a test file that never settles) leaves them.
    const blocks = [codeA, codeB, ...Array.from({ length: 24 }, (_, i) => [
      `export function f${i}(x: number): string {`,
      `  const y = x * ${i} + ${JSON.stringify(String(Math.random()))}.length;`,
      '  return `${y}`;',
      '}',
    ])];
    const expected: unknown[] = [];
    for (const code of blocks) expected.push(await alone(code));
    const hl = new SyntaxHighlighter();
    // The grammar is loaded first, as it is in a running app: while it loads,
    // every parse waits on it and they happen to run one after another.
    hl.highlight(`const warm = ${JSON.stringify(String(Math.random()))};`, 'ts');
    await hl.settle();
    for (const code of blocks) hl.highlight(code.join('\n'), 'ts');
    await hl.settle();
    // A block whose parse walked a freed tree failed for good (null, the
    // regex placeholder forever) or kept wrong colours.
    blocks.forEach((code, i) => {
      expect(hl.highlight(code.join('\n'), 'ts')).toEqual(expected[i] as never);
    });
  });
});
