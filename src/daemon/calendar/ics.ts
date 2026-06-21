// RFC 5545 (iCalendar) parser + generator for the CalDAV calendar surface.
//
// This module is pure (no network, no secrets). It is used by the CalDAV client
// to serialise events for PUT and to deserialise REPORT/GET responses, and by
// the operator methods for `calendar.ics.import` / `calendar.ics.export`.
//
// The implementation targets the VEVENT subset that calendar connectors need:
// SUMMARY, DTSTART, DTEND, DESCRIPTION, LOCATION, UID, ATTENDEE, ORGANIZER,
// STATUS, RRULE, plus all-day (VALUE=DATE) detection. Unknown properties are
// preserved on parse via the `raw` map so round-tripping does not lose data.

export interface ICalAttendee {
  /** Display name only (CN parameter, or local-part of the address). */
  displayName: string;
  /** Raw value retained for internal generation only — never surfaced to callers. */
  rawValue: string;
}

export interface ParsedICalEvent {
  uid: string;
  summary: string;
  description?: string;
  location?: string;
  /** ISO-8601 start. */
  start: string;
  /** ISO-8601 end. */
  end: string;
  allDay: boolean;
  status?: string;
  /** Raw RRULE value (e.g. "FREQ=WEEKLY;COUNT=10") when present. */
  recurrence?: string;
  attendees: ICalAttendee[];
  /** Organizer display name only (CN or local-part). */
  organizer?: string;
  /** Raw organizer value for internal use only. */
  organizerRaw?: string;
  /** Any properties not explicitly modelled, keyed by upper-case name. */
  raw: Record<string, string>;
}

export interface GenerateICalInput {
  uid: string;
  summary: string;
  start: string; // ISO-8601
  end: string; // ISO-8601
  description?: string;
  location?: string;
  attendees?: string[]; // raw addresses or display names
  organizer?: string;
  status?: string;
  recurrence?: string;
  allDay?: boolean;
  /** Stamp time (ISO-8601); defaults to now. */
  dtStamp?: string;
}

const PRODID = '-//GoodVibes//CalDAV Connector//EN';
const CRLF = '\r\n';

// ---------------------------------------------------------------------------
// Line folding / unfolding (RFC 5545 section 3.1)
// ---------------------------------------------------------------------------

const UTF8 = new TextEncoder();

/** Number of octets a string occupies when encoded as UTF-8. */
function octetLength(value: string): number {
  return UTF8.encode(value).length;
}

/**
 * Fold a content line to <=75 octets per line (RFC 5545 §3.1), with continuation
 * lines prefixed by a single space.
 *
 * Folding is measured in UTF-8 OCTETS, not JS string length (UTF-16 code units),
 * and a fold boundary is never placed in the middle of a multi-byte codepoint.
 * Iterating by Unicode codepoint (via the string iterator, which yields whole
 * codepoints rather than surrogate halves) guarantees the wire bytes stay valid
 * UTF-8 even for non-ASCII SUMMARY/DESCRIPTION/LOCATION content.
 */
export function foldLine(line: string): string {
  if (octetLength(line) <= 75) return line;
  const parts: string[] = [];
  let chunk = '';
  let chunkOctets = 0;
  // First line budget is 75 octets; continuation lines reserve 1 octet for the
  // leading space, leaving 74 octets of payload.
  let budget = 75;
  for (const cp of line) {
    const cpOctets = octetLength(cp);
    if (chunkOctets + cpOctets > budget) {
      parts.push(chunk);
      chunk = cp;
      chunkOctets = cpOctets;
      budget = 74;
    } else {
      chunk += cp;
      chunkOctets += cpOctets;
    }
  }
  if (chunk.length > 0 || parts.length === 0) parts.push(chunk);
  return parts.map((part, index) => (index === 0 ? part : ` ${part}`)).join(CRLF);
}

