import { describe, expect, test } from 'bun:test';
import { createRuntimeStore, createDomainDispatch } from '../../runtime/store/index.ts';
import { selectStreamToolPreview } from '../../runtime/store/selectors/index.ts';

describe('createDomainDispatch', () => {
  test('drives conversation state from typed turn and tool events', () => {
    const store = createRuntimeStore();
    const dispatch = createDomainDispatch(store);

    dispatch.dispatchTurnEvent({
      type: 'TURN_SUBMITTED',
      turnId: 'turn-1',
      prompt: 'hello',
    });
    dispatch.dispatchTurnEvent({
      type: 'STREAM_START',
      turnId: 'turn-1',
    });
    dispatch.dispatchTurnEvent({
      type: 'STREAM_DELTA',
      turnId: 'turn-1',
      content: 'hi',
      accumulated: 'hi',
      toolCalls: [{ index: 0, name: 'read_file', arguments: '{"path":"/tmp/demo.txt"}' }],
    });
    dispatch.dispatchToolEvent({
      type: 'TOOL_RECEIVED',
      callId: 'call-1',
      turnId: 'turn-1',
      tool: 'read_file',
      args: { path: '/tmp/demo.txt' },
    });
    dispatch.dispatchToolEvent({
      type: 'TOOL_EXECUTING',
      callId: 'call-1',
      turnId: 'turn-1',
      tool: 'read_file',
      startedAt: 123,
    });
    dispatch.dispatchTurnEvent({
      type: 'TURN_COMPLETED',
      turnId: 'turn-1',
      response: 'done',
      stopReason: 'completed',
    });

    const state = store.getState();
    expect(state.conversation.currentTurnId).toBe('turn-1');
    expect(state.conversation.turnState).toBe('completed');
    expect(state.conversation.stream.accumulated).toBe('hi');
    expect(state.conversation.toolCallsThisTurn).toBe(1);
    expect(state.conversation.activeToolCalls.get('call-1')?.state).toBe('executing');
    expect(state.conversation.totalTurns).toBe(1);
    expect(state.conversation.lastTurnStopReason).toBe('completed');
    expect(state.conversation.lastTurnResponse).toBe('done');
    expect(selectStreamToolPreview(state)).toBeUndefined();
  });

  test('records explicit preflight failure and reconciliation evidence', () => {
    const store = createRuntimeStore();
    const dispatch = createDomainDispatch(store);

    dispatch.dispatchTurnEvent({
      type: 'TURN_SUBMITTED',
      turnId: 'turn-2',
      prompt: 'hello',
    });
    dispatch.dispatchToolEvent({
      type: 'TOOL_RECONCILED',
      turnId: 'turn-2',
      count: 1,
      callIds: ['call-9'],
      toolNames: ['read'],
      reason: 'exception-before-results',
      timestamp: 123,
      isMalformed: false,
    });
    dispatch.dispatchTurnEvent({
      type: 'PREFLIGHT_FAIL',
      turnId: 'turn-2',
      reason: 'context overflow',
      stopReason: 'context_overflow',
    });

    const state = store.getState();
    expect(state.conversation.turnState).toBe('failed');
    expect(state.conversation.lastTurnStopReason).toBe('context_overflow');
    expect(state.conversation.lastPreflightFailure).toBe('context overflow');
    expect(state.conversation.lastToolReconciliation?.reason).toBe('exception-before-results');
  });

  test('rejects out-of-order or wrong-turn events and keeps stream preview in the store', () => {
    const store = createRuntimeStore();
    const dispatch = createDomainDispatch(store);

    dispatch.dispatchTurnEvent({
      type: 'STREAM_START',
      turnId: 'turn-missing',
    });
    dispatch.dispatchTurnEvent({
      type: 'TURN_SUBMITTED',
      turnId: 'turn-3',
      prompt: 'hello',
    });
    dispatch.dispatchTurnEvent({
      type: 'STREAM_START',
      turnId: 'wrong-turn',
    });
    dispatch.dispatchTurnEvent({
      type: 'PREFLIGHT_OK',
      turnId: 'turn-3',
    });
    dispatch.dispatchTurnEvent({
      type: 'STREAM_START',
      turnId: 'turn-3',
    });
    dispatch.dispatchTurnEvent({
      type: 'STREAM_DELTA',
      turnId: 'turn-3',
      content: 'tool call',
      accumulated: 'tool call',
      toolCalls: [{ index: 0, name: 'write_file', arguments: '{"path":"/tmp/out.txt","text":"hello world"}' }],
    });
    dispatch.dispatchTurnEvent({
      type: 'STREAM_DELTA',
      turnId: 'wrong-turn',
      content: 'bad',
      accumulated: 'bad',
      toolCalls: [{ index: 0, name: 'delete_file', arguments: '{"path":"/tmp/nope.txt"}' }],
    });
    dispatch.dispatchTurnEvent({
      type: 'TURN_COMPLETED',
      turnId: 'turn-3',
      response: 'done',
      stopReason: 'completed',
    });
    dispatch.dispatchTurnEvent({
      type: 'STREAM_DELTA',
      turnId: 'turn-3',
      content: 'late',
      accumulated: 'late',
    });

    const state = store.getState();
    expect(state.conversation.currentTurnId).toBe('turn-3');
    expect(state.conversation.turnState).toBe('completed');
    expect(state.conversation.stream.accumulated).toBe('tool call');
    expect(selectStreamToolPreview(state)).toBeUndefined();
    expect(state.conversation.stream.deltaCount).toBe(1);
  });

  test('stores permission lifecycle and final decision', () => {
    const store = createRuntimeStore();
    const dispatch = createDomainDispatch(store);

    dispatch.dispatchPermissionEvent({
      type: 'PERMISSION_REQUESTED',
      callId: 'call-2',
      tool: 'exec',
      args: { cmd: 'ls' },
      category: 'exec',
    });
    dispatch.dispatchPermissionEvent({
      type: 'DECISION_EMITTED',
      callId: 'call-2',
      tool: 'exec',
      approved: true,
      source: 'user_prompt',
    });

    const state = store.getState();
    expect(state.permissions.awaitingDecision).toBe(false);
    expect(state.permissions.totalChecks).toBe(1);
    expect(state.permissions.approvalCount).toBe(1);
    expect(state.permissions.lastDecision?.callId).toBe('call-2');
    expect(state.permissions.lastDecision?.outcome).toBe('approved');
  });

  test('tracks task, agent, plugin, mcp, and transport domain updates', () => {
    const store = createRuntimeStore();
    const dispatch = createDomainDispatch(store);

    dispatch.dispatchTaskEvent({
      type: 'TASK_CREATED',
      taskId: 'task-1',
      description: 'demo task',
      priority: 1,
    });
    dispatch.dispatchTaskEvent({
      type: 'TASK_STARTED',
      taskId: 'task-1',
    });
    dispatch.dispatchAgentEvent({
      type: 'AGENT_SPAWNING',
      agentId: 'agent-1',
      taskId: 'task-1',
      task: 'demo task',
    });
    dispatch.dispatchAgentEvent({
      type: 'AGENT_PROGRESS',
      agentId: 'agent-1',
      taskId: 'task-1',
      progress: 'reading files',
    });
    dispatch.dispatchAgentEvent({
      type: 'AGENT_STREAM_DELTA',
      agentId: 'agent-1',
      taskId: 'task-1',
      content: 'hello',
      accumulated: 'hello world',
    });
    dispatch.dispatchPluginEvent({
      type: 'PLUGIN_DISCOVERED',
      pluginId: 'plugin-1',
      path: '/plugins/demo',
      version: '1.0.0',
    });
    dispatch.dispatchMcpEvent({
      type: 'MCP_CONNECTED',
      serverId: 'mcp-1',
      toolCount: 3,
      resourceCount: 1,
    });
    dispatch.dispatchTransportEvent({
      type: 'TRANSPORT_CONNECTED',
      transportId: 'daemon:primary',
      endpoint: 'ipc://daemon.sock',
    });

    const state = store.getState();
    expect(state.tasks.runningIds).toEqual(['task-1']);
    expect(state.agents.activeAgentIds).toEqual(['agent-1']);
    expect(state.agents.agents.get('agent-1')?.latestProgress).toBe('reading files');
    expect(state.agents.agents.get('agent-1')?.latestOutput).toBe('hello world');
    expect(state.plugins.plugins.get('plugin-1')?.status).toBe('discovered');
    expect(state.mcp.connectedServerNames).toEqual(['mcp-1']);
    expect(state.daemon.transportState).toBe('connected');
  });
});
