import { join } from 'path';
import { PersistentStore } from '../state/persistent-store.ts';
import { AgentManager } from '../tools/agent/index.ts';
import { logger } from '../utils/logger.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ScheduledTask {
  id: string;
  name: string;
  cron: string; // cron expression: "*/30 * * * *" = every 30 min
  prompt: string; // the prompt to send to the model
  model?: string; // optional model override
  template?: string; // agent template (engineer, reviewer, etc.)
  enabled: boolean;
  lastRun?: number; // timestamp
  nextRun?: number; // computed
  runCount: number;
  createdAt: number;
}

export interface TaskRunRecord {
  taskId: string;
  startedAt: number;
  agentId: string;
  status: 'running' | 'completed' | 'failed';
  error?: string;
}

interface CronFields {
  minute: CronField;
  hour: CronField;
  dayOfMonth: CronField;
  month: CronField;
  dayOfWeek: CronField;
}

type CronField =
  | { type: 'any' }
  | { type: 'exact'; values: number[] }
  | { type: 'step'; step: number; from?: number }
  | { type: 'range'; from: number; to: number }
  | { type: 'list'; values: number[] };

interface StoreData extends Record<string, unknown> {
  tasks: ScheduledTask[];
  history: TaskRunRecord[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SCHEDULES_PATH = join(process.cwd(), '.goodvibes', 'tui', 'schedules.json');

/** Max run history records to keep per task. */
const MAX_HISTORY_PER_TASK = 5;

// ---------------------------------------------------------------------------
// Cron parser
// ---------------------------------------------------------------------------

/**
 * Parse a single cron field token (e.g. "*", "* /5", "1-5", "1,2,3", "3").
 *
 * Supported: any | step | range | list | exact
 */
function parseCronField(token: string, min: number, max: number): CronField {
  if (token === '*') {
    return { type: 'any' };
  }

  // Step: */N or N/N or N-M/N (e.g. "*/5", "0/15", "1-5/2")
  if (token.includes('/')) {
    const slashIdx = token.indexOf('/');
    const base = token.slice(0, slashIdx);
    const stepRaw = token.slice(slashIdx + 1);
    const step = parseInt(stepRaw, 10);
    if (isNaN(step) || step < 1) throw new Error(`Invalid cron step: ${token}`);
    if (base === '*') {
      return { type: 'step', step, from: min };
    }
    // Base can be a range (N-M) or a plain number
    if (base.includes('-')) {
      const [fromRaw, toRaw] = base.split('-');
      const from = parseInt(fromRaw, 10);
      const to = parseInt(toRaw, 10);
      if (isNaN(from) || isNaN(to) || from < min || to > max || from > to) {
        throw new Error(`Invalid cron range in step: ${token} (allowed ${min}-${max})`);
      }
      // Expand range with step
      const values: number[] = [];
      for (let v = from; v <= to; v += step) values.push(v);
      return { type: 'list', values };
    }
    const from = parseInt(base, 10);
    if (isNaN(from)) throw new Error(`Invalid cron step base: ${token}`);
    return { type: 'step', step, from };
  }

  // List: N,M,... (elements may be ranges N-M)
  if (token.includes(',')) {
    const values: number[] = [];
    for (const part of token.split(',')) {
      if (part.includes('-')) {
        const [fromRaw, toRaw] = part.split('-');
        const from = parseInt(fromRaw, 10);
        const to = parseInt(toRaw, 10);
        if (isNaN(from) || isNaN(to) || from < min || to > max || from > to) {
          throw new Error(`Invalid cron range in list: ${part} (allowed ${min}-${max})`);
        }
        for (let v = from; v <= to; v++) values.push(v);
      } else {
        const v = parseInt(part, 10);
        if (isNaN(v) || v < min || v > max) {
          throw new Error(`Invalid cron list value: ${part} (allowed ${min}-${max})`);
        }
        values.push(v);
      }
    }
    return { type: 'list', values };
  }

  // Range: N-M
  if (token.includes('-')) {
    const [fromRaw, toRaw] = token.split('-');
    const from = parseInt(fromRaw, 10);
    const to = parseInt(toRaw, 10);
    if (isNaN(from) || isNaN(to) || from < min || to > max || from > to) {
      throw new Error(`Invalid cron range: ${token} (allowed ${min}-${max})`);
    }
    return { type: 'range', from, to };
  }

  // Exact value
  const val = parseInt(token, 10);
  if (isNaN(val) || val < min || val > max) {
    throw new Error(`Invalid cron value: ${token} (allowed ${min}-${max})`);
  }
  return { type: 'exact', values: [val] };
}

/**
 * Parse a 5-field cron expression: minute hour day-of-month month day-of-week
 */
function parseCron(expr: string): CronFields {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error(`Cron expression must have 5 fields: "${expr}"`);
  }
  return {
    minute: parseCronField(parts[0], 0, 59),
    hour: parseCronField(parts[1], 0, 23),
    dayOfMonth: parseCronField(parts[2], 1, 31),
    month: parseCronField(parts[3], 1, 12),
    dayOfWeek: normalizeDayOfWeek(parseCronField(parts[4], 0, 7)),
  };
}

/**
 * Normalize dayOfWeek field: expand all field types to explicit value lists,
 * then map 7 → 0 (both mean Sunday, POSIX compat).
 */
function normalizeDayOfWeek(field: CronField): CronField {
  if (field.type === 'any') return field;

  // Expand to explicit values list regardless of type
  const values: number[] = [];
  if (field.type === 'exact') {
    values.push(...field.values);
  } else if (field.type === 'list') {
    values.push(...field.values);
  } else if (field.type === 'range') {
    for (let i = field.from; i <= field.to; i++) values.push(i);
  } else if (field.type === 'step') {
    for (let i = field.from ?? 0; i <= 7; i += field.step) values.push(i);
  }

  // Normalize 7 → 0
  const normalized = [...new Set(values.map((v) => (v === 7 ? 0 : v)))].sort((a, b) => a - b);

  if (normalized.length === 1) return { type: 'exact', values: normalized };
  return { type: 'list', values: normalized };
}

/**
 * Check whether a value matches a CronField.
 */
function fieldMatches(field: CronField, value: number): boolean {
  switch (field.type) {
    case 'any':
      return true;
    case 'exact':
      return field.values.includes(value);
    case 'step': {
      const from = field.from ?? 0;
      if (value < from) return false;
      return (value - from) % field.step === 0;
    }
    case 'range':
      return value >= field.from && value <= field.to;
    case 'list':
      return field.values.includes(value);
  }
}

/**
 * Compute the next Date when a cron expression fires after `from`.
 * Returns a Date at most 366 days in the future; throws if none found.
 *
 * Advances minute-by-minute to find the next matching moment.
 * Handles DST gracefully by working in local time arithmetic.
 */
function computeNextRun(expr: string, from: Date): Date {
  const fields = parseCron(expr);

  // Start from the next minute after `from`
  const base = new Date(from.getTime());
  base.setSeconds(0, 0);
  base.setMinutes(base.getMinutes() + 1);

  const limit = new Date(base.getTime() + 366 * 24 * 60 * 60 * 1000);

  let cur = new Date(base.getTime());

  while (cur < limit) {
    const month = cur.getMonth() + 1; // 1-12
    const dom = cur.getDate(); // 1-31
    const dow = cur.getDay(); // 0-6
    const hour = cur.getHours();
    const minute = cur.getMinutes();

    if (!fieldMatches(fields.month, month)) {
      // Advance to next month
      cur = new Date(cur.getFullYear(), month, 1, 0, 0, 0, 0); // month index = next
      continue;
    }

    // POSIX cron OR logic: when both dom and dow are non-wildcard, either match suffices.
    const domIsAny = fields.dayOfMonth.type === 'any';
    const dowIsAny = fields.dayOfWeek.type === 'any';
    const domMatch = fieldMatches(fields.dayOfMonth, dom);
    const dowMatch = fieldMatches(fields.dayOfWeek, dow);
    const dayMatch = domIsAny && dowIsAny
      ? true
      : domIsAny
        ? dowMatch
        : dowIsAny
          ? domMatch
          : domMatch || dowMatch;
    if (!dayMatch) {
      // Advance to next day
      cur = new Date(cur.getFullYear(), cur.getMonth(), dom + 1, 0, 0, 0, 0);
      continue;
    }

    if (!fieldMatches(fields.hour, hour)) {
      // Advance to next hour
      cur = new Date(cur.getFullYear(), cur.getMonth(), dom, hour + 1, 0, 0, 0);
      continue;
    }

    if (!fieldMatches(fields.minute, minute)) {
      // Advance to next minute
      cur = new Date(cur.getFullYear(), cur.getMonth(), dom, hour, minute + 1, 0, 0);
      continue;
    }

    return cur;
  }

  throw new Error(`No matching time found in the next year for cron: ${expr}`);
}

// ---------------------------------------------------------------------------
// TaskScheduler
// ---------------------------------------------------------------------------

/**
 * TaskScheduler — cron-like task scheduler that runs inside the daemon.
 *
 * Tasks persist to disk (`.goodvibes/tui/schedules.json`) and survive restarts.
 * Each execution spawns a fresh agent via AgentManager; no shared state between runs.
 */
export class TaskScheduler {
  private static instance: TaskScheduler | null = null;

