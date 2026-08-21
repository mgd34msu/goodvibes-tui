/**
 * Local natural-language schedule parsing for `/schedule add when "<phrase>"`.
 *
 * Parses common English scheduling phrases entirely offline into one of the
 * three concrete schedule shapes the automation manager already understands,
 * `cron`, `every` (fixed interval), or `at` (one-shot timestamp), and returns
 * a plain-English description of exactly what it decided, so the caller can
 * ALWAYS echo the concrete interpretation back to the user before anything is
 * saved.
 *
 * This is intentionally a bounded, predictable grammar rather than a fuzzy
 * date library: it recognizes a fixed set of shapes and reports an honest error
 * for anything it does not understand, so the user is never silently given a
 * schedule that does not match what they typed.
 */

export type ParsedSchedule =
  | { readonly kind: 'cron'; readonly expression: string; readonly description: string }
  | { readonly kind: 'every'; readonly interval: string; readonly description: string }
  | { readonly kind: 'at'; readonly at: number; readonly description: string }
  | { readonly kind: 'error'; readonly error: string };

const DOW: Record<string, number> = {
  sunday: 0, sun: 0,
  monday: 1, mon: 1,
  tuesday: 2, tue: 2, tues: 2,
  wednesday: 3, wed: 3,
  thursday: 4, thu: 4, thurs: 4,
  friday: 5, fri: 5,
  saturday: 6, sat: 6,
};

const DOW_NAME = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** Parse "9am", "9:30pm", "14:00", "9" → {hour, minute} in 24h, or null. */
function parseTimeOfDay(raw: string): { hour: number; minute: number } | null {
  const m = raw.trim().toLowerCase().match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/);
  if (!m) return null;
  let hour = Number(m[1]);
  const minute = m[2] ? Number(m[2]) : 0;
  const meridiem = m[3];
  if (minute > 59) return null;
  if (meridiem === 'am') {
    if (hour < 1 || hour > 12) return null;
    if (hour === 12) hour = 0;
  } else if (meridiem === 'pm') {
    if (hour < 1 || hour > 12) return null;
    if (hour !== 12) hour += 12;
  } else if (hour > 23) {
    return null;
  }
  return { hour, minute };
}

function fmtTime(hour: number, minute: number): string {
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

const UNIT_MS: Record<string, number> = {
  second: 1000, seconds: 1000, sec: 1000, secs: 1000,
  minute: 60_000, minutes: 60_000, min: 60_000, mins: 60_000,
  hour: 3_600_000, hours: 3_600_000, hr: 3_600_000, hrs: 3_600_000,
  day: 86_400_000, days: 86_400_000,
};

/** Parse a natural-language scheduling phrase into a concrete schedule. */
export function parseNaturalLanguageSchedule(phrase: string, now: number = Date.now()): ParsedSchedule {
  const text = phrase.trim().toLowerCase().replace(/\s+/g, ' ');
  if (!text) return { kind: 'error', error: 'Empty schedule phrase.' };

  // "at HH..." with an optional day anchor → one-shot `at`.
  const relIn = text.match(/^in (\d+) (second|seconds|sec|secs|minute|minutes|min|mins|hour|hours|hr|hrs|day|days)$/);
  if (relIn) {
    const unitMs = UNIT_MS[relIn[2]!]!;
    const at = now + Number(relIn[1]) * unitMs;
    return { kind: 'at', at, description: `once at ${new Date(at).toLocaleString()}` };
  }

  // Shorthand words.
  if (text === 'hourly') return { kind: 'cron', expression: '0 * * * *', description: 'every hour, on the hour' };
  if (text === 'daily') return { kind: 'cron', expression: '0 0 * * *', description: 'every day at 00:00' };
  if (text === 'weekly') return { kind: 'cron', expression: '0 0 * * 0', description: 'every week on Sunday at 00:00' };

  // "every <n> <unit>" → fixed interval.
  const everyN = text.match(/^every (\d+) (second|seconds|sec|secs|minute|minutes|min|mins|hour|hours|hr|hrs|day|days)$/);
  if (everyN) {
    const n = everyN[1]!;
    const unit = everyN[2]!;
    const short = unit.startsWith('sec') ? 's' : unit.startsWith('min') ? 'm' : unit.startsWith('h') ? 'h' : 'd';
    return { kind: 'every', interval: `${n}${short}`, description: `every ${n} ${unit}` };
  }

  // "every <unit>" (singular) → interval of 1 unit.
  const everyUnit = text.match(/^every (second|minute|hour|day)$/);
  if (everyUnit) {
    const unit = everyUnit[1]!;
    const short = unit === 'second' ? 's' : unit === 'minute' ? 'm' : unit === 'hour' ? 'h' : 'd';
    return { kind: 'every', interval: `1${short}`, description: `every ${unit}` };
  }

  // Time-of-day driven cron forms. Extract a trailing "at <time>", default midnight.
  const atMatch = text.match(/(?:^|\s)at (\d{1,2}(?::\d{2})?\s*(?:am|pm)?)$/);
  const timeStr = atMatch ? atMatch[1]! : null;
  const time = timeStr ? parseTimeOfDay(timeStr) : { hour: 0, minute: 0 };
  if (timeStr && !time) return { kind: 'error', error: `Could not understand the time "${timeStr}".` };
  const head = atMatch ? text.slice(0, text.length - atMatch[0].length).trim() : text;
  const { hour, minute } = time!;

  // "every day" / "everyday" / "daily at <time>".
  if (head === 'every day' || head === 'everyday' || head === 'daily') {
    return { kind: 'cron', expression: `${minute} ${hour} * * *`, description: `every day at ${fmtTime(hour, minute)}` };
  }

  // "every weekday" / "weekdays".
  if (head === 'every weekday' || head === 'weekdays' || head === 'every weekdays') {
    return { kind: 'cron', expression: `${minute} ${hour} * * 1-5`, description: `every weekday (Mon-Fri) at ${fmtTime(hour, minute)}` };
  }

  // "every weekend" / "weekends".
  if (head === 'every weekend' || head === 'weekends' || head === 'every weekends') {
    return { kind: 'cron', expression: `${minute} ${hour} * * 0,6`, description: `every weekend (Sat-Sun) at ${fmtTime(hour, minute)}` };
  }

  // "every <weekday>" / "every monday" etc.
  const everyDow = head.match(/^every (\w+)$/) ?? head.match(/^(\w+)s$/);
  if (everyDow) {
    const day = everyDow[1]!;
    const dow = DOW[day] ?? DOW[day.replace(/s$/, '')];
    if (dow !== undefined) {
      return { kind: 'cron', expression: `${minute} ${hour} * * ${dow}`, description: `every ${DOW_NAME[dow]} at ${fmtTime(hour, minute)}` };
    }
  }

  // Bare "at <time>" → one-shot at the next occurrence of that time today/tomorrow.
  if (timeStr && head === '') {
    const next = new Date(now);
    next.setSeconds(0, 0);
    next.setHours(hour, minute, 0, 0);
    if (next.getTime() <= now) next.setDate(next.getDate() + 1);
    return { kind: 'at', at: next.getTime(), description: `once at ${next.toLocaleString()}` };
  }

  return {
    kind: 'error',
    error: `Could not parse "${phrase}". Try phrases like "every weekday at 9am", "every 30 minutes", "daily at 6pm", "every monday at 08:00", or "in 2 hours".`,
  };
}
