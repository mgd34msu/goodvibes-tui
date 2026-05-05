import { describe, test, expect } from 'bun:test';
import { REASONING_BUDGET_MAP } from '@pellux/goodvibes-sdk/platform/providers';

// ---------------------------------------------------------------------------
// REASONING_BUDGET_MAP constant
// ---------------------------------------------------------------------------
describe('REASONING_BUDGET_MAP', () => {
  test('contains all 4 effort levels', () => {
    expect(Object.keys(REASONING_BUDGET_MAP)).toEqual(['instant', 'low', 'medium', 'high']);
  });

  test('instant maps to 0', () => {
    expect(REASONING_BUDGET_MAP['instant']).toBe(0);
  });

  test('low maps to 2048', () => {
    expect(REASONING_BUDGET_MAP['low']).toBe(2048);
  });

  test('medium maps to 8192', () => {
    expect(REASONING_BUDGET_MAP['medium']).toBe(8192);
  });

  test('high maps to 32768', () => {
    expect(REASONING_BUDGET_MAP['high']).toBe(32768);
  });

  test('unknown level returns undefined (no silent fallback)', () => {
    expect(REASONING_BUDGET_MAP['unknown']).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Anthropic provider reasoning effort mapping
// ---------------------------------------------------------------------------
describe('Anthropic reasoning effort mapping', () => {
  function buildAnthropicBody(reasoningEffort: string): Record<string, unknown> {
    const body: Record<string, unknown> = {};
    if (reasoningEffort && reasoningEffort !== 'instant') {
      const budget = REASONING_BUDGET_MAP[reasoningEffort];
      if (budget !== undefined && budget > 0) {
        body['thinking'] = { type: 'enabled', budget_tokens: budget };
      }
    }
    return body;
  }

  test('instant: no thinking block set', () => {
    const body = buildAnthropicBody('instant');
    expect(body['thinking']).toBeUndefined();
  });

  test('low: thinking enabled with budget 2048', () => {
    const body = buildAnthropicBody('low');
    expect(body['thinking']).toEqual({ type: 'enabled', budget_tokens: 2048 });
  });

  test('medium: thinking enabled with budget 8192', () => {
    const body = buildAnthropicBody('medium');
    expect(body['thinking']).toEqual({ type: 'enabled', budget_tokens: 8192 });
  });

  test('high: thinking enabled with budget 32768', () => {
    const body = buildAnthropicBody('high');
    expect(body['thinking']).toEqual({ type: 'enabled', budget_tokens: 32768 });
  });

  test('unknown level: no thinking block (no silent default)', () => {
    const body = buildAnthropicBody('ultra');
    expect(body['thinking']).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Gemini provider reasoning effort mapping
// ---------------------------------------------------------------------------
describe('Gemini reasoning effort mapping', () => {
  function buildGeminiGenerationConfig(reasoningEffort: string): Record<string, unknown> | undefined {
    if (reasoningEffort) {
      const budget = REASONING_BUDGET_MAP[reasoningEffort];
      if (budget !== undefined) {
        return { thinking_config: { thinking_budget: budget } };
      }
    }
    return undefined;
  }

  test('instant: thinking_budget is 0', () => {
    const config = buildGeminiGenerationConfig('instant');
    expect(config).toEqual({ thinking_config: { thinking_budget: 0 } });
  });

  test('low: thinking_budget is 2048', () => {
    const config = buildGeminiGenerationConfig('low');
    expect(config).toEqual({ thinking_config: { thinking_budget: 2048 } });
  });

  test('medium: thinking_budget is 8192', () => {
    const config = buildGeminiGenerationConfig('medium');
    expect(config).toEqual({ thinking_config: { thinking_budget: 8192 } });
  });

  test('high: thinking_budget is 32768', () => {
    const config = buildGeminiGenerationConfig('high');
    expect(config).toEqual({ thinking_config: { thinking_budget: 32768 } });
  });

  test('unknown level: no config (no silent default)', () => {
    const config = buildGeminiGenerationConfig('ultra');
    expect(config).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// /effort command logic
// ---------------------------------------------------------------------------
describe('/effort command', () => {
  const VALID_LEVELS = ['instant', 'low', 'medium', 'high'] as const;
  type EffortLevel = typeof VALID_LEVELS[number];

  function parseEffortCommand(args: string[]): { level?: EffortLevel; error?: string } {
    if (args.length === 0) return {};
    const level = args[0] as EffortLevel;
    if (!VALID_LEVELS.includes(level)) {
      return { error: `Invalid effort level: ${level}\nValid levels: ${VALID_LEVELS.join(', ')}` };
    }
    return { level };
  }

  test('valid level: instant accepted', () => {
    const result = parseEffortCommand(['instant']);
    expect(result.level).toBe('instant');
    expect(result.error).toBeUndefined();
  });

  test('valid level: low accepted', () => {
    const result = parseEffortCommand(['low']);
    expect(result.level).toBe('low');
    expect(result.error).toBeUndefined();
  });

  test('valid level: medium accepted', () => {
    const result = parseEffortCommand(['medium']);
    expect(result.level).toBe('medium');
    expect(result.error).toBeUndefined();
  });

  test('valid level: high accepted', () => {
    const result = parseEffortCommand(['high']);
    expect(result.level).toBe('high');
    expect(result.error).toBeUndefined();
  });

  test('invalid level: rejected with error message', () => {
    const result = parseEffortCommand(['ultra']);
    expect(result.level).toBeUndefined();
    expect(result.error).toContain('Invalid effort level: ultra');
    expect(result.error).toContain('instant, low, medium, high');
  });

  test('no args: returns no level and no error (display mode)', () => {
    const result = parseEffortCommand([]);
    expect(result.level).toBeUndefined();
    expect(result.error).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Config integration: effort level persists
// ---------------------------------------------------------------------------
describe('effort config integration', () => {
  test('set persists to configManager', () => {
    // Simulate the config manager set/get pattern used by the /effort command
    const store: Record<string, unknown> = {};
    const configManager = {
      get: (key: string) => store[key],
      set: (key: string, val: unknown) => { store[key] = val; },
    };
    const runtime: Record<string, unknown> = {};

    // Simulate /effort high
    runtime['reasoningEffort'] = 'high';
    configManager.set('provider.reasoningEffort', 'high');

    expect(runtime['reasoningEffort']).toBe('high');
    expect(configManager.get('provider.reasoningEffort')).toBe('high');
  });

  test('budget lookup uses configManager value after set', () => {
    const store: Record<string, unknown> = {};
    const configManager = {
      get: (key: string) => store[key],
      set: (key: string, val: unknown) => { store[key] = val; },
    };

    configManager.set('provider.reasoningEffort', 'low');
    const current = configManager.get('provider.reasoningEffort') as string;
    const budget = REASONING_BUDGET_MAP[current] ?? 8192;
    expect(budget).toBe(2048);
  });

  test('instant effort yields 0 budget in display lookup', () => {
    const store: Record<string, unknown> = {};
    const configManager = {
      get: (key: string) => store[key],
      set: (key: string, val: unknown) => { store[key] = val; },
    };

    configManager.set('provider.reasoningEffort', 'instant');
    const current = configManager.get('provider.reasoningEffort') as string;
    const budget = REASONING_BUDGET_MAP[current] ?? 8192;
    expect(budget).toBe(0);
  });
});
