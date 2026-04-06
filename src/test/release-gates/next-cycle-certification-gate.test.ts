import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import type { AgentRecord } from '../../tools/agent/index.ts';
import { _resetProviderRegistryForTesting } from '../../providers/registry.ts';
import { _resetMemoryRegistryForTesting, buildKnowledgeInjectionPrompt } from '../../state/index.ts';
import { buildMcpAttackPathReview } from '../../runtime/mcp/index.ts';
import { CommandRegistry } from '../../input/command-registry.ts';
import { registerBuiltinCommands } from '../../input/commands.ts';
import { createRuntimeStore } from '../../runtime/store/index.ts';
import { AgentManager } from '../../tools/agent/index.ts';

function makeRecord(overrides: Partial<AgentRecord> = {}): AgentRecord {
  return {
    id: 'agent-gate-01',
    task: 'Update orchestration store behavior for graph nodes',
    template: 'engineer',
    tools: ['read', 'edit'],
    status: 'pending',
    startedAt: Date.now(),
    orchestrationDepth: 0,
    toolCallCount: 0,
    executionProtocol: 'gather-plan-apply',
    reviewMode: 'wrfc',
    communicationLane: 'direct',
    writeScope: ['src/runtime/store'],
    ...overrides,
  };
}

describe('next cycle certification gate', () => {
  beforeEach(() => {
    AgentManager.resetInstance();
    _resetProviderRegistryForTesting();
    _resetMemoryRegistryForTesting();
  });

  afterEach(() => {
    _resetMemoryRegistryForTesting();
  });

  test('knowledge prompt includes reviewed project knowledge with an explainable source trail', () => {
    const record = makeRecord({
      knowledgeInjections: [{
        id: 'mem-gate-1',
        cls: 'runbook',
        summary: 'Use targeted runtime edits for orchestration store changes',
        reason: 'matched write scope "src/runtime/store"',
        confidence: 95,
        reviewState: 'reviewed',
      }],
    });
    const knowledgePrompt = buildKnowledgeInjectionPrompt(record.knowledgeInjections ?? []);

    expect(knowledgePrompt).toContain('Injected Project Knowledge');
    expect(record.knowledgeInjections?.[0]?.summary).toContain('orchestration store');
    expect(record.knowledgeInjections?.[0]?.reason).toContain('matched');
  });

  test('remote operator control uses a scoped command path and cancels the target agent only', async () => {
    const registry = new CommandRegistry();
    registerBuiltinCommands(registry);
    const manager = AgentManager.getInstance();
    const remoteRecord = manager.spawn({ mode: 'spawn', task: 'Stuck task', template: 'general', tools: [] });
    const otherRecord = manager.spawn({ mode: 'spawn', task: 'Stuck task', template: 'general', tools: [] });
    const store = createRuntimeStore();
    store.setState((state) => ({
      ...state,
      acp: {
        ...state.acp,
        activeConnectionIds: [remoteRecord.id],
        connections: new Map([
          [remoteRecord.id, {
            agentId: remoteRecord.id,
            label: 'remote implementer',
            transportState: 'connected',
            connectedAt: Date.now(),
            completing: false,
            messageCount: 0,
            errorCount: 0,
          }],
        ]),
      },
    }));

    const printed: string[] = [];
    await registry.execute('remote', ['cancel', remoteRecord.id], {
      providerRegistry: {} as never,
      conversationManager: {} as never,
      config: {} as never,
      configManager: {} as never,
      runtime: {
        model: 'mock',
        provider: 'mock',
        debugMode: false,
        systemPrompt: '',
        reasoningEffort: 'medium',
        sessionId: 'session-gate',
      },
      renderRequest: () => {},
      print: (text: string) => { printed.push(text); },
      exit: () => {},
      toolRegistry: {} as never,
      mcpRegistry: {} as never,
      runtimeStore: store,
    });

    expect(manager.getStatus(remoteRecord.id)?.status).toBe('cancelled');
    expect(manager.getStatus(otherRecord.id)?.status).toBe('pending');
    expect(printed.join('\n')).toContain(`Cancelled remote agent ${remoteRecord.id}`);
  });

  test('MCP security review produces programmatic attack-path findings for incoherent servers', () => {
    const review = buildMcpAttackPathReview({
      servers: [{
        name: 'docs',
        role: 'docs',
        trustMode: 'ask-on-risk',
        allowedPaths: [],
        allowedHosts: ['docs.example.com'],
        schemaFreshness: 'quarantined',
        quarantineReason: 'incompatible',
        connected: true,
      }],
      recentDecisions: [{
        serverName: 'docs',
        toolName: 'write_file',
        verdict: 'deny',
        riskLevel: 'critical',
        capability: 'write_fs',
        incoherent: true,
        reason: 'docs server attempted filesystem mutation',
        profileMode: 'ask-on-risk',
        evaluatedAt: Date.now(),
      }],
    });

    expect(review.criticalFindings).toBeGreaterThan(0);
    expect(review.incoherentFindings).toBeGreaterThan(0);
    expect(review.findings[0]?.serverName).toBe('docs');
    expect(review.findings[0]?.reason).toContain('docs');
  });
});