  private tasks: Map<string, ScheduledTask> = new Map();
  private timers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private history: TaskRunRecord[] = [];
  private store: PersistentStore<StoreData>;
  private running = false;

  constructor(storePath: string = SCHEDULES_PATH) {
    this.store = new PersistentStore<StoreData>(storePath);
  }

  /** Singleton accessor. */
  static getInstance(storePath?: string): TaskScheduler {
    if (!TaskScheduler.instance) {
      TaskScheduler.instance = new TaskScheduler(storePath);
    }
    return TaskScheduler.instance;
  }

  /** Reset singleton — for testing only. */
  static resetInstance(): void {
    TaskScheduler.instance?.stop();
    TaskScheduler.instance = null;
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /** Load tasks from disk and start timers. */
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    await this.load();
    for (const task of this.tasks.values()) {
      if (task.enabled) {
        this.scheduleNext(task);
      }
    }
    logger.info('TaskScheduler started', { taskCount: this.tasks.size });
  }

  /** Stop all timers. */
  stop(): void {
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
    this.running = false;
    logger.info('TaskScheduler stopped');
  }

  // -------------------------------------------------------------------------
  // Task management
  // -------------------------------------------------------------------------

  /** Add a new scheduled task. Returns the created task with generated ID. */
  add(input: Omit<ScheduledTask, 'id' | 'runCount' | 'createdAt'>): ScheduledTask {
    // Validate the cron expression eagerly
    parseCron(input.cron);

    const id = `sched-${crypto.randomUUID().slice(0, 8)}`;
    const now = Date.now();
    const nextRun = computeNextRun(input.cron, new Date(now)).getTime();

    const task: ScheduledTask = {
      ...input,
      id,
      runCount: 0,
      createdAt: now,
      nextRun,
    };

    this.tasks.set(id, task);
    void this.save().catch((err) => logger.debug('TaskScheduler: save failed', { error: String(err) }));

    if (task.enabled && this.running) {
      this.scheduleNext(task);
    }

    return task;
  }

