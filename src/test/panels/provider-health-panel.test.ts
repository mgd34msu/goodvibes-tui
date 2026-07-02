import { describe, expect, test } from 'bun:test';
import { createEventEnvelope, RuntimeEventBus } from '@/runtime/index.ts';
import { createUiRuntimeEvents } from '../../runtime/ui-events.ts';
import { ConfigManager } from '@pellux/goodvibes-sdk/platform/config';
import { ProviderHealthPanel } from '../../panels/provider-health-panel.ts';
import type { PanelIntegrationContext } from '../../panels/types.ts';
import type { Line } from '../../types/grid.ts';
import { createStaticUiReadModel } from '../helpers/ui-read-models.ts';
import { createTestManagers } from '../helpers/test-managers.ts';
import { createRuntimeStore } from '../../runtime/store/index.ts';
import { buildMcpAttackPathReview } from '@/runtime/index.ts';
import { createProviderApi } from '@pellux/goodvibes-sdk/platform/providers';
import { createProviderRuntimeInspectionQuery } from '../../runtime/ui-service-queries.ts';

function linesText(lines: Line[]): string {
  return lines
    .map((line) => line.map((cell) => cell.char ?? ' ').join('').trimEnd())
    .filter(Boolean)
    .join('\n');
}

// RuntimeEventBus dispatches listeners on the microtask queue (OBS-14 async
// dispatch) — drain it after emits so panel handlers run before assertions.
const flushMicrotasks = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

function createPanel(runtimeBus = new RuntimeEventBus()): ProviderHealthPanel {
  const managers = createTestManagers();
  managers.configManager.setDynamic('provider.model', 'openai:model-1');
  managers.providerRegistry.register({
    name: 'openai',
    models: ['model-1'],
    async chat() {
      return {
        content: '',
        toolCalls: [],
        usage: { inputTokens: 0, outputTokens: 0 },
        stopReason: 'completed',
      };
    },
  });
  managers.providerRegistry.setCurrentModel('openai:model-1');
  const store = createRuntimeStore();
  const events = createUiRuntimeEvents(runtimeBus);
  const baseProviderRuntime = createProviderRuntimeInspectionQuery(createProviderApi({
    providerRegistry: managers.providerRegistry,
    favoritesStore: managers.favoritesStore,
    benchmarkStore: managers.benchmarkStore,
  }));
  const providerRuntime = {
    listProviderIds: () => ['openai'],
    inspectAll: async () => {
      const snapshot = await baseProviderRuntime.inspect('openai');
      return snapshot ? [snapshot] : [];
    },
    inspect: (providerId: string) => baseProviderRuntime.inspect(providerId),
  };
  return new ProviderHealthPanel(
    providerRuntime,
    {
      configManager: new ConfigManager({ surfaceRoot: 'tui', homeDir: '/tmp', workingDir: '/tmp' }),
      turnEvents: events.turns,
      providerEvents: events.providers,
      providers: createStaticUiReadModel({
        providerIds: ['openai'],
      }),
      session: createStaticUiReadModel({
        session: store.getState().session,
        totalTurns: 4,
        messageCount: 12,
        estimatedContextTokens: 6400,
        contextWindow: 128000,
        turnState: 'idle',
        contextWarningActive: false,
        pendingApproval: false,
        denialCount: 1,
      }),
      security: createStaticUiReadModel({
        audit: {
          managed: true,
          totalTokens: 1,
          results: [],
          blocked: [],
          scopeViolations: [],
          rotationWarnings: [],
          rotationOverdue: [],
          lastAuditAt: null,
          capturedAt: new Date().toISOString(),
        },
        policy: {
          preflightStatus: 'warn',
          preflightIssueCount: 1,
          lintFindingCount: 0,
        },
        deniedPermissions: 1,
        incidents: [],
        latestIncident: undefined,
        mcpServers: [],
        recentMcpDecisions: [],
        attackPathReview: buildMcpAttackPathReview({ servers: [], recentDecisions: [] }),
        plugins: [],
        quarantinedPlugins: [],
        untrustedPlugins: [],
      }),
      localAuth: createStaticUiReadModel({
        bootstrapCredentialPresent: false,
        userCount: 2,
        sessionCount: 1,
      }),
      settings: createStaticUiReadModel({
        available: true,
        conflictCount: 0,
        recentFailureCount: 0,
        managedLockCount: 0,
        hasStagedManagedBundle: false,
      }),
      remote: createStaticUiReadModel({
        daemon: {
          transportState: 'connected',
          isRunning: true,
          reconnectAttempts: 0,
          runningJobCount: 0,
          lastError: undefined,
        },
        acp: {
          transportState: 'connected',
          totalMessages: 0,
          activeConnections: [],
        },
        pools: [],
        contracts: [],
        artifacts: [],
        supervisor: {
          capturedAt: Date.now(),
          totalConnections: 0,
          activeConnections: 0,
          degradedConnections: 0,
          pools: [],
          sessions: [],
        },
        distributed: {
          pairRequests: [],
          peers: [],
          work: [],
        },
      }),
      intelligence: createStaticUiReadModel({
        diagnosticsStatus: 'ready',
        symbolSearchStatus: 'ready',
        completionsStatus: 'ready',
        hoverStatus: 'ready',
        errorCount: 0,
        warningCount: 0,
        totalRequests: 12,
        avgLatencyMs: 72,
        hover: { active: false, filePath: undefined },
        diagnostics: new Map(),
      }),
      continuity: createStaticUiReadModel({
        sessionId: '',
        status: 'idle',
        recoveryState: 'clean',
        lastSessionPointer: 'session-1',
        recoveryFilePresent: false,
        recoveryFile: null,
        returnContext: undefined,
      }),
      worktrees: createStaticUiReadModel({
        summary: {
          total: 0,
          active: 0,
          paused: 0,
          pendingCleanup: 0,
          discard: 0,
        },
        records: [],
      }),
    },
  );
}

