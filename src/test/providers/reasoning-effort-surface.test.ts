// ---------------------------------------------------------------------------
// reasoning-effort-surface.test.ts — the TUI's per-model reasoning-effort
// presentation.
//
// The defect these pin: every effort surface carried the same hardcoded four
// levels (instant, low, medium, high). That offered 'instant' to models that
// reject it, hid 'none', 'minimal', 'xhigh' and 'max' from models that accept
// them, and printed a fixed four-provider wire explainer ("Mercury-2 … Claude
// … Gemini … GPT-5") regardless of which model was actually serving.
//
// Each spec kind gets its own honest presentation, a level a model does not
// offer snaps DOWN with the SDK's own sentence, and a best-guess spec is
// labelled as one rather than presented as verified provider data.
// ---------------------------------------------------------------------------

import { describe, expect, test } from 'bun:test';
import type { ReasoningEffortSpec } from '@pellux/goodvibes-sdk/platform/providers';
import {
  describeConfiguredEffort,
  describeEffortForModel,
  effortLevelsForModel,
  effortPresentationForModel,
  offersConfigurableEffort,
  remapEffortForServingModel,
  type EffortModelLike,
} from '../../providers/reasoning-effort-surface.ts';

/**
 * Model ids that must not match a curated family row, so the spec attached
 * here is the one under test rather than one the SDK's family table supplies.
 * (`resolveReasoningEffortSpec` lets the curated table outrank a non-catalog
 * spec on purpose — see its doc — so these tests use catalog-sourced specs.)
 */
const UNKNOWN_ID = 'test-only-model-with-no-family-row';

function model(spec: ReasoningEffortSpec | undefined, overrides: Partial<EffortModelLike> = {}): EffortModelLike {
  return {
    id: UNKNOWN_ID,
    provider: 'openai',
    displayName: 'Test Model',
    ...(spec ? { reasoningEffort: spec } : {}),
    ...overrides,
  };
}

const EFFORT_SPEC: ReasoningEffortSpec = {
  kind: 'effort',
  values: ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
  source: 'catalog',
};

const BUDGET_SPEC: ReasoningEffortSpec = {
  kind: 'budget_tokens',
  values: ['none', 'minimal', 'low', 'medium', 'high'],
  source: 'catalog',
  minBudgetTokens: 1024,
  maxBudgetTokens: 32768,
};

const TOGGLE_SPEC: ReasoningEffortSpec = {
  kind: 'toggle',
  values: ['none', 'high'],
  source: 'catalog',
  note: 'This model only exposes reasoning on or off.',
};

const UNAVAILABLE_SPEC: ReasoningEffortSpec = {
  kind: 'unavailable',
  values: [],
  source: 'catalog',
  note: 'This model always reasons at a fixed depth.',
};

describe('effort presentation per spec kind', () => {
  test('a named-levels model offers exactly its own levels, not the old four', () => {
    const presentation = effortPresentationForModel(model(EFFORT_SPEC));
    expect(presentation.choices.map((c) => c.level)).toEqual(['none', 'low', 'medium', 'high', 'xhigh', 'max']);
    expect(presentation.configurable).toBe(true);
    // The levels the hardcoded list used to invent for every model.
    expect(presentation.choices.map((c) => c.level)).not.toContain('instant');
    // Every offered level carries a description; an empty detail column was
    // the old behaviour for anything outside the four-level table.
    for (const choice of presentation.choices) {
      expect(choice.description.length).toBeGreaterThan(0);
    }
  });

  test('a budget-typed model shows the thinking-token budget each level sends', () => {
    const presentation = effortPresentationForModel(model(BUDGET_SPEC));
    expect(presentation.headline).toContain('thinking-token budget');
    const medium = presentation.choices.find((c) => c.level === 'medium');
    expect(medium?.description).toContain('8,192 thinking tokens');
    const none = presentation.choices.find((c) => c.level === 'none');
    expect(none?.description).toContain('thinking off');
  });

  test('a toggle model says on-or-off and does not imply depth', () => {
    const presentation = effortPresentationForModel(model(TOGGLE_SPEC));
    expect(presentation.headline).toContain('on or off');
    expect(presentation.choices.map((c) => c.level)).toEqual(['none', 'high']);
    expect(presentation.choices.find((c) => c.level === 'high')?.description).toContain('own depth');
  });

  test('a model with nothing configurable says so instead of listing an empty set', () => {
    const presentation = effortPresentationForModel(model(UNAVAILABLE_SPEC));
    expect(presentation.configurable).toBe(false);
    expect(presentation.choices).toHaveLength(0);
    expect(presentation.headline).toContain('no configurable reasoning level');
  });
});

