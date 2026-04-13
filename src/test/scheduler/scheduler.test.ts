import { describe, test, expect, beforeEach } from 'bun:test';
import { TaskScheduler } from '../../scheduler/scheduler.ts';
import { getTestTaskScheduler, resetTestTaskScheduler } from '../helpers/runtime-services.ts';

// ---------------------------------------------------------------------------
// Cron parser — tested indirectly via getNextRun
// ---------------------------------------------------------------------------

describe('Cron parser', () => {
  let scheduler: TaskScheduler;

  beforeEach(() => {
    resetTestTaskScheduler();
    scheduler = getTestTaskScheduler('/tmp/gv-scheduler-cron-' + Math.random().toString(36).slice(2) + '.json');
  });

  test('wildcard (*) matches any minute', () => {
    // "* * * * *" — next run is always 1 minute away
    const from = new Date('2024-01-15T10:30:00Z');
    const next = scheduler.getNextRun('* * * * *', from);
    expect(next.getTime()).toBe(new Date('2024-01-15T10:31:00Z').getTime());
  });

  test('exact value matches', () => {
    const from = new Date('2024-01-15T09:00:00Z');
    const next = scheduler.getNextRun('0 10 * * *', from);
    expect(next.getHours()).toBe(10);
    expect(next.getMinutes()).toBe(0);
  });

  test('step expression */15', () => {
    const from = new Date('2024-01-15T10:00:00Z');
    const next = scheduler.getNextRun('*/15 * * * *', from);
    expect(next.getMinutes()).toBe(15);
  });

  test('step expression 0/30', () => {
    const from = new Date('2024-01-15T10:01:00Z');
    const next = scheduler.getNextRun('0/30 * * * *', from);
    expect(next.getMinutes()).toBe(30);
  });

  test('range expression 9-17', () => {
    // "0 9-17 * * *" fires at the top of hours 9-17
    const from = new Date('2024-01-15T08:00:00Z');
    const next = scheduler.getNextRun('0 9-17 * * *', from);
    expect(next.getHours()).toBe(9);
    expect(next.getMinutes()).toBe(0);
  });

  test('list expression 1,15 (minutes)', () => {
    const from = new Date('2024-01-15T10:02:00Z');
    const next = scheduler.getNextRun('1,15 * * * *', from);
    expect(next.getMinutes()).toBe(15);
  });

  test('combined: list with range 1,3-5', () => {
    // Minutes 1,3,4,5 — from minute 2, next is 3
    const from = new Date('2024-01-15T10:02:00Z');
    const next = scheduler.getNextRun('1,3-5 * * * *', from);
    expect(next.getMinutes()).toBe(3);
  });

  test('combined: range with step 1-5/2', () => {
    // Minutes 1,3,5 — from minute 2, next is 3
    const from = new Date('2024-01-15T10:02:00Z');
    const next = scheduler.getNextRun('1-5/2 * * * *', from);
    expect(next.getMinutes()).toBe(3);
  });

  test('throws on invalid expression (3 fields)', () => {
    expect(() => scheduler.getNextRun('* * *')).toThrow();
  });

  test('throws on out-of-range value', () => {
    expect(() => scheduler.getNextRun('60 * * * *')).toThrow();
  });

  test('throws on invalid step (0)', () => {
    expect(() => scheduler.getNextRun('*/0 * * * *')).toThrow();
  });
});

// ---------------------------------------------------------------------------
// dayOfMonth / dayOfWeek — POSIX OR logic
// ---------------------------------------------------------------------------

