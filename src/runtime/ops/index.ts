/**
 * Operational runbook registry for the goodvibes-tui runtime.
 *
 * Provides a machine-readable playbook registry consumed by the diagnostics
 * panel. Each playbook describes symptoms, diagnostic checks, resolution
 * steps, and escalation criteria for a specific failure scenario.
 *
 * @example
 * ```ts
 * import { getPlaybookRegistry, getPlaybook } from '@pellux/goodvibes-sdk/platform/runtime/ops/index';
 *
 * const registry = getPlaybookRegistry();
 * const playbook = getPlaybook('stuck-turn');
 * if (playbook) {
 *   for (const check of playbook.checks) {
 *     const result = await check.run();
 *     console.log(check.label, result.passed ? 'PASS' : 'FAIL', result.summary);
 *   }
 * }
 * ```
 */

// Re-export types
export type {
  DiagnosticSeverity,
  DiagnosticCheckResult,
  DiagnosticCheck,
  PlaybookStepKind,
  PlaybookStep,
  Playbook,
  PlaybookRegistryEntry,
  PlaybookRegistry,
} from '@pellux/goodvibes-sdk/platform/runtime/ops/types';

// Re-export all playbooks
export {
  stuckTurnPlaybook,
  reconnectFailurePlaybook,
  permissionDeadlockPlaybook,
  pluginDegradationPlaybook,
  exportRecoveryPlaybook,
  sessionUnrecoverablePlaybook,
  compactionFailurePlaybook,
} from '@pellux/goodvibes-sdk/platform/runtime/ops/playbooks/index';

import type { Playbook, PlaybookRegistry, PlaybookRegistryEntry } from '@pellux/goodvibes-sdk/platform/runtime/ops/types';
import {
  stuckTurnPlaybook,
  reconnectFailurePlaybook,
  permissionDeadlockPlaybook,
  pluginDegradationPlaybook,
  exportRecoveryPlaybook,
  sessionUnrecoverablePlaybook,
  compactionFailurePlaybook,
} from '@pellux/goodvibes-sdk/platform/runtime/ops/playbooks/index';

/** All registered playbooks in definition order. */
const ALL_PLAYBOOKS: readonly Playbook[] = [
  stuckTurnPlaybook,
  reconnectFailurePlaybook,
  permissionDeadlockPlaybook,
  pluginDegradationPlaybook,
  exportRecoveryPlaybook,
  sessionUnrecoverablePlaybook,
  compactionFailurePlaybook,
] as const;

/** Registry version — bump when playbooks are added or updated. */
export const REGISTRY_VERSION = '1.0.0';

/**
 * Build and return the playbook registry.
 *
 * The registry is a Map keyed by playbook ID for O(1) lookup.
 */
export function getPlaybookRegistry(): PlaybookRegistry {
  const registry: PlaybookRegistry = new Map<string, PlaybookRegistryEntry>();
  for (const playbook of ALL_PLAYBOOKS) {
    registry.set(playbook.id, {
      playbook,
      version: REGISTRY_VERSION,
      updatedAt: new Date().toISOString(),
    });
  }
  return registry;
}

/**
 * Look up a single playbook by ID.
 *
 * @param id - The playbook ID (e.g. 'stuck-turn').
 * @returns The playbook, or undefined if not found.
 */
export function getPlaybook(id: string): Playbook | undefined {
  return ALL_PLAYBOOKS.find((p) => p.id === id);
}

/**
 * Find playbooks whose tags overlap with the provided set.
 *
 * @param tags - One or more tag strings to match.
 * @returns Playbooks that have at least one matching tag.
 */
export function findPlaybooksByTag(...tags: string[]): Playbook[] {
  const tagSet = new Set(tags);
  return ALL_PLAYBOOKS.filter((p) => p.tags.some((t) => tagSet.has(t)));
}

/**
 * Find playbooks whose symptoms partially match the provided query string.
 *
 * @param query - A substring to search for in symptom descriptions.
 * @returns Matching playbooks, sorted by number of matching symptoms (desc).
 */
export function findPlaybooksBySymptom(query: string): Playbook[] {
  const lower = query.toLowerCase();
  const scored = ALL_PLAYBOOKS.map((p) => ({
    playbook: p,
    matches: p.symptoms.filter((s) => s.toLowerCase().includes(lower)).length,
  })).filter(({ matches }) => matches > 0);
  return scored.sort((a, b) => b.matches - a.matches).map(({ playbook }) => playbook);
}