function emitProvidersChanged(runtimeBus: RuntimeEventBus): void {
  runtimeBus.emit('providers', createEventEnvelope('PROVIDERS_CHANGED', {
    type: 'PROVIDERS_CHANGED',
    added: ['openai'],
    removed: [],
    updated: [],
  }, { sessionId: 'session-1', source: 'test' }));
}

function emitSuccessfulTurn(runtimeBus: RuntimeEventBus): void {
  runtimeBus.emit('turn', createEventEnvelope('TURN_SUBMITTED', {
    type: 'TURN_SUBMITTED',
    turnId: 'turn-1',
    prompt: 'hello',
  }, { sessionId: 'session-1', source: 'test', turnId: 'turn-1' }));
  runtimeBus.emit('turn', createEventEnvelope('STREAM_START', {
    type: 'STREAM_START',
    turnId: 'turn-1',
  }, { sessionId: 'session-1', source: 'test', turnId: 'turn-1' }));
  runtimeBus.emit('turn', createEventEnvelope('LLM_RESPONSE_RECEIVED', {
    type: 'LLM_RESPONSE_RECEIVED',
    turnId: 'turn-1',
    provider: 'openai',
    model: 'gpt-5.4',
    contentSummary: 'hello',
    toolCallCount: 0,
    inputTokens: 24,
    outputTokens: 8,
  }, { sessionId: 'session-1', source: 'test', turnId: 'turn-1' }));
}

