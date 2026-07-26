// ---------------------------------------------------------------------------
// cost-pricing-render.test.ts — the cost surfaces render dollars with their
// source ("your price" vs "catalog price, as of <date>"), the explicit
// "price unknown" marker (never $0.00) with its one-key fix, the manual
// price editor persisting to pricing.modelPrices live, and unpriced-spend
// honesty wherever budget state shows.
//
// Line assertions on descriptive text are FULL-STRING at 80 and 60 columns.
// The resolver is injected per test and cleared after — never live state.
// ---------------------------------------------------------------------------

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { ResolvedModelPricing } from '@pellux/goodvibes-sdk/platform/providers';
import { RuntimeEventBus, createEventEnvelope } from '@/runtime/index.ts';
import { createUiRuntimeEvents } from '../../runtime/ui-events.ts';
import { CostTrackerPanel } from '../../panels/cost-tracker-panel.ts';
import {
  describePricingSource,
  setModelPricingResolver,
  setPricingSource,
  MODEL_PRICES_CONFIG_KEY,
  BUDGET_ALERT_USD_CONFIG_KEY,
} from '../../export/cost-utils.ts';

const TEST_ENV_CTX = { sessionId: 'test-session', traceId: 'test-trace', source: 'cost-pricing-test' };

function pricedResolution(source: 'user' | 'provider' | 'catalog', asOf?: string): ResolvedModelPricing {
  return {
    status: 'priced',
    source,
    ...(asOf ? { asOf } : {}),
    rates: { inputPerMTok: 3, outputPerMTok: 15 },
  } as ResolvedModelPricing;
}

function linesToText(lines: { char?: string }[][]): string[] {
  return lines.map((line) => line.map((cell) => cell.char ?? ' ').join(''));
}

class FakeConfig {
  readonly values = new Map<string, unknown>();
  readonly get = (key: string): unknown => this.values.get(key);
  readonly set = (key: string, value: unknown): void => {
    this.values.set(key, value);
  };
}

function makePanel(options: {
  model: string;
  usage?: { input: number; output: number; cacheRead: number; cacheWrite: number };
  configAccess?: FakeConfig;
}): { panel: CostTrackerPanel; bus: RuntimeEventBus; flush: () => Promise<void> } {
  const bus = new RuntimeEventBus();
  const events = createUiRuntimeEvents(bus);
  const usage = options.usage ?? { input: 1_000_000, output: 100_000, cacheRead: 0, cacheWrite: 0 };
  const panel = new CostTrackerPanel(
    events.turns,
    events.agents,
    () => ({ ...usage, model: options.model }),
    options.configAccess ? { configAccess: options.configAccess } : {},
  );
  const flush = async (): Promise<void> => {
    await Promise.resolve();
    await Promise.resolve();
  };
  return { panel, bus, flush };
}

async function completeTurn(bus: RuntimeEventBus, flush: () => Promise<void>): Promise<void> {
  bus.emit('turn', createEventEnvelope('TURN_COMPLETED', { type: 'TURN_COMPLETED', turnId: 'turn-1', response: '', stopReason: 'completed' }, TEST_ENV_CTX));
  await flush();
}

describe('cost panel: dollars carry their source; unknown prices carry the fix', () => {
  beforeEach(() => {
    setPricingSource(null);
  });
  afterEach(() => {
    setModelPricingResolver(null);
    setPricingSource(null);
  });

  test('80 cols: a manual price renders (your price) on the Total line (full string)', async () => {
    setModelPricingResolver(() => pricedResolution('user'));
    const { panel, bus, flush } = makePanel({ model: 'anthropic:claude-sonnet-4-6' });
    await completeTurn(bus, flush);
    const texts = linesToText(panel.render(80, 24));
    const totalLine = texts.find((t) => t.trimStart().startsWith('Total'));
    expect(totalLine).toBe(' Total    : $4.500 (your price)                                                 ');
  });

  test('80 cols: a dated catalog price renders catalog price, as of <date> (full string)', async () => {
    setModelPricingResolver(() => pricedResolution('catalog', '2026-07-01'));
    const { panel, bus, flush } = makePanel({ model: 'anthropic:claude-sonnet-4-6' });
    await completeTurn(bus, flush);
    const texts = linesToText(panel.render(80, 24));
    const totalLine = texts.find((t) => t.trimStart().startsWith('Total'));
    expect(totalLine).toBe(' Total    : $4.500 (catalog price, as of 2026-07-01)                            ');
  });

  test('60 cols: the price-unknown marker and its one-key fix render (full string)', async () => {
    setModelPricingResolver(() => ({ status: 'unknown' } as ResolvedModelPricing));
    const { panel, bus, flush } = makePanel({ model: 'mystery:model-x' });
    await completeTurn(bus, flush);
    const texts = linesToText(panel.render(60, 24));
    const totalLine = texts.find((t) => t.trimStart().startsWith('Total'));
    expect(totalLine).toBe(' Total    : price unknown — press p to set a price          ');
    expect(totalLine).not.toContain('$0.00');
  });

  test('budget state renders unpriced-spend honesty when spend has no known price', async () => {
    setModelPricingResolver(() => ({ status: 'unknown' } as ResolvedModelPricing));
    const config = new FakeConfig();
    config.set(BUDGET_ALERT_USD_CONFIG_KEY, 5);
    const { panel, bus, flush } = makePanel({ model: 'mystery:model-x', configAccess: config });
    await completeTurn(bus, flush);
    const texts = linesToText(panel.render(80, 24));
    expect(texts.some((t) => t.includes('some spend has no known price and is not counted above'))).toBe(true);
  });

  test('budget state carries no unpriced note when everything is priced', async () => {
    setModelPricingResolver(() => pricedResolution('catalog', '2026-07-01'));
    const config = new FakeConfig();
    config.set(BUDGET_ALERT_USD_CONFIG_KEY, 5);
    const { panel, bus, flush } = makePanel({ model: 'anthropic:claude-sonnet-4-6', configAccess: config });
    await completeTurn(bus, flush);
    const texts = linesToText(panel.render(80, 24));
    expect(texts.some((t) => t.includes('some spend has no known price'))).toBe(false);
  });
});

