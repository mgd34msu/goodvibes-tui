/**
 * Chaos: MCP reconnect flapping and auth-expiry simulation.
 *
 * Tests the MCP lifecycle state machine under rapid connect/disconnect
 * cycles and the reconnect configuration limits. No real network calls.
 *
 * MCP state machine transitions:
 *   configured -> connecting -> connected -> reconnecting -> connecting (loop)
 *   connecting -> reconnecting (direct, on transient failure before connected)
 *   reconnecting -> disconnected (give up)
 *   disconnected -> connecting (restart)
 */

import { describe, test, expect } from 'bun:test';
import {
  canTransition,
  applyTransition,
  isOperational,
  isTerminal,
  reachableFrom,
} from '../../runtime/mcp/lifecycle.ts';
import { McpPermissionManager } from '../../runtime/mcp/permissions.ts';
import { DEFAULT_RECONNECT_CONFIG } from '../../runtime/mcp/types.ts';
import type { McpServerState } from '../../runtime/mcp/types.ts';

// ---------------------------------------------------------------------------
// MCP lifecycle state transitions
// ---------------------------------------------------------------------------

describe('chaos: MCP reconnect flapping', () => {
  describe('basic state machine transitions', () => {
    test('configured -> connecting is valid', () => {
      expect(canTransition('configured', 'connecting')).toBe(true);
    });

    test('connecting -> connected is valid', () => {
      expect(canTransition('connecting', 'connected')).toBe(true);
    });

    test('connected -> reconnecting is valid', () => {
      expect(canTransition('connected', 'reconnecting')).toBe(true);
    });

    test('reconnecting -> connecting is valid (retry loop)', () => {
      expect(canTransition('reconnecting', 'connecting')).toBe(true);
    });

    test('reconnecting -> disconnected is valid (give up)', () => {
      expect(canTransition('reconnecting', 'disconnected')).toBe(true);
    });

    test('connected -> disconnected is valid (clean disconnect)', () => {
      expect(canTransition('connected', 'disconnected')).toBe(true);
    });

    test('disconnected -> connecting is valid (restart)', () => {
      expect(canTransition('disconnected', 'connecting')).toBe(true);
    });

    test('auth_required -> connecting is valid (retry after auth)', () => {
      expect(canTransition('auth_required', 'connecting')).toBe(true);
    });
  });

  describe('flapping — rapid connect/disconnect cycles', () => {
    test('single flap cycle: configured -> connecting -> connected -> reconnecting', () => {
      let state: McpServerState = 'configured';

      const r1 = applyTransition(state, 'connecting');
      expect(r1.success).toBe(true);
      if (r1.success) state = r1.next;
      expect(state).toBe('connecting');

      const r2 = applyTransition(state, 'connected');
      expect(r2.success).toBe(true);
      if (r2.success) state = r2.next;
      expect(state).toBe('connected');

      const r3 = applyTransition(state, 'reconnecting');
      expect(r3.success).toBe(true);
      if (r3.success) state = r3.next;
      expect(state).toBe('reconnecting');
    });

    test('reconnecting state can re-enter connecting (retry)', () => {
      let state: McpServerState = 'reconnecting';
      const r = applyTransition(state, 'connecting');
      expect(r.success).toBe(true);
      if (r.success) state = r.next;
      expect(state).toBe('connecting');
    });

    test('reconnecting state is not operational (tools should be blocked)', () => {
      expect(isOperational('reconnecting')).toBe(false);
    });

    test('connected state is operational', () => {
      expect(isOperational('connected')).toBe(true);
    });

    test('disconnected state is not operational', () => {
      expect(isOperational('disconnected')).toBe(false);
    });

    test('degraded state is operational', () => {
      expect(isOperational('degraded')).toBe(true);
    });
  });

  describe('auth-expiry: reconnect exhaustion', () => {
    test('DEFAULT_RECONNECT_CONFIG has sensible maxAttempts', () => {
      expect(DEFAULT_RECONNECT_CONFIG.maxAttempts).toBeGreaterThan(0);
      expect(DEFAULT_RECONNECT_CONFIG.maxAttempts).toBeLessThanOrEqual(20);
    });

    test('DEFAULT_RECONNECT_CONFIG base delay is positive', () => {
      expect(DEFAULT_RECONNECT_CONFIG.baseDelayMs).toBeGreaterThan(0);
    });

    test('after exhausted reconnect attempts, can transition to disconnected', () => {
      // Simulate: N reconnect attempts -> then give up -> disconnected
      let state: McpServerState = 'reconnecting';

      for (let i = 0; i < DEFAULT_RECONNECT_CONFIG.maxAttempts; i++) {
        // Attempt to reconnect (reconnecting -> connecting)
        const tryConnect = applyTransition(state, 'connecting');
        if (tryConnect.success) {
          state = tryConnect.next;
          // Auth expiry: fail back to reconnecting from connecting
          const failBack = applyTransition(state, 'reconnecting');
          if (failBack.success) state = failBack.next;
        }
      }

      // After exhausting retries, state is still 'reconnecting'; give up -> disconnected
      expect(state).toBe('reconnecting');
      const giveUp = applyTransition(state, 'disconnected');
      expect(giveUp.success).toBe(true);
      if (giveUp.success) expect(giveUp.next).toBe('disconnected');
    });

    test('disconnected is a terminal state (isTerminal)', () => {
      expect(isTerminal('disconnected')).toBe(true);
    });

    test('reconnecting is not terminal (can still retry)', () => {
      expect(isTerminal('reconnecting')).toBe(false);
    });
  });

  describe('reachableFrom — state graph integrity', () => {
    test('configured has reachable states', () => {
      const reachable = reachableFrom('configured');
      expect(reachable.size).toBeGreaterThan(0);
    });

    test('reconnecting can reach connecting or disconnected', () => {
      const reachable = reachableFrom('reconnecting');
      expect(reachable.has('connecting')).toBe(true);
      expect(reachable.has('disconnected')).toBe(true);
    });

    test('disconnected can reconnect (reachable states not empty)', () => {
      const reachable = reachableFrom('disconnected');
      expect(reachable.size).toBeGreaterThan(0);
      expect(reachable.has('connecting')).toBe(true);
    });
  });

  describe('MCP permission manager — trust enforcement during flap', () => {
    test('unregistered server denies all tool calls', () => {
      const mgr = new McpPermissionManager();
      const result = mgr.isToolAllowed('ghost-server', 'dangerous-tool');
      expect(result.allowed).toBe(false);
    });

    test('registered server with standard trust allows tools by default', () => {
      const mgr = new McpPermissionManager();
      mgr.registerServer('my-server', 'standard');
      const result = mgr.isToolAllowed('my-server', 'read-file');
      expect(result.allowed).toBe(true);
    });

    test('explicitly denied tool is blocked even if server is registered', () => {
      const mgr = new McpPermissionManager();
      mgr.registerServer('my-server', 'standard');
      mgr.denyTool('my-server', 'drop-database');
      const result = mgr.isToolAllowed('my-server', 'drop-database');
      expect(result.allowed).toBe(false);
    });

    test('reconnect does not grant new permissions (server deny persists after re-register)', () => {
      const mgr = new McpPermissionManager();
      mgr.registerServer('my-server', 'standard');
      mgr.denyTool('my-server', 'write-fs');

      // Simulate reconnect: re-register the server (idempotent)
      mgr.registerServer('my-server', 'standard');

      // Deny should still hold (no permission escalation on reconnect)
      const result = mgr.isToolAllowed('my-server', 'write-fs');
      expect(result.allowed).toBe(false);
    });
  });
});
