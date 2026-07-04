/**
 * /recall injections command tests (Wave-5 W5.2, wo803).
 *
 * Exercises the actual registered `/recall injections` subcommand (not just
 * the pure renderer in turn-injection.test.ts) against a fake
 * ShellAgentManagerService, covering: populated records, the honest empty
 * state (no records at all — the flag-off-observable-equivalent proxy),
 * unknown agent id, and the no-id usage/scope-explanation text.
 */
import { describe, expect, test } from 'bun:test';
import type { CommandContext } from '../../input/command-registry.ts';
import { recallCommand } from '../../input/commands/memory.ts';
import type { AgentRecord } from '@pellux/goodvibes-sdk/platform/tools';

function makeAgentRecord(overrides: Partial<AgentRecord> & { id: string; task: string }): AgentRecord {
  return {
    id: overrides.id,
    task: overrides.task,
    template: overrides.template ?? 'engineer',
    tools: [],
    status: 'completed',
    startedAt: Date.now(),
    toolCallCount: 2,
    orchestrationDepth: 0,
    executionProtocol: 'direct',
    reviewMode: 'none',
    communicationLane: 'parent-only',
    ...overrides,
  } as AgentRecord;
}

function makeContext(records: AgentRecord[], printed: string[]): CommandContext {
  return {
    session: {
      conversationManager: {} as never,
      runtime: { model: '', provider: '', debugMode: false, systemPrompt: '', reasoningEffort: '', sessionId: 'session-1' },
    },
    provider: { providerRegistry: {} as never },
    workspace: {},
    platform: { config: {} as never, configManager: {} as never },
    ops: {
      agentManager: {
        exportState: () => records,
      } as never,
    },
    extensions: { toolRegistry: {} as never, mcpRegistry: {} as never },
    renderRequest: () => {},
    print: (text: string) => { printed.push(text); },
    exit: () => {},
  } as unknown as CommandContext;
}

describe('/recall injections', () => {
  test('no agentId: prints usage text explaining the main-session scope limitation, plus known ids', () => {
    const printed: string[] = [];
    const context = makeContext([makeAgentRecord({ id: 'agent-abc', task: 'do a thing' })], printed);
    recallCommand.handler(['injections'], context);
    const text = printed.join('\n');
    expect(text).toContain('Usage: /recall injections <agentId>');
    expect(text).toContain('main interactive session does not route through the passive-injection engine');
    expect(text).toContain('agent-abc');
  });

  test('unknown agentId: prints an honest not-found message', () => {
    const printed: string[] = [];
    const context = makeContext([], printed);
    recallCommand.handler(['injections', 'no-such-agent'], context);
    expect(printed.join('\n')).toContain('Agent not found: no-such-agent');
  });

  test('agent with no turnInjections yet: honest empty state, not a fabricated "nothing injected"', () => {
    const printed: string[] = [];
    const context = makeContext([makeAgentRecord({ id: 'agent-1', task: 'task' })], printed);
    recallCommand.handler(['injections', 'agent-1'], context);
    const text = printed.join('\n');
    expect(text).toContain('No per-turn injection records for agent agent-1');
    expect(text).toContain('disabled');
  });

  test('agent with populated turnInjections: renders each turn, most recent first', () => {
    const printed: string[] = [];
    const record = makeAgentRecord({
      id: 'agent-2',
      task: 'task',
      turnInjections: [
        {
          turn: 1,
          query: 'task steer-word',
          candidatesConsidered: 4,
          injectedIds: ['mem-9'],
          droppedForBudget: [],
          tokenCost: 220,
          budgetTokens: 800,
          relevanceFloor: 95,
          ingestModes: ['semantic'],
          embeddingBackend: 'available',
        },
        {
          turn: 2,
          query: 'task steer-word two',
          candidatesConsidered: 2,
          injectedIds: [],
          droppedForBudget: [],
          tokenCost: 0,
          budgetTokens: 800,
          relevanceFloor: 95,
          ingestModes: [],
          embeddingBackend: 'fallback-lexical',
          reason: 'no records cleared relevance floor',
        },
      ],
    });
    const context = makeContext([record], printed);
    recallCommand.handler(['injections', 'agent-2'], context);
    const text = printed.join('\n');
    expect(text).toContain('agent-2');
    expect(text).toContain('turn 1');
    expect(text).toContain('mem-9');
    expect(text).toContain('turn 2');
    expect(text).toContain('nothing injected this turn — nothing cleared the relevance floor');
    expect(text).toContain('[lexical fallback]');
    // Most recent first: turn 2's line should appear before turn 1's.
    expect(text.indexOf('turn 2')).toBeLessThan(text.indexOf('turn 1'));
  });
});
