/**
 * MCP schema drift quarantine — execution block tests.
 *
 * Verifies that:
 *   - stale/incompatible schemas are quarantined correctly
 *   - tool execution is blocked while a schema is quarantined
 *   - operator override (approveQuarantine) temporarily unblocks execution
 *   - a successful schema refresh clears quarantine
 *   - auto-quarantine triggers after the consecutive failure threshold
 *   - events are emitted on quarantine and approval
 */

import { describe, test, expect } from 'bun:test';
import { McpSchemaFreshnessTracker } from '@pellux/goodvibes-sdk/platform/runtime/mcp/schema-freshness';
import { McpLifecycleManager } from '@pellux/goodvibes-sdk/platform/runtime/mcp/manager';
import type { McpEvent } from '@pellux/goodvibes-sdk/platform/runtime/events/mcp';
import type { QuarantineReason } from '@pellux/goodvibes-sdk/platform/runtime/mcp/types';

// ---------------------------------------------------------------------------
// McpSchemaFreshnessTracker — quarantine unit tests
// ---------------------------------------------------------------------------

describe('McpSchemaFreshnessTracker: quarantine', () => {
  describe('markQuarantined', () => {
    test('sets freshness to quarantined', () => {
      const tracker = new McpSchemaFreshnessTracker();
      tracker.registerServer('srv');
      tracker.markQuarantined('srv', 'incompatible', 'schema version mismatch');
      expect(tracker.getFreshness('srv')).toBe('quarantined');
    });

    test('isQuarantined returns true after markQuarantined', () => {
      const tracker = new McpSchemaFreshnessTracker();
      tracker.registerServer('srv');
      tracker.markQuarantined('srv', 'operator_flagged');
      expect(tracker.isQuarantined('srv')).toBe(true);
    });

    test('quarantine record stores reason and timestamp', () => {
      const tracker = new McpSchemaFreshnessTracker();
      tracker.registerServer('srv');
      const before = Date.now();
      tracker.markQuarantined('srv', 'stale_threshold', 'too many retries');
      const record = tracker.getRecord('srv');
      expect(record?.quarantine?.reason).toBe('stale_threshold');
      expect(record?.quarantine?.detail).toBe('too many retries');
      expect(record?.quarantine?.quarantinedAt).toBeGreaterThanOrEqual(before);
    });

    test('quarantine is sticky — markStale does not override quarantine', () => {
      const tracker = new McpSchemaFreshnessTracker();
      tracker.registerServer('srv');
      tracker.markFresh('srv');
      tracker.markQuarantined('srv', 'incompatible');
      // markStale only affects 'fresh' records; quarantine should remain
      tracker.markStale('srv');
      expect(tracker.getFreshness('srv')).toBe('quarantined');
    });

    test('quarantining an unregistered server creates a record', () => {
      const tracker = new McpSchemaFreshnessTracker();
      tracker.markQuarantined('ghost', 'operator_flagged');
      expect(tracker.getFreshness('ghost')).toBe('quarantined');
    });
  });

  describe('auto-quarantine on consecutive failures', () => {
    test('auto-quarantines after threshold consecutive failures', () => {
      // threshold=2 means 2nd failure triggers quarantine
      const tracker = new McpSchemaFreshnessTracker(undefined, 2);
      tracker.registerServer('srv');
      tracker.markFailed('srv', 'timeout');
      expect(tracker.getFreshness('srv')).toBe('fetch_failed');
      tracker.markFailed('srv', 'timeout again');
      expect(tracker.getFreshness('srv')).toBe('quarantined');
    });

    test('auto-quarantine record has reason stale_threshold', () => {
      const tracker = new McpSchemaFreshnessTracker(undefined, 2);
      tracker.registerServer('srv');
      tracker.markFailed('srv', 'err1');
      tracker.markFailed('srv', 'err2');
      const record = tracker.getRecord('srv');
      expect(record?.quarantine?.reason).toBe('stale_threshold');
    });

    test('single failure below threshold does not quarantine', () => {
      const tracker = new McpSchemaFreshnessTracker(undefined, 3);
      tracker.registerServer('srv');
      tracker.markFailed('srv', 'transient');
      expect(tracker.getFreshness('srv')).toBe('fetch_failed');
      expect(tracker.isQuarantined('srv')).toBe(false);
    });
  });

  describe('approveQuarantine — operator override', () => {
    test('transitions quarantined to stale after operator approval', () => {
      const tracker = new McpSchemaFreshnessTracker();
      tracker.registerServer('srv');
      tracker.markQuarantined('srv', 'operator_flagged');
      tracker.approveQuarantine('srv', 'operator-alice');
      expect(tracker.getFreshness('srv')).toBe('stale');
    });

    test('isQuarantined returns false after approval', () => {
      const tracker = new McpSchemaFreshnessTracker();
      tracker.registerServer('srv');
      tracker.markQuarantined('srv', 'incompatible');
      tracker.approveQuarantine('srv', 'operator-bob');
      expect(tracker.isQuarantined('srv')).toBe(false);
    });

    test('operator id is recorded in quarantine record', () => {
      const tracker = new McpSchemaFreshnessTracker();
      tracker.registerServer('srv');
      tracker.markQuarantined('srv', 'operator_flagged');
      const before = Date.now();
      tracker.approveQuarantine('srv', 'operator-carol');
      const record = tracker.getRecord('srv');
      expect(record?.quarantine?.overrideAcknowledgedBy).toBe('operator-carol');
      expect(record?.quarantine?.overrideAcknowledgedAt).toBeGreaterThanOrEqual(before);
    });

    test('approveQuarantine on non-quarantined server is a no-op', () => {
      const tracker = new McpSchemaFreshnessTracker();
      tracker.registerServer('srv');
      tracker.markFresh('srv');
      // Should not throw or change freshness
      tracker.approveQuarantine('srv', 'operator-dan');
      expect(tracker.getFreshness('srv')).toBe('fresh');
    });

    test('approveQuarantine on unknown server is a no-op', () => {
      const tracker = new McpSchemaFreshnessTracker();
      // Should not throw
      expect(() => tracker.approveQuarantine('ghost', 'operator-eve')).not.toThrow();
    });
  });

  describe('re-quarantine after approval', () => {
    test('single failure after approval does not immediately re-quarantine', () => {
      // threshold=2: two consecutive failures required to auto-quarantine
      const tracker = new McpSchemaFreshnessTracker(undefined, 2);
      tracker.registerServer('srv');
      // Drive to quarantine via threshold
      tracker.markFailed('srv', 'err1');
      tracker.markFailed('srv', 'err2');
      expect(tracker.getFreshness('srv')).toBe('quarantined');
      // Operator approves — resets consecutiveFailures to 0
      tracker.approveQuarantine('srv', 'operator-alice');
      expect(tracker.getFreshness('srv')).toBe('stale');
      // One transient failure below threshold: should NOT re-quarantine
      tracker.markFailed('srv', 'transient');
      expect(tracker.getFreshness('srv')).toBe('fetch_failed');
      expect(tracker.isQuarantined('srv')).toBe(false);
    });

    test('failures at threshold after approval do re-quarantine', () => {
      // threshold=2
      const tracker = new McpSchemaFreshnessTracker(undefined, 2);
      tracker.registerServer('srv');
      tracker.markFailed('srv', 'err1');
      tracker.markFailed('srv', 'err2');
      tracker.approveQuarantine('srv', 'operator-bob');
      // Now two more failures should re-quarantine
      tracker.markFailed('srv', 'new-err1');
      expect(tracker.isQuarantined('srv')).toBe(false);
      tracker.markFailed('srv', 'new-err2');
      expect(tracker.getFreshness('srv')).toBe('quarantined');
    });
  });

  describe('markFresh clears quarantine', () => {
    test('markFresh transitions quarantined back to fresh', () => {
      const tracker = new McpSchemaFreshnessTracker();
      tracker.registerServer('srv');
      tracker.markQuarantined('srv', 'incompatible');
      tracker.markFresh('srv');
      expect(tracker.getFreshness('srv')).toBe('fresh');
      expect(tracker.isQuarantined('srv')).toBe(false);
    });

    test('markFresh clears quarantine record', () => {
      const tracker = new McpSchemaFreshnessTracker();
      tracker.registerServer('srv');
      tracker.markQuarantined('srv', 'operator_flagged', 'manual flag');
      tracker.markFresh('srv');
      const record = tracker.getRecord('srv');
      expect(record?.quarantine).toBeUndefined();
      expect(record?.consecutiveFailures).toBe(0);
    });
  });
});

