import { describe, test, expect, beforeEach } from 'bun:test';
import { getCostFromPricingCatalog } from '@pellux/goodvibes-sdk/platform/providers';
import type { PricingCatalog } from '@pellux/goodvibes-sdk/platform/providers';
import { RuntimeEventBus, createEventEnvelope } from '@/runtime/index.ts';
import { createUiRuntimeEvents } from '../../runtime/ui-events.ts';
import { CostTrackerPanel } from '../../panels/cost-tracker-panel.ts';
import type { AgentRecord } from '@pellux/goodvibes-sdk/platform/tools';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TEST_CATALOG: PricingCatalog = {
  fetchedAt: Date.now(),
  models: [
    {
      id: 'test-paid-model',
      name: 'Test Paid Model',
      provider: 'test-provider',
      providerId: 'test-provider',
      providerEnvVars: [],
      pricing: { input: 5.00, output: 15.00 },
      tier: 'paid',
    },
    {
      id: 'test-free-model',
      name: 'Test Free Model',
      provider: 'test-provider',
      providerId: 'test-provider',
      providerEnvVars: [],
      pricing: { input: 0, output: 0 },
      tier: 'free',
    },
    {
      id: 'test-subscription-model',
      name: 'Test Subscription Model',
      provider: 'test-provider',
      providerId: 'test-provider',
      providerEnvVars: [],
      pricing: { input: 10.00, output: 30.00 },
      tier: 'subscription',
    },
    {
      id: 'claude-sonnet-4-6',
      name: 'Claude Sonnet 4.6',
      provider: 'anthropic',
      providerId: 'anthropic',
      providerEnvVars: ['ANTHROPIC_API_KEY'],
      pricing: { input: 3.00, output: 15.00 },
      tier: 'paid',
    },
  ],
};

// ---------------------------------------------------------------------------
// getCostFromPricingCatalog tests
// ---------------------------------------------------------------------------

describe('getCostFromPricingCatalog', () => {
  describe('catalog model returns correct pricing', () => {
    test('paid model returns its pricing', () => {
      const result = getCostFromPricingCatalog('test-paid-model', TEST_CATALOG);
      expect(result.input).toBe(5.00);
      expect(result.output).toBe(15.00);
    });

    test('subscription model returns its pricing', () => {
      const result = getCostFromPricingCatalog('test-subscription-model', TEST_CATALOG);
      expect(result.input).toBe(10.00);
      expect(result.output).toBe(30.00);
    });

    test('known model with versioned suffix matches via prefix', () => {
      const result = getCostFromPricingCatalog('claude-sonnet-4-6-20250101', TEST_CATALOG);
      expect(result.input).toBe(3.00);
      expect(result.output).toBe(15.00);
    });

    test('result is a plain object with input and output fields', () => {
      const result = getCostFromPricingCatalog('test-paid-model', TEST_CATALOG);
      expect(typeof result.input).toBe('number');
      expect(typeof result.output).toBe('number');
    });
  });

  describe('free model returns { 0, 0 }', () => {
    test('catalog free-tier model returns {0,0}', () => {
      const result = getCostFromPricingCatalog('test-free-model', TEST_CATALOG);
      expect(result.input).toBe(0);
      expect(result.output).toBe(0);
    });

    test(':free suffix returns {0,0} regardless of catalog', () => {
      const result = getCostFromPricingCatalog('any-model:free', TEST_CATALOG);
      expect(result.input).toBe(0);
      expect(result.output).toBe(0);
    });

    test(':free suffix on known paid model still returns {0,0}', () => {
      const result = getCostFromPricingCatalog('test-paid-model:free', TEST_CATALOG);
      expect(result.input).toBe(0);
      expect(result.output).toBe(0);
    });

    test('free model shows $0.00 when formatted', () => {
      const result = getCostFromPricingCatalog('test-free-model', TEST_CATALOG);
      const usd = (1000 * result.input + 1000 * result.output) / 1_000_000;
      expect(usd).toBe(0);
      const formatted = usd === 0 ? '$0.00' : `$${usd.toFixed(3)}`;
      expect(formatted).toBe('$0.00');
    });
  });

  describe('unknown model falls back gracefully', () => {
    test('completely unknown model returns {0,0}', () => {
      const result = getCostFromPricingCatalog('totally-unknown-model-xyz', TEST_CATALOG);
      expect(result.input).toBe(0);
      expect(result.output).toBe(0);
    });

    test('unknown model does not throw', () => {
      expect(() => getCostFromPricingCatalog('nonexistent-model', TEST_CATALOG)).not.toThrow();
    });

    test('empty string model ID returns {0,0}', () => {
      const result = getCostFromPricingCatalog('', TEST_CATALOG);
      expect(result.input).toBe(0);
      expect(result.output).toBe(0);
    });

    test('unknown model with debug=false does not write to stderr', () => {
      const result = getCostFromPricingCatalog('unknown-model', TEST_CATALOG, undefined, { debug: false });
      expect(result.input).toBe(0);
      expect(result.output).toBe(0);
    });
  });

  describe('cost calculation with catalog pricing', () => {
    test('calculates cost correctly with catalog pricing (per 1M tokens)', () => {
      const pricing = getCostFromPricingCatalog('test-paid-model', TEST_CATALOG);
      const cost = (1_000_000 * pricing.input + 0 * pricing.output) / 1_000_000;
      expect(cost).toBe(5.00);
    });

    test('calculates cost for mixed input/output tokens', () => {
      const pricing = getCostFromPricingCatalog('test-paid-model', TEST_CATALOG);
      const cost = (500_000 * pricing.input + 100_000 * pricing.output) / 1_000_000;
      expect(cost).toBeCloseTo(2.50 + 1.50, 6);
    });

    test('zero cost for free model regardless of token count', () => {
      const pricing = getCostFromPricingCatalog('test-free-model', TEST_CATALOG);
      const cost = (1_000_000 * pricing.input + 1_000_000 * pricing.output) / 1_000_000;
      expect(cost).toBe(0);
    });

    test('zero cost for unknown model (graceful fallback)', () => {
      const pricing = getCostFromPricingCatalog('unknown-model-xyz', TEST_CATALOG);
      const cost = (1_000_000 * pricing.input + 1_000_000 * pricing.output) / 1_000_000;
      expect(cost).toBe(0);
    });

    test('catalog returns immutable copy (mutations do not affect catalog)', () => {
      const pricing = getCostFromPricingCatalog('test-paid-model', TEST_CATALOG);
      pricing.input = 9999;
      const pricing2 = getCostFromPricingCatalog('test-paid-model', TEST_CATALOG);
      expect(pricing2.input).toBe(5.00);
    });
  });
});