describe('cost panel: the p manual-price editor persists to pricing.modelPrices live', () => {
  afterEach(() => {
    setModelPricingResolver(null);
    setPricingSource(null);
  });

  test('p opens the editor; typing input,output and Enter writes the provider:model entry', async () => {
    setModelPricingResolver(() => ({ status: 'unknown' } as ResolvedModelPricing));
    const config = new FakeConfig();
    const { panel, bus, flush } = makePanel({ model: 'anthropic:claude-sonnet-4-6', configAccess: config });
    await completeTurn(bus, flush);

    expect(panel.handleInput('p')).toBe(true);
    for (const ch of '3.00,15.00') expect(panel.handleInput(ch)).toBe(true);
    expect(panel.handleInput('enter')).toBe(true);

    expect(config.values.get(MODEL_PRICES_CONFIG_KEY)).toEqual({
      'anthropic:claude-sonnet-4-6': { input: 3, output: 15 },
    });
  });

  test('the editor preserves existing entries for other models', async () => {
    const config = new FakeConfig();
    config.set(MODEL_PRICES_CONFIG_KEY, { 'openai:gpt-5.4': { input: 5, output: 15 } });
    const { panel, bus, flush } = makePanel({ model: 'anthropic:claude-sonnet-4-6', configAccess: config });
    await completeTurn(bus, flush);

    panel.handleInput('p');
    for (const ch of '2,8') panel.handleInput(ch);
    panel.handleInput('enter');

    expect(config.values.get(MODEL_PRICES_CONFIG_KEY)).toEqual({
      'openai:gpt-5.4': { input: 5, output: 15 },
      'anthropic:claude-sonnet-4-6': { input: 2, output: 8 },
    });
  });

  test('a model without a provider prefix renders the honest refusal instead of an editor', async () => {
    const config = new FakeConfig();
    const { panel, bus, flush } = makePanel({ model: 'bare-model-id', configAccess: config });
    await completeTurn(bus, flush);

    panel.handleInput('p');
    const texts = linesToText(panel.render(80, 24));
    expect(texts.some((t) => t.includes('has no provider prefix'))).toBe(true);
    // Enter closes without writing anything.
    panel.handleInput('enter');
    expect(config.values.has(MODEL_PRICES_CONFIG_KEY)).toBe(false);
  });

  test('without a wired config the key falls through instead of opening a dead editor', async () => {
    const { panel, bus, flush } = makePanel({ model: 'anthropic:claude-sonnet-4-6' });
    await completeTurn(bus, flush);
    expect(panel.handleInput('p')).toBe(false);
  });

  test('malformed input keeps the editor open for correction', async () => {
    const config = new FakeConfig();
    const { panel, bus, flush } = makePanel({ model: 'anthropic:claude-sonnet-4-6', configAccess: config });
    await completeTurn(bus, flush);

    panel.handleInput('p');
    for (const ch of '3.00') panel.handleInput(ch); // only one number
    panel.handleInput('enter');
    expect(config.values.has(MODEL_PRICES_CONFIG_KEY)).toBe(false);
    const texts = linesToText(panel.render(80, 24));
    expect(texts.some((t) => t.includes('Set your manual price for anthropic:claude-sonnet-4-6'))).toBe(true);
  });
});

describe('describePricingSource', () => {
  afterEach(() => {
    setModelPricingResolver(null);
    setPricingSource(null);
  });

  test('manual price reads your price', () => {
    setModelPricingResolver(() => pricedResolution('user'));
    expect(describePricingSource('anthropic:claude-sonnet-4-6')).toBe('your price');
  });

  test('dated catalog price reads catalog price, as of <date>', () => {
    setModelPricingResolver(() => pricedResolution('catalog', '2026-07-01'));
    expect(describePricingSource('anthropic:claude-sonnet-4-6')).toBe('catalog price, as of 2026-07-01');
  });

  test('provider-served price reads provider price, as of <date>', () => {
    setModelPricingResolver(() => pricedResolution('provider', '2026-07-10'));
    expect(describePricingSource('anthropic:claude-sonnet-4-6')).toBe('provider price, as of 2026-07-10');
  });

  test('unknown model has no source description (callers render price unknown)', () => {
    setModelPricingResolver(() => ({ status: 'unknown' } as ResolvedModelPricing));
    expect(describePricingSource('mystery:model-x')).toBeNull();
  });

  test('the built-in fallback table names itself honestly', () => {
    // No resolver, no catalog: the static net prices this model.
    expect(describePricingSource('claude-sonnet-4-6')).toBe('built-in price');
  });
});
