/**
 * Playbook: Stuck Turn / Task
 *
 * Diagnoses and resolves turns or tasks that have stopped progressing.
 * Common causes: LLM timeout, tool deadlock, event loop stall.
 */
import type { Playbook, DiagnosticCheckResult } from '../types.ts';
import { safeCheck } from '../safe-check.ts';

// TODO(GC-HEALTH-003): Wire live runtime context for diagnostic checks
/** Stuck turn / task resolution playbook. */
export const stuckTurnPlaybook: Playbook = {
  id: 'stuck-turn',
  name: 'Stuck Turn / Task',
  description:
    'Diagnoses turns or tasks that have stopped progressing. ' +
    'Covers LLM timeout, tool deadlock, and event-loop stall scenarios.',
  symptoms: [
    'Turn has been in-flight longer than the configured timeout',
    'No new events emitted on the task event bus for > 30 s',
    'Spinner/progress indicator frozen in TUI',
    'CPU near 0% with pending async operations',
    'Health check reports degraded turn throughput',
  ],
  checks: [
    {
      id: 'turn.timeout-elapsed',
      label: 'Turn timeout elapsed',
      description: 'Checks whether the active turn has exceeded its configured timeout.',
      run: async (): Promise<DiagnosticCheckResult> =>
        safeCheck(async () => ({
          passed: false,
          summary:
            'Cannot determine elapsed time without a live runtime context — attach the RuntimeTracer to inspect active spans.',
          severity: 'warning',
          context: { hint: 'Run runtime.tracer.getActiveSpans() if available' },
        })),
    },
    {
      id: 'turn.event-bus-silent',
      label: 'Event bus silent',
      description: 'Checks whether the RuntimeEventBus has emitted any events recently.',
      run: async (): Promise<DiagnosticCheckResult> =>
        safeCheck(async () => ({
          passed: false,
          summary:
            'No live bus reference available in static context. ' +
            'Inject the event bus to enable real-time silence detection.',
          severity: 'warning',
          context: { hint: 'Subscribe to eventBus and compare lastEventAt with Date.now()' },
        })),
    },
    {
      id: 'turn.pending-tool-calls',
      label: 'Pending tool calls',
      description: 'Checks for tool calls that have been dispatched but not yet resolved.',
      run: async (): Promise<DiagnosticCheckResult> =>
        safeCheck(async () => ({
          passed: false,
          summary: 'Cannot query tool executor state in static context.',
          severity: 'warning',
          context: { hint: 'Inspect PhasedToolExecutor.pendingCount() if available' },
        })),
    },
  ],
  steps: [
    {
      step: 1,
      title: 'Identify stuck span',
      action:
        'Query the active span list from the RuntimeTracer. ' +
        'Look for spans with durationMs > turnTimeoutMs and status UNSET.',
      kind: 'observe',
      expectedOutcome: 'One or more spans identified as candidates.',
      automatable: false,
    },
    {
      step: 2,
      title: 'Check for tool deadlock',
      action:
        'Inspect the PhasedToolExecutor queue for tools awaiting permissions or locks. ' +
        'Cross-reference with PermissionManager.pendingRequests().',
      kind: 'observe',
      command: 'runtime.tools.executor.dumpState()',
      expectedOutcome: 'Tool queue is empty or shows a specific blocked tool.',
      automatable: false,
    },
    {
      step: 3,
      title: 'Cancel the stuck turn',
      action:
        'Emit a task.cancel event on the RuntimeEventBus with the stuck taskId. ' +
        'The TaskStateMachine should transition to CANCELLED within 1 s.',
      kind: 'command',
      command: 'eventBus.emit("task.cancel", { taskId })',
      expectedOutcome: 'Turn transitions to CANCELLED; health check recovers.',
      automatable: true,
    },
    {
      step: 4,
      title: 'Restart turn with reduced timeout',
      action:
        'Re-submit the failed turn with a shorter LLM timeout (e.g. 30 s) and ' +
        'tool-use disabled to isolate whether the model or a tool is the root cause.',
      kind: 'command',
      command: 'runtime.submitTurn({ ...turnPayload, timeoutMs: 30_000, tools: [] })',
      expectedOutcome: 'Turn completes or fails fast with a clear error.',
      automatable: false,
    },
    {
      step: 5,
      title: 'Review LLM provider health',
      action:
        'Check the provider health dashboard or call the provider status endpoint. ' +
        'Consider switching to a fallback provider if degraded.',
      kind: 'observe',
      expectedOutcome: 'Provider status confirmed healthy or fallback selected.',
      automatable: false,
    },
  ],
  escalationCriteria: [
    'Multiple consecutive turns stuck after attempting cancel+restart',
    'Event loop stall confirmed by > 60 s with zero runtime events',
    'Memory usage growing continuously without turns completing',
    'Core health check reports CRITICAL for > 5 minutes',
  ],
  tags: ['turn', 'task', 'timeout', 'deadlock', 'llm'],
};
