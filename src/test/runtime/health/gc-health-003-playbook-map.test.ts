/**
 * GC-HEALTH-003: Playbook mapping completeness tests.
 *
 * Verifies that:
 * - Every cascade rule in CASCADE_RULES has at least one entry in CASCADE_PLAYBOOK_MAP
 * - Every playbook ID referenced in the map corresponds to a real playbook
 * - ALL_CASCADE_RULE_IDS is in sync with CASCADE_RULES
 * - The mapping is exhaustive (no unmapped rules)
 */

import { describe, test, expect } from 'bun:test';
import { CASCADE_RULES } from '@/runtime/index.ts';
import { CASCADE_PLAYBOOK_MAP, ALL_CASCADE_RULE_IDS } from '@/runtime/index.ts';
import {
  stuckTurnPlaybook,
  reconnectFailurePlaybook,
  permissionDeadlockPlaybook,
  pluginDegradationPlaybook,
  exportRecoveryPlaybook,
  sessionUnrecoverablePlaybook,
  compactionFailurePlaybook,
} from '@/runtime/index.ts';

// Build the set of all known playbook IDs from the registry
const ALL_KNOWN_PLAYBOOKS = new Map([
  [stuckTurnPlaybook.id, stuckTurnPlaybook],
  [reconnectFailurePlaybook.id, reconnectFailurePlaybook],
  [permissionDeadlockPlaybook.id, permissionDeadlockPlaybook],
  [pluginDegradationPlaybook.id, pluginDegradationPlaybook],
  [exportRecoveryPlaybook.id, exportRecoveryPlaybook],
  [sessionUnrecoverablePlaybook.id, sessionUnrecoverablePlaybook],
  [compactionFailurePlaybook.id, compactionFailurePlaybook],
]);

// ---------------------------------------------------------------------------
// 1. All cascade rule IDs are mapped
// ---------------------------------------------------------------------------

