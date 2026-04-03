/**
 * Playbook: Session Unrecoverable
 *
 * Handles the scenario where session recovery has been exhausted and the
 * runtime has emitted SESSION_UNRECOVERABLE — triggering a full-system cascade.
 */
import type { Playbook, DiagnosticCheckResult } from '../types.ts';
import { safeCheck } from '../safe-check.ts';

// TODO(GC-HEALTH-003): Wire live runtime context for diagnostic checks
/** Session unrecoverable resolution playbook. */
export const sessionUnrecoverablePlaybook: Playbook = {
  id: 'session-unrecoverable',
  name: 'Session Unrecoverable',
  description:
    'Diagnoses and recovers from SESSION_UNRECOVERABLE events. ' +
    'Fired when all session recovery attempts are exhausted, cascading to all domains.',
  symptoms: [
    'SESSION_UNRECOVERABLE event emitted on the runtime event bus',
    'All domain health checks transitioning to failed or unknown',
    'No new turns can be started; all in-flight operations cancelled',
    'TUI shows system-wide failure banner',
    'Session state file missing or corrupted',
  ],
  checks: [
    {
      id: 'session.recovery-attempts',
      label: 'Session recovery attempts exhausted',
      description: 'Confirms that all configured recovery attempts have been made before the cascade.',
      run: async (): Promise<DiagnosticCheckResult> =>
        safeCheck(async () => ({
          passed: false,
          summary: 'Session recovery state requires live SessionStateMachine context.',
          severity: 'critical',
          context: { hint: 'Inspect SessionStateMachine.recoveryAttempts vs maxRecoveryAttempts' },
        })),
    },
    {
      id: 'session.state-file',
      label: 'Session state file integrity',
      description: 'Checks whether the session state file exists and is parseable.',
      run: async (): Promise<DiagnosticCheckResult> =>
        safeCheck(async () => ({
          passed: false,
          summary: 'Session file path requires live session config context.',
          severity: 'error',
          context: { hint: 'Locate session state file via config.sessionDir and verify JSON integrity' },
        })),
    },
    {
      id: 'session.event-bus-silent',
      label: 'Event bus silent after cascade',
      description: 'Verifies that no further domain events are being processed after SESSION_UNRECOVERABLE.',
      run: async (): Promise<DiagnosticCheckResult> =>
        safeCheck(async () => ({
          passed: false,
          summary: 'Event bus state requires live RuntimeEventBus context.',
          severity: 'warning',
          context: { hint: 'Subscribe to eventBus and confirm no events within 5 s' },
        })),
    },
  ],
  steps: [
    {
      step: 1,
      title: 'Capture full session state dump',
      action:
        'Before any recovery attempt, export the full runtime state snapshot ' +
        '(health, tasks, agents, active spans) to a diagnostic file.',
      kind: 'observe',
      expectedOutcome: 'State dump captured for post-mortem analysis.',
      automatable: false,
    },
    {
      step: 2,
      title: 'Attempt graceful session restart',
      action:
        'Call runtime.session.restart() to attempt a clean session re-initialization. ' +
        'This resets all domain health, clears the event queue, and reinitialises plugins.',
      kind: 'command',
      command: 'runtime.session.restart()',
      expectedOutcome: 'Session health returns to healthy; all domains reinitialise.',
      automatable: true,
    },
    {
      step: 3,
      title: 'Clear corrupted session state',
      action:
        'If restart fails, remove or rename the corrupted session state file and restart. ' +
        'This loses in-progress turns but allows the runtime to boot fresh.',
      kind: 'command',
      command: 'runtime.session.clearState()',
      expectedOutcome: 'Clean session state; turns must be re-submitted.',
      automatable: true,
    },
    {
      step: 4,
      title: 'Verify plugin and MCP connectivity',
      action:
        'After session restart, confirm all plugins have re-connected to their MCP servers ' +
        'and tool registrations are complete.',
      kind: 'observe',
      expectedOutcome: 'All plugins HEALTHY; tool registry populated.',
      automatable: false,
    },
    {
      step: 5,
      title: 'Escalate if restart loop detected',
      action:
        'If the session reaches SESSION_UNRECOVERABLE again within 5 minutes, ' +
        'escalate to human review — the root cause is not self-healing.',
      kind: 'escalate',
      expectedOutcome: 'Human-reviewed root cause identified and resolved.',
      automatable: false,
    },
  ],
  escalationCriteria: [
    'SESSION_UNRECOVERABLE fires more than once within 5 minutes',
    'Session state file cannot be written (disk full, permission denied)',
    'All plugins fail to reconnect after session restart',
    'Runtime process exits immediately after restart attempt',
  ],
  tags: ['session', 'unrecoverable', 'cascade', 'critical'],
};
