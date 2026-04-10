import { TaskScheduler } from '../scheduler/scheduler.ts';

export interface AutomationAtSchedule {
  readonly kind: 'at';
  readonly at: number;
}

export interface AutomationEverySchedule {
  readonly kind: 'every';
  readonly intervalMs: number;
  readonly anchorAt?: number;
}

export interface AutomationCronSchedule {
  readonly kind: 'cron';
  readonly expression: string;
  readonly timezone?: string;
}

export type AutomationScheduleDefinition =
  | AutomationAtSchedule
  | AutomationEverySchedule
  | AutomationCronSchedule;

export type AutomationScheduleKind = AutomationScheduleDefinition['kind'];

const EVERY_PATTERN = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/;
const CRON_HELPER = new TaskScheduler('.goodvibes/tui/.automation-cron-helper.json');

function ensurePositiveFinite(value: number, label: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${label} must be a positive finite number`);
  }
}

export function parseEveryInterval(input: string): number {
  const match = input.trim().match(EVERY_PATTERN);
  if (!match) {
    throw new Error(`Invalid interval: "${input}". Use values like 30s, 5m, 1h, or 1d.`);
  }
  const amount = Number.parseFloat(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error(`Invalid interval amount: "${input}"`);
  }
  switch (match[2]) {
    case 'ms':
      return amount;
    case 's':
      return amount * 1_000;
    case 'm':
      return amount * 60_000;
    case 'h':
      return amount * 3_600_000;
    case 'd':
      return amount * 86_400_000;
    default:
      throw new Error(`Unsupported interval unit: "${match[2]}"`);
  }
}

export function formatEveryInterval(intervalMs: number): string {
  ensurePositiveFinite(intervalMs, 'intervalMs');
  const units: ReadonlyArray<readonly [number, string]> = [
    [86_400_000, 'd'],
    [3_600_000, 'h'],
    [60_000, 'm'],
    [1_000, 's'],
  ];
  for (const [size, unit] of units) {
    if (intervalMs >= size && intervalMs % size === 0) {
      return `${intervalMs / size}${unit}`;
    }
  }
  return `${intervalMs}ms`;
}

export function validateSchedule(schedule: AutomationScheduleDefinition): void {
  switch (schedule.kind) {
    case 'at':
      ensurePositiveFinite(schedule.at, 'schedule.at');
      break;
    case 'every':
      ensurePositiveFinite(schedule.intervalMs, 'schedule.intervalMs');
      if (schedule.anchorAt !== undefined) {
        ensurePositiveFinite(schedule.anchorAt, 'schedule.anchorAt');
      }
      break;
    case 'cron':
      if (!schedule.expression.trim()) {
        throw new Error('schedule.expression must not be empty');
      }
      if (schedule.timezone) {
        TaskScheduler.validateTimezone(schedule.timezone);
      }
      CRON_HELPER.getNextRun(schedule.expression, new Date(), schedule.timezone);
      break;
  }
}

export function normalizeAtSchedule(at: number): AutomationAtSchedule {
  const schedule: AutomationAtSchedule = { kind: 'at', at };
  validateSchedule(schedule);
  return schedule;
}

export function normalizeEverySchedule(interval: string | number, anchorAt?: number): AutomationEverySchedule {
  const intervalMs = typeof interval === 'string' ? parseEveryInterval(interval) : interval;
  const schedule: AutomationEverySchedule = {
    kind: 'every',
    intervalMs,
    ...(anchorAt !== undefined ? { anchorAt } : {}),
  };
  validateSchedule(schedule);
  return schedule;
}

export function normalizeCronSchedule(expression: string, timezone?: string): AutomationCronSchedule {
  const schedule: AutomationCronSchedule = {
    kind: 'cron',
    expression,
    ...(timezone ? { timezone } : {}),
  };
  validateSchedule(schedule);
  return schedule;
}

export function getNextAutomationOccurrence(
  schedule: AutomationScheduleDefinition,
  fromMs: number = Date.now(),
): number | undefined {
  validateSchedule(schedule);
  switch (schedule.kind) {
    case 'at':
      return schedule.at > fromMs ? schedule.at : undefined;
    case 'every': {
      const anchorAt = schedule.anchorAt ?? fromMs;
      if (anchorAt > fromMs) return anchorAt;
      const elapsed = Math.max(0, fromMs - anchorAt);
      const periodsElapsed = Math.floor(elapsed / schedule.intervalMs) + 1;
      return anchorAt + periodsElapsed * schedule.intervalMs;
    }
    case 'cron':
      return CRON_HELPER.getNextRun(schedule.expression, new Date(fromMs), schedule.timezone).getTime();
  }
}

export function isAutomationDue(
  schedule: AutomationScheduleDefinition,
  nextRunAt: number | undefined,
  now: number = Date.now(),
): boolean {
  if (schedule.kind === 'at' && nextRunAt === undefined) return false;
  return nextRunAt !== undefined && nextRunAt <= now;
}
