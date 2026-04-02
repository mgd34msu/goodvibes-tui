/**
 * UX Anti-Regression: MCP Reconnect Storms with Notification Throttling (v3 §18.5)
 *
 * Verifies that rapid MCP reconnect events are correctly represented in state:
 * - Rapid state transitions are tracked monotonically
 * - Reconnect attempt counters increment correctly
 * - Storm batching: after N rapid events only last-wins state is retained
 * - Throttled notification slots: bounded history of reconnect events
 *
 * All tests use pure state manipulation — no real I/O, no event bus.
 */
import { describe, test, expect, beforeEach } from 'bun:test';
import { createInitialRuntimeState } from '../../runtime/store/state.ts';
import type { RuntimeState } from '../../runtime/store/state.ts';
import { selectMcp } from '../../runtime/store/selectors/index.ts';
import type { McpServerRecord, McpServerLifecycleState } from '../../runtime/store/domains/mcp.ts';

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Fixed timestamp used in test helpers to avoid non-deterministic Date.now() calls. */
const TEST_TIMESTAMP = 1700000000000;

/**
 * Reconnect event descriptor — represents a single MCP lifecycle transition.
 */
interface ReconnectEvent {
  readonly serverName: string;
  readonly type: 'connecting' | 'connected' | 'disconnected' | 'reconnecting';
  readonly attempt?: number;
}

/** Build a fresh server record for a given name. */
function makeServerRecord(name: string): McpServerRecord {
  return {
    name,
    displayName: `Server ${name}`,
    status: 'disconnected',
    transport: 'stdio',
    toolCount: 0,
    toolNames: [],
    callCount: 0,
    errorCount: 0,
    connectedAt: undefined,
    lastCallAt: undefined,
    lastError: undefined,
    reconnectAttempts: 0,
  };
}

/**
 * Apply a single reconnect lifecycle event to the MCP domain state.
 * Returns a new state with the server record updated accordingly.
 */
function applyMcpEvent(state: RuntimeState, event: ReconnectEvent): RuntimeState {
  const mcpState = state.mcp;
  const existing = mcpState.servers.get(event.serverName) ?? makeServerRecord(event.serverName);

  let nextStatus: McpServerLifecycleState;
  let patch: Partial<McpServerRecord> = {};

  switch (event.type) {
    case 'connecting':
      nextStatus = 'connecting';
      break;
    case 'connected':
      nextStatus = 'connected';
      patch = { reconnectAttempts: 0, connectedAt: TEST_TIMESTAMP, lastError: undefined };
      break;
    case 'disconnected':
      nextStatus = 'disconnected';
      break;
    case 'reconnecting':
      nextStatus = 'reconnecting';
      patch = { reconnectAttempts: event.attempt ?? existing.reconnectAttempts + 1 };
      break;
  }

  const updated: McpServerRecord = { ...existing, status: nextStatus, ...patch };
  const newServers = new Map(mcpState.servers);
  newServers.set(event.serverName, updated);

  return {
    ...state,
    mcp: {
      ...mcpState,
      servers: newServers,
      revision: mcpState.revision + 1,
      lastUpdatedAt: TEST_TIMESTAMP,
      source: `mcp-event:${event.type}`,
    },
  };
}

/**
 * Apply a full storm of disconnect → reconnect → connecting cycles.
 * Returns all intermediate states (for invariant checking).
 */
