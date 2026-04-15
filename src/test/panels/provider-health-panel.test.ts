import { describe, expect, test } from 'bun:test';
import { createEventEnvelope, RuntimeEventBus } from '@pellux/goodvibes-sdk/platform/runtime/events/index';
import { createUiRuntimeEvents } from '@pellux/goodvibes-sdk/platform/runtime/ui-events';
import { ConfigManager } from '@pellux/goodvibes-sdk/platform/config/manager';
import { ProviderHealthPanel } from '../../panels/provider-health-panel.ts';
import type { Line } from '@pellux/goodvibes-sdk/platform/types/grid';
import { createStaticUiReadModel } from '../helpers/ui-read-models.ts';
import { createTestManagers } from '../helpers/test-managers.ts';
import { createRuntimeStore } from '../../runtime/store/index.ts';
import { buildMcpAttackPathReview } from '@pellux/goodvibes-sdk/platform/runtime/mcp/index';
import { createProviderApi } from '@pellux/goodvibes-sdk/platform/providers/provider-api';
import { createProviderRuntimeInspectionQuery } from '../../runtime/ui-service-queries.ts';

function linesText(lines: Line[]): string {
  return lines
    .map((line) => line.map((cell) => cell.char ?? ' ').join('').trimEnd())
    .filter(Boolean)
    .join('\n');
}

function createPanel(runtimeBus = new RuntimeEventBus()): ProviderHealthPanel {
  const managers = createTestManagers();
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
          cleanupPending: 0,
          discard: 0,
        },
        records: [],
      }),
    },
  );
}

describe('ProviderHealthPanel', () => {
  test('renders cross-domain health summaries from shell read models', () => {
    const runtimeBus = new RuntimeEventBus();
    const panel = createPanel(runtimeBus);
    runtimeBus.emit('providers', createEventEnvelope('PROVIDERS_CHANGED', {
      type: 'PROVIDERS_CHANGED',
      added: ['openai'],
      removed: [],
      updated: [],
    }, { sessionId: 'session-1', source: 'test' }));
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
      content: 'hello',
      toolCallCount: 0,
      inputTokens: 24,
      outputTokens: 8,
    }, { sessionId: 'session-1', source: 'test', turnId: 'turn-1' }));
    const text = linesText(panel.render(140, 28));
    expect(text).toContain('Health posture');
    expect(text).toContain('Repair Domains');
    expect(text).toContain('auth');
    expect(text).toContain('settings');
    expect(text).toContain('continuity');
    expect(text).toContain('Session Maintenance');
  });

  test('tracks provider health from shell event feeds without raw runtime bus access', () => {
    const runtimeBus = new RuntimeEventBus();
    const panel = createPanel(runtimeBus);

    runtimeBus.emit('providers', createEventEnvelope('PROVIDERS_CHANGED', {
      type: 'PROVIDERS_CHANGED',
      added: ['openai'],
      removed: [],
      updated: [],
    }, { sessionId: 'session-1', source: 'test' }));
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
      content: 'hi',
      toolCallCount: 0,
      inputTokens: 42,
      outputTokens: 7,
    }, { sessionId: 'session-1', source: 'test', turnId: 'turn-1' }));

    const text = linesText(panel.render(140, 28));
    expect(text).toContain('openai');
    expect(text).toContain('online');
  });
});