describe('computeNextRun — dayOfMonth/dayOfWeek OR logic', () => {
  let scheduler: TaskScheduler;

  beforeEach(() => {
    resetTestTaskScheduler();
    scheduler = getTestTaskScheduler('/tmp/gv-scheduler-dom-dow-' + Math.random().toString(36).slice(2) + '.json');
  });

  test('both wildcard — matches every day', () => {
    const from = new Date('2024-01-15T10:00:00Z'); // Monday
    const next = scheduler.getNextRun('0 12 * * *', from);
    expect(next.getDate()).toBe(15); // same day
  });

  test('only dom specified — only dom must match', () => {
    // Fire on the 1st of every month
    const from = new Date('2024-01-15T00:00:00Z');
    const next = scheduler.getNextRun('0 0 1 * *', from);
    expect(next.getDate()).toBe(1);
    expect(next.getMonth()).toBe(1); // February
  });

  test('only dow specified — only dow must match', () => {
    // Fire on Mondays (1); Jan 15 2024 is Monday, next Monday is Jan 22
    const from = new Date('2024-01-15T12:00:00Z');
    const next = scheduler.getNextRun('0 8 * * 1', from);
    expect(next.getDay()).toBe(1);
  });

  test('both dom and dow specified — OR logic (either match fires)', () => {
    // dom=1 (1st of month) OR dow=1 (Monday)
    // From Jan 15 (Mon), next is Jan 16 (1st check fails, Mon check: Jan 15 is Mon but hour already past)
    // Actually from Jan 15 12:00, next Mon 8:00 = Jan 22 8:00, but dom=1 = Feb 1 8:00
    // With OR: Jan 22 (Monday) comes first
    const from = new Date('2024-01-15T12:00:00Z');
    const next = scheduler.getNextRun('0 8 1 * 1', from);
    // Jan 22 is the next Monday, which is < Feb 1 (dom=1)
    expect(next.getDate()).toBe(22);
    expect(next.getMonth()).toBe(0); // January
  });

  test('dayOfWeek 7 treated as Sunday (same as 0)', () => {
    // Fire on Sundays (7 should equal 0)
    const from = new Date('2024-01-15T12:00:00Z'); // Monday Jan 15
    const next = scheduler.getNextRun('0 8 * * 7', from);
    expect(next.getDay()).toBe(0); // Sunday
  });

  test('dayOfWeek range 5-7 includes Sunday (7 normalizes to 0)', () => {
    // Fri(5), Sat(6), Sun(7->0) — from Monday Jan 15, next match is Friday Jan 19
    const from = new Date('2024-01-15T12:00:00Z'); // Monday Jan 15
    const next = scheduler.getNextRun('0 8 * * 5-7', from);
    expect(next.getDay()).toBe(5); // Friday
  });
});

// ---------------------------------------------------------------------------
// computeNextRun — basic cases
// ---------------------------------------------------------------------------