/** Unfold folded content lines: join continuation lines (those starting with space/tab). */
export function unfoldLines(content: string): string[] {
  const rawLines = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const lines: string[] = [];
  for (const rawLine of rawLines) {
    if ((rawLine.startsWith(' ') || rawLine.startsWith('\t')) && lines.length > 0) {
      lines[lines.length - 1] += rawLine.slice(1);
    } else {
      lines.push(rawLine);
    }
  }
  return lines.filter((line) => line.length > 0);
}

// ---------------------------------------------------------------------------
// Text escaping (RFC 5545 section 3.3.11)
// ---------------------------------------------------------------------------

export function escapeText(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\n|\r/g, '\\n');
}

export function unescapeText(value: string): string {
  let result = '';
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i];
    if (ch === '\\' && i + 1 < value.length) {
      const next = value[i + 1];
      if (next === 'n' || next === 'N') {
        result += '\n';
      } else if (next === '\\' || next === ';' || next === ',') {
        result += next;
      } else {
        // Unrecognised escape sequence (not one of \\ \; \, \n \N): RFC 5545
        // defines no such sequence, so the backslash is a literal character.
        // Preserve BOTH the backslash and the following char so values that
        // happen to contain a literal backslash round-trip losslessly.
        result += ch;
        result += next;
      }
      i += 1;
    } else {
      result += ch;
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Date/time formatting (RFC 5545 section 3.3.5)
// ---------------------------------------------------------------------------

function pad2(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

/** Format an ISO-8601 datetime as a UTC iCalendar timestamp: YYYYMMDDTHHMMSSZ. */
export function formatICalDateTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid date value: ${iso}`);
  }
  return (
    `${date.getUTCFullYear()}`
    + `${pad2(date.getUTCMonth() + 1)}`
    + `${pad2(date.getUTCDate())}`
    + 'T'
    + `${pad2(date.getUTCHours())}`
    + `${pad2(date.getUTCMinutes())}`
    + `${pad2(date.getUTCSeconds())}`
    + 'Z'
  );
}

/**
 * Format an ISO-8601 datetime as an all-day iCalendar DATE: YYYYMMDD.
 *
 * An all-day DATE is a floating calendar day with no timezone (RFC 5545 §3.3.4),
 * so it must reflect the calendar day as written in the INPUT's own offset, not
 * the UTC instant. Deriving YYYYMMDD from UTC components would roll an input such
 * as `2026-12-25T00:00:00+09:00` back to the 24th, corrupting the DATE. We read
 * the wall-clock date components directly from the ISO string's leading
 * `YYYY-MM-DD` (which, for any offset, IS that offset's calendar day) and fall
 * back to UTC components only for non-extended forms that omit a date prefix.
 */
export function formatICalDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid date value: ${iso}`);
  }
  const wallDate = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso.trim());
  if (wallDate) {
    const [, y, m, d] = wallDate;
    return `${y}${m}${d}`;
  }
  return (
    `${date.getUTCFullYear()}`
    + `${pad2(date.getUTCMonth() + 1)}`
    + `${pad2(date.getUTCDate())}`
  );
}

/**
 * Parse an iCalendar date/date-time value into an ISO-8601 string.
 * Supports: YYYYMMDD (DATE), YYYYMMDDTHHMMSSZ (UTC), YYYYMMDDTHHMMSS (floating/local).
 */
