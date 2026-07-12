/**
 * /compact command handler tests (capacity-% fix).
 *
 * shell-core.ts's registered '/compact' handler previously hardcoded
 * contextWindow=0 when building the pre-compact preview, even though the
 * value is directly reachable via ctx.provider.providerRegistry (the exact
 * call compactConversation() in runtime-services.ts already makes). That bug
 * shipped past both suites because no test exercised the HANDLER itself —
 * only the pure compactConversation() helper (compact-conversation-command.test.ts)
 * and the pure buildCompactionPreview() builder (compaction-preview.test.ts)
 * were tested separately. This file closes that gap by driving the actual
 * registered command through CommandRegistry.execute().
 */
import { describe, expect, test } from 'bun:test';
import { CommandRegistry, type CommandContext } from '../../input/command-registry.ts';
import { registerShellCoreCommands } from '../../input/commands/shell-core.ts';

function makeContext(printed: string[]): CommandContext {
  return {
    session: {
      runtime: { model: 'test-model', provider: 'test-provider', debugMode: false, systemPrompt: '', reasoningEffort: '', sessionId: 'session-1' },
      conversationManager: {
        getMessagesForLLM: () => [{ role: 'user', content: 'a'.repeat(2_000) }],
        replaceMessagesForLLM: () => {},
        compact: async () => {},
      },
      sessionMemoryStore: { list: () => [] },
      sessionLineageTracker: { getEntries: () => [], getCompactionCount: () => 0, getOriginalTask: () => null },
      wrfcController: { listChains: () => [] },
    },
    provider: {
      providerRegistry: {
        getCurrentModel: () => ({ id: 'test-model' }),
        // 200,000-token context window — the handler must read this live
        // value instead of hardcoding 0.
        getContextWindowForModel: () => 200_000,
      },
    },
    ops: {
      agentManager: { exportState: () => [] },
      planManager: { getActive: () => null },
    },
    renderRequest: () => {},
    print: (text: string) => { printed.push(text); },
    exit: () => {},
  } as unknown as CommandContext;
}

describe('/compact handler — capacity-% plumbing', () => {
  test('the pre-compact preview includes the context-window capacity clause, not the old hardcoded-0 omission', async () => {
    const registry = new CommandRegistry();
    registerShellCoreCommands(registry);
    const printed: string[] = [];
    const context = makeContext(printed);

    await registry.execute('compact', [], context);

    expect(printed.length).toBeGreaterThan(0);
    const preview = printed[0]!;
    expect(preview).toContain('% of');
    expect(preview).toContain('context window');
    expect(preview).toContain('200,000');
  });

  test('when compaction produces no new event, the handler still completes with an honest fallback message', async () => {
    const registry = new CommandRegistry();
    registerShellCoreCommands(registry);
    const printed: string[] = [];
    const context = makeContext(printed);

    await registry.execute('compact', [], context);

    // The mocked conversationManager.compact() never touches the SDK's real
    // compaction-event log, so compactConversation() correctly reports "no
    // new event" and the handler falls back to the plain complete message.
    expect(printed.some((line) => line.includes('[Context] Compact complete.'))).toBe(true);
  });
});
