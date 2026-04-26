import { describe, expect, test } from 'bun:test';
import { CommandRegistry, type CommandContext } from '../../input/command-registry.ts';
import { registerTtsRuntimeCommands } from '../../input/commands/tts-runtime.ts';
import type { SelectionItem, SelectionResult } from '../../input/selection-modal.ts';

type OpenedSelection = {
  title: string;
  items: SelectionItem[];
  callback: (result: SelectionResult | null) => void;
};

function makeContext(options: {
  out?: string[];
  openedSelections?: OpenedSelection[];
  modelTargets?: string[];
  initialConfig?: Record<string, unknown>;
} = {}): { ctx: CommandContext; values: Record<string, unknown> } {
  const out = options.out ?? [];
  const openedSelections = options.openedSelections ?? [];
  const modelTargets = options.modelTargets ?? [];
  const values: Record<string, unknown> = {
    'tts.provider': 'elevenlabs',
    'tts.voice': '',
    'tts.llmProvider': '',
    'tts.llmModel': '',
    ...options.initialConfig,
  };
  const ctx: CommandContext = {
    session: {
      conversationManager: {} as never,
      runtime: { model: 'gpt-5.4', provider: 'openai', debugMode: false, systemPrompt: '', reasoningEffort: 'medium', sessionId: 'sess' },
    },
    provider: {
      providerRegistry: {
        getSelectableModels: () => [
          { id: 'gpt-5.4', registryKey: 'openai:gpt-5.4', displayName: 'GPT 5.4', provider: 'openai', contextWindow: 1000000 },
          { id: 'claude-sonnet', registryKey: 'anthropic:claude-sonnet', displayName: 'Claude Sonnet', provider: 'anthropic', contextWindow: 200000 },
        ],
      } as never,
    },
    workspace: {},
    platform: {
      config: {} as never,
      configManager: {
        get(key: string) {
          return values[key];
        },
        setDynamic(key: string, value: unknown) {
          values[key] = value;
        },
      } as never,
      voiceProviderRegistry: {
        list: () => [
          { id: 'elevenlabs', label: 'ElevenLabs', capabilities: ['tts', 'tts-stream'] },
          { id: 'openai', label: 'OpenAI', capabilities: ['tts', 'tts-stream'] },
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
    openSelection: (title, items, _opts, callback) => {
      openedSelections.push({ title, items, callback });
    },
    openModelPickerWithTarget: (target) => {
      modelTargets.push(target);
      return true;
    },
  };
  return { ctx, values };
}

describe('TTS runtime commands', () => {
  test('/tts submits spoken prompt and stop cancels playback', async () => {
    const registry = new CommandRegistry();
    registerTtsRuntimeCommands(registry);
    const out: string[] = [];
    const { ctx } = makeContext({ out });

    await registry.execute('tts', ['say', 'hello'], ctx);
    await registry.execute('tts', ['stop'], ctx);

    expect(out).toEqual(['spoken:say hello', 'stopped', 'Live TTS playback stopped.']);
  });

  test('/config-tts writes SDK TTS config keys', async () => {
    const registry = new CommandRegistry();
    registerTtsRuntimeCommands(registry);
    const out: string[] = [];
    const { ctx, values } = makeContext({ out });

    await registry.execute('config-tts', ['provider', 'elevenlabs'], ctx);
    await registry.execute('config-tts', ['voice', 'clear'], ctx);
    await registry.execute('config-tts', ['llm-provider', 'openai'], ctx);
    await registry.execute('config-tts', ['llm-model', 'openai:gpt-5.4'], ctx);

    expect(out).toContain('tts.provider set to elevenlabs.');
    expect(out).toContain('tts.voice cleared.');
    expect(values['tts.llmProvider']).toBe('openai');
    expect(values['tts.llmModel']).toBe('openai:gpt-5.4');
  });

  test('/config-tts lists only streaming TTS providers and available voices', async () => {
    const registry = new CommandRegistry();
    registerTtsRuntimeCommands(registry);
    const out: string[] = [];
    const { ctx } = makeContext({ out });

    ctx.openSelection = undefined;
    await registry.execute('config-tts', ['providers'], ctx);
    await registry.execute('config-tts', ['voices'], ctx);

    const text = out.join('\n');
    expect(text).toContain('elevenlabs: ElevenLabs');
    expect(text).toContain('openai: OpenAI');
    expect(text).not.toContain('legacy: Legacy');
    expect(text).toContain('voice-1: Voice One');
    expect(text).toContain('Set provider: /config-tts provider <provider-id>');
    expect(text).toContain('Set voice: /config-tts voice <voice-id>');
  });

  test('/config-tts opens a modal with provider, voice, and TTS LLM actions', async () => {
    const registry = new CommandRegistry();
    registerTtsRuntimeCommands(registry);
    const openedSelections: OpenedSelection[] = [];
    const modelTargets: string[] = [];
    const { ctx } = makeContext({ openedSelections, modelTargets });

    await registry.execute('config-tts', [], ctx);

    expect(openedSelections).toHaveLength(1);
    expect(openedSelections[0].title).toBe('TTS Configuration');
    expect(openedSelections[0].items.map((item) => item.id)).toEqual([
      'provider',
      'voice',
      'llm-provider',
      'llm-model',
      'clear-voice',
      'clear-llm',
    ]);

    const providerItem = openedSelections[0].items.find((item) => item.id === 'llm-provider');
    expect(providerItem).toBeDefined();
    openedSelections[0].callback({ item: providerItem!, action: 'select' });
    expect(openedSelections[1].title).toBe('Choose TTS LLM Provider');
    expect(modelTargets).toEqual([]);
  });

  test('/config-tts provider picker sets provider and clears stale voice', async () => {
    const registry = new CommandRegistry();
    registerTtsRuntimeCommands(registry);
    const out: string[] = [];
    const openedSelections: OpenedSelection[] = [];
    const { ctx, values } = makeContext({
      out,
      openedSelections,
      initialConfig: { 'tts.provider': 'elevenlabs', 'tts.voice': 'voice-1' },
    });

    await registry.execute('config-tts', ['providers'], ctx);

    expect(openedSelections).toHaveLength(1);
    expect(openedSelections[0].title).toBe('Choose TTS Provider');
    const provider = openedSelections[0].items.find((item) => item.id === 'openai');
    expect(provider).toBeDefined();
    openedSelections[0].callback({ item: provider!, action: 'select' });

    expect(values['tts.provider']).toBe('openai');
    expect(values['tts.voice']).toBe('');
    expect(out).toContain('TTS provider set to openai. TTS voice was cleared because voices are provider-specific.');
  });

  test('/config-tts voice picker sets a selected voice', async () => {
    const registry = new CommandRegistry();
    registerTtsRuntimeCommands(registry);
    const out: string[] = [];
    const openedSelections: OpenedSelection[] = [];
    const { ctx, values } = makeContext({ out, openedSelections });

    await registry.execute('config-tts', ['voices'], ctx);

    expect(openedSelections).toHaveLength(1);
    expect(openedSelections[0].title).toBe('Choose TTS Voice (elevenlabs)');
    const voice = openedSelections[0].items.find((item) => item.id === 'voice-1');
    expect(voice).toBeDefined();
    openedSelections[0].callback({ item: voice!, action: 'select' });

    expect(values['tts.voice']).toBe('voice-1');
    expect(out).toContain('TTS voice set to voice-1.');
  });

  test('/config-tts llm chooses provider then provider-scoped model and clear resets overrides', async () => {
    const registry = new CommandRegistry();
    registerTtsRuntimeCommands(registry);
    const out: string[] = [];
    const openedSelections: OpenedSelection[] = [];
    const { ctx, values } = makeContext({
      out,
      openedSelections,
      initialConfig: { 'tts.llmProvider': 'openai', 'tts.llmModel': 'openai:gpt-5.4' },
    });

    await registry.execute('config-tts', ['llm'], ctx);
    expect(openedSelections[0].title).toBe('Choose TTS LLM Provider');
    const anthropic = openedSelections[0].items.find((item) => item.id === 'anthropic');
    expect(anthropic).toBeDefined();
    openedSelections[0].callback({ item: anthropic!, action: 'select' });
    expect(openedSelections[1].title).toBe('Choose TTS LLM Model (anthropic)');
    const sonnet = openedSelections[1].items.find((item) => item.id === 'anthropic:claude-sonnet');
    expect(sonnet).toBeDefined();
    openedSelections[1].callback({ item: sonnet!, action: 'select' });
    await registry.execute('config-tts', ['llm', 'clear'], ctx);

    expect(values['tts.llmProvider']).toBe('');
    expect(values['tts.llmModel']).toBe('');
    expect(out).toContain('TTS LLM set to Claude Sonnet (anthropic).');
    expect(out).toContain('TTS LLM override cleared. /tts will use the current chat model.');
  });
});