describe('CASCADE_PLAYBOOK_MAP — completeness', () => {
  test('every cascade rule has at least one playbook mapping', () => {
    for (const rule of CASCADE_RULES) {
      const playbooks = CASCADE_PLAYBOOK_MAP.get(rule.id);
      expect(
        playbooks,
        `Rule '${rule.id}' has no entry in CASCADE_PLAYBOOK_MAP`,
      ).toBeDefined();
      expect(
        playbooks!.length,
        `Rule '${rule.id}' maps to zero playbooks`,
      ).toBeGreaterThan(0);
    }
  });

  test('no cascade rule is mapped to an empty array', () => {
    for (const [ruleId, playbooks] of CASCADE_PLAYBOOK_MAP) {
      expect(
        playbooks.length,
        `Rule '${ruleId}' maps to an empty playbook array`,
      ).toBeGreaterThan(0);
    }
  });

  test('all entries in CASCADE_PLAYBOOK_MAP correspond to real cascade rules', () => {
    const ruleIds = new Set(CASCADE_RULES.map((r) => r.id));
    for (const ruleId of CASCADE_PLAYBOOK_MAP.keys()) {
      expect(
        ruleIds.has(ruleId),
        `CASCADE_PLAYBOOK_MAP has entry for unknown rule: '${ruleId}'`,
      ).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. All referenced playbook IDs resolve to real playbooks
// ---------------------------------------------------------------------------

describe('CASCADE_PLAYBOOK_MAP — playbook ID validity', () => {
  test('every playbook ID in the map exists as a real playbook', () => {
    for (const [ruleId, playbookIds] of CASCADE_PLAYBOOK_MAP) {
      for (const playbookId of playbookIds) {
        expect(
          ALL_KNOWN_PLAYBOOKS.has(playbookId),
          `Rule '${ruleId}' references unknown playbook '${playbookId}'`,
        ).toBe(true);
      }
    }
  });

  test('all playbook IDs in the map are non-empty strings', () => {
    for (const playbookIds of CASCADE_PLAYBOOK_MAP.values()) {
      for (const id of playbookIds) {
        expect(typeof id).toBe('string');
        expect(id.length).toBeGreaterThan(0);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 3. ALL_CASCADE_RULE_IDS synchronisation
// ---------------------------------------------------------------------------

describe('ALL_CASCADE_RULE_IDS — sync with CASCADE_RULES', () => {
  test('ALL_CASCADE_RULE_IDS contains every rule ID from CASCADE_RULES', () => {
    const ruleIdSet = new Set(ALL_CASCADE_RULE_IDS);
    for (const rule of CASCADE_RULES) {
      expect(
        ruleIdSet.has(rule.id),
        `Rule '${rule.id}' is missing from ALL_CASCADE_RULE_IDS`,
      ).toBe(true);
    }
  });

  test('ALL_CASCADE_RULE_IDS does not contain extra IDs not in CASCADE_RULES', () => {
    const cascadeRuleIdSet = new Set(CASCADE_RULES.map((r) => r.id));
    for (const id of ALL_CASCADE_RULE_IDS) {
      expect(
        cascadeRuleIdSet.has(id),
        `ALL_CASCADE_RULE_IDS contains stale entry '${id}' not in CASCADE_RULES`,
      ).toBe(true);
    }
  });

  test('ALL_CASCADE_RULE_IDS length matches CASCADE_RULES length', () => {
    expect(ALL_CASCADE_RULE_IDS.length).toBe(CASCADE_RULES.length);
  });
});

// ---------------------------------------------------------------------------
// 4. Specific per-rule playbook assertions
// ---------------------------------------------------------------------------

describe('CASCADE_PLAYBOOK_MAP — per-rule assertions', () => {
  test('turn-failed-cancels-tools → stuck-turn', () => {
    expect(CASCADE_PLAYBOOK_MAP.get('turn-failed-cancels-tools')).toContain('stuck-turn');
  });

  test('tool-failed-errors-turn → stuck-turn', () => {
    expect(CASCADE_PLAYBOOK_MAP.get('tool-failed-errors-turn')).toContain('stuck-turn');
  });

  test('mcp-disconnected-blocks-mcp-tools → reconnect-failure', () => {
    expect(CASCADE_PLAYBOOK_MAP.get('mcp-disconnected-blocks-mcp-tools')).toContain('reconnect-failure');
  });

  test('agent-failed-marks-child-tasks → stuck-turn', () => {
    expect(CASCADE_PLAYBOOK_MAP.get('agent-failed-marks-child-tasks')).toContain('stuck-turn');
  });

  test('plugin-error-deregisters-tools → plugin-degradation', () => {
    expect(CASCADE_PLAYBOOK_MAP.get('plugin-error-deregisters-tools')).toContain('plugin-degradation');
  });

  test('transport-disconnected-blocks-remote-tasks → reconnect-failure', () => {
    expect(CASCADE_PLAYBOOK_MAP.get('transport-disconnected-blocks-remote-tasks')).toContain('reconnect-failure');
  });

  test('session-recovery-failed-unrecoverable → session-unrecoverable', () => {
    expect(CASCADE_PLAYBOOK_MAP.get('session-recovery-failed-unrecoverable')).toContain('session-unrecoverable');
  });

  test('compaction-failed-blocks-new-turns → compaction-failure', () => {
    expect(CASCADE_PLAYBOOK_MAP.get('compaction-failed-blocks-new-turns')).toContain('compaction-failure');
  });
});

// ---------------------------------------------------------------------------
// 5. New playbooks are valid
// ---------------------------------------------------------------------------

describe('new playbooks — structural validity', () => {
  test('sessionUnrecoverablePlaybook has required fields', () => {
    expect(sessionUnrecoverablePlaybook.id).toBe('session-unrecoverable');
    expect(sessionUnrecoverablePlaybook.name.length).toBeGreaterThan(0);
    expect(sessionUnrecoverablePlaybook.steps.length).toBeGreaterThan(0);
    expect(sessionUnrecoverablePlaybook.checks.length).toBeGreaterThan(0);
    expect(sessionUnrecoverablePlaybook.escalationCriteria.length).toBeGreaterThan(0);
  });

  test('compactionFailurePlaybook has required fields', () => {
    expect(compactionFailurePlaybook.id).toBe('compaction-failure');
    expect(compactionFailurePlaybook.name.length).toBeGreaterThan(0);
    expect(compactionFailurePlaybook.steps.length).toBeGreaterThan(0);
    expect(compactionFailurePlaybook.checks.length).toBeGreaterThan(0);
    expect(compactionFailurePlaybook.escalationCriteria.length).toBeGreaterThan(0);
  });

  test('sessionUnrecoverablePlaybook tags include session and critical', () => {
    expect(sessionUnrecoverablePlaybook.tags).toContain('session');
    expect(sessionUnrecoverablePlaybook.tags).toContain('critical');
  });

  test('compactionFailurePlaybook tags include compaction', () => {
    expect(compactionFailurePlaybook.tags).toContain('compaction');
  });
});