export function parseICalDate(value: string): { iso: string; allDay: boolean } {
  const trimmed = value.trim();
  const dateOnly = /^(\d{4})(\d{2})(\d{2})$/.exec(trimmed);
  if (dateOnly) {
    const [, y, m, d] = dateOnly;
    const iso = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d), 0, 0, 0)).toISOString();
    return { iso, allDay: true };
  }
  const dateTime = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/.exec(trimmed);
  if (dateTime) {
    const [, y, m, d, hh, mm, ss, zulu] = dateTime;
    // A trailing 'Z' marks an absolute UTC instant. Without it the value is a
    // floating/local time (RFC 5545 §3.3.5): it has no offset and denotes the
    // wall-clock time in the observer's own zone. Interpreting it via Date.UTC
    // would relabel that wall-clock as UTC and shift the resulting ISO instant
    // by the local offset on round-trip; we instead build it through the local
    // Date constructor so the ISO reflects the same wall-clock in local time.
    const date = zulu
      ? new Date(Date.UTC(Number(y), Number(m) - 1, Number(d), Number(hh), Number(mm), Number(ss)))
      : new Date(Number(y), Number(m) - 1, Number(d), Number(hh), Number(mm), Number(ss));
    return { iso: date.toISOString(), allDay: false };
  }
  throw new Error(`Unrecognised iCalendar date value: ${value}`);
}

// ---------------------------------------------------------------------------
// Property line parsing
// ---------------------------------------------------------------------------

interface ContentLine {
  name: string;
  params: Record<string, string>;
  value: string;
}

function parseContentLine(line: string): ContentLine {
  // Split name(+params) from value at the first unquoted colon.
  let colonIndex = -1;
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') inQuotes = !inQuotes;
    else if (ch === ':' && !inQuotes) {
      colonIndex = i;
      break;
    }
  }
  if (colonIndex === -1) {
    return { name: line.toUpperCase(), params: {}, value: '' };
  }
  const namePart = line.slice(0, colonIndex);
  const value = line.slice(colonIndex + 1);
  const segments = splitParams(namePart);
  const name = (segments.shift() ?? '').toUpperCase();
  const params: Record<string, string> = {};
  for (const segment of segments) {
    const eq = segment.indexOf('=');
    if (eq === -1) continue;
    const key = segment.slice(0, eq).toUpperCase();
    let paramValue = segment.slice(eq + 1);
    if (paramValue.startsWith('"') && paramValue.endsWith('"')) {
      paramValue = paramValue.slice(1, -1);
    }
    params[key] = paramValue;
  }
  return { name, params, value };
}

/** Split a "NAME;PARAM=foo;OTHER=\"a;b\"" prefix on unquoted semicolons. */
function splitParams(input: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
      current += ch;
    } else if (ch === ';' && !inQuotes) {
      result.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.length > 0) result.push(current);
  return result;
}

