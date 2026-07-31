/**
 * tasks-union.test.ts — `/tasks` reads both registries, and writes to the right
 * one.
 *
 * Two distinct failures are pinned here, and the second is the dangerous one.
 *
 * READ: a list showing only this terminal's tasks would look complete while
 * omitting everything the daemon runs. So the union, deduped with the local
 * (live) copy winning, and an honest note when the daemon could not be reached
 * — carried ALONGSIDE the local rows, never instead of them.
 *
 * WRITE: an act aimed at a task the daemon owns must never be applied to a
 * local registry that has no such record. That path reports success and changes
 * nothing on the process actually running the task, which is the exact class of
 * silent no-op the daemon separation exists to remove. Where a verb exists
 * (cancel, retry) it is used; where none does the refusal names the act.
 */
import { describe, expect, test } from 'bun:test';
import { createTasksClient } from '../../runtime/client/tasks-client.ts';
import type { RuntimeTask } from '@/runtime/index.ts';

function task(id: string, title: string): RuntimeTask {
  return {
    id, kind: 'agent', title, status: 'running', owner: 'someone',
    cancellable: true, childTaskIds: [], queuedAt: 1_000,
  } as unknown as RuntimeTask;
}

function localSource(tasks: readonly RuntimeTask[]) {
  return {
    list: () => tasks,
    get: (id: string) => tasks.find((t) => t.id === id) ?? null,
  };
}

function verbs(answers: Record<string, unknown>, options: { unavailable?: string; throws?: boolean } = {}) {
  const calls: [string, unknown][] = [];
  return {
    calls,
    probe: () => (options.unavailable
      ? { available: false as const, reason: options.unavailable }
      : { available: true as const, sdk: {} as never }),
    invoke: async (methodId: string, input?: unknown) => {
      calls.push([methodId, input]);
      if (options.throws) throw new Error('connection reset');
      return answers[methodId] ?? {};
    },
  };
}

describe('the task list is both registries', () => {
  test('local and daemon rows are unioned', async () => {
    const client = createTasksClient({
      local: localSource([task('l1', 'local work')]),
      verbs: verbs({ 'tasks.list': { tasks: [task('d1', 'scheduled work')] } }) as never,
    });
    const result = await client.list();
    expect(result.tasks.map((t) => t.task.id).sort()).toEqual(['d1', 'l1']);
    expect(result.tasks.find((t) => t.task.id === 'l1')?.origin).toBe('local');
    expect(result.tasks.find((t) => t.task.id === 'd1')?.origin).toBe('daemon');
    expect(result.daemonUnavailable).toBeNull();
  });

  test('an id both registries carry appears once, from the local half', async () => {
    const client = createTasksClient({
      local: localSource([task('shared', 'live local title')]),
      verbs: verbs({ 'tasks.list': { tasks: [task('shared', 'stale daemon title')] } }) as never,
    });
    const result = await client.list();
    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0]?.task.title).toBe('live local title');
    expect(result.tasks[0]?.origin).toBe('local');
  });

  test('an unreachable daemon still returns the local half, with the reason attached', async () => {
    const client = createTasksClient({
      local: localSource([task('l1', 'local work')]),
      verbs: verbs({}, { throws: true }) as never,
    });
    const result = await client.list();
    // The local tasks are real and must not be hidden behind an error; the
    // reason is what stops the shortened list from reading as complete.
    expect(result.tasks.map((t) => t.task.id)).toEqual(['l1']);
    expect(result.daemonUnavailable).toContain('connection reset');
  });

  test('no daemon configured is reported as such, not as a failure', async () => {
    const client = createTasksClient({
      local: localSource([task('l1', 'local work')]),
      verbs: verbs({}, { unavailable: 'the daemon is disabled (daemon.enabled=false)' }) as never,
    });
    const result = await client.list();
    expect(result.tasks).toHaveLength(1);
    expect(result.daemonUnavailable).toContain('daemon.enabled=false');
  });
});

describe('one task, and which registry owns it', () => {
  test('a local id resolves locally and is never asked of the daemon', async () => {
    const caller = verbs({ 'tasks.get': { task: task('l1', 'daemon copy') } });
    const client = createTasksClient({ local: localSource([task('l1', 'local work')]), verbs: caller as never });
    const found = await client.get('l1');
    expect(found?.origin).toBe('local');
    expect(caller.calls).toEqual([]);
  });

  test('an unknown id falls through to the daemon', async () => {
    const caller = verbs({ 'tasks.get': { task: task('d1', 'scheduled work') } });
    const client = createTasksClient({ local: localSource([]), verbs: caller as never });
    const found = await client.get('d1');
    expect(found?.origin).toBe('daemon');
    expect(caller.calls[0]).toEqual(['tasks.get', { taskId: 'd1' }]);
  });

  test('an id neither registry has is null, not a fabricated record', async () => {
    const client = createTasksClient({ local: localSource([]), verbs: verbs({ 'tasks.get': {} }) as never });
    expect(await client.get('nope')).toBeNull();
  });
});

describe('acting on a daemon-owned task', () => {
  test('cancel and retry go over their verbs', async () => {
    const caller = verbs({});
    const client = createTasksClient({ local: localSource([]), verbs: caller as never });
    await client.cancel('d1');
    await client.retry('d2');
    expect(caller.calls).toEqual([
      ['tasks.cancel', { taskId: 'd1' }],
      ['tasks.retry', { taskId: 'd2' }],
    ]);
  });

  test('with no daemon reachable the act REJECTS rather than reporting success', async () => {
    const client = createTasksClient({
      local: localSource([]),
      verbs: verbs({}, { unavailable: 'no control-plane base URL is configured' }) as never,
    });
    // Silently doing nothing here is what leaves a task running that the user
    // was told had been cancelled.
    await expect(client.cancel('d1')).rejects.toThrow('no control-plane base URL');
  });
});
