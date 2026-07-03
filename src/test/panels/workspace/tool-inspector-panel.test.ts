import { beforeEach, describe, expect, test } from 'bun:test';
import { createEventEnvelope, type RuntimeEventBus } from '@/runtime/index.ts';
import { createUiRuntimeEvents } from '../../../runtime/ui-events.ts';
import { ToolInspectorPanel } from '../../../panels/tool-inspector-panel.ts';
import { createRuntimeBusStub, flushMicrotasks, linesText } from './_shared.ts';

describe('workspace panel migrations', () => {
  let runtimeBus: RuntimeEventBus;

  beforeEach(async () => {
    runtimeBus = createRuntimeBusStub();
  });

  test('ToolInspectorPanel renders shared workspace empty state cleanly', async () => {
    const events = createUiRuntimeEvents(runtimeBus);
    const panel = new ToolInspectorPanel(events.tools, events.turns);
    const lines = panel.render(80, 20);
    expect(lines).toHaveLength(20);
    expect(lines.every((line) => line.length === 80)).toBe(true);
    expect(linesText(lines)).toContain('Tools');
    expect(linesText(lines)).toContain('No tool calls yet');
  });

  test('ToolInspectorPanel keeps ingesting tool events while deactivated', async () => {
    const events = createUiRuntimeEvents(runtimeBus);
    const panel = new ToolInspectorPanel(events.tools, events.turns);
    panel.onActivate();
    panel.onDeactivate();
    runtimeBus.emit(
      'tools',
      createEventEnvelope(
        'TOOL_RECEIVED',
        { type: 'TOOL_RECEIVED', callId: 'call-1', turnId: 'turn-1', tool: 'write', args: { path: 'x.ts' } },
        {
          sessionId: 'sess-1',
          source: 'test',
          turnId: 'turn-1',
        },
      ),
    );
    await flushMicrotasks();
    const text = linesText(panel.render(80, 20));
    expect(text).toContain('write');
  });

  test('WO-131: TOOL_EXECUTING sets the real execution start used for duration, and TOOL_CANCELLED reaches a terminal state', async () => {
    const events = createUiRuntimeEvents(runtimeBus);
    const panel = new ToolInspectorPanel(events.tools, events.turns);

    runtimeBus.emit('tools', createEventEnvelope(
      'TOOL_RECEIVED',
      { type: 'TOOL_RECEIVED', callId: 'call-1', turnId: 'turn-1', tool: 'bash', args: { command: 'ls' } },
      { sessionId: 'sess-1', source: 'test', turnId: 'turn-1' },
    ));
    await flushMicrotasks();

    const startedAt = Date.now();
    runtimeBus.emit('tools', createEventEnvelope(
      'TOOL_EXECUTING',
      { type: 'TOOL_EXECUTING', callId: 'call-1', turnId: 'turn-1', tool: 'bash', startedAt },
      { sessionId: 'sess-1', source: 'test', turnId: 'turn-1' },
    ));
    await flushMicrotasks();

    // Still running — no terminal status yet.
    let text = linesText(panel.render(80, 20));
    expect(text).toContain('(running)');

    runtimeBus.emit('tools', createEventEnvelope(
      'TOOL_CANCELLED',
      { type: 'TOOL_CANCELLED', callId: 'call-1', turnId: 'turn-1', tool: 'bash', reason: 'user requested cancel' },
      { sessionId: 'sess-1', source: 'test', turnId: 'turn-1' },
    ));
    await flushMicrotasks();

    // TOOL_CANCELLED is a terminal state: no longer "(running)", and the call
    // shows as cancelled rather than hanging forever.
    text = linesText(panel.render(80, 20));
    expect(text).toContain('cancelled');
    expect(text).not.toContain('(running)');
  });

  test("WO-131: 'c' clear goes through the project-standard confirm contract instead of clearing immediately", async () => {
    const events = createUiRuntimeEvents(runtimeBus);
    const panel = new ToolInspectorPanel(events.tools, events.turns);

    runtimeBus.emit('tools', createEventEnvelope(
      'TOOL_RECEIVED',
      { type: 'TOOL_RECEIVED', callId: 'call-1', turnId: 'turn-1', tool: 'read', args: { path: 'x.ts' } },
      { sessionId: 'sess-1', source: 'test', turnId: 'turn-1' },
    ));
    await flushMicrotasks();

    panel.handleInput('c');
    const confirming = linesText(panel.render(80, 20));
    expect(confirming).toContain('Clear');
    expect(confirming).not.toContain('No tool calls yet');

    panel.handleInput('n'); // cancel — the call is not dropped
    expect(linesText(panel.render(80, 20))).toContain('read');

    panel.handleInput('c');
    panel.handleInput('y'); // confirm — now it clears
    expect(linesText(panel.render(80, 20))).toContain('No tool calls yet');
  });

  test("WO-131: 'a' queues an approval-panel jump only while the selected call awaits a permission decision", async () => {
    const events = createUiRuntimeEvents(runtimeBus);
    const panel = new ToolInspectorPanel(events.tools, events.turns);

    runtimeBus.emit('tools', createEventEnvelope(
      'TOOL_RECEIVED',
      { type: 'TOOL_RECEIVED', callId: 'call-1', turnId: 'turn-1', tool: 'bash', args: { command: 'rm -rf /tmp/x' } },
      { sessionId: 'sess-1', source: 'test', turnId: 'turn-1' },
    ));
    await flushMicrotasks();

    // Still awaiting a permission decision (no TOOL_PERMISSIONED yet) — 'a' is live.
    expect(panel.handleInput('a')).toBe(true);

    runtimeBus.emit('tools', createEventEnvelope(
      'TOOL_PERMISSIONED',
      { type: 'TOOL_PERMISSIONED', callId: 'call-1', turnId: 'turn-1', tool: 'bash', approved: true },
      { sessionId: 'sess-1', source: 'test', turnId: 'turn-1' },
    ));
    await flushMicrotasks();

    // Decision recorded — 'a' is no longer meaningful for this call.
    expect(panel.handleInput('a')).toBe(false);
  });

  test('WO-131: the risk heuristic is labelled honestly as a class, not surfaced as "risk"', async () => {
    const events = createUiRuntimeEvents(runtimeBus);
    const panel = new ToolInspectorPanel(events.tools, events.turns);

    runtimeBus.emit('tools', createEventEnvelope(
      'TOOL_RECEIVED',
      { type: 'TOOL_RECEIVED', callId: 'call-1', turnId: 'turn-1', tool: 'write', args: { path: 'x.ts' } },
      { sessionId: 'sess-1', source: 'test', turnId: 'turn-1' },
    ));
    await flushMicrotasks();

    const text = linesText(panel.render(80, 20));
    expect(text).toContain('Class');
    expect(text).not.toContain('Risk');
  });
});