/** Extract a display name from an ATTENDEE/ORGANIZER value + params. */
export function attendeeDisplayName(params: Record<string, string>, value: string): string {
  const cn = params.CN;
  if (cn && cn.trim().length > 0) return cn.trim();
  const normalized = value.trim();
  const withoutScheme = normalized.replace(/^mailto:/i, '');
  const atIndex = withoutScheme.indexOf('@');
  if (atIndex > 0) return withoutScheme.slice(0, atIndex);
  return withoutScheme;
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

/**
 * Parse a full .ics document and return all VEVENT components. Multiple VEVENTs
 * (e.g. a VCALENDAR with recurring instances) are all returned.
 */
/**
 * Internal accumulator used while parsing a single VEVENT. Carries the VALUE
 * type observed on DTSTART / DTEND so finaliseEvent can enforce agreement
 * (RFC 5545 §3.8.2.2: DTEND must have the same VALUE type as DTSTART).
 */
type ParsingEvent = Partial<ParsedICalEvent> & {
  raw: Record<string, string>;
  attendees?: ICalAttendee[];
  startIsDate?: boolean;
  endIsDate?: boolean;
};

export function parseICS(content: string): ParsedICalEvent[] {
  const lines = unfoldLines(content);
  const events: ParsedICalEvent[] = [];
  let current: ParsingEvent | null = null;

  for (const line of lines) {
    const upper = line.toUpperCase();
    if (upper === 'BEGIN:VEVENT') {
      current = { attendees: [], raw: {} };
      continue;
    }
    if (upper === 'END:VEVENT') {
      if (current) {
        events.push(finaliseEvent(current));
        current = null;
      }
      continue;
    }
    if (!current) continue;

    const parsed = parseContentLine(line);
    applyProperty(current, parsed);
  }

  return events;
}

function applyProperty(
  target: ParsingEvent,
  line: ContentLine,
): void {
  switch (line.name) {
    case 'UID':
      target.uid = line.value.trim();
      break;
    case 'SUMMARY':
      target.summary = unescapeText(line.value);
      break;
    case 'DESCRIPTION':
      target.description = unescapeText(line.value);
      break;
    case 'LOCATION':
      target.location = unescapeText(line.value);
      break;
    case 'STATUS':
      target.status = line.value.trim().toLowerCase();
      break;
    case 'RRULE':
      target.recurrence = line.value.trim();
      break;
    case 'DTSTART': {
      const { iso, allDay } = parseICalDate(line.value);
      // A value is DATE-typed when explicitly tagged VALUE=DATE or when the
      // serialised form carries no time component (parseICalDate -> allDay).
      const isDate = line.params.VALUE === 'DATE' || allDay;
      target.start = iso;
      target.startIsDate = isDate;
      target.allDay = isDate;
      break;
    }
    case 'DTEND': {
      const { iso, allDay } = parseICalDate(line.value);
      const isDate = line.params.VALUE === 'DATE' || allDay;
      target.end = iso;
      target.endIsDate = isDate;
      break;
    }
    case 'ATTENDEE': {
      (target.attendees ??= []).push({
        displayName: attendeeDisplayName(line.params, line.value),
        rawValue: line.value.trim(),
      });
      break;
    }
    case 'ORGANIZER':
      target.organizer = attendeeDisplayName(line.params, line.value);
      target.organizerRaw = line.value.trim();
      break;
    default:
      target.raw[line.name] = line.value;
      break;
  }
}

function finaliseEvent(
  partial: ParsingEvent,
): ParsedICalEvent {
  // RFC 5545 §3.8.2.2: when DTEND is present it MUST share the VALUE type of
  // DTSTART. A DATE-valued DTSTART paired with a DATE-TIME DTEND (or vice
  // versa) is malformed; accepting it silently would corrupt all-day handling.
  if (
    partial.startIsDate !== undefined
    && partial.endIsDate !== undefined
    && partial.startIsDate !== partial.endIsDate
  ) {
    throw new Error(
      'VEVENT DTSTART and DTEND have mismatched VALUE types (one DATE, one DATE-TIME).',
    );
  }
  const start = partial.start ?? new Date(0).toISOString();
  const end = partial.end ?? start;
  return {
    uid: partial.uid ?? '',
    summary: partial.summary ?? '',
    description: partial.description,
    location: partial.location,
    start,
    end,
    allDay: partial.allDay ?? false,
    status: partial.status,
    recurrence: partial.recurrence,
    attendees: partial.attendees ?? [],
    organizer: partial.organizer,
    organizerRaw: partial.organizerRaw,
    raw: partial.raw,
  };
}

// ---------------------------------------------------------------------------
// Generator
// ---------------------------------------------------------------------------

function normaliseAttendeeForOutput(entry: string): { value: string; cn?: string } {
  const trimmed = entry.trim();
  if (/@/.test(trimmed) && !/^mailto:/i.test(trimmed)) {
    return { value: `mailto:${trimmed}` };
  }
  if (/^mailto:/i.test(trimmed)) {
    return { value: trimmed };
  }
  // A bare display name (no address): encode as CN with an empty mailto target.
  return { value: 'mailto:invalid@invalid', cn: trimmed };
}

/**
 * Render a CN parameter for an ATTENDEE/ORGANIZER line. RFC 5545 §3.2 requires a
 * param value containing COLON, SEMICOLON, or COMMA to be DQUOTE-quoted: without
 * quoting, the parser splits params on the unquoted ';' and ends the value at the
 * first unquoted ':', mis-parsing a display name like 'Doe, Jane' or 'Team: Eng'.
 * DQUOTE itself may not appear inside a quoted param value (§3.2), so any embedded
 * DQUOTE is dropped to keep the emitted line well-formed.
 */
function formatCNParam(cn: string): string {
  const sanitised = cn.replace(/"/g, '');
  const needsQuoting = /[:;,]/.test(sanitised);
  return `;CN=${needsQuoting ? `"${sanitised}"` : sanitised}`;
}

/** Generate a single VEVENT line block (without BEGIN/END VCALENDAR). */
export function eventToVEvent(input: GenerateICalInput): string[] {
  const lines: string[] = [];
  lines.push('BEGIN:VEVENT');
  lines.push(`UID:${input.uid}`);
  lines.push(`DTSTAMP:${formatICalDateTime(input.dtStamp ?? new Date().toISOString())}`);
  if (input.allDay) {
    lines.push(`DTSTART;VALUE=DATE:${formatICalDate(input.start)}`);
    lines.push(`DTEND;VALUE=DATE:${formatICalDate(input.end)}`);
  } else {
    lines.push(`DTSTART:${formatICalDateTime(input.start)}`);
    lines.push(`DTEND:${formatICalDateTime(input.end)}`);
  }
  lines.push(`SUMMARY:${escapeText(input.summary)}`);
  if (input.description !== undefined && input.description.length > 0) {
    lines.push(`DESCRIPTION:${escapeText(input.description)}`);
  }
  if (input.location !== undefined && input.location.length > 0) {
    lines.push(`LOCATION:${escapeText(input.location)}`);
  }
  if (input.status !== undefined && input.status.length > 0) {
    lines.push(`STATUS:${input.status.toUpperCase()}`);
  }
  if (input.recurrence !== undefined && input.recurrence.length > 0) {
    lines.push(`RRULE:${input.recurrence}`);
  }
  if (input.organizer !== undefined && input.organizer.length > 0) {
    const org = normaliseAttendeeForOutput(input.organizer);
    lines.push(`ORGANIZER${org.cn ? formatCNParam(org.cn) : ''}:${org.value}`);
  }
  for (const attendee of input.attendees ?? []) {
    if (attendee.trim().length === 0) continue;
    const norm = normaliseAttendeeForOutput(attendee);
    lines.push(`ATTENDEE${norm.cn ? formatCNParam(norm.cn) : ''}:${norm.value}`);
  }
  lines.push('END:VEVENT');
  return lines;
}

/** Generate a full VCALENDAR wrapping one event. Output uses CRLF line endings. */
export function generateICS(input: GenerateICalInput): string {
  const lines: string[] = [];
  lines.push('BEGIN:VCALENDAR');
  lines.push('VERSION:2.0');
  lines.push(`PRODID:${PRODID}`);
  lines.push('CALSCALE:GREGORIAN');
  lines.push(...eventToVEvent(input));
  lines.push('END:VCALENDAR');
  return `${lines.map(foldLine).join(CRLF)}${CRLF}`;
}

/** Generate a full VCALENDAR wrapping many events (used by export). */
export function generateCalendar(events: GenerateICalInput[]): string {
  const lines: string[] = [];
  lines.push('BEGIN:VCALENDAR');
  lines.push('VERSION:2.0');
  lines.push(`PRODID:${PRODID}`);
  lines.push('CALSCALE:GREGORIAN');
  for (const event of events) {
    lines.push(...eventToVEvent(event));
  }
  lines.push('END:VCALENDAR');
  return `${lines.map(foldLine).join(CRLF)}${CRLF}`;
}

/** Extract the first UID from a raw .ics document, if present. */
export function extractUid(content: string): string | undefined {
  for (const line of unfoldLines(content)) {
    if (line.toUpperCase().startsWith('UID:')) {
      return line.slice(line.indexOf(':') + 1).trim();
    }
  }
  return undefined;
}
