import { describe, expect, test } from 'bun:test';
import { CommandRegistry } from '../../input/command-registry.ts';
import { registerBuiltinCommands } from '../../input/commands.ts';
import { ConversationManager } from '../../core/conversation.ts';
import { createRuntimeStore } from '../../runtime/store/index.ts';

describe('conversation runtime command', () => {
  function makeContext(out: string[]) {
    const conversationManager = new ConversationManager(() => 100);
    conversationManager.addUserMessage('review the diff');
    conversationManager.addAssistantMessage('Running checks.', {
      toolCalls: [{ id: 'call-1', name: 'exec', arguments: { command: 'git diff --stat' } }],
      model: 'gpt-5.4',
      provider: 'openai',
    });
    conversationManager.addToolResults([{ callId: 'call-1', success: true, output: '1 file changed' }]);
    conversationManager.addSystemMessage('[Approval] Waiting for operator input');

    const runtimeStore = createRuntimeStore();
    runtimeStore.setState((state) => ({
      ...state,
      conversation: {
        ...state.conversation,
        turnState: 'preflight',
        messageCount: 4,
        estimatedContextTokens: 321,
        contextWarningActive: true,
      },
    }));

    return {
      providerRegistry: { getCurrentModel: () => ({ id: 'gpt-5.4' }) } as never,
      conversationManager,
      config: {} as never,
      configManager: { get: () => undefined } as never,
      runtime: { model: 'gpt-5.4', provider: 'openai', debugMode: false, systemPrompt: '', reasoningEffort: '', sessionId: 'sess-1' },
      renderRequest: () => {},
      print: (text: string) => { out.push(text); },
      exit: () => {},
      toolRegistry: {} as never,
      mcpRegistry: {} as never,
      runtimeStore,
    };
  }

  test('surfaces transcript structure and composer posture', async () => {
    const registry = new CommandRegistry();
    registerBuiltinCommands(registry);
    const command = registry.get('conversation');
    expect(command).toBeDefined();

    const out: string[] = [];
    const ctx = makeContext(out) as never;

    await command!.handler(['review'], ctx);
    expect(out.join('\n')).toContain('Conversation Review');
    expect(out.join('\n')).toContain('events:');
    expect(out.join('\n')).toContain('tool_call=1');

    out.length = 0;
    await command!.handler(['hotspots'], ctx);
    expect(out.join('\n')).toContain('Conversation Hotspots');
    expect(out.join('\n')).toContain('tool_call');

    out.length = 0;
    await command!.handler(['composer'], ctx);
    expect(out.join('\n')).toContain('Composer Review');
    expect(out.join('\n')).toContain('status: preflight');
    expect(out.join('\n')).toContain('context warning: yes');

    out.length = 0;
    await command!.handler(['find', 'approval', 'approval_request'], ctx);
    expect(out.join('\n')).toContain('Conversation Search: approval_request');

    out.length = 0;
    await command!.handler(['restore'], ctx);
    expect(out.join('\n')).toContain('Conversation Restore Review');
  });
});
