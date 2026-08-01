// Deliberately per-repo test, byte-identical to the sibling product's copy by design: the module it exercises is this repo's own and has diverged from the sibling's, so the two copies prove different code and neither can stand in for the other.
// ---------------------------------------------------------------------------
// conversation-turn-structure.test.ts — assistant-turn grouping, structural
// placement, connector geometry and nested-agent splicing.
//
// These assert SHAPE (which rows, in what order, with which connectors), not
// pixel output, so they stay honest without pinning styling details.
// ---------------------------------------------------------------------------

import { describe, test, expect } from 'bun:test';
import {
  buildRenderPlan,
  computeAssistantTurns,
  MAX_NEST_DEPTH,
} from '../../core/conversation-turn-structure.ts';
import type { ConversationMessageSnapshot } from '@pellux/goodvibes-sdk/platform/core';

type Message = ConversationMessageSnapshot;

function assistant(opts: {
  content?: string;
  model?: string;
  provider?: string;
  calls?: Array<{ id: string; name?: string }>;
}): Message {
  return {
    role: 'assistant',
    content: opts.content ?? '',
    model: opts.model ?? 'GPT-5.6 Sol',
    provider: opts.provider ?? 'openai',
    toolCalls: (opts.calls ?? []).map((c) => ({ id: c.id, name: c.name ?? 'svc', arguments: {} })),
  } as Message;
}
const toolResult = (callId: string, content = 'ok'): Message =>
  ({ role: 'tool', callId, content, toolName: 'svc' });
const user = (content = 'hi'): Message => ({ role: 'user', content });

/** Compact shape of the plan: id + depth + connector. */
function shape(plan: ReturnType<typeof buildRenderPlan>): string[] {
  return plan.map((n) => `${n.id}@${n.depth}${n.connector ?? ''}`);
}

describe('assistant turn grouping', () => {
  test('consecutive tool-only assistant messages share ONE header', () => {
    const messages: Message[] = [
      user(),
      assistant({ calls: [{ id: 'a' }] }),
      toolResult('a'),
      assistant({ calls: [{ id: 'b' }] }),
      toolResult('b'),
      assistant({ calls: [{ id: 'c' }] }),
      toolResult('c'),
    ];
    const turns = computeAssistantTurns(messages, 0);
    const heads = [1, 3, 5].filter((i) => turns.get(i)?.isHead);
    expect(heads).toEqual([1]);
    // The header speaks for the whole run, not for one message.
    expect(turns.get(1)!.toolCallCount).toBe(3);
    expect(turns.get(5)!.turnKey).toBe('turn_1');
  });

  test('a shared tool label is hoisted to the header exactly once', () => {
    const messages: Message[] = [
      assistant({ calls: [{ id: 'a', name: 'Calling the assistant service' }] }),
      toolResult('a'),
      assistant({ calls: [{ id: 'b', name: 'Calling the assistant service' }] }),
      toolResult('b'),
    ];
    expect(computeAssistantTurns(messages, 0).get(0)!.sharedToolLabel)
      .toBe('Calling the assistant service');
  });

  test('differing tool labels leave each row to carry its own', () => {
    const messages: Message[] = [
      assistant({ calls: [{ id: 'a', name: 'read' }] }),
      toolResult('a'),
      assistant({ calls: [{ id: 'b', name: 'exec' }] }),
      toolResult('b'),
    ];
    expect(computeAssistantTurns(messages, 0).get(0)!.sharedToolLabel).toBeUndefined();
  });

  test('prose closes the group — what follows starts a new header', () => {
    const messages: Message[] = [
      assistant({ calls: [{ id: 'a' }] }),
      toolResult('a'),
      assistant({ content: 'Here is what I found.' }),
      assistant({ calls: [{ id: 'b' }] }),
      toolResult('b'),
    ];
    const turns = computeAssistantTurns(messages, 0);
    expect(turns.get(0)!.isHead).toBe(true);
    expect(turns.get(2)!.isHead).toBe(true);
    // The tool-only message after the prose joins the PROSE's group.
    expect(turns.get(3)!.isHead).toBe(false);
    expect(turns.get(3)!.turnKey).toBe('turn_2');
  });

  test('a model switch mid-run stays visible as a new header', () => {
    const messages: Message[] = [
      assistant({ calls: [{ id: 'a' }], model: 'GPT-5.6 Sol' }),
      toolResult('a'),
      assistant({ calls: [{ id: 'b' }], model: 'Claude Opus 5' }),
    ];
    const turns = computeAssistantTurns(messages, 0);
    expect(turns.get(2)!.isHead).toBe(true);
  });

  test('a user message ends the run', () => {
    const messages: Message[] = [
      assistant({ calls: [{ id: 'a' }] }),
      user('again please'),
      assistant({ calls: [{ id: 'b' }] }),
    ];
    expect(computeAssistantTurns(messages, 0).get(2)!.isHead).toBe(true);
  });

  test('a system message does NOT break a run', () => {
    const messages: Message[] = [
      assistant({ calls: [{ id: 'a' }] }),
      { role: 'system', content: 'mcp server reconnected' },
      assistant({ calls: [{ id: 'b' }] }),
    ];
    expect(computeAssistantTurns(messages, 0).get(2)!.isHead).toBe(false);
  });

  test('a streaming placeholder with no model yet does not split the run', () => {
    const messages: Message[] = [
      assistant({ calls: [{ id: 'a' }] }),
      { role: 'assistant', content: '', toolCalls: [] } as Message,
    ];
    expect(computeAssistantTurns(messages, 0).get(1)!.isHead).toBe(false);
  });
});

