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

  test('embeddingProvider mode renders the provider list honestly, including unconfigured entries', () => {
    const picker = makePicker();
    picker.embeddingProviders = [
      { id: 'hashed-local', label: 'Hashed Local Embeddings', dimensions: 384, configured: true },
      { id: 'openai', label: 'OpenAI Embeddings', dimensions: 1536, configured: false, detail: 'Set OPENAI_API_KEY to enable.' },
    ];
    picker.mode = 'embeddingProvider';
    picker.selectedIndex = 0;

    const text = linesToText(renderModelWorkspace(picker, W, H)).join('\n');

    expect(text).toContain('Embedding providers');
    expect(text).toContain('Embedding provider');
    expect(text).toContain('Hashed Local Embeddings');
    expect(text).toContain('OpenAI Embeddings');
    expect(text).toContain('configured');
    expect(text).toContain('unconfigured');
    // No phantom "model:" concept for this mode.
    expect(text).not.toContain('Model key');
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

    const text = linesToText(renderModelWorkspace(picker, W, H)).join('\n');

    expect(text).toContain('Embeddings');
    expect(text).toContain('hashed-local · 384d');
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

  // Owner design test (v1.16.1 modal rule, extended here): UI-authored
  // descriptive text is always shown in full, wrap or scroll, never clip.
  // detailLines(...) used to be sliced to a fixed 32%-of-body-rows proportion
  // via .slice(0, detailRows), silently dropping whatever detail content
  // didn't fit that guess (typically the trailing filter line). The fix sizes
  // the detail band to the actual content instead. Full strings, not
  // prefixes, a facade assertion that only checks a short substring would
  // stay green even if the rest were clipped.
  describe('detail lines are never silently dropped, at 80x24 and 60-col narrow heights', () => {
    /** The workspace is two columns (targets | detail) sharing one row per
     * line, flattening whole rows would interleave target-column text
     * between wrapped detail sentences. Extract just the detail column
     * (right of the shared vertical divider, itself found from the header
     * row) and join it back into one string. */
    function extractDetailColumnText(lines: ReturnType<typeof renderModelWorkspace>): string {
      const header = lines[1]!;
      let dividerX = -1;
      for (let x = 1; x < header.length - 1; x += 1) {
        if (header[x]!.char === '│') { dividerX = x; break; }
      }
      expect(dividerX).toBeGreaterThan(0);
      const parts: string[] = [];
      for (const line of lines) {
        if (line.length <= dividerX + 1) continue;
        parts.push(line.slice(dividerX + 1, line.length - 1).map((cell) => cell.char).join(''));
      }
      return parts.join(' ').replace(/\s+/g, ' ').trim();
    }

    for (const [label, width, height] of [
      ['normal', 80, 24],
      ['narrow', 60, 24],
    ] as const) {
      test(`${label} (${width}x${height}): the full model detail and the full filter line both survive`, () => {
        const picker = makePicker();
        const selected = picker.getSelected();
        expect(selected).toBeDefined();

        const detailText = extractDetailColumnText(renderModelWorkspace(picker, width, height));

        // The model-selection instruction line and the full "Selected: ..."
        // summary line (key | display name | context | capabilities),
        // previously the first casualty of the 32%-of-body-rows slice.
        expect(detailText).toContain('Model selection: choose the model to store for Main Chat. Use filters to narrow large catalogs.');
        expect(detailText).toContain(`Selected: ${selected!.registryKey} | ${selected!.displayName} | context`);
        // The trailing filter line, previously dropped entirely at narrow
        // heights because it was always last in the wrapped-lines array.
        expect(detailText).toContain('Price:');
        expect(detailText).toContain('Capability:');
        expect(detailText).toContain('Group:');
        expect(detailText).toContain('Available only:');
      });
    }
  });

  describe('footer hints are state-aware (only advertise shortcuts that currently work)', () => {
    test('search blurred: advertises the C/A/B/G single-key shortcuts (they work in this state)', () => {
      const picker = makePicker();
      picker.blurSearch();
      expect(picker.searchFocused).toBe(false);

      // Wider than the default W: the footer hint string is long enough to
      // get width-truncated at W=132 (a pre-existing, unrelated constraint),
      // so use a width that comfortably fits the full hint line.
      const text = linesToText(renderModelWorkspace(picker, 200, H)).join('\n');

      expect(text).toContain('C caps');
      expect(text).toContain('A available');
      expect(text).toContain('B benchmark');
      expect(text).toContain('G group');
      expect(text).toContain('Tab price');
    });

    test('search focused (the default on open): does not advertise C/A/B/G (they type into the query instead), but keeps Tab', () => {
      const picker = makePicker();
      expect(picker.searchFocused).toBe(true);

      // Wider than the default W: the footer hint string is long enough to
      // get width-truncated at W=132 (a pre-existing, unrelated constraint),
      // so use a width that comfortably fits the full hint line.
      const text = linesToText(renderModelWorkspace(picker, 200, H)).join('\n');

      expect(text).not.toContain('C caps');
      expect(text).not.toContain('A available');
      expect(text).not.toContain('B benchmark');
      expect(text).not.toContain('G group');
      expect(text).toContain('Tab price');
      expect(text).toContain('Typing filters search');
    });
  });
});