describe('computeNextRun basic cases', () => {
  let scheduler: TaskScheduler;

  beforeEach(() => {
    resetTestTaskScheduler();
    scheduler = getTestTaskScheduler('/tmp/gv-scheduler-tz-' + Math.random().toString(36).slice(2) + '.json');
  });

  test('every 30 minutes', () => {
    const from = new Date('2024-01-15T10:00:00Z');
    const next = scheduler.getNextRun('*/30 * * * *', from);
    expect(next.getMinutes()).toBe(30);
    expect(next.getHours()).toBe(10);
  });

  test('monthly on 1st at midnight', () => {
    const from = new Date('2024-01-15T00:00:00Z');
    const next = scheduler.getNextRun('0 0 1 * *', from);
    expect(next.getDate()).toBe(1);
    expect(next.getHours()).toBe(0);
    expect(next.getMinutes()).toBe(0);
  });

  test('next run is always in the future', () => {
    const from = new Date();
    const next = scheduler.getNextRun('* * * * *', from);
    expect(next.getTime()).toBeGreaterThan(from.getTime());
  });

  test('throws if no match found within ~1 year (impossible expression)', () => {
    // Feb 30 does not exist — cron won't fire within a year
    expect(() => scheduler.getNextRun('0 0 30 2 *')).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Task lifecycle
// ---------------------------------------------------------------------------

describe('Task lifecycle', () => {
  let scheduler: TaskScheduler;

  beforeEach(() => {
    resetTestTaskScheduler();
    // Use in-memory store path that won't write to real disk
    scheduler = getTestTaskScheduler('/tmp/gv-scheduler-test-' + Math.random().toString(36).slice(2) + '.json');
  });

  test('add() creates a task with generated id and nextRun', () => {
    const task = scheduler.add({
      name: 'test-task',
      cron: '*/5 * * * *',
      prompt: 'Hello world',
      enabled: true,
    });
    expect(task.id).toMatch(/^sched-/);
    expect(task.runCount).toBe(0);
    expect(task.nextRun).toBeGreaterThan(Date.now());
  });

  test('add() throws on invalid cron', () => {
    expect(() =>
      scheduler.add({
        name: 'bad',
        cron: 'not a cron',
        prompt: 'test',
        enabled: true,
      })
    ).toThrow();
  });

  test('list() returns added tasks', () => {
    scheduler.add({ name: 'a', cron: '* * * * *', prompt: 'A', enabled: true });
    scheduler.add({ name: 'b', cron: '0 * * * *', prompt: 'B', enabled: true });
    expect(scheduler.list()).toHaveLength(2);
  });

  test('remove() removes an existing task', () => {
    const task = scheduler.add({ name: 'r', cron: '* * * * *', prompt: 'R', enabled: true });
    expect(scheduler.remove(task.id)).toBe(true);
    expect(scheduler.list()).toHaveLength(0);
  });

  test('remove() returns false for unknown id', () => {
    expect(scheduler.remove('nonexistent-id')).toBe(false);
  });

  test('setEnabled(false) disables a task', () => {
    const task = scheduler.add({ name: 'e', cron: '* * * * *', prompt: 'E', enabled: true });
    expect(scheduler.setEnabled(task.id, false)).toBe(true);
    const updated = scheduler.list().find((t) => t.id === task.id);
    expect(updated?.enabled).toBe(false);
  });

  test('setEnabled(true) re-enables a task and recomputes nextRun', () => {
    const task = scheduler.add({ name: 'f', cron: '* * * * *', prompt: 'F', enabled: false });
    scheduler.setEnabled(task.id, true);
    const updated = scheduler.list().find((t) => t.id === task.id);
    expect(updated?.enabled).toBe(true);
    expect(updated?.nextRun).toBeGreaterThan(Date.now());
  });

  test('setEnabled() returns false for unknown id', () => {
    expect(scheduler.setEnabled('nope', true)).toBe(false);
  });

  test('test helper reuses the same scheduler until reset', () => {
    const a = getTestTaskScheduler();
    const b = getTestTaskScheduler();
    expect(a).toBe(b);
    resetTestTaskScheduler();
  });

  test('test helper accepts an explicit storePath', () => {
    const path = '/tmp/gv-test-scheduler-' + Math.random().toString(36).slice(2) + '.json';
    const inst = getTestTaskScheduler(path);
    expect(inst).toBeInstanceOf(TaskScheduler);
    resetTestTaskScheduler();
  });

  test('runNow reschedules task after execution (even on failure)', async () => {
    const scheduler2 = new TaskScheduler({
      storePath: '/tmp/gv-scheduler-test-' + Math.random().toString(36).slice(2) + '.json',
      spawnTask: () => 'agent-scheduler-runnow',
    });
    scheduler2.start();
    const task = scheduler2.add({ name: 'resched-test', cron: '* * * * *', prompt: 'test', enabled: true });

    const originalNextRun = task.nextRun;
    expect(originalNextRun).toBeDefined();

    // Clear nextRun to verify it gets recomputed
    task.nextRun = undefined;

    // runNow triggers executeTask (fails without AgentManager) but should reschedule
    await scheduler2.runNow(task.id);

    // nextRun should be recomputed by the reschedule in runNow
    expect(task.nextRun).toBeDefined();
    expect(task.nextRun).toBeGreaterThan(Date.now() - 1000);

    scheduler2.stop();
  });
});
