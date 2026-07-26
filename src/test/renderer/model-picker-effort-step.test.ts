// ---------------------------------------------------------------------------
// model-picker-effort-step.test.ts — the picker's effort step shows the
// SELECTED model's real reasoning options.
//
// It used to render `model.reasoningEffort` as a bare list of level names, and
// that list was the same hardcoded four for every model. Now the step is built
// from the model's resolved ReasoningEffortSpec, so what appears differs by
// spec kind: named levels, a thinking-token budget per level, an on/off
// toggle, or a statement that nothing is configurable.
// ---------------------------------------------------------------------------

import { describe, expect, test } from 'bun:test';
import type { ModelDefinition, ReasoningEffortSpec } from '@pellux/goodvibes-sdk/platform/providers';
import { ModelPickerModal } from '../../input/model-picker.ts';
import { renderModelWorkspace } from '../../renderer/model-workspace.ts';
import { linesToText } from '../setup.ts';

const W = 132;
const H = 34;

/** No curated family row matches this id, so the attached spec is what governs. */
const UNKNOWN_ID = 'test-only-model-with-no-family-row';

function makeModel(spec: ReasoningEffortSpec | undefined): ModelDefinition {
  return {
    id: UNKNOWN_ID,
    provider: 'openai',
    registryKey: `openai:${UNKNOWN_ID}`,
    displayName: 'Test Model',
    description: '',
    capabilities: { toolCalling: true, codeEditing: true, reasoning: true, multimodal: false },
    contextWindow: 128_000,
    selectable: true,
    tier: 'premium',
    ...(spec ? { reasoningEffort: spec } : {}),
  };
}

function renderEffortStep(spec: ReasoningEffortSpec | undefined, current = 'medium'): string {
  const picker = new ModelPickerModal(
    { getRecentModels: async () => [] },
    { getBenchmarks: () => undefined },
    { getSyntheticModelInfoFromCatalog: () => null, getSyntheticCanonicalModels: () => [] },
  );
  picker.active = true;
  const model = makeModel(spec);
  picker.models = [model];
  picker.showEffortPicker(model, current);
  return linesToText(renderModelWorkspace(picker, W, H)).join('\n');
}

describe('the effort step renders the selected model’s own options', () => {
  test('named levels: exactly the model’s levels, each with a description', () => {
    const text = renderEffortStep({
      kind: 'effort',
      values: ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
      source: 'catalog',
    });
    expect(text).toContain('accepts these reasoning levels');
    for (const level of ['none', 'low', 'medium', 'high', 'xhigh', 'max']) {
      expect(text).toContain(level);
    }
    expect(text).toContain('Deepest this model allows');
    // 'instant' was in the old hardcoded list; this model does not offer it.
    expect(text).not.toContain('instant');
  });

  test('token budget: each level names the budget it sends', () => {
    const text = renderEffortStep({
      kind: 'budget_tokens',
      values: ['none', 'low', 'medium', 'high'],
      source: 'catalog',
      minBudgetTokens: 1024,
      maxBudgetTokens: 32768,
      canDisableReasoning: true,
    });
    expect(text).toContain('thinking-token budget');
    expect(text).toContain('8,192 thinking tokens');
  });

  test('toggle: says on-or-off rather than implying a depth choice', () => {
    const text = renderEffortStep({
      kind: 'toggle',
      values: ['none', 'high'],
      source: 'catalog',
    });
    expect(text).toContain('on or off');
  });

  test('nothing configurable: the step states that instead of listing levels', () => {
    const text = renderEffortStep({ kind: 'unavailable', values: [], source: 'catalog' });
    expect(text).toContain('no configurable reasoning level');
    expect(text).toContain('Esc returns to the model list');
  });

  test('an unrecognised model is labelled a best guess', () => {
    const text = renderEffortStep(undefined);
    expect(text).toContain('Best guess');
  });
});

describe('picker state matches what is rendered', () => {
  test('effortLevels come from the resolved spec, not the raw definition', () => {
    const picker = new ModelPickerModal(
      { getRecentModels: async () => [] },
      { getBenchmarks: () => undefined },
      { getSyntheticModelInfoFromCatalog: () => null, getSyntheticCanonicalModels: () => [] },
    );
    const model = makeModel({ kind: 'effort', values: ['low', 'high', 'max'], source: 'catalog' });
    picker.showEffortPicker(model, 'high');
    expect(picker.effortLevels).toEqual(['low', 'high', 'max']);
    expect(picker.effortPresentation?.spec.kind).toBe('effort');
    // Pre-selection lands on the current level, which is a real index here.
    expect(picker.effortLevels[picker.selectedIndex]).toBe('high');
  });

  test('closing the picker clears the presentation', () => {
    const picker = new ModelPickerModal(
      { getRecentModels: async () => [] },
      { getBenchmarks: () => undefined },
      { getSyntheticModelInfoFromCatalog: () => null, getSyntheticCanonicalModels: () => [] },
    );
    picker.showEffortPicker(makeModel({ kind: 'toggle', values: ['none', 'high'], source: 'catalog' }), 'high');
    expect(picker.effortPresentation).not.toBeNull();
    picker.close();
    expect(picker.effortPresentation).toBeNull();
  });
});
