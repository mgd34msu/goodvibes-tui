import { describe, expect, test } from 'bun:test';
import { frameFromLayer } from '../helpers/surface-frame.ts';
import type { ModelDefinition } from '@pellux/goodvibes-sdk/platform/providers';
import { ModelPickerModal } from '../../input/model-picker.ts';
import { renderModelWorkspace } from '../../renderer/model-workspace.ts';
import { lineToString, linesToText } from '../setup.ts';
import { activeTokens } from '../../renderer/theme.ts';

const W = 132;
const H = 34;

function makeModel(overrides: Partial<ModelDefinition> = {}): ModelDefinition {
  const base: ModelDefinition = {
    id: 'gpt-test',
    provider: 'openai',
    registryKey: 'openai:gpt-test',
    displayName: 'GPT Test',
    description: '',
    capabilities: { toolCalling: true, codeEditing: true, reasoning: true, multimodal: false },
    contextWindow: 128_000,
    selectable: true,
    tier: 'premium',
    ...overrides,
  };
  if (!base.registryKey) base.registryKey = `${base.provider}:${base.id}`;
  return base;
}

function makePicker(): ModelPickerModal {
  const picker = new ModelPickerModal(
    { getRecentModels: async () => [] },
    { getBenchmarks: () => undefined },
    { getSyntheticModelInfoFromCatalog: () => null, getSyntheticCanonicalModels: () => [] },
  );
  picker.active = true;
  picker.models = [
    makeModel(),
    makeModel({
      id: 'claude-test',
      provider: 'anthropic',
      registryKey: 'anthropic:claude-test',
      displayName: 'Claude Test',
      tier: 'subscription',
      contextWindow: 200_000,
    }),
  ];
  picker.providers = ['openai', 'anthropic'];
  picker.configuredProviders = new Set(['openai', 'anthropic']);
  picker.configuredViaMap = new Map([['openai', 'env'], ['anthropic', 'subscription']]);
  picker.setTargetInfos([
    {
      target: 'main',
      label: 'Main Chat',
      description: 'Default provider and model for normal chat turns.',
      provider: 'openai',
      model: 'openai:gpt-test',
      enabled: true,
      inherited: false,
    },
    {
      target: 'helper',
      label: 'Helper Model',
      description: 'Helper route.',
      provider: 'anthropic',
      model: 'anthropic:claude-test',
      enabled: true,
      inherited: false,
    },
    {
      target: 'tool',
      label: 'Tool LLM',
      description: 'Tool route.',
      provider: 'openai',
      model: 'openai:gpt-test',
      enabled: false,
      inherited: true,
    },
    {
      target: 'tts',
      label: 'TTS LLM',
      description: 'Spoken response route.',
      provider: 'openai',
      model: 'openai:gpt-test',
      enabled: true,
      inherited: true,
    },
  ]);
  picker.openAllModels(picker.models, 'openai:gpt-test');
  return picker;
}

