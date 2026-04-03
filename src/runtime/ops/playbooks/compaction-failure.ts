/**
 * Playbook: Compaction Failure
 *
 * Diagnoses and resolves conversation compaction failures that block
 * new turns from starting.
 */
import type { Playbook, DiagnosticCheckResult } from '../types.ts';
import { safeCheck } from '../safe-check.ts';

/** Compaction failure resolution playbook. */
export const compactionFailurePlaybook: Playbook = {
  id: 'compaction-failure',
  name: 'Compaction Failure',
  description:
    'Diagnoses and resolves conversation compaction failures. ' +
    'When compaction fails, new turns are blocked until the issue is resolved.',
  symptoms: [
    'Compaction health check reports FAILED',
    'New turn submissions rejected with BLOCK_NEW cascade',
    'CompactionStateMachine stuck in error state',
    'Context window approaching limit with no successful compaction',
    'Compaction span shows repeated ERROR status',
  ],
  checks: [
    {
      id: 'compaction.strategy-available',
      label: 'Compaction strategy available',
      description: 'Checks whether a compaction strategy is configured and operative.',
      run: async (): Promise<DiagnosticCheckResult> =>
        safeCheck(async () => ({
          passed: false,
          summary: 'Compaction strategy availability requires live CompactionManager context.',
          severity: 'error',
          context: { hint: 'Inspect CompactionManager.currentStrategy — confirm it is not null' },
        })),
    },
    {
      id: 'compaction.token-budget',
      label: 'Token budget within limit',
      description: 'Checks whether the current context window token count is within the compaction trigger threshold.',
      run: async (): Promise<DiagnosticCheckResult> =>
        safeCheck(async () => ({
          passed: false,
          summary: 'Token budget check requires live ContextWindowManager context.',
          severity: 'warning',
          context: { hint: 'Compare ContextWindowManager.currentTokens with config.compactionTriggerTokens' },
        })),
    },
    {
      id: 'compaction.state-machine',
      label: 'Compaction state machine in error state',
      description: 'Confirms the CompactionStateMachine is in an error state, not idle or running.',
      run: async (): Promise<DiagnosticCheckResult> =>
        safeCheck(async () => ({
          passed: false,
          summary: 'State machine inspection requires live CompactionStateMachine context.',
          severity: 'error',
          context: { hint: 'Call CompactionStateMachine.getState() — expect "error" or "failed"' },
        })),
    },
  ],
  steps: [
    {
      step: 1,
      title: 'Inspect compaction error telemetry',
      action:
        'Review compaction.* spans in the local ledger for ERROR status. ' +
        'Note the error message, strategy, and token count at time of failure.',
      kind: 'observe',
      expectedOutcome: 'Root cause identified from span error messages.',
      automatable: false,
    },
    {
      step: 2,
      title: 'Reset the compaction state machine',
      action:
        'Call runtime.compaction.reset() to transition the state machine back to idle. ' +
        'This unblocks new turns without re-attempting the failed compaction.',
      kind: 'command',
      command: 'runtime.compaction.reset()',
      expectedOutcome: 'CompactionStateMachine returns to idle; new turns unblocked.',
      automatable: true,
    },
    {
      step: 3,
      title: 'Switch to a fallback compaction strategy',
      action:
        'If the default strategy continues to fail, switch to a simpler fallback ' +
        '(e.g. truncation or summarization) to restore turn availability.',
      kind: 'config',
      command: 'runtime.compaction.setStrategy("truncate")',
      expectedOutcome: 'Compaction succeeds with fallback strategy; turns resume.',
      automatable: false,
    },
    {
      step: 4,
      title: 'Manually compact the conversation',
      action:
        'Trigger a manual compaction run with verbose logging to isolate the failure point.',
      kind: 'command',
      command: 'runtime.compaction.runNow({ verbose: true })',
      expectedOutcome: 'Compaction completes or fails with a detailed error message.',
      automatable: false,
    },
    {
      step: 5,
      title: 'Review context window limits',
      action:
        'Verify that the configured context window limit matches the active model capabilities. ' +
        'Reduce the turn token budget if needed to prevent repeated overflow.',
      kind: 'config',
      expectedOutcome: 'Token budget aligned with model; compaction triggering correctly.',
      automatable: false,
    },
  ],
  escalationCriteria: [
    'Compaction fails consistently across all available strategies',
    'Context window overflow preventing any new model calls',
    'CompactionStateMachine crash-loops on reset',
    'Token budget configuration is corrupt or missing',
  ],
  tags: ['compaction', 'context-window', 'token-budget', 'turn-blocking'],
};
