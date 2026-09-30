/**
 * usage-pricing.test.ts, the Usage modal's money: dollars carry their source,
 * an unknown price shows the marker and the one-key fix (never $0.00), budget
 * rows are honest about unpriced spend, and p stores your own price for the
 * current model in pricing.modelPrices.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { InputToken } from '@pellux/goodvibes-sdk/platform/core';
import type { ResolvedModelPricing } from '@pellux/goodvibes-sdk/platform/providers';
import {
  setModelPricingResolver,
  setPricingSource,
  MODEL_PRICES_CONFIG_KEY,
  BUDGET_ALERT_USD_CONFIG_KEY,
} from '@pellux/goodvibes-sdk/platform/providers';
import { RuntimeEventBus, createEventEnvelope, createUiRuntimeEvents } from '@/runtime/index.ts';
import { UsageTracker } from '../../runtime/usage-tracker.ts';
import { UsageModal } from '../../input/usage-modal.ts';
import { SurfaceModalHost } from '../../input/surface-modal-host.ts';
import { layerTextBlock } from '../helpers/surface-frame.ts';

const TEST_ENV_CTX = { sessionId: 'test-session', traceId: 'test-trace', source: 'usage-pricing-test' };

function pricedResolution(source: 'user' | 'provider' | 'catalog', asOf?: string): ResolvedModelPricing {
  return { status: 'priced', source, ...(asOf ? { asOf } : {}), rates: { inputPerMTok: 3, outputPerMTok: 15 } } as ResolvedModelPricing;
}

class FakeConfig {
  readonly values = new Map<string, unknown>();
  readonly get = (key: string): unknown => this.values.get(key);
  readonly set = (key: string, value: unknown): void => { this.values.set(key, value); };
}

function makeModal(options: { model: string; usage?: { input: number; output: number; cacheRead: number; cacheWrite: number }; config?: FakeConfig }) {
  const bus = new RuntimeEventBus();
  const events = createUiRuntimeEvents(bus);
  const usage = options.usage ?? { input: 1_000_000, output: 100_000, cacheRead: 0, cacheWrite: 0 };
  const config = options.config ?? new FakeConfig();
  const tracker = new UsageTracker({
    turnEvents: events.turns,
    agentEvents: events.agents,
    getUsage: () => ({ ...usage, model: options.model }),
    getContextTokens: () => 0,
    getContextWindow: () => 0,
    getModelId: () => options.model,
    configManager: config as never,
  });
  const modal = new UsageModal({ tracker, compact: () => {}, pollMs: 0 });
  const host = new SurfaceModalHost();
  host.push(modal);
  const text = (): string => layerTextBlock(modal.render(120, 40));
  const type = (value: string): void => { for (const ch of value) host.handleToken({ type: 'text', value: ch }); };
  const key = (name: string): void => { host.handleToken({ type: 'key', name, logicalName: name, ctrl: false, shift: false, meta: false } as InputToken); };
  const completeTurn = async (): Promise<void> => {
    bus.emit('turn', createEventEnvelope('TURN_COMPLETED', { type: 'TURN_COMPLETED', turnId: 'turn-1', response: '', stopReason: 'completed' }, TEST_ENV_CTX));
    await Promise.resolve();
    await Promise.resolve();
  };
  return { tracker, modal, host, text, type, key, config, completeTurn };
}

describe('Usage: dollars carry their source; unknown prices carry the fix', () => {
  beforeEach(() => { setPricingSource(null); });
  afterEach(() => { setModelPricingResolver(null); setPricingSource(null); });

  test('a manual price renders with "your price"', async () => {
    setModelPricingResolver(() => pricedResolution('user'));
    const { text, completeTurn } = makeModal({ model: 'anthropic:claude-sonnet-4-6' });
    await completeTurn();
    expect(text()).toContain('$4.500');
    expect(text()).toContain('your price');
  });

  test('a dated catalog price renders "catalog price, as of <date>"', async () => {
    setModelPricingResolver(() => pricedResolution('catalog', '2026-07-01'));
    const { text, completeTurn } = makeModal({ model: 'anthropic:claude-sonnet-4-6' });
    await completeTurn();
    expect(text()).toContain('catalog price, as of 2026-07-01');
  });

  test('an unknown price shows the marker and its one-key fix, never $0.00', async () => {
    setModelPricingResolver(() => ({ status: 'unknown' } as ResolvedModelPricing));
    const { text, completeTurn } = makeModal({ model: 'mystery:model-x' });
    await completeTurn();
    expect(text()).toContain('price unknown');
    expect(text()).toContain('press p to set one');
    expect(text()).not.toContain('$0.00');
  });

  test('with a budget set, unpriced spend is called out', async () => {
    setModelPricingResolver(() => ({ status: 'unknown' } as ResolvedModelPricing));
    const config = new FakeConfig();
    config.set(BUDGET_ALERT_USD_CONFIG_KEY, 5);
    const { text, completeTurn } = makeModal({ model: 'mystery:model-x', config });
    await completeTurn();
    expect(text()).toContain('some spend has no known price');
  });

  test('with everything priced there is no unpriced note', async () => {
    setModelPricingResolver(() => pricedResolution('catalog', '2026-07-01'));
    const config = new FakeConfig();
    config.set(BUDGET_ALERT_USD_CONFIG_KEY, 5);
    const { text, completeTurn } = makeModal({ model: 'anthropic:claude-sonnet-4-6', config });
    await completeTurn();
    expect(text()).not.toContain('some spend has no known price');
    expect(text()).toContain('Budget');
  });
});

describe('Usage: p stores your price in pricing.modelPrices live', () => {
  afterEach(() => { setModelPricingResolver(null); setPricingSource(null); });

  test('p, then input,output and Enter writes the provider:model entry', () => {
    setModelPricingResolver(() => ({ status: 'unknown' } as ResolvedModelPricing));
    const { type, key, config, modal } = makeModal({ model: 'anthropic:claude-sonnet-4-6' });
    type('p');
    expect(modal.entry?.kind).toBe('price');
    type('3.00,15.00');
    key('enter');
    expect(config.values.get(MODEL_PRICES_CONFIG_KEY)).toEqual({ 'anthropic:claude-sonnet-4-6': { input: 3, output: 15 } });
    expect(modal.entry).toBeNull();
  });

  test('other models\' prices are kept', () => {
    const config = new FakeConfig();
    config.set(MODEL_PRICES_CONFIG_KEY, { 'openai:gpt-5.4': { input: 5, output: 15 } });
    const { type, key } = makeModal({ model: 'anthropic:claude-sonnet-4-6', config });
    type('p');
    type('2,8');
    key('enter');
    expect(config.values.get(MODEL_PRICES_CONFIG_KEY)).toEqual({
      'openai:gpt-5.4': { input: 5, output: 15 },
      'anthropic:claude-sonnet-4-6': { input: 2, output: 8 },
    });
  });

  test('a model without a provider prefix says why instead of storing anything', () => {
    const { type, key, config, text } = makeModal({ model: 'bare-model-id' });
    type('p');
    expect(text()).toContain('has no provider prefix');
    key('enter');
    expect(config.values.has(MODEL_PRICES_CONFIG_KEY)).toBe(false);
  });

  test('a malformed price keeps the entry open for correction', () => {
    const { type, key, config, modal, text } = makeModal({ model: 'anthropic:claude-sonnet-4-6' });
    type('p');
    type('3.00');
    key('enter');
    expect(config.values.has(MODEL_PRICES_CONFIG_KEY)).toBe(false);
    expect(modal.entry?.kind).toBe('price');
    expect(text()).toContain('Model price for anthropic:claude-sonnet-4-6');
  });

  test('Esc closes the entry first, then the modal', () => {
    const { type, host, modal } = makeModal({ model: 'anthropic:claude-sonnet-4-6' });
    type('p');
    host.escape();
    expect(modal.entry).toBeNull();
    expect(host.active).toBe(true);
    host.escape();
    expect(host.active).toBe(false);
  });
});