describe('renderModelWorkspace', () => {
  test('fills the full viewport with stable-width lines', () => {
    const lines = frameFromLayer(renderModelWorkspace(makePicker(), W, H), W, H);

    expect(lines).toHaveLength(H);
    for (const line of lines) expect(line).toHaveLength(W);
  });

  test('renders the five targets as tabs, the model list and the selected model in the detail inset', () => {
    const text = linesToText(frameFromLayer(renderModelWorkspace(makePicker(), W, H), W, H)).join('\n');

    expect(text).toContain('✦ Models');
    expect(text).toContain('Main Chat');
    expect(text).toContain('Helper');
    expect(text).toContain('Tool LLM');
    expect(text).toContain('▏Search models');
    expect(text).toContain('GPT Test');
    expect(text).toContain('Claude Test');
    // Detail inset: the selected model's key and facts.
    expect(text).toContain('openai:gpt-test');
    expect(text).toContain('configured');
    expect(text).toContain(' ⏎  use for Main Chat');
  });

  test('provider mode renders providers with their configuration state', () => {
    const picker = makePicker();
    picker.openProviders(['openai', 'anthropic'], 'openai');

    const text = linesToText(frameFromLayer(renderModelWorkspace(picker, W, H), W, H)).join('\n');

    expect(text).toContain('✦ Models › Providers');
    expect(text).toContain('openai');
    expect(text).toContain('env');
    expect(text).toMatch(/\d+ models/);
  });

  test('embeddingProvider mode renders the provider list honestly, including unconfigured entries', () => {
    const picker = makePicker();
    picker.embeddingProviders = [
      { id: 'hashed-local', label: 'Hashed Local Embeddings', dimensions: 384, configured: true },
      { id: 'openai', label: 'OpenAI Embeddings', dimensions: 1536, configured: false, detail: 'Set OPENAI_API_KEY to enable.' },
    ];
    picker.mode = 'embeddingProvider';
    picker.selectedIndex = 0;

    const text = linesToText(frameFromLayer(renderModelWorkspace(picker, W, H), W, H)).join('\n');

    expect(text).toContain('Embedding provider');
    expect(text).toContain('Hashed Local Embeddings');
    expect(text).toContain('OpenAI Embeddings');
    expect(text).toContain('configured');
    expect(text).toContain('unconfigured');
    expect(text).toContain('Set');
    expect(text).toContain('OPENAI_API_KEY to enable.');
  });

  test('the embeddings target shows provider id + dimensions + configured state, never a model route', () => {
    const picker = makePicker();
    picker.setTargetInfos([
      ...picker.targetInfos,
      {
        target: 'embeddings',
        label: 'Embeddings',
        description: 'Embedding provider used for memory search and the code index.',
        provider: 'hashed-local',
        model: '',
        enabled: true,
        inherited: false,
        configuredNote: 'hashed-local · 384d',
      },
    ]);
    picker.setTarget('embeddings');

    const text = linesToText(frameFromLayer(renderModelWorkspace(picker, W, H), W, H)).join('\n');

    expect(text).toContain('Embeddings');
    expect(text).toContain('hashed-local · 384d');
  });

  test('the active target is the tab drawn with the gradient', () => {
    const picker = makePicker();
    picker.setTarget('helper');

    const lines = frameFromLayer(renderModelWorkspace(picker, W, H), W, H);
    const tabRow = lines.find((line) => lineToString(line).includes('Main Chat'))!;
    const text = lineToString(tabRow);
    expect(tabRow[text.indexOf('Helper')]!.bold).toBe(true);
    expect(tabRow[text.indexOf('Helper')]!.fg).toBe(activeTokens().selectedListItemText);
    expect(tabRow[text.indexOf('Main Chat')]!.bold).toBe(false);
  });

  test('uses a render cache when the picker state has not changed', () => {
    const picker = makePicker();

    const first = renderModelWorkspace(picker, W, H);
    const second = renderModelWorkspace(picker, W, H);

    expect(second).toBe(first);
  });

  // Owner design rule: descriptive text is shown in full, wrap or scroll,
  // never clipped. The selected model's key and facts must survive at 80x24,
  // and at 60 columns (no room for the detail inset) the selected row itself
  // names the full key.
  describe('the selected model is never silently dropped, at 80x24 and 60-col narrow heights', () => {
    test('normal (80x24): the detail inset carries the key, provider and status', () => {
      const picker = makePicker();
      const selected = picker.getSelected()!;
      const text = linesToText(frameFromLayer(renderModelWorkspace(picker, 80, 24), 80, 24)).join('\n');
      expect(text).toContain(selected.registryKey);
      expect(text).toContain(selected.displayName);
      expect(text).toMatch(/Status +configured/);
    });

    test('narrow (60x24): the selected row names the full key', () => {
      const picker = makePicker();
      const selected = picker.getSelected()!;
      const text = linesToText(frameFromLayer(renderModelWorkspace(picker, 60, 24), 60, 24)).join('\n');
      expect(text).toContain(selected.displayName);
      expect(text).toContain(selected.registryKey);
    });
  });

  describe('hints and filters', () => {
    test('the filter chords are advertised (they work while typing, so no letter is stolen from search)', () => {
      const text = linesToText(frameFromLayer(renderModelWorkspace(makePicker(), 200, H), 200, H)).join('\n');
      expect(text).toContain(' tab  next target');
      expect(text).toContain(' ctrl+f  pin');
      expect(text.replace(/\s+/g, ' ')).toContain('ctrl+t price · ctrl+k capability · ctrl+a available · ctrl+b benchmark sort · ctrl+g group');
      // Without room for the detail inset, they move into the hint row.
      const narrow = linesToText(frameFromLayer(renderModelWorkspace(makePicker(), 60, 30), 60, 30)).join('\n');
      expect(narrow).toContain(' ctrl+t  price');
    });

    test('active filters are named on the search row', () => {
      const picker = makePicker();
      picker.setCategoryFilter('free');
      const text = linesToText(frameFromLayer(renderModelWorkspace(picker, W, H), W, H)).join('\n');
      expect(text).toContain('free only');
    });
  });
});
