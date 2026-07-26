/**
 * /recall injections command tests.
 *
 * Exercises the actual registered `/recall injections` subcommand (not just
 * the pure renderer in turn-injection.test.ts) against a fake
 * ShellAgentManagerService, covering the explicit-agent-id path (populated
 * records, the honest empty state, unknown agent id) and the no-id path, which
 * as of renders the MAIN session's own per-turn injection ring via the
 * `session.getMainSessionTurnInjections` accessor (populated from a stub
 * orchestrator, plus the honest empty state when the accessor isn't wired).
 */
import { describe, expect, test } from 'bun:test';
import type { CommandContext } from '../../input/command-registry.ts';
import { recallCommand } from '../../input/commands/memory.ts';
import type { TurnInjectionEntry } from '../../renderer/turn-injection.ts';
import type { AgentRecord } from '@pellux/goodvibes-sdk/platform/tools';

function makeAgentRecord(overrides: Partial<AgentRecord> & { id: string; task: string }): AgentRecord {
  return {
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

function makeContext(
  records: AgentRecord[],
  printed: string[],
  mainSessionInjections?: readonly TurnInjectionEntry[],
): CommandContext {
  return {
    session: {
      conversationManager: {} as never,
      runtime: { model: '', provider: '', debugMode: false, systemPrompt: '', reasoningEffort: '', sessionId: 'session-1' },
      // when provided, mirrors the real bootstrap wiring of
      // Orchestrator.getTurnInjections() onto the command context. When omitted,
      // the accessor is absent — exactly like a context built without an
      // orchestrator — so the no-id path renders the honest empty state.
      getMainSessionTurnInjections: mainSessionInjections
        ? () => mainSessionInjections
        : undefined,
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
  test('no agentId, accessor unwired: honest main-session empty state (not a usage hint, not a fabricated record)', () => {
    const printed: string[] = [];
    const context = makeContext([makeAgentRecord({ id: 'agent-abc', task: 'do a thing' })], printed);
    recallCommand.handler(['injections'], context);
    const text = printed.join('\n');
    expect(text).toContain('No per-turn injection records for the main session yet');
    expect(text).toContain('disabled');
    // No longer routes to the old usage/limitation text, and does not leak agent ids.
    expect(text).not.toContain('Usage: /recall injections');
    expect(text).not.toContain('does not route through the passive-injection engine');
    expect(text).not.toContain('agent-abc');
  });

  test('no agentId, stub orchestrator with records: renders the MAIN session ring, most recent first', () => {
    const printed: string[] = [];
    const mainSessionInjections: TurnInjectionEntry[] = [
      {
        turn: 1,
        query: 'user prompt one',
        candidatesConsidered: 3,
        codeCandidatesConsidered: 0,
        injectedIds: ['mem-main-1'],
        injectedSources: ['memory'],
        droppedForBudget: [],
        tokenCost: 180,
        budgetTokens: 800,
        relevanceFloor: 95,
        ingestModes: ['semantic'],
        embeddingBackend: 'available',
      },
      {
        turn: 2,
        query: 'user prompt two',
        candidatesConsidered: 2,
        codeCandidatesConsidered: 0,
        injectedIds: [],
        injectedSources: [],
        droppedForBudget: [],
        tokenCost: 0,
        budgetTokens: 800,
        relevanceFloor: 95,
        ingestModes: [],
        embeddingBackend: 'fallback-lexical',
        reason: 'no records cleared relevance floor',
      },
    ];
    const context = makeContext([], printed, mainSessionInjections);
    recallCommand.handler(['injections'], context);
    const text = printed.join('\n');
    expect(text).toContain('Per-turn knowledge injections for the main session (2, most recent first)');
    expect(text).toContain('turn 1');
    expect(text).toContain('mem-main-1');
    expect(text).toContain('turn 2');
    expect(text).toContain('nothing injected this turn — nothing cleared the relevance floor');
    expect(text).toContain('[lexical fallback]');
    // Most recent first: turn 2's line appears before turn 1's.
    expect(text.indexOf('turn 2')).toBeLessThan(text.indexOf('turn 1'));
    // Main-session path, not the per-agent phrasing.
    expect(text).not.toContain('for agent');
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
          codeCandidatesConsidered: 0,
          injectedIds: ['mem-9'],
          injectedSources: ['memory'],
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
          codeCandidatesConsidered: 0,
          injectedIds: [],
          injectedSources: [],
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