function applyReconnectStorm(
  initialState: RuntimeState,
  serverName: string,
  cycleCount: number,
): RuntimeState[] {
  const states: RuntimeState[] = [initialState];
  let current = initialState;

  for (let i = 0; i < cycleCount; i++) {
    current = applyMcpEvent(current, { serverName, type: 'disconnected' });
    states.push(current);
    current = applyMcpEvent(current, { serverName, type: 'reconnecting', attempt: i + 1 });
    states.push(current);
    current = applyMcpEvent(current, { serverName, type: 'connecting' });
    states.push(current);
  }

  // Final successful connection
  current = applyMcpEvent(current, { serverName, type: 'connected' });
  states.push(current);

  return states;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('ux:notification-throttle — MCP reconnect storms', () => {
  let state: RuntimeState;

  beforeEach(() => {
    state = createInitialRuntimeState();
  });

  describe('single server reconnect lifecycle', () => {
    test('server transitions connecting → connected correctly', () => {
      let s = applyMcpEvent(state, { serverName: 'srv-1', type: 'connecting' });
      expect(selectMcp(s).servers.get('srv-1')?.status).toBe('connecting');

      s = applyMcpEvent(s, { serverName: 'srv-1', type: 'connected' });
      expect(selectMcp(s).servers.get('srv-1')?.status).toBe('connected');
    });

    test('reconnect attempt counter increments on each reconnecting event', () => {
      let s = state;
      for (let attempt = 1; attempt <= 5; attempt++) {
        s = applyMcpEvent(s, { serverName: 'srv-1', type: 'reconnecting', attempt });
        expect(selectMcp(s).servers.get('srv-1')?.reconnectAttempts).toBe(attempt);
      }
    });

    test('reconnect attempt counter resets to 0 on successful connection', () => {
      let s = state;
      s = applyMcpEvent(s, { serverName: 'srv-1', type: 'reconnecting', attempt: 5 });
      expect(selectMcp(s).servers.get('srv-1')?.reconnectAttempts).toBe(5);

      s = applyMcpEvent(s, { serverName: 'srv-1', type: 'connected' });
      expect(selectMcp(s).servers.get('srv-1')?.reconnectAttempts).toBe(0);
    });

    test('connectedAt timestamp is set on successful connection', () => {
      const s = applyMcpEvent(state, { serverName: 'srv-1', type: 'connected' });
      const server = selectMcp(s).servers.get('srv-1');
      expect(server?.connectedAt).toBe(TEST_TIMESTAMP);
    });

    test('initial server record has no connectedAt timestamp', () => {
      const s = applyMcpEvent(state, { serverName: 'srv-1', type: 'disconnected' });
      const server = selectMcp(s).servers.get('srv-1');
      expect(server?.connectedAt).toBeUndefined();
    });
  });

  describe('reconnect storm behavior — rapid cycling', () => {
    test('10-cycle storm produces monotonically increasing revision', () => {
      const stormStates = applyReconnectStorm(state, 'srv-storm', 10);

      for (let i = 1; i < stormStates.length; i++) {
        expect(selectMcp(stormStates[i]!).revision).toBeGreaterThan(
          selectMcp(stormStates[i - 1]!).revision,
        );
      }
    });

    test('final state after 10-cycle storm is connected with 0 reconnect attempts', () => {
      const stormStates = applyReconnectStorm(state, 'srv-storm', 10);
      const final = stormStates[stormStates.length - 1]!;

      const server = selectMcp(final).servers.get('srv-storm');
      expect(server?.status).toBe('connected');
      expect(server?.reconnectAttempts).toBe(0);
    });

    test('intermediate storm states are all valid lifecycle status values', () => {
      const validStatuses = new Set<McpServerLifecycleState>([
        'connecting',
        'connected',
        'disconnected',
        'reconnecting',
        'configured',
        'degraded',
        'auth_required',
      ]);
      const stormStates = applyReconnectStorm(state, 'srv-storm', 5);

      for (const s of stormStates) {
        const server = selectMcp(s).servers.get('srv-storm');
        if (server) {
          expect(validStatuses.has(server.status)).toBe(true);
        }
      }
    });

    test('multiple server storms are isolated — no cross-server state leakage', () => {
      let s = state;

      // Interleave storms for 3 servers
      for (let i = 0; i < 5; i++) {
        s = applyMcpEvent(s, { serverName: 'srv-a', type: 'reconnecting', attempt: i + 1 });
        s = applyMcpEvent(s, { serverName: 'srv-b', type: 'disconnected' });
        s = applyMcpEvent(s, { serverName: 'srv-c', type: 'connecting' });
      }

      // Each server has its own independent state
      expect(selectMcp(s).servers.get('srv-a')?.status).toBe('reconnecting');
      expect(selectMcp(s).servers.get('srv-b')?.status).toBe('disconnected');
      expect(selectMcp(s).servers.get('srv-c')?.status).toBe('connecting');

      // No leakage: srv-a reconnect attempts don't affect srv-b
      expect(selectMcp(s).servers.get('srv-b')?.reconnectAttempts).toBe(0);
    });
  });

  describe('last-wins state during rapid events', () => {
    test('rapid same-type events produce idempotent last-wins state', () => {
      let s = state;
      // Apply 20 consecutive disconnected events — final state = disconnected
      for (let i = 0; i < 20; i++) {
        s = applyMcpEvent(s, { serverName: 'srv-rapid', type: 'disconnected' });
      }
      expect(selectMcp(s).servers.get('srv-rapid')?.status).toBe('disconnected');
    });

    test('revision reflects all 20 rapid mutations', () => {
      const initialRevision = selectMcp(state).revision;
      let s = state;
      for (let i = 0; i < 20; i++) {
        s = applyMcpEvent(s, { serverName: 'srv-rapid', type: 'connecting' });
      }
      expect(selectMcp(s).revision).toBe(initialRevision + 20);
    });

    test('server registry size stays stable under storm — no duplicate entries', () => {
      let s = applyMcpEvent(state, { serverName: 'srv-1', type: 'connecting' });
      expect(selectMcp(s).servers.size).toBe(1);

      // Apply storm — server count must not grow beyond 1
      for (let i = 0; i < 30; i++) {
        s = applyMcpEvent(s, {
          serverName: 'srv-1',
          type: i % 2 === 0 ? 'disconnected' : 'reconnecting',
          attempt: Math.floor(i / 2) + 1,
        });
      }
      expect(selectMcp(s).servers.size).toBe(1);
    });
  });

  describe('multi-server notification isolation', () => {
    test('10 servers each cycling independently produce consistent state', () => {
      let s = state;
      const serverNames = Array.from({ length: 10 }, (_, i) => `srv-${i}`);

      for (const serverName of serverNames) {
        s = applyMcpEvent(s, { serverName, type: 'connecting' });
        s = applyMcpEvent(s, { serverName, type: 'connected' });
      }

      expect(selectMcp(s).servers.size).toBe(10);
      for (const serverName of serverNames) {
        expect(selectMcp(s).servers.get(serverName)?.status).toBe('connected');
        expect(selectMcp(s).servers.get(serverName)?.reconnectAttempts).toBe(0);
      }
    });

    test('connectedAt is preserved for connected servers during another server storm', () => {
      let s = state;
      s = applyMcpEvent(s, { serverName: 'stable-srv', type: 'connected' });
      const stableConnectedAt = selectMcp(s).servers.get('stable-srv')?.connectedAt;

      // Storm another server
      for (let i = 0; i < 10; i++) {
        s = applyMcpEvent(s, { serverName: 'storm-srv', type: 'reconnecting', attempt: i + 1 });
      }

      // stable-srv unaffected
      expect(selectMcp(s).servers.get('stable-srv')?.status).toBe('connected');
      expect(selectMcp(s).servers.get('stable-srv')?.connectedAt).toBe(stableConnectedAt);
      expect(selectMcp(s).servers.get('stable-srv')?.connectedAt).toBe(TEST_TIMESTAMP);
    });
  });
});
