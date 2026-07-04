/**
 * Wave-5 (wo805) main-session passive-injection WIRING tests — the regression
 * class the stubbed /recall tests could not catch.
 *
 * Background: the SDK turn loop hard-gates per-turn passive knowledge
 * injection on `Orchestrator.coreServices.memoryRegistry` (undefined is a
 * silent no-op). Both TUI `setCoreServices()` call sites (runtime/bootstrap.ts
 * and main.ts) originally omitted `memoryRegistry`, so main-session injection
 * was dead in production while every /recall test passed against stubs.
 *
 * Two layers here:
 *  1. Seam: buildSharedOrchestratorCoreServices() — the REAL payload builder
 *     both call sites now spread — must forward `memoryRegistry` by identity.
 *     Dropping the field from the builder fails this test immediately.
 *  2. Full turn: a REAL Orchestrator (the TUI's re-export), fed the REAL
 *     builder output via the REAL setCoreServices(), runs handleUserInput()
 *     against a canned LLM provider — and the turn must (a) compose the
 *     relevant record onto the systemPrompt actually sent to provider.chat()
 *     and (b) surface a TurnInjectionRecord through getTurnInjections(), the
 *     exact accessor `/recall injections` (no agent id) renders. This
 *     exercises the whole chain the blocker broke: builder -> setCoreServices
 *     -> coreServices.memoryRegistry -> turn-loop injection -> accessor ring.
 */
import { describe, expect, test } from 'bun:test';
import { Orchestrator } from '../../core/orchestrator.ts';
import { ConversationManager } from '../../core/conversation.ts';
import { buildSharedOrchestratorCoreServices, type OrchestratorCoreServicesSource } from '../../runtime/orchestrator-core-services.ts';
import { ToolRegistry } from '@pellux/goodvibes-sdk/platform/tools';
import type { PermissionManager } from '@pellux/goodvibes-sdk/platform/permissions';
import type { ConfigManager } from '@pellux/goodvibes-sdk/platform/config';
import type { ChatResponse, LLMProvider, ModelDefinition, ProviderRegistry } from '@pellux/goodvibes-sdk/platform/providers';
import type { MemoryRecord } from '@pellux/goodvibes-sdk/platform/state';

const FAKE_MODEL: ModelDefinition = {
  id: 'fake-model',
  provider: 'fake',
  registryKey: 'fake:fake-model',
  displayName: 'Fake Model',
  description: 'test-only stub model',
  capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: false },
  contextWindow: 0,
  selectable: true,
};

/** A reviewed, high-confidence record that scores over the relevance floor for the rate-limiting query below (mirrors the SDK's own wo805 turn-loop fixture). */
function makeRelevantRecord(): MemoryRecord {
  return {
    id: 'mem_ratelimit',
    scope: 'project',
    cls: 'fact',
    summary: 'rate limiting: token bucket, 100 requests per minute',
    detail: undefined,
    tags: ['rate-limiting'],
    provenance: [],
    reviewState: 'reviewed',
    confidence: 90,
    createdAt: 1,
    updatedAt: 1,
  };
}

function makeServicesSource(memoryRegistry: unknown): OrchestratorCoreServicesSource {
  // The five stubs are irrelevant to these tests (the orchestrator treats each
  // as optional); memoryRegistry is the field under test and stays a real
  // reference so identity assertions are meaningful.
  return {
    planManager: undefined,
    adaptivePlanner: undefined,
    sessionMemoryStore: undefined,
    sessionLineageTracker: undefined,
    idempotencyStore: undefined,
    memoryRegistry,
  } as unknown as OrchestratorCoreServicesSource;
}

function makeStubConfigManager(): ConfigManager {
  return {
    get: (key: string) => {
      if (key === 'display.stream') return false;
      if (key === 'cache.monitorHitRate') return false;
      return undefined;
    },
    getCategory: () => ({}),
    getWorkingDirectory: () => process.cwd(),
  } as unknown as ConfigManager;
}