  /** Remove a task by ID. Returns true if found and removed. */
  remove(taskId: string): boolean {
    if (!this.tasks.has(taskId)) return false;
    this.cancelTimer(taskId);
    this.tasks.delete(taskId);
    void this.save().catch((err) => logger.debug('TaskScheduler: save failed', { error: String(err) }));
    return true;
  }

  /** Enable or disable a task. */
  setEnabled(taskId: string, enabled: boolean): boolean {
    const task = this.tasks.get(taskId);
    if (!task) return false;
    task.enabled = enabled;
    if (enabled) {
      const next = computeNextRun(task.cron, new Date()).getTime();
      task.nextRun = next;
      if (this.running) this.scheduleNext(task);
    } else {
      this.cancelTimer(taskId);
    }
    void this.save().catch((err) => logger.debug('TaskScheduler: save failed', { error: String(err) }));
    return true;
  }

  /** Return all tasks as an array. */
  list(): ScheduledTask[] {
    return Array.from(this.tasks.values());
  }

  /** Return the run history for a given task (up to MAX_HISTORY_PER_TASK). */
  getHistory(taskId: string): TaskRunRecord[] {
    return this.history.filter((r) => r.taskId === taskId).slice(-MAX_HISTORY_PER_TASK);
  }

  /** Return all run history records. */
  getAllHistory(): TaskRunRecord[] {
    return [...this.history];
  }