describe('ProviderHealthPanel', () => {
  test('providers view renders console posture plus per-provider metrics table', async () => {
    const runtimeBus = new RuntimeEventBus();
    const panel = createPanel(runtimeBus);
    emitProvidersChanged(runtimeBus);
    emitSuccessfulTurn(runtimeBus);
    await flushMicrotasks();
    const text = linesText(panel.render(140, 30));
    expect(text).toContain('Provider console posture');
    expect(text).toContain('latency trend');
    expect(text).toContain('tokens');
    expect(text).toContain('cost');
    expect(text).toContain('openai');
    expect(text).toContain('online');
  });

  test('t cycles providers, routes, and domains views', async () => {
    const runtimeBus = new RuntimeEventBus();
    const panel = createPanel(runtimeBus);
    emitProvidersChanged(runtimeBus);
    // Let the async inspectAll() posture refresh land before the routes view.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(panel.handleInput('t')).toBe(true);
    const routesText = linesText(panel.render(140, 30));
    expect(routesText).toContain('Auth Routes');
    expect(routesText).toContain('openai');

    expect(panel.handleInput('t')).toBe(true);
    const domainsText = linesText(panel.render(140, 30));
    expect(domainsText).toContain('Repair Domains');
    expect(domainsText).toContain('Session Maintenance');
    expect(domainsText).toContain('auth');
    expect(domainsText).toContain('settings');
    expect(domainsText).toContain('continuity');

    expect(panel.handleInput('t')).toBe(true);
    const providersText = linesText(panel.render(140, 30));
    expect(providersText).toContain('Providers');
  });

  test('TURN_ERROR is attributed to the active provider — no phantom unknown row', async () => {
    const runtimeBus = new RuntimeEventBus();
    const panel = createPanel(runtimeBus);
    emitProvidersChanged(runtimeBus);
    runtimeBus.emit('turn', createEventEnvelope('TURN_SUBMITTED', {
      type: 'TURN_SUBMITTED',
      turnId: 'turn-1',
      prompt: 'hello',
    }, { sessionId: 'session-1', source: 'test', turnId: 'turn-1' }));
    runtimeBus.emit('turn', createEventEnvelope('LLM_REQUEST_STARTED', {
      type: 'LLM_REQUEST_STARTED',
      turnId: 'turn-1',
      provider: 'openai',
      model: 'gpt-5.4',
      promptSummary: 'hello',
    }, { sessionId: 'session-1', source: 'test', turnId: 'turn-1' }));
    runtimeBus.emit('turn', createEventEnvelope('TURN_ERROR', {
      type: 'TURN_ERROR',
      turnId: 'turn-1',
      error: 'connection reset by provider',
      stopReason: 'provider_error',
    }, { sessionId: 'session-1', source: 'test', turnId: 'turn-1' }));
    await flushMicrotasks();

    const text = linesText(panel.render(140, 30));
    expect(text).toContain('openai');
    expect(text).toContain('degraded');
    expect(text).toContain('connection reset by provider');
    // The retired tracker default invented an 'unknown' provider row on every
    // TURN_ERROR; the console must never render one again (a phantom row would
    // render as a status dot followed by the literal provider name 'unknown').
    expect(text).not.toMatch(/[●◑◐✕○] unknown/);
  });

  test('rate-limit errors attribute to the active provider with a cooldown', async () => {
    const runtimeBus = new RuntimeEventBus();
    const panel = createPanel(runtimeBus);
    emitProvidersChanged(runtimeBus);
    runtimeBus.emit('turn', createEventEnvelope('LLM_REQUEST_STARTED', {
      type: 'LLM_REQUEST_STARTED',
      turnId: 'turn-1',
      provider: 'openai',
      model: 'gpt-5.4',
      promptSummary: 'hello',
    }, { sessionId: 'session-1', source: 'test', turnId: 'turn-1' }));
    runtimeBus.emit('turn', createEventEnvelope('TURN_ERROR', {
      type: 'TURN_ERROR',
      turnId: 'turn-1',
      error: 'Error 429: rate limit exceeded',
      stopReason: 'provider_error',
    }, { sessionId: 'session-1', source: 'test', turnId: 'turn-1' }));
    await flushMicrotasks();

    const text = linesText(panel.render(140, 30));
    expect(text).toContain('rate-limited');
    expect(text).toContain('cooldown');
    expect(text).not.toMatch(/[●◑◐✕○] unknown/);
  });

  test('enter dispatches /accounts repair for the selected provider', async () => {
    const runtimeBus = new RuntimeEventBus();
    const panel = createPanel(runtimeBus);
    emitProvidersChanged(runtimeBus);
    await flushMicrotasks();

    const calls: Array<{ name: string; args: string[] }> = [];
    const ctx = {
      panelManager: {},
      executeCommand: async (name: string, args: string[]) => {
        calls.push({ name, args });
        return undefined;
      },
    } as unknown as PanelIntegrationContext;

    expect(panel.handlePanelIntegrationAction('enter', ctx)).toBe(true);
    expect(calls).toEqual([{ name: 'accounts', args: ['repair', 'openai'] }]);

    // Without an executeCommand bridge the key is not consumed.
    const bare = { panelManager: {} } as unknown as PanelIntegrationContext;
    expect(panel.handlePanelIntegrationAction('enter', bare)).toBe(false);
  });

  test('1s display tick starts on activate and stops on deactivate', () => {
    const panel = createPanel();
    const tickId = () => (panel as unknown as { _tickTimerId: unknown })._tickTimerId;
    expect(tickId()).toBeNull();
    panel.onActivate();
    expect(tickId()).not.toBeNull();
    panel.onDeactivate();
    expect(tickId()).toBeNull();
    panel.onDestroy();
  });

  test('provider list shows the merged column header and context-aware footer hints', () => {
    const runtimeBus = new RuntimeEventBus();
    const panel = createPanel(runtimeBus);
    emitProvidersChanged(runtimeBus);
    const text = linesText(panel.render(140, 30));
    // Column header row for the provider roster (stats absorbed from the
    // retired providers panel).
    expect(text).toContain('provider');
    expect(text).toContain('p95');
    expect(text).toContain('auth');
    // Footer keyboard hints bind real actions instead of command signposts.
    expect(text).toContain('repair');
    expect(text).toContain('refresh posture');
    expect(text).toContain('/provider');
  });
});