describe('structural placement', () => {
  test('a result renders under ITS OWN call, not in arrival order', () => {
    // Two concurrent calls; B settles FIRST in the message array.
    const messages: Message[] = [
      assistant({ calls: [{ id: 'a' }, { id: 'b' }] }),
      toolResult('b', 'b done'),
      toolResult('a', 'a done'),
    ];
    expect(shape(buildRenderPlan(messages, 0))).toEqual([
      'm:0@0',
      'c:0:0@1├',   // call A
      'm:2@2└',     // A's result, lifted above call B
      'c:0:1@1└',   // call B
      'm:1@2└',     // B's result
    ]);
  });

  test('a late child lands inside its own subtree, above a later sibling', () => {
    const before: Message[] = [
      assistant({ calls: [{ id: 'a' }, { id: 'b' }] }),
      toolResult('b'),
    ];
    const after: Message[] = [
      assistant({ calls: [{ id: 'a' }, { id: 'b' }] }),
      toolResult('b'),
      toolResult('a'),
    ];
    const idsBefore = shape(buildRenderPlan(before, 0));
    const idsAfter = shape(buildRenderPlan(after, 0));
    // A's late result inserts between call A and call B rather than appending.
    expect(idsBefore).toEqual(['m:0@0', 'c:0:0@1├', 'c:0:1@1└', 'm:1@2└']);
    expect(idsAfter).toEqual(['m:0@0', 'c:0:0@1├', 'm:2@2└', 'c:0:1@1└', 'm:1@2└']);
  });

  test('multiple results for one call all hang under it, in array order', () => {
    const messages: Message[] = [
      assistant({ calls: [{ id: 'a' }] }),
      toolResult('a', 'first'),
      toolResult('a', 'second'),
    ];
    expect(shape(buildRenderPlan(messages, 0)))
      .toEqual(['m:0@0', 'c:0:0@1└', 'm:1@2├', 'm:2@2└']);
  });

  test('an orphan result (no matching call) renders flush at depth 0', () => {
    const messages: Message[] = [toolResult('nobody')];
    expect(shape(buildRenderPlan(messages, 0))).toEqual(['m:0@0']);
  });
});

