import { describe, expect, test } from 'bun:test';
import { CommandRegistry, type CommandContext } from '../../input/command-registry.ts';
import { registerTtsRuntimeCommands } from '../../input/commands/tts-runtime.ts';

function makeContext(out: string[] = []): CommandContext {
  const setValues: Record<string, unknown> = {};
  return {
    session: {
      conversationManager: {} as never,
      runtime: { model: 'gpt-5.4', provider: 'openai', debugMode: false, systemPrompt: '', reasoningEffort: 'medium', sessionId: 'sess' },
    },
    provider: { providerRegistry: {} as never },
    workspace: {},
    platform: {
      config: {} as never,
      configManager: {
        get(key: string) {
          if (key === 'tts.provider') return 'elevenlabs';
          if (key === 'tts.voice') return '';
          if (key === 'tts.llmProvider') return '';
          if (key === 'tts.llmModel') return '';
          return setValues[key];
        },
        setDynamic(key: string, value: unknown) {
          setValues[key] = value;
        },
      } as never,
      voiceProviderRegistry: {
        list: () => [
          { id: 'elevenlabs', label: 'ElevenLabs', capabilities: ['tts', 'tts-stream'] },
          { id: 'legacy', label: 'Legacy', capabilities: ['tts'] },
        ],
      } as never,
      voiceService: {
        listVoices: async () => [
          { id: 'voice-1', label: 'Voice One', metadata: {} },
        ],
      } as never,
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

    expect(out).toEqual(['spoken:say hello', 'stopped', 'Live TTS playback stopped.']);
  });

  test('/config-tts writes SDK TTS config keys', async () => {
    const registry = new CommandRegistry();
    registerTtsRuntimeCommands(registry);
    const out: string[] = [];
    const ctx = makeContext(out);

    await registry.execute('config-tts', ['provider', 'elevenlabs'], ctx);
    await registry.execute('config-tts', ['voice', 'clear'], ctx);

    expect(out).toContain('tts.provider set to elevenlabs.');
    expect(out).toContain('tts.voice cleared.');
  });

  test('/config-tts lists only streaming TTS providers and available voices', async () => {
    const registry = new CommandRegistry();
    registerTtsRuntimeCommands(registry);
    const out: string[] = [];
    const ctx = makeContext(out);

    await registry.execute('config-tts', ['providers'], ctx);
    await registry.execute('config-tts', ['voices'], ctx);

    const text = out.join('\n');
    expect(text).toContain('elevenlabs: ElevenLabs');
    expect(text).not.toContain('legacy: Legacy');
    expect(text).toContain('voice-1: Voice One');
  });
});