// ---------------------------------------------------------------------------
// getCostFromPricingCatalog tests
// ---------------------------------------------------------------------------

describe('getCostFromPricingCatalog with explicit catalog shapes', () => {
  test('returns catalog pricing from an explicit model array', () => {
    const result = getCostFromPricingCatalog('test-paid-model', TEST_CATALOG);
    expect(result.input).toBe(5.00);
    expect(result.output).toBe(15.00);
  });

  test('returns zero for free-tier models from an explicit catalog', () => {
    const result = getCostFromPricingCatalog('test-free-model', TEST_CATALOG);
    expect(result.input).toBe(0);
    expect(result.output).toBe(0);
  });

  test('returns zero for empty explicit catalogs', () => {
    const result = getCostFromPricingCatalog('unknown-model', { models: [] });
    expect(result.input).toBe(0);
    expect(result.output).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// CostTrackerPanel agent cost population (TASK-042 / TASK-044)
// ---------------------------------------------------------------------------

function makeAgentRecord(overrides: Partial<AgentRecord> = {}): AgentRecord {
  return {
    id: 'test-agent-id',
    task: 'test task',
    template: 'general',
    tools: [],
    status: 'completed',
    startedAt: Date.now() - 5000,
    completedAt: Date.now(),
    toolCallCount: 5,
    orchestrationDepth: 0,
    executionProtocol: 'direct',
    reviewMode: 'none',
    communicationLane: 'parent-only',
    ...overrides,
  };
}

const TEST_ENV_CTX = { sessionId: 'test-session', traceId: 'test-trace', source: 'cost-tracker-test' };

describe('CostTrackerPanel — agent cost attribution on AGENT_COMPLETED', () => {
  let runtimeBus: RuntimeEventBus;
  const flushMicrotasks = async (): Promise<void> => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  };

  beforeEach(() => {
    runtimeBus = new RuntimeEventBus();
  });

  test('agent entry cost remains 0 when getAgentStatus is not provided', async () => {
    const events = createUiRuntimeEvents(runtimeBus);
    const panel = new CostTrackerPanel(
      events.turns,
      events.agents,
      () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }),
      // no getAgentStatus
    );
    // Spawn then complete an agent
    runtimeBus.emit('agents', createEventEnvelope('AGENT_SPAWNING', { agentId: 'agt-1', task: 'do work', type: 'AGENT_SPAWNING' }, TEST_ENV_CTX));
    runtimeBus.emit('agents', createEventEnvelope('AGENT_COMPLETED', { agentId: 'agt-1', durationMs: 1000, type: 'AGENT_COMPLETED' }, TEST_ENV_CTX));
    await flushMicrotasks();
    // Panel renders without fabricating a cost
    const lines = panel.render(80, 20);
    const text = lines.map((l) => l.map((c) => c.char ?? ' ').join('')).join('\n');
    // Agent entry is present; session model is still 'unknown' (no real data
    // available yet), so the Total line shows the honest unpriced marker
    // rather than a $0.00 that could be mistaken for a genuinely free model.
    expect(text).toContain('agt-1');
    expect(text).toContain('unpriced');
  });

  test('agent entry populates real tokens and cost when getAgentStatus returns usage', async () => {
    const agentRec = makeAgentRecord({
      id: 'agt-2',
      model: 'claude-sonnet-4-6',
      usage: {
        inputTokens: 10_000,
        outputTokens: 2_000,
        cacheReadTokens: 1_000,
        cacheWriteTokens: 500,
        llmCallCount: 3,
        turnCount: 2,
      },
    });
    const events = createUiRuntimeEvents(runtimeBus);
    const panel = new CostTrackerPanel(
      events.turns,
      events.agents,
      () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }),
      {
        getAgentStatus: (id) => (id === 'agt-2' ? agentRec : null),
      },
    );
    runtimeBus.emit('agents', createEventEnvelope('AGENT_SPAWNING', { agentId: 'agt-2', task: 'real work', type: 'AGENT_SPAWNING' }, TEST_ENV_CTX));
    runtimeBus.emit('agents', createEventEnvelope('AGENT_COMPLETED', { agentId: 'agt-2', durationMs: 5000, type: 'AGENT_COMPLETED' }, TEST_ENV_CTX));
    await flushMicrotasks();
    const lines = panel.render(80, 20);
    const text = lines.map((l) => l.map((c) => c.char ?? ' ').join('')).join('\n');
    // claude-sonnet-4-6: input $3/1M, output $15/1M
    // billableInput = 10000 + 1000 + 500 = 11500 tokens
    // cost = (11500*3 + 2000*15) / 1_000_000 = (34500 + 30000) / 1_000_000 = $0.0645
    expect(text).toContain('agt-2');
    // Cost: (11500×3 + 2000×15)/1_000_000 = $0.0645 → formatCost renders as '$0.065'
    expect(text).toContain('$0.065');
  });

  test('renders a budget meter with percent when a budget threshold is set', async () => {
    const events = createUiRuntimeEvents(runtimeBus);
    const panel = new CostTrackerPanel(
      events.turns,
      events.agents,
      () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }),
      { budgetThreshold: 5 },
    );
    const lines = panel.render(80, 20);
    const text = lines.map((l) => l.map((c) => c.char ?? ' ').join('')).join('\n');
    // Budget meter row is the headline glance for this panel.
    expect(text).toContain('Budget [');
    expect(text).toContain('0%');
  });

  test('empty agents state points at the b key, not a printed /cost budget command', async () => {
    // WO-160: 'b' already opens the in-panel budget-entry field from this
    // empty state (see handleInput), so the empty-state hint advertises the
    // key instead of a redundant '/cost budget <usd>' signpost.
    const events = createUiRuntimeEvents(runtimeBus);
    const panel = new CostTrackerPanel(
      events.turns,
      events.agents,
      () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }),
    );
    const lines = panel.render(80, 20);
    const text = lines.map((l) => l.map((c) => c.char ?? ' ').join('')).join('\n');
    expect(text).not.toContain('/cost budget');
    expect(text).toContain('set a session budget alert');
    expect(panel.handleInput('b')).toBe(true);
  });

  test('agent entry model is updated from AgentRecord on AGENT_COMPLETED', async () => {
    const agentRec = makeAgentRecord({
      id: 'agt-3',
      model: 'claude-haiku-4-5',
      usage: {
        inputTokens: 5_000,
        outputTokens: 1_000,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        llmCallCount: 1,
        turnCount: 1,
      },
    });
    const events = createUiRuntimeEvents(runtimeBus);
    const panel = new CostTrackerPanel(
      events.turns,
      events.agents,
      () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }),
      { getAgentStatus: (id) => (id === 'agt-3' ? agentRec : null) },
    );
    runtimeBus.emit('agents', createEventEnvelope('AGENT_SPAWNING', { agentId: 'agt-3', task: 'haiku task', type: 'AGENT_SPAWNING' }, TEST_ENV_CTX));
    runtimeBus.emit('agents', createEventEnvelope('AGENT_COMPLETED', { agentId: 'agt-3', durationMs: 2000, type: 'AGENT_COMPLETED' }, TEST_ENV_CTX));
    await flushMicrotasks();
    const lines = panel.render(80, 20);
    const text = lines.map((l) => l.map((c) => c.char ?? ' ').join('')).join('\n');
    // Haiku pricing: input $0.80/1M, output $4/1M
    // cost = (5000 * 0.80 + 1000 * 4) / 1_000_000 = (4000 + 4000) / 1_000_000 = $0.000008 -> shows as <$0.0001
    expect(text).toContain('agt-3');
    // Haiku cost: (5000×0.80 + 1000×4)/1_000_000 = 8000/1_000_000 = $0.008 → formatCost renders as '$0.0080'
    expect(text).toContain('$0.0080');
  });
});