describe('connectors', () => {
  test('a row flips └ to ├ when a sibling is appended, and NOTHING else changes', () => {
    const one: Message[] = [assistant({ calls: [{ id: 'a' }] }), toolResult('a')];
    const two: Message[] = [assistant({ calls: [{ id: 'a' }] }), toolResult('a'), toolResult('a', 'second')];

    const rowBefore = buildRenderPlan(one, 0).find((n) => n.id === 'm:1')!;
    const rowAfter = buildRenderPlan(two, 0).find((n) => n.id === 'm:1')!;

    // The connector — and only the connector — differs.
    expect(rowBefore.connector).toBe('└');
    expect(rowAfter.connector).toBe('├');
    expect(rowAfter.depth).toBe(rowBefore.depth);
    expect(rowAfter.id).toBe(rowBefore.id);
    expect(rowAfter.absIdx).toBe(rowBefore.absIdx);
    expect(rowAfter.scope).toBe(rowBefore.scope);
    expect(rowAfter.openAncestorDepths).toEqual(rowBefore.openAncestorDepths);
    expect(rowAfter.message).toEqual(rowBefore.message);
  });

  test('an open ancestor carries a │ gutter down through its descendants', () => {
    const messages: Message[] = [
      assistant({ calls: [{ id: 'a' }, { id: 'b' }] }),
      toolResult('a'),
      toolResult('b'),
    ];
    const plan = buildRenderPlan(messages, 0);
    // A's result sits under a NON-last call, so depth 1 stays open beneath it.
    expect(plan.find((n) => n.id === 'm:1')!.openAncestorDepths).toEqual([1]);
    // B's call is last, so its result draws no ancestor gutter.
    expect(plan.find((n) => n.id === 'm:2')!.openAncestorDepths).toEqual([]);
  });
});

describe('nested agents', () => {
  const spawnCall = (id: string): Message =>
    ({ role: 'assistant', content: '', model: 'm', provider: 'p',
       toolCalls: [{ id, name: 'Agent', arguments: {} }] } as Message);
  const spawnResult = (callId: string, agentId: string): Message =>
    ({ role: 'tool', callId, content: JSON.stringify({ agentId }), toolName: 'Agent' });

  test("a spawned agent's rows splice in beneath the call that spawned it", () => {
    const child: Message[] = [
      assistant({ calls: [{ id: 'x' }] }),
      toolResult('x', 'child work'),
    ];
    const plan = buildRenderPlan(
      [spawnCall('s1'), spawnResult('s1', 'agent-1')],
      0,
      { resolveAgentSnapshot: (id) => (id === 'agent-1' ? child : null) },
    );
    const ids = plan.map((n) => n.id);
    expect(ids).toContain('a:agent-1/m:0');
    expect(ids).toContain('a:agent-1/c:0:0');
    // The child's rows sit BELOW the spawning call, deeper than it.
    const callDepth = plan.find((n) => n.id === 'c:0:0')!.depth;
    const childDepth = plan.find((n) => n.id === 'a:agent-1/m:0')!.depth;
    expect(childDepth).toBeGreaterThan(callDepth);
  });

  test('nesting recurses — an agent that spawns an agent nests again', () => {
    const grandchild: Message[] = [assistant({ calls: [{ id: 'g' }] })];
    const child: Message[] = [spawnCall('s2'), spawnResult('s2', 'agent-2')];
    const plan = buildRenderPlan(
      [spawnCall('s1'), spawnResult('s1', 'agent-1')],
      0,
      { resolveAgentSnapshot: (id) => (id === 'agent-1' ? child : id === 'agent-2' ? grandchild : null) },
    );
    expect(plan.map((n) => n.id)).toContain('a:agent-1/a:agent-2/m:0');
  });

  test('a spawn cycle is caught and reported, not followed', () => {
    const selfSpawning: Message[] = [spawnCall('s1'), spawnResult('s1', 'agent-1')];
    const plan = buildRenderPlan(selfSpawning, 0, {
      resolveAgentSnapshot: () => selfSpawning,
    });
    const truncated = plan.filter((n) => n.truncated === 'cycle');
    expect(truncated.length).toBeGreaterThan(0);
  });

  test('runaway depth stops at the ceiling and says so', () => {
    // Every agent spawns a fresh, distinct agent forever.
    let counter = 0;
    const plan = buildRenderPlan([spawnCall('s1'), spawnResult('s1', 'agent-0')], 0, {
      resolveAgentSnapshot: () => {
        counter += 1;
        return [spawnCall(`s${counter}`), spawnResult(`s${counter}`, `agent-${counter}`)];
      },
    });
    expect(plan.some((n) => n.truncated === 'depth')).toBe(true);
    expect(Math.max(...plan.map((n) => n.depth))).toBeLessThanOrEqual(MAX_NEST_DEPTH);
  });

  test('no resolver means no nesting and an unchanged transcript', () => {
    const plan = buildRenderPlan([spawnCall('s1'), spawnResult('s1', 'agent-1')], 0);
    expect(plan.map((n) => n.id)).toEqual(['m:0', 'c:0:0', 'm:1']);
  });
});