function makeCapturingProviderRegistry(): { providerRegistry: ProviderRegistry; capturedSystemPrompts: string[] } {
  const capturedSystemPrompts: string[] = [];
  const provider: LLMProvider = {
    name: 'fake',
    models: ['fake-model'],
    async chat(request): Promise<ChatResponse> {
      capturedSystemPrompts.push(request.systemPrompt ?? '');
      return { content: 'done', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 }, stopReason: 'completed' };
    },
  };
  const providerRegistry = {
    require: () => provider,
    getForModel: () => provider,
    getCurrentModel: () => FAKE_MODEL,
    getContextWindowForModel: () => 0,
    getTokenLimitsForModel: () => ({
      maxOutputTokens: 4096,
      maxToolResultTokens: 50_000,
      maxToolCalls: 128,
      maxReasoningTokens: 16_384,
    }),
  } as unknown as ProviderRegistry;
  return { providerRegistry, capturedSystemPrompts };
}

describe('buildSharedOrchestratorCoreServices — the shared setCoreServices payload (seam)', () => {
  test('forwards memoryRegistry by identity — the wo805 main-session injection gate', () => {
    const sentinelRegistry = { getAll: () => [] };
    const payload = buildSharedOrchestratorCoreServices({
      services: makeServicesSource(sentinelRegistry),
      configManager: makeStubConfigManager(),
      providerRegistry: makeCapturingProviderRegistry().providerRegistry,
    });
    // The load-bearing assertion: if memoryRegistry is ever dropped from the
    // builder again, main-session passive injection dies silently — this fails loudly.
    expect(payload.memoryRegistry).toBe(sentinelRegistry as never);
    expect(payload.memoryRegistry).toBeDefined();
  });

  test('forwards the other shared fields both call sites rely on', () => {
    const configManager = makeStubConfigManager();
    const { providerRegistry } = makeCapturingProviderRegistry();
    const payload = buildSharedOrchestratorCoreServices({
      services: makeServicesSource({ getAll: () => [] }),
      configManager,
      providerRegistry,
    });
    expect(payload.configManager).toBe(configManager);
    expect(payload.providerRegistry).toBe(providerRegistry);
    expect(Object.keys(payload)).toContain('memoryRegistry');
  });
});

describe('main-session per-turn passive injection through the REAL wiring (full turn)', () => {
  async function runOneTurn(memoryRegistry: unknown): Promise<{ orchestrator: Orchestrator; capturedSystemPrompts: string[] }> {
    const conversation = new ConversationManager(() => 80);
    const { providerRegistry, capturedSystemPrompts } = makeCapturingProviderRegistry();

    const orchestrator = new Orchestrator({
      conversation,
      getViewportHeight: () => 20,
      scrollToEnd: () => {},
      toolRegistry: new ToolRegistry(),
      permissionManager: {} as unknown as PermissionManager,
      getSystemPrompt: () => 'You are the goodvibes assistant.',
      requestRender: () => {},
      sessionId: 'wiring-test-session',
      services: {
        agentManager: { list: () => [], spawn: async () => 'noop-agent-id' } as never,
        wrfcController: { listChains: () => [] } as never,
      },
    });

    // The REAL payload builder — exactly what bootstrap.ts and main.ts spread.
    orchestrator.setCoreServices(
      buildSharedOrchestratorCoreServices({
        services: makeServicesSource(memoryRegistry),
        configManager: makeStubConfigManager(),
        providerRegistry,
      }),
    );

    await orchestrator.handleUserInput('how do I configure rate limiting for the API');
    return { orchestrator, capturedSystemPrompts };
  }

  test('a relevant record reaches the sent systemPrompt and getTurnInjections() — the /recall injections source', async () => {
    const { orchestrator, capturedSystemPrompts } = await runOneTurn({ getAll: () => [makeRelevantRecord()] });

    expect(capturedSystemPrompts.length).toBeGreaterThan(0);
    expect(capturedSystemPrompts[0]).toContain('mem_ratelimit');
    expect(capturedSystemPrompts[0]).toContain('Injected Project Knowledge');

    const ring = orchestrator.getTurnInjections();
    expect(ring.length).toBe(1);
    expect(ring[0]!.injectedIds).toEqual(['mem_ratelimit']);
    expect(ring[0]!.tokenCost).toBeGreaterThan(0);
  });

  test('control: with memoryRegistry undefined the same turn injects nothing (the pre-fix production behavior)', async () => {
    const { orchestrator, capturedSystemPrompts } = await runOneTurn(undefined);

    expect(capturedSystemPrompts.length).toBeGreaterThan(0);
    expect(capturedSystemPrompts[0]).not.toContain('mem_ratelimit');
    expect(capturedSystemPrompts[0]).not.toContain('Injected Project Knowledge');
    expect(orchestrator.getTurnInjections()).toEqual([]);
  });
});
