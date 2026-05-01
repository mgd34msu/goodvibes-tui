import { describe, expect, test } from 'bun:test';
import { CommandRegistry, type CommandContext } from '../../input/command-registry.ts';
import { registerTtsRuntimeCommands } from '../../input/commands/tts-runtime.ts';

function makeContext(out: string[] = []): CommandContext {
  return {
    session: {
      conversationManager: {} as never,
      runtime: { model: 'gpt-5.4', provider: 'openai', debugMode: false, systemPrompt: '', reasoningEffort: 'medium', sessionId: 'sess' },
    },
    provider: {
      providerRegistry: {} as never,
    },
    workspace: {},
    platform: {
      config: {} as never,
      configManager: {} as never,
    },
    ops: {},
    extensions: { toolRegistry: {} as never, mcpRegistry: {} as never },
    renderRequest: () => {},
    print: (text) => out.push(text),
    exit: () => {},
    submitSpokenInput: (text) => out.push(`spoken:${text}`),
    stopSpokenOutput: () => out.push('stopped'),
  };
}

describe('TTS runtime commands', () => {
  test('/tts submits spoken prompt and stop cancels playback', async () => {
    const registry = new CommandRegistry();
    registerTtsRuntimeCommands(registry);
    const out: string[] = [];
    const ctx = makeContext(out);

    await registry.execute('tts', ['say', 'hello'], ctx);
    await registry.execute('tts', ['stop'], ctx);

    expect(registry.get('config-tts')).toBeUndefined();
    expect(registry.get('tts-config')).toBeUndefined();
    expect(out).toEqual(['spoken:say hello', 'stopped', 'Live TTS playback stopped.']);
  });
});
