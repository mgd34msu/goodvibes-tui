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
});
