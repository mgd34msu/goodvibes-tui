/**
 * Cascade rule → remediation playbook mapping.
 *
 * Each cascade rule ID maps to one or more playbook IDs that provide
 * actionable remediation steps for that failure mode.
 *
 * This mapping is consumed by:
 * - CascadeTimer (attaches remediationPlaybookIds to TimedCascadeResult)
 * - HealthPanel (surfaces remediation actions in the health dashboard)
 * - Completeness tests (verify every rule has at least one playbook)
 */

/**
 * Map from cascade rule ID → ordered list of remediation playbook IDs.
 * The first playbook in each array is the primary recommendation.
 */
export const CASCADE_PLAYBOOK_MAP: ReadonlyMap<string, readonly string[]> = new Map([
  // turn-failed-cancels-tools: stuck turn is the primary remediation path
  ['turn-failed-cancels-tools', ['stuck-turn']],

  // tool-failed-errors-turn: stuck turn playbook covers tool deadlock and recovery
  ['tool-failed-errors-turn', ['stuck-turn']],

  // mcp-disconnected-blocks-mcp-tools: reconnect failure playbook
  ['mcp-disconnected-blocks-mcp-tools', ['reconnect-failure']],

  // agent-failed-marks-child-tasks: stuck turn covers turn/task lifecycle recovery
  ['agent-failed-marks-child-tasks', ['stuck-turn']],

  // plugin-error-deregisters-tools: plugin degradation playbook
  ['plugin-error-deregisters-tools', ['plugin-degradation']],

  // transport-disconnected-blocks-remote-tasks: reconnect failure is primary;
  // stuck turn is secondary for any blocked tasks
  ['transport-disconnected-blocks-remote-tasks', ['reconnect-failure', 'stuck-turn']],

  // session-recovery-failed-unrecoverable: dedicated session unrecoverable playbook
  ['session-recovery-failed-unrecoverable', ['session-unrecoverable']],

  // compaction-failed-blocks-new-turns: dedicated compaction failure playbook
  ['compaction-failed-blocks-new-turns', ['compaction-failure']],
]);

/**
 * All cascade rule IDs that must have at least one playbook mapping.
 * Derived from cascade-rules.ts — update when rules are added or removed.
 */
export const ALL_CASCADE_RULE_IDS: readonly string[] = [
  'turn-failed-cancels-tools',
  'tool-failed-errors-turn',
  'mcp-disconnected-blocks-mcp-tools',
  'agent-failed-marks-child-tasks',
  'plugin-error-deregisters-tools',
  'transport-disconnected-blocks-remote-tasks',
  'session-recovery-failed-unrecoverable',
  'compaction-failed-blocks-new-turns',
];