  /**
   * Compute the next run time for a cron expression, starting from `from`
   * (defaults to now). Throws if the expression is invalid.
   */
  getNextRun(cron: string, from?: Date): Date {
    return computeNextRun(cron, from ?? new Date());
  }

  /** Run a task immediately (ignoring its schedule). */
  async runNow(taskId: string): Promise<string> {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    return this.executeTask(task);
  }

  // -------------------------------------------------------------------------
  // Internal scheduling
  // -------------------------------------------------------------------------

  private scheduleNext(task: ScheduledTask): void {
    this.cancelTimer(task.id);

    let nextDate: Date;
    try {
      nextDate = computeNextRun(task.cron, new Date());
    } catch (err) {
      logger.error('TaskScheduler: invalid cron, disabling task', { taskId: task.id, error: String(err) });
      return;
    }

    const delayMs = nextDate.getTime() - Date.now();
    task.nextRun = nextDate.getTime();

    const timer = setTimeout(() => {
      if (!task.enabled) return;
      this.executeTask(task)
        .catch((err) => {
          logger.error('TaskScheduler: task execution failed', { taskId: task.id, error: String(err) });
        })
        .finally(() => {
          if (task.enabled && this.running) this.scheduleNext(task);
        });
    }, Math.max(0, delayMs));

    this.timers.set(task.id, timer);
  }

  private cancelTimer(taskId: string): void {
    const existing = this.timers.get(taskId);
    if (existing !== undefined) {
      clearTimeout(existing);
      this.timers.delete(taskId);
    }
  }

  /**
   * Execute a task by spawning an agent with the task's prompt.
   * Records the run in history and updates the task's lastRun/runCount.
   * Returns the spawned agent ID.
   */
  private async executeTask(task: ScheduledTask): Promise<string> {
    logger.info('TaskScheduler: executing task', { taskId: task.id, name: task.name });

    const agentManager = AgentManager.getInstance();
    let agentId: string;

    try {
      const record = agentManager.spawn({
        mode: 'spawn',
        task: task.prompt,
        ...(task.model !== undefined && { model: task.model }),
        ...(task.template !== undefined && { template: task.template }),
      });
      agentId = record.id;
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      logger.error('TaskScheduler: spawn failed', { taskId: task.id, error: errorMsg });

      const runRecord: TaskRunRecord = {
        taskId: task.id,
        startedAt: Date.now(),
        agentId: '',
        status: 'failed',
        error: errorMsg,
      };
      this.pushHistory(runRecord);
      void this.save().catch((e) => logger.debug('TaskScheduler: save failed', { error: String(e) }));
      throw err;
    }

    // Update task stats
    task.lastRun = Date.now();
    task.runCount++;

    const runRecord: TaskRunRecord = {
      taskId: task.id,
      startedAt: task.lastRun,
      agentId,
      status: 'running',
    };
    this.pushHistory(runRecord);
    void this.save().catch((err) => logger.debug('TaskScheduler: save failed', { error: String(err) }));

    return agentId;
  }

  private pushHistory(record: TaskRunRecord): void {
    this.history.push(record);
    // Keep only MAX_HISTORY_PER_TASK per task
    const perTask = this.history.filter((r) => r.taskId === record.taskId);
    if (perTask.length > MAX_HISTORY_PER_TASK) {
      // Remove the oldest entries for this task
      const toRemove = perTask.length - MAX_HISTORY_PER_TASK;
      let removed = 0;
      this.history = this.history.filter((r) => {
        if (r.taskId === record.taskId && removed < toRemove) {
          removed++;
          return false;
        }
        return true;
      });
    }
  }

  // -------------------------------------------------------------------------
  // Persistence
  // -------------------------------------------------------------------------

  private async save(): Promise<void> {
    await this.store.persist({
      tasks: Array.from(this.tasks.values()),
      history: this.history,
    });
  }

  private async load(): Promise<void> {
    const data = await this.store.load();
    if (!data) return;

    if (Array.isArray(data.tasks)) {
      for (const t of data.tasks) {
        // Recompute nextRun on load so stale values are replaced
        try {
          t.nextRun = computeNextRun(t.cron, new Date()).getTime();
        } catch {
          t.enabled = false; // Disable tasks with invalid cron
        }
        this.tasks.set(t.id, t);
      }
    }

    if (Array.isArray(data.history)) {
      this.history = data.history;
    }
  }
}
