import { createHash } from 'node:crypto';
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
  readonly staggerMs?: number;
}

export type AutomationScheduleDefinition =
  | AutomationAtSchedule
  | AutomationEverySchedule
  | AutomationCronSchedule;

export type AutomationScheduleKind = AutomationScheduleDefinition['kind'];

const EVERY_PATTERN = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/;
const CRON_HELPER_STATE_PATH = '.goodvibes/tui/.automation-cron-helper.json';

export const DEFAULT_TOP_OF_HOUR_STAGGER_MS = 5 * 60 * 1_000;

function createCronHelper(): TaskScheduler {
  return new TaskScheduler(CRON_HELPER_STATE_PATH);
}

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

function parseCronFields(expression: string): string[] {
  return expression.trim().split(/\s+/).filter(Boolean);
}

export function isRecurringTopOfHourCronExpression(expression: string): boolean {
  const fields = parseCronFields(expression);
  if (fields.length === 5) {
    const [minuteField, hourField] = fields;
    return minuteField === '0' && hourField.includes('*');
  }
  if (fields.length === 6) {
    const [secondField, minuteField, hourField] = fields;
    return secondField === '0' && minuteField === '0' && hourField.includes('*');
  }
  return false;
}

export function normalizeCronStaggerMs(raw: unknown): number | undefined {
  const numeric = typeof raw === 'number'
    ? raw
    : typeof raw === 'string' && raw.trim().length > 0
      ? Number(raw)
      : Number.NaN;
  if (!Number.isFinite(numeric)) {
    return undefined;
  }
  return Math.max(0, Math.floor(numeric));
}

export function resolveDefaultCronStaggerMs(expression: string): number | undefined {
  return isRecurringTopOfHourCronExpression(expression) ? DEFAULT_TOP_OF_HOUR_STAGGER_MS : undefined;
}

export function resolveAutomationCronStaggerMs(schedule: AutomationCronSchedule): number {
  const explicit = normalizeCronStaggerMs(schedule.staggerMs);
  if (explicit !== undefined) return explicit;
  return resolveDefaultCronStaggerMs(schedule.expression) ?? 0;
}

export function resolveStableAutomationCronOffsetMs(stableId: string | undefined, staggerMs: number): number {
  if (!stableId || staggerMs <= 1) return 0;
  const digest = createHash('sha256').update(stableId).digest();
  return digest.readUInt32BE(0) % staggerMs;
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
      if (schedule.staggerMs !== undefined && normalizeCronStaggerMs(schedule.staggerMs) === undefined) {
        throw new Error('schedule.staggerMs must be a finite number when provided');
      }
      createCronHelper().getNextRun(schedule.expression, new Date(), schedule.timezone);
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

export function normalizeCronSchedule(expression: string, timezone?: string, staggerMs?: unknown): AutomationCronSchedule {
  const normalizedStaggerMs = normalizeCronStaggerMs(staggerMs);
  const effectiveStaggerMs = normalizedStaggerMs ?? resolveDefaultCronStaggerMs(expression);
  const schedule: AutomationCronSchedule = {
    kind: 'cron',
    expression,
    ...(timezone ? { timezone } : {}),
    ...(effectiveStaggerMs !== undefined ? { staggerMs: effectiveStaggerMs } : {}),
  };
  validateSchedule(schedule);
  return schedule;
}

function getNextCronOccurrence(schedule: AutomationCronSchedule, fromMs: number): number {
  return createCronHelper().getNextRun(schedule.expression, new Date(fromMs), schedule.timezone).getTime();
}

export function getNextAutomationOccurrence(
  schedule: AutomationScheduleDefinition,
  fromMs: number = Date.now(),
  stableId?: string,
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
    case 'cron': {
      const offsetMs = resolveStableAutomationCronOffsetMs(stableId, resolveAutomationCronStaggerMs(schedule));
      if (offsetMs <= 0) {
        return getNextCronOccurrence(schedule, fromMs);
      }
      let cursorMs = Math.max(0, fromMs - offsetMs);
      for (let attempt = 0; attempt < 8; attempt++) {
        const baseNext = getNextCronOccurrence(schedule, cursorMs);
        const shiftedNext = baseNext + offsetMs;
        if (shiftedNext > fromMs) return shiftedNext;
        cursorMs = Math.max(cursorMs + 1_000, baseNext + 1_000);
      }
      return getNextCronOccurrence(schedule, fromMs) + offsetMs;
    }
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
