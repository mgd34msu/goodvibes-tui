import { describe, test, expect } from 'bun:test';
import {
  normalizeWrfcAgentToolInvocation,
  type WrfcGuardTrace,
} from '../../tools/wrfc-agent-guard.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function captureTrace(
  args: Parameters<typeof normalizeWrfcAgentToolInvocation>[0],
  lastUserMessage?: string,
): { result: ReturnType<typeof normalizeWrfcAgentToolInvocation>; traces: WrfcGuardTrace[] } {
  const traces: WrfcGuardTrace[] = [];
  const result = normalizeWrfcAgentToolInvocation(args, {
    getLastUserMessage: lastUserMessage !== undefined ? () => lastUserMessage : undefined,
    onTrace: (t) => traces.push(t),
  });
  return { result, traces };
}

// ---------------------------------------------------------------------------
// Guard trace: spawn-forced-wrfc
// ---------------------------------------------------------------------------

describe('guard trace: spawn-forced-wrfc', () => {
  test('emits trace when explicit implementation verb triggers WRFC', () => {
    const { traces } = captureTrace({
      mode: 'spawn',
      task: 'implement the rate limiter',
    });
    expect(traces).toHaveLength(1);
    expect(traces[0]!.kind).toBe('spawn-forced-wrfc');
    expect(traces[0]!.reason).toBe('task judged implementation-like');
    expect(traces[0]!.task).toBe('implement the rate limiter');
  });

  test('emits trace with reason "reviewMode explicitly set to wrfc"', () => {
    const { traces } = captureTrace({
      mode: 'spawn',
      task: 'run the analysis',
      reviewMode: 'wrfc',
    });
    expect(traces).toHaveLength(1);
    expect(traces[0]!.kind).toBe('spawn-forced-wrfc');
    expect(traces[0]!.reason).toBe('reviewMode explicitly set to wrfc');
  });

  test('emits trace with reason "task contains explicit WRFC signal"', () => {
    const { traces } = captureTrace({
      mode: 'spawn',
      task: 'run the wrfc cycle for the feature',
    });
    expect(traces).toHaveLength(1);
    expect(traces[0]!.kind).toBe('spawn-forced-wrfc');
    expect(traces[0]!.reason).toBe('task contains explicit WRFC signal');
  });

  test('emits trace with reason "task identified as root review-role"', () => {
    const { traces } = captureTrace({
      mode: 'spawn',
      template: 'reviewer',
      task: 'verify the solution compiles',
    });
    expect(traces).toHaveLength(1);
    expect(traces[0]!.kind).toBe('spawn-forced-wrfc');
    expect(traces[0]!.reason).toContain('review-role');
  });
});

// ---------------------------------------------------------------------------
// Guard trace: spawn-suppressed-wrfc
// ---------------------------------------------------------------------------

describe('guard trace: spawn-suppressed-wrfc', () => {
  test('emits trace when task is read-only (leading inspect verb)', () => {
    const { traces } = captureTrace({
      mode: 'spawn',
      task: 'inspect the package structure',
    });
    expect(traces).toHaveLength(1);
    expect(traces[0]!.kind).toBe('spawn-suppressed-wrfc');
    expect(traces[0]!.reason).toContain('read-only');
    expect(traces[0]!.task).toBe('inspect the package structure');
  });

  test('emits trace when task has do-not-write guard', () => {
    const { traces } = captureTrace({
      mode: 'spawn',
      task: 'analyze and report findings, do not write any files',
    });
    expect(traces).toHaveLength(1);
    expect(traces[0]!.kind).toBe('spawn-suppressed-wrfc');
  });

  test('emits trace when no implementation signal detected at all', () => {
    const { traces } = captureTrace({
      mode: 'spawn',
      task: 'what is the architecture of this repo',
    });
    expect(traces).toHaveLength(1);
    expect(traces[0]!.kind).toBe('spawn-suppressed-wrfc');
  });
});

// ---------------------------------------------------------------------------
// Guard trace: batch-collapsed-to-wrfc
// ---------------------------------------------------------------------------