// ---------------------------------------------------------------------------
// McpLifecycleManager — quarantine execution block
// ---------------------------------------------------------------------------

describe('McpLifecycleManager: quarantine execution block', () => {
  function makeManager(): { mgr: McpLifecycleManager; events: McpEvent[] } {
    const mgr = new McpLifecycleManager();
    const events: McpEvent[] = [];
    mgr.onEvent((e) => events.push(e));
    // Seed permissions so the server is registered
    mgr['permissions'].registerServer('my-server', 'standard');
    mgr['freshness'].registerServer('my-server');
    return { mgr, events };
  }

  describe('isToolAllowed blocks quarantined schema', () => {
    test('tool call denied when schema is quarantined', () => {
      const { mgr } = makeManager();
      mgr.quarantineSchema('my-server', 'incompatible', 'v2 schema required');
      const result = mgr.isToolAllowed('my-server', 'any-tool');
      expect(result.allowed).toBe(false);
    });

    test('denial reason mentions quarantine', () => {
      const { mgr } = makeManager();
      mgr.quarantineSchema('my-server', 'incompatible');
      const result = mgr.isToolAllowed('my-server', 'any-tool');
      expect(result.reason).toMatch(/quarantined/i);
    });

    test('trusted server is also blocked when schema is quarantined', () => {
      const { mgr } = makeManager();
      mgr.setTrustLevel('my-server', 'trusted');
      mgr.quarantineSchema('my-server', 'stale_threshold');
      const result = mgr.isToolAllowed('my-server', 'trusted-tool');
      expect(result.allowed).toBe(false);
    });

    test('tool call allowed after operator approves quarantine', () => {
      const { mgr } = makeManager();
      mgr.quarantineSchema('my-server', 'operator_flagged');
      expect(mgr.isToolAllowed('my-server', 'some-tool').allowed).toBe(false);

      mgr.approveSchemaQuarantine('my-server', 'operator-frank');
      const result = mgr.isToolAllowed('my-server', 'some-tool');
      expect(result.allowed).toBe(true);
    });

    test('non-quarantined server is not blocked', () => {
      const { mgr } = makeManager();
      const result = mgr.isToolAllowed('my-server', 'read-file');
      expect(result.allowed).toBe(true);
    });
  });

  describe('isSchemaQuarantined', () => {
    test('returns true after quarantineSchema', () => {
      const { mgr } = makeManager();
      mgr.quarantineSchema('my-server', 'incompatible');
      expect(mgr.isSchemaQuarantined('my-server')).toBe(true);
    });

    test('returns false before quarantine', () => {
      const { mgr } = makeManager();
      expect(mgr.isSchemaQuarantined('my-server')).toBe(false);
    });

    test('returns false after operator approval', () => {
      const { mgr } = makeManager();
      mgr.quarantineSchema('my-server', 'stale_threshold');
      mgr.approveSchemaQuarantine('my-server', 'operator-grace');
      expect(mgr.isSchemaQuarantined('my-server')).toBe(false);
    });
  });

  describe('MCP_SCHEMA_QUARANTINED event', () => {
    test('emits MCP_SCHEMA_QUARANTINED when quarantineSchema is called', () => {
      const { mgr, events } = makeManager();
      mgr.quarantineSchema('my-server', 'incompatible', 'version mismatch');
      const ev = events.find((e) => e.type === 'MCP_SCHEMA_QUARANTINED');
      expect(ev).toBeDefined();
      expect(ev?.type === 'MCP_SCHEMA_QUARANTINED' && ev.serverId).toBe('my-server');
    });

    test('MCP_SCHEMA_QUARANTINED carries reason and detail', () => {
      const { mgr, events } = makeManager();
      mgr.quarantineSchema('my-server', 'stale_threshold', 'too stale');
      const ev = events.find((e) => e.type === 'MCP_SCHEMA_QUARANTINED');
      if (!ev || ev.type !== 'MCP_SCHEMA_QUARANTINED') throw new Error('event missing');
      expect(ev.reason).toBe('stale_threshold');
      expect(ev.detail).toBe('too stale');
    });
  });

  describe('MCP_SCHEMA_QUARANTINE_APPROVED event', () => {
    test('emits MCP_SCHEMA_QUARANTINE_APPROVED on operator approval', () => {
      const { mgr, events } = makeManager();
      mgr.quarantineSchema('my-server', 'operator_flagged');
      mgr.approveSchemaQuarantine('my-server', 'operator-henry');
      const ev = events.find((e) => e.type === 'MCP_SCHEMA_QUARANTINE_APPROVED');
      expect(ev).toBeDefined();
      if (!ev || ev.type !== 'MCP_SCHEMA_QUARANTINE_APPROVED') throw new Error('event missing');
      expect(ev.operatorId).toBe('operator-henry');
      expect(ev.serverId).toBe('my-server');
    });

    test('approveSchemaQuarantine on non-quarantined server does not emit event', () => {
      const { mgr, events } = makeManager();
      mgr.approveSchemaQuarantine('my-server', 'operator-ivan');
      const ev = events.find((e) => e.type === 'MCP_SCHEMA_QUARANTINE_APPROVED');
      expect(ev).toBeUndefined();
    });
  });

  describe('quarantine rollback via getSchemaFreshness', () => {
    test('getSchemaFreshness returns quarantined when blocked', () => {
      const { mgr } = makeManager();
      mgr.quarantineSchema('my-server', 'incompatible');
      expect(mgr.getSchemaFreshness('my-server')).toBe('quarantined');
    });

    test('getSchemaFreshness returns stale after operator approval', () => {
      const { mgr } = makeManager();
      mgr.quarantineSchema('my-server', 'incompatible');
      mgr.approveSchemaQuarantine('my-server', 'operator-judy');
      expect(mgr.getSchemaFreshness('my-server')).toBe('stale');
    });
  });
});
