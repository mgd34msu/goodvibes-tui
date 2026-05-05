import { describe, expect, test } from 'bun:test';
import type { ModelDefinition } from '@pellux/goodvibes-sdk/platform/providers';
import { ModelPickerModal } from '../../input/model-picker.ts';
import { renderModelWorkspace } from '../../renderer/model-workspace.ts';
import { linesToText } from '../setup.ts';

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
    { getSyntheticModelInfoFromCatalog: () => null },
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
    const lines = renderModelWorkspace(makePicker(), W, H);

    expect(lines).toHaveLength(H);
    for (const line of lines) expect(line).toHaveLength(W);
  });

  test('renders targets, selected target details, and model table', () => {
    const text = linesToText(renderModelWorkspace(makePicker(), W, H)).join('\n');

    expect(text).toContain('Model Workspace / Providers And Models');
    expect(text).toContain('Targets');
    expect(text).toContain('Main Chat');
    expect(text).toContain('Helper Model');
    expect(text).toContain('Target: Main Chat');
    expect(text).toContain('Model key');
    expect(text).toContain('openai:gpt-test');
    expect(text).toContain('Claude Test');
  });

  test('provider mode renders provider table and configuration state', () => {
    const picker = makePicker();
    picker.openProviders(['openai', 'anthropic'], 'openai');

    const text = linesToText(renderModelWorkspace(picker, W, H)).join('\n');

    expect(text).toContain('Provider list');
    expect(text).toContain('Provider');
    expect(text).toContain('Configuration');
    expect(text).toContain('openai');
    expect(text).toContain('env');
  });

  test('target pane focus changes only the target marker', () => {
    const picker = makePicker();
    picker.focusTargets();

    const text = linesToText(renderModelWorkspace(picker, W, H)).join('\n');

    expect(text).toContain('Focus targets');
    expect(text).toContain('Main Chat');
  });

  test('uses a render cache when the picker state has not changed', () => {
    const picker = makePicker();

    const first = renderModelWorkspace(picker, W, H);
    const second = renderModelWorkspace(picker, W, H);

    expect(second).toBe(first);
  });
});