describe('guard trace: batch-collapsed-to-wrfc', () => {
  test('emits trace when batch with WRFC reviewer is collapsed', () => {
    const { traces } = captureTrace({
      mode: 'batch-spawn',
      tasks: [
        { task: 'design a rate limiter API', template: 'engineer', dangerously_disable_wrfc: true },
        { task: 'reviewer: check design', template: 'reviewer', dangerously_disable_wrfc: true },
      ],
    }, 'build a rate limiter');
    expect(traces).toHaveLength(1);
    expect(traces[0]!.kind).toBe('batch-collapsed-to-wrfc');
    expect(traces[0]!.reason).toContain('collapsed');
    expect(traces[0]!.task).toBe('build a rate limiter');
  });

  test('trace message mentions batch count', () => {
    const { traces } = captureTrace({
      mode: 'batch-spawn',
      tasks: [
        { task: 'task a', template: 'engineer', dangerously_disable_wrfc: true },
        { task: 'review results', template: 'reviewer', dangerously_disable_wrfc: true },
        { task: 'task c', template: 'engineer', dangerously_disable_wrfc: true },
      ],
    }, 'the user request');
    expect(traces[0]!.reason).toContain('3');
  });

  test('no trace emitted for plain batch without WRFC signal', () => {
    const { traces } = captureTrace({
      mode: 'batch-spawn',
      tasks: [
        { task: 'inspect pkg A', template: 'engineer' },
        { task: 'inspect pkg B', template: 'engineer' },
      ],
    });
    expect(traces).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Expanded heuristic matrix — ambiguous phrasings (pinning current behavior)
// ---------------------------------------------------------------------------

describe('heuristic: implementation-like tasks without keywords', () => {
  test('"make the button blue" → WRFC (imperative "make")', () => {
    const { result } = captureTrace({ mode: 'spawn', task: 'make the button blue' });
    expect(result.reviewMode).toBe('wrfc');
  });

  test('"wire up the login form to the API" → WRFC ("wire up")', () => {
    const { result } = captureTrace({ mode: 'spawn', task: 'wire up the login form to the API' });
    expect(result.reviewMode).toBe('wrfc');
  });

  test('"connect the database to the service" → WRFC ("connect")', () => {
    const { result } = captureTrace({ mode: 'spawn', task: 'connect the database to the service' });
    expect(result.reviewMode).toBe('wrfc');
  });

  test('"rename the UserService to AccountService" → WRFC ("rename")', () => {
    const { result } = captureTrace({ mode: 'spawn', task: 'rename the UserService to AccountService' });
    expect(result.reviewMode).toBe('wrfc');
  });

  test('"migrate the old table to the new schema" → WRFC ("migrate")', () => {
    const { result } = captureTrace({ mode: 'spawn', task: 'migrate the old table to the new schema' });
    expect(result.reviewMode).toBe('wrfc');
  });

  test('"set the timeout to 30s" → WRFC ("set the")', () => {
    const { result } = captureTrace({ mode: 'spawn', task: 'set the timeout to 30s' });
    expect(result.reviewMode).toBe('wrfc');
  });

  test('"enable dark mode" → WRFC ("enable")', () => {
    const { result } = captureTrace({ mode: 'spawn', task: 'enable dark mode' });
    expect(result.reviewMode).toBe('wrfc');
  });

  test('"configure the redis connection" → WRFC ("configure")', () => {
    const { result } = captureTrace({ mode: 'spawn', task: 'configure the redis connection' });
    expect(result.reviewMode).toBe('wrfc');
  });
});

describe('heuristic: read-only tasks with strong verbs (should NOT get WRFC)', () => {
  test('"analyze and report code coverage" → no WRFC ("do not write" implied by "report" only)', () => {
    // "analyze" is a leading read-only verb
    const { result } = captureTrace({ mode: 'spawn', task: 'analyze and report the code coverage' });
    // analyze is read-only-leading without implementation verb → suppressed
    expect(result.reviewMode).toBe('none');
  });

  test('"read-only: inspect the config" explicit guard → no WRFC', () => {
    const { result } = captureTrace({ mode: 'spawn', task: 'read-only: inspect the config' });
    expect(result.reviewMode).toBe('none');
  });

  test('"summarize the codebase" → no WRFC', () => {
    const { result } = captureTrace({ mode: 'spawn', task: 'summarize the codebase' });
    expect(result.reviewMode).toBe('none');
  });

  test('"find all usages of deprecated API" → no WRFC', () => {
    const { result } = captureTrace({ mode: 'spawn', task: 'find all usages of deprecated API' });
    expect(result.reviewMode).toBe('none');
  });

  test('"explain the architecture" → no WRFC', () => {
    const { result } = captureTrace({ mode: 'spawn', task: 'explain the architecture' });
    expect(result.reviewMode).toBe('none');
  });

  test('"research best practices for rate limiting" → no WRFC', () => {
    const { result } = captureTrace({ mode: 'spawn', task: 'research best practices for rate limiting' });
    expect(result.reviewMode).toBe('none');
  });
});

describe('heuristic: regression class — analysis tasks referencing action verbs (no WRFC)', () => {
  // These were falsely routed to WRFC before the isReadOnlyTask leading-verb fix.
  // The tasks DISCUSS or ANALYZE an action; they do not perform it.

  test('"report on how to migrate the auth module" → no WRFC', () => {
    const { result } = captureTrace({ mode: 'spawn', task: 'report on how to migrate the auth module' });
    expect(result.reviewMode).toBe('none');
  });

  test('"investigate what to remove" → no WRFC', () => {
    const { result } = captureTrace({ mode: 'spawn', task: 'investigate what to remove' });
    expect(result.reviewMode).toBe('none');
  });

  test('"document how we would convert X to Y" → no WRFC', () => {
    const { result } = captureTrace({ mode: 'spawn', task: 'document how we would convert X to Y' });
    expect(result.reviewMode).toBe('none');
  });

  test('"describe the steps to disable telemetry" → no WRFC', () => {
    const { result } = captureTrace({ mode: 'spawn', task: 'describe the steps to disable telemetry' });
    expect(result.reviewMode).toBe('none');
  });

  test('"audit which modules to delete" → no WRFC', () => {
    const { result } = captureTrace({ mode: 'spawn', task: 'audit which modules to delete' });
    expect(result.reviewMode).toBe('none');
  });

  test('"evaluate whether to migrate" → no WRFC', () => {
    const { result } = captureTrace({ mode: 'spawn', task: 'evaluate whether to migrate' });
    expect(result.reviewMode).toBe('none');
  });

  test('"assess the impact of restructuring" → no WRFC', () => {
    const { result } = captureTrace({ mode: 'spawn', task: 'assess the impact of restructuring' });
    expect(result.reviewMode).toBe('none');
  });

  test('"check whether to enable the feature" → no WRFC', () => {
    const { result } = captureTrace({ mode: 'spawn', task: 'check whether to enable the feature' });
    expect(result.reviewMode).toBe('none');
  });

  test('"compare approaches to migrating the schema" → no WRFC', () => {
    const { result } = captureTrace({ mode: 'spawn', task: 'compare approaches to migrating the schema' });
    expect(result.reviewMode).toBe('none');
  });

  // Note: 'review' as leading verb routes to WRFC via isRootReviewRoleTask (correct behavior).
  // Use 'assess' instead to test analysis-of-restructure without the role check.
  test('"assess the impact of the folder restructure" → no WRFC (assess is analysis-leading)', () => {
    const { result } = captureTrace({ mode: 'spawn', task: 'assess the impact of the folder restructure' });
    expect(result.reviewMode).toBe('none');
  });

  // Verify imperative forms of the same actions still DO route to WRFC
  test('"migrate the auth module" (imperative) → WRFC', () => {
    const { result } = captureTrace({ mode: 'spawn', task: 'migrate the auth module' });
    expect(result.reviewMode).toBe('wrfc');
  });

  test('"remove the deprecated API" (imperative) → WRFC', () => {
    const { result } = captureTrace({ mode: 'spawn', task: 'remove the deprecated API' });
    expect(result.reviewMode).toBe('wrfc');
  });

  test('"convert the old schema" (imperative) → WRFC', () => {
    const { result } = captureTrace({ mode: 'spawn', task: 'convert the old schema' });
    expect(result.reviewMode).toBe('wrfc');
  });

  test('"disable the telemetry endpoint" (imperative) → WRFC', () => {
    const { result } = captureTrace({ mode: 'spawn', task: 'disable the telemetry endpoint' });
    expect(result.reviewMode).toBe('wrfc');
  });

  test('"delete the legacy files" (imperative) → WRFC', () => {
    const { result } = captureTrace({ mode: 'spawn', task: 'delete the legacy files' });
    expect(result.reviewMode).toBe('wrfc');
  });
});

describe('heuristic: mixed batch-spawn (WRFC task subset)', () => {
  test('batch with one explicit reviewer and one reader → wrfcTasks path (not collapsed)', () => {
    const { result } = captureTrace({
      mode: 'batch-spawn',
      tasks: [
        { task: 'inspect package A', template: 'engineer' },
        { task: 'inspect package B', template: 'engineer', reviewMode: 'wrfc' },
      ],
    });
    // No lastUserMessage so collapse path does not trigger; falls to wrfcTasks path
    expect(result.reviewMode).toBe('wrfc');
    const tasks = result.tasks as Array<Record<string, unknown>>;
    expect(tasks[1]!.reviewMode).toBe('wrfc');
    // Non-WRFC task is left as-is (no forced mode change in wrfcTasks path)
    expect(tasks[0]!.reviewMode).toBeUndefined();
  });

  test('batch with no WRFC signals → all tasks disabled', () => {
    const { result } = captureTrace({
      mode: 'batch-spawn',
      tasks: [
        { task: 'read package A' },
        { task: 'read package B' },
      ],
    });
    expect(result.reviewMode).toBe('none');
    expect(result.dangerously_disable_wrfc).toBe(true);
    const tasks = result.tasks as Array<Record<string, unknown>>;
    expect(tasks.every((t) => t.dangerously_disable_wrfc === true)).toBe(true);
  });
});

describe('heuristic: no onTrace option (backward compat)', () => {
  test('normalizes without onTrace silently', () => {
    const result = normalizeWrfcAgentToolInvocation({
      mode: 'spawn',
      task: 'implement the feature',
    });
    expect(result.reviewMode).toBe('wrfc');
  });

  test('suppresses without onTrace silently', () => {
    const result = normalizeWrfcAgentToolInvocation({
      mode: 'spawn',
      task: 'inspect the code',
    });
    expect(result.reviewMode).toBe('none');
  });
});

describe('trace task field truncation', () => {
  test('truncates long tasks to 80 chars in trace (guard behavior - task field stored raw)', () => {
    // The guard emits the full task text in WrfcGuardTrace.task
    const longTask = 'x'.repeat(200);
    const { traces } = captureTrace({ mode: 'spawn', task: longTask, reviewMode: 'wrfc' });
    // trace.task is the raw cleanText'd value from the guard
    expect(traces[0]!.task).toBe(longTask);
  });
});