describe('best-guess (fallback-source) specs are labelled, never presented as verified', () => {
  test('an unrecognised model carries the best-guess caveat', () => {
    // No spec attached and no family row => the SDK's labelled fallback ladder.
    const presentation = effortPresentationForModel(model(undefined));
    expect(presentation.spec.source).toBe('fallback');
    expect(presentation.caveat).toBeDefined();
    expect(presentation.caveat).toContain('Best guess');
    // The SDK's OpenAI and Gemini adapters drop the field entirely for such a
    // model, so the caveat has to say the setting may not reach the provider.
    expect(presentation.caveat).toContain('send nothing');
  });

  test('the picker does not put an effort STEP in front of a guess', () => {
    // The adapters discard the level for a fallback-sourced model, so offering
    // a choice that will be thrown away is worse than not offering one. The
    // explicit `/effort` command still lists them, with the caveat.
    expect(offersConfigurableEffort(model(undefined))).toBe(false);
    expect(offersConfigurableEffort(model(EFFORT_SPEC))).toBe(true);
    expect(offersConfigurableEffort(model(UNAVAILABLE_SPEC))).toBe(false);
  });

  test('the status/doctor line reports the same guess honestly', () => {
    const line = describeConfiguredEffort(`openai:${UNKNOWN_ID}`, 'high');
    expect(line).toContain('unverified');
    expect(line).toContain('not in the model catalog');
  });
});

describe('the /effort explainer is generated from the resolved spec', () => {
  test('it names the field this model actually receives, not a fixed provider list', () => {
    const text = describeEffortForModel(model(EFFORT_SPEC), 'high').join('\n');
    expect(text).toContain("reasoning_effort = 'high'");
    // The old block named four unrelated providers for every model.
    expect(text).not.toContain('Mercury-2');
    expect(text).not.toContain('GPT-5:');
    expect(text).not.toContain('thinking_config.thinking_budget');
  });

  test('an Anthropic effort model is explained with its own field name', () => {
    const anthropic = model(EFFORT_SPEC, { provider: 'anthropic', displayName: 'Claude Test' });
    const text = describeEffortForModel(anthropic, 'xhigh').join('\n');
    expect(text).toContain("output_config.effort = 'xhigh'");
  });

  test('a budget-typed model is explained as a token budget', () => {
    const text = describeEffortForModel(model(BUDGET_SPEC), 'high').join('\n');
    expect(text).toContain('thinking.budget_tokens = 32,768');
  });

  test('a model with no configurable level says nothing is sent', () => {
    const text = describeEffortForModel(model(UNAVAILABLE_SPEC), 'high').join('\n');
    expect(text).toContain('no configurable reasoning level');
    expect(text).toContain('not sent');
  });

  test('a level this model does not offer is explained, and snapped down', () => {
    const limited: ReasoningEffortSpec = { kind: 'effort', values: ['low', 'medium', 'high'], source: 'catalog' };
    const text = describeEffortForModel(model(limited), 'xhigh').join('\n');
    expect(text).toContain("'xhigh' isn't available");
    expect(text).toContain("using 'high'");
  });
});

describe('switching or failing over re-resolves the level against the serving model', () => {
  test('a level the serving model lacks snaps down and carries the SDK note', () => {
    const serving = model({ kind: 'effort', values: ['low', 'medium', 'high'], source: 'catalog' }, {
      displayName: 'gpt-5',
    });
    const remapped = remapEffortForServingModel('xhigh', serving);
    expect(remapped.value).toBe('high');
    expect(remapped.note).toContain("Reasoning effort 'xhigh' isn't available on gpt-5");
    expect(remapped.note).toContain("using 'high'");
  });

  test('a level the serving model does offer is left alone and says nothing', () => {
    const serving = model(EFFORT_SPEC);
    const remapped = remapEffortForServingModel('xhigh', serving);
    expect(remapped.value).toBe('xhigh');
    expect(remapped.note).toBeUndefined();
  });

  test('resolution only ever snaps DOWN — never up to a costlier level', () => {
    const highOnly: ReasoningEffortSpec = { kind: 'effort', values: ['high', 'max'], source: 'catalog' };
    const remapped = remapEffortForServingModel('low', model(highOnly));
    // Nothing at or below 'low' exists, so the field is dropped and the
    // provider default applies; promoting 'low' to 'high' would spend
    // reasoning tokens the caller never asked for.
    expect(remapped.value).toBeUndefined();
    expect(remapped.note).toContain('offers nothing lower');
  });

  test('a serving model with no configurable reasoning drops the level entirely', () => {
    const remapped = remapEffortForServingModel('high', model(UNAVAILABLE_SPEC));
    expect(remapped.value).toBeUndefined();
    expect(remapped.note).toContain("isn't configurable");
  });
});

describe('level lists come from the model, not from a constant', () => {
  test('two models with different specs offer different levels', () => {
    expect(effortLevelsForModel(model(EFFORT_SPEC))).toEqual(['none', 'low', 'medium', 'high', 'xhigh', 'max']);
    expect(effortLevelsForModel(model(TOGGLE_SPEC))).toEqual(['none', 'high']);
    expect(effortLevelsForModel(model(UNAVAILABLE_SPEC))).toEqual([]);
  });
});
