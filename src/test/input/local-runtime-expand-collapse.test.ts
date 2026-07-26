// ---------------------------------------------------------------------------
// local-runtime-expand-collapse.test.ts — /expand tool and /collapse tool
// against a folded tool-result group (see conversation-turn-structure.ts).
//
// Regression: a folded (non-owning) group member pushes no BlockMeta of its
// own while the group stays collapsed, so it never surfaced from
// toggleBlocks's block-registry loop to be toggled individually. One
// '/expand tool' call used to open only the group's header; each member then
// rendered at whatever its own default collapse state was, needing a second
// '/expand tool' pass to actually see the tool bodies. The fix expands every
// member's own collapse key in the SAME pass as the group header.
// ---------------------------------------------------------------------------

import { describe, expect, test } from 'bun:test';
import { CommandRegistry } from '../../input/command-registry.ts';
import type { CommandContext } from '../../input/command-registry.ts';
import { registerLocalRuntimeCommands } from '../../input/commands/local-runtime.ts';
import { ConversationManager } from '../../core/conversation.ts';

function makeContext(conversationManager: ConversationManager): { context: CommandContext; printed: string[] } {
  const printed: string[] = [];
  const context = {
    session: { conversationManager },
    provider: {},
    workspace: {},
    platform: {},
    ops: {},
    extensions: {},
    print: (text: string) => { printed.push(text); },
    renderRequest: () => {},
    exit: () => {},
  } as unknown as CommandContext;
  return { context, printed };
}

const LONG_OUTPUT = Array.from({ length: 30 }, (_, i) => `line ${i + 1} of a long tool result body`).join('\n');

function buildFoldedGroup(): ConversationManager {
  const cm = new ConversationManager(() => 100);
  cm.addUserMessage('read and write two files');
  cm.addAssistantMessage('reading and writing now', {
    toolCalls: [
      { id: 'call-1', name: 'Read', arguments: { path: 'foo.ts' } },
      { id: 'call-2', name: 'Write', arguments: { path: 'bar.ts' } },
    ],
  });
  cm.addToolResults([
    { callId: 'call-1', success: true, output: LONG_OUTPUT },
    { callId: 'call-2', success: true, output: LONG_OUTPUT },
  ]);
  cm.getDisplayBlocks(); // warm
  // Turns default EXPANDED (collapsing must never hide prose), so the folded
  // starting condition this suite exercises is established explicitly.
  cm.setCollapsed('turn_1', true);
  cm.getDisplayBlocks();
  return cm;
}

describe('/expand tool on a collapsed assistant turn', () => {
  test('one pass expands the turn header AND every result — no second /expand needed', async () => {
    const cm = buildFoldedGroup();
    const registry = new CommandRegistry();
    registerLocalRuntimeCommands(registry);
    const { context } = makeContext(cm);

    const before = cm.getBlockRegistry();
    expect(before.filter((b) => b.type === 'assistant_turn').length).toBe(1);
    expect(before.filter((b) => b.type === 'tool').length).toBe(0); // collapsed turn: no result blocks yet

    await registry.execute('expand', ['tool'], context);
    cm.getDisplayBlocks(); // re-render after the single /expand pass

    const after = cm.getBlockRegistry();
    const memberBlocks = after.filter((b) => b.type === 'tool');
    expect(after.filter((b) => b.type === 'assistant_turn').length).toBe(1);
    expect(memberBlocks.length).toBe(2);
    // Each result is rendered in FULL (its own multi-line body), not the
    // 1-2 line "N hidden" collapsed fragment — proof both results expanded in
    // the same pass as the turn header, not just the header itself.
    for (const block of memberBlocks) {
      expect(block.lineCount).toBeGreaterThan(10);
    }
  });

  test('/collapse tool on an already-expanded turn re-collapses everything with one pass too', async () => {
    const cm = buildFoldedGroup();
    const registry = new CommandRegistry();
    registerLocalRuntimeCommands(registry);
    const { context } = makeContext(cm);

    await registry.execute('expand', ['tool'], context);
    cm.getDisplayBlocks();
    expect(cm.getBlockRegistry().filter((b) => b.type === 'tool').length).toBe(2);

    await registry.execute('collapse', ['tool'], context);
    cm.getDisplayBlocks();
    const after = cm.getBlockRegistry();
    expect(after.filter((b) => b.type === 'assistant_turn').length).toBe(1);
    expect(after.filter((b) => b.type === 'tool').length).toBe(0);
  });
});
