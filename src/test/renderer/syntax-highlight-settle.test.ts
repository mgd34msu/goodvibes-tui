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
