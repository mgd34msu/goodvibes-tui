import { describe, expect, it } from 'bun:test';
import {
  attendeeDisplayName,
  escapeText,
  extractUid,
  foldLine,
  formatICalDate,
  formatICalDateTime,
  generateCalendar,
  generateICS,
  parseICalDate,
  parseICS,
  unescapeText,
  unfoldLines,
} from '../../../daemon/calendar/ics.ts';

describe('ics line folding', () => {
  it('folds lines longer than 75 octets with leading-space continuations', () => {
    const long = `SUMMARY:${'x'.repeat(200)}`;
    const folded = foldLine(long);
    const lines = folded.split('\r\n');
    expect(lines.length).toBeGreaterThan(1);
    expect(lines[0].length).toBeLessThanOrEqual(75);
    for (const line of lines.slice(1)) {
      expect(line.startsWith(' ')).toBe(true);
    }
  });

  it('round-trips fold/unfold without data loss', () => {
    const value = `DESCRIPTION:${'a'.repeat(300)}`;
    const folded = foldLine(value);
    const unfolded = unfoldLines(folded);
    expect(unfolded[0]).toBe(value);
  });

  it('folds by UTF-8 octets, never by JS string length, for multi-byte content', () => {
    // 'é' is 2 octets in UTF-8 but length 1 in JS. 50 of them is 100 octets but
    // only 50 code units; a length-based fold would never trigger. Octet folding
    // must split it so no wire line exceeds 75 octets.
    const long = `SUMMARY:${'é'.repeat(50)}`;
    const folded = foldLine(long);
    const lines = folded.split('\r\n');
    expect(lines.length).toBeGreaterThan(1);
    const encoder = new TextEncoder();
    for (const [index, line] of lines.entries()) {
      const payload = index === 0 ? line : line.slice(1); // strip leading space
      const octets = encoder.encode(index === 0 ? payload : ` ${payload}`).length;
      expect(octets).toBeLessThanOrEqual(75);
    }
  });

  it('never splits a multi-byte codepoint across a fold boundary (valid UTF-8 on the wire)', () => {
    // '😀' is a 4-octet astral codepoint (2 UTF-16 code units). Folding must keep
    // each codepoint intact; decoding the wire bytes must reproduce every emoji.
    const long = `DESCRIPTION:${'😀'.repeat(40)}`;
    const folded = foldLine(long);
    const encoder = new TextEncoder();
    const decoder = new TextDecoder('utf-8', { fatal: true });
    for (const [index, line] of folded.split('\r\n').entries()) {
      const payload = index === 0 ? line : line.slice(1);
      // fatal decode throws if any line contains a truncated multi-byte sequence.
      expect(() => decoder.decode(encoder.encode(payload))).not.toThrow();
      expect(encoder.encode(index === 0 ? payload : ` ${payload}`).length).toBeLessThanOrEqual(75);
    }
    // Round-trips losslessly through unfold.
    expect(unfoldLines(folded)[0]).toBe(long);
  });
});

describe('ics text escaping', () => {
  it('escapes special characters', () => {
    expect(escapeText('a;b,c\\d\ne')).toBe('a\\;b\\,c\\\\d\\ne');
  });
  it('round-trips escape/unescape', () => {
    const original = 'Meeting; with, special\\chars\nand newline';
    expect(unescapeText(escapeText(original))).toBe(original);
  });
  it('preserves the backslash for unrecognised escape sequences (lossless)', () => {
    // \x is not a defined RFC 5545 escape: the backslash is a literal char and
    // must survive unescaping rather than being silently dropped.
    expect(unescapeText('a\\xb')).toBe('a\\xb');
    expect(unescapeText('path C:\\temp')).toBe('path C:\\temp');
  });
});

describe('ics date formatting', () => {
  it('formats a UTC datetime', () => {
    expect(formatICalDateTime('2026-03-15T09:30:00.000Z')).toBe('20260315T093000Z');
  });
  it('formats an all-day date', () => {
    expect(formatICalDate('2026-03-15T00:00:00.000Z')).toBe('20260315');
  });
  it('keeps the all-day calendar day for a non-UTC positive offset (no UTC roll-back)', () => {
    // UTC components would roll this midnight back to the 24th. The DATE must
    // reflect the calendar day as written in the input's own offset: the 25th.
    expect(formatICalDate('2026-12-25T00:00:00+09:00')).toBe('20261225');
  });
  it('keeps the all-day calendar day for a non-UTC negative offset', () => {
    expect(formatICalDate('2026-12-25T23:00:00-05:00')).toBe('20261225');
  });
  it('parses a UTC datetime value', () => {
    const { iso, allDay } = parseICalDate('20260315T093000Z');
    expect(iso).toBe('2026-03-15T09:30:00.000Z');
    expect(allDay).toBe(false);
  });
  it('parses an all-day DATE value', () => {
    const { iso, allDay } = parseICalDate('20260315');
    expect(iso).toBe('2026-03-15T00:00:00.000Z');
    expect(allDay).toBe(true);
  });
  it('throws on unrecognised date', () => {
    expect(() => parseICalDate('not-a-date')).toThrow();
  });
  it('parses a floating (non-Z) date-time as local wall-clock, not relabelled UTC', () => {
    // RFC 5545 §3.3.5: a date-time without a trailing 'Z' is floating/local time.
    // It must denote the wall-clock in the observer's zone; interpreting it via
    // Date.UTC would shift the resulting instant by the local offset. Asserting on
    // local components keeps the test deterministic in any timezone.
    const { iso, allDay } = parseICalDate('20260315T093000');
    expect(allDay).toBe(false);
    const d = new Date(iso);
    expect(d.getFullYear()).toBe(2026);
    expect(d.getMonth()).toBe(2); // March (0-based)
    expect(d.getDate()).toBe(15);
    expect(d.getHours()).toBe(9);
    expect(d.getMinutes()).toBe(30);
    expect(d.getSeconds()).toBe(0);
  });
});

describe('attendee display name extraction', () => {
  it('prefers the CN parameter', () => {
    expect(attendeeDisplayName({ CN: 'Jane Doe' }, 'mailto:jane@example.com')).toBe('Jane Doe');
  });
  it('falls back to the local-part of the address', () => {
    expect(attendeeDisplayName({}, 'mailto:john.smith@example.com')).toBe('john.smith');
  });
});

describe('generateICS', () => {
  it('produces a valid VCALENDAR/VEVENT with CRLF endings', () => {
    const ics = generateICS({
      uid: 'evt-1@goodvibes',
      summary: 'Standup',
      start: '2026-03-15T09:00:00.000Z',
      end: '2026-03-15T09:30:00.000Z',
      description: 'Daily sync',
      location: 'Room 1',
      attendees: ['jane@example.com'],
      organizer: 'boss@example.com',
      status: 'confirmed',
    });
    expect(ics).toContain('BEGIN:VCALENDAR');
    expect(ics).toContain('BEGIN:VEVENT');
    expect(ics).toContain('UID:evt-1@goodvibes');
    expect(ics).toContain('SUMMARY:Standup');
    expect(ics).toContain('DTSTART:20260315T090000Z');
    expect(ics).toContain('ATTENDEE');
    expect(ics).toContain('END:VCALENDAR');
    expect(ics.includes('\r\n')).toBe(true);
  });

  it('emits all-day events using VALUE=DATE', () => {
    const ics = generateICS({
      uid: 'evt-2',
      summary: 'Holiday',
      start: '2026-12-25T00:00:00.000Z',
      end: '2026-12-26T00:00:00.000Z',
      allDay: true,
    });
    expect(ics).toContain('DTSTART;VALUE=DATE:20261225');
    expect(ics).toContain('DTEND;VALUE=DATE:20261226');
  });
});

describe('parseICS round-trip', () => {
  it('parses a generated event back to the same core fields', () => {
    const ics = generateICS({
      uid: 'rt-1@goodvibes',
      summary: 'Review; with, escapes',
      start: '2026-03-15T14:00:00.000Z',
      end: '2026-03-15T15:00:00.000Z',
      description: 'Line one\nLine two',
      location: 'HQ',
      attendees: ['Jane Doe via name only', 'jane@example.com'],
      organizer: 'boss@example.com',
      status: 'confirmed',
      recurrence: 'FREQ=WEEKLY;COUNT=4',
    });
    const events = parseICS(ics);
    expect(events.length).toBe(1);
    const event = events[0];
    expect(event.uid).toBe('rt-1@goodvibes');
    expect(event.summary).toBe('Review; with, escapes');
    expect(event.description).toBe('Line one\nLine two');
    expect(event.location).toBe('HQ');
    expect(event.start).toBe('2026-03-15T14:00:00.000Z');
    expect(event.end).toBe('2026-03-15T15:00:00.000Z');
    expect(event.status).toBe('confirmed');
    expect(event.recurrence).toBe('FREQ=WEEKLY;COUNT=4');
    expect(event.attendees.length).toBe(2);
    // Display names must never be raw mailto addresses.
    for (const attendee of event.attendees) {
      expect(attendee.displayName.startsWith('mailto:')).toBe(false);
    }
    expect(event.attendees.map((a) => a.displayName)).toContain('jane');
    expect(event.organizer).toBe('boss');
  });

  it('parses multiple VEVENTs', () => {
    const ics = generateCalendar([
      { uid: 'a', summary: 'A', start: '2026-01-01T00:00:00.000Z', end: '2026-01-01T01:00:00.000Z' },
      { uid: 'b', summary: 'B', start: '2026-01-02T00:00:00.000Z', end: '2026-01-02T01:00:00.000Z' },
    ]);
    const events = parseICS(ics);
    expect(events.map((e) => e.uid).sort()).toEqual(['a', 'b']);
  });

  it('parses folded content lines correctly', () => {
    const ics = generateICS({
      uid: 'fold-1',
      summary: 'S'.repeat(120),
      start: '2026-03-15T09:00:00.000Z',
      end: '2026-03-15T10:00:00.000Z',
    });
    const events = parseICS(ics);
    expect(events[0].summary).toBe('S'.repeat(120));
  });

  it('rejects a VEVENT whose DTSTART and DTEND VALUE types disagree', () => {
    const ics = [
      'BEGIN:VCALENDAR',
      'BEGIN:VEVENT',
      'UID:mismatch-1',
      'SUMMARY:Mismatch',
      'DTSTART;VALUE=DATE:20260315',
      'DTEND:20260316T100000Z',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');
    expect(() => parseICS(ics)).toThrow(/VALUE type/i);
  });

  it('accepts a VEVENT where both DTSTART and DTEND are DATE-valued', () => {
    const ics = [
      'BEGIN:VCALENDAR',
      'BEGIN:VEVENT',
      'UID:allday-1',
      'SUMMARY:Holiday',
      'DTSTART;VALUE=DATE:20261225',
      'DTEND;VALUE=DATE:20261226',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');
    const events = parseICS(ics);
    expect(events[0].allDay).toBe(true);
  });

  it('preserves unknown properties in raw map', () => {
    const ics = [
      'BEGIN:VCALENDAR',
      'BEGIN:VEVENT',
      'UID:custom-1',
      'SUMMARY:Has custom',
      'DTSTART:20260315T090000Z',
      'DTEND:20260315T100000Z',
      'X-CUSTOM-PROP:custom-value',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');
    const events = parseICS(ics);
    expect(events[0].raw['X-CUSTOM-PROP']).toBe('custom-value');
  });
});

describe('CN parameter quoting (RFC 5545 §3.2)', () => {
  it('round-trips an organizer display name containing a comma without corruption', () => {
    // 'Doe, Jane' becomes a CN; the comma must be DQUOTE-quoted on the wire so the
    // parser does not mis-split params/value. Round-trip must recover the name.
    const ics = generateICS({
      uid: 'cn-comma',
      summary: 'S',
      start: '2026-03-15T09:00:00.000Z',
      end: '2026-03-15T10:00:00.000Z',
      organizer: 'Doe, Jane',
    });
    expect(ics).toContain('ORGANIZER;CN="Doe, Jane":');
    const events = parseICS(ics);
    expect(events[0].organizer).toBe('Doe, Jane');
  });

  it('round-trips attendee display names containing colon and semicolon', () => {
    // ':' would otherwise terminate the value early and ';' would start a bogus
    // param; both must be DQUOTE-quoted. Verify via full generate→parse round-trip.
    const ics = generateICS({
      uid: 'cn-special',
      summary: 'S',
      start: '2026-03-15T09:00:00.000Z',
      end: '2026-03-15T10:00:00.000Z',
      attendees: ['Team: Eng', 'Ops; OnCall'],
    });
    expect(ics).toContain('ATTENDEE;CN="Team: Eng":');
    expect(ics).toContain('ATTENDEE;CN="Ops; OnCall":');
    const events = parseICS(ics);
    const names = events[0].attendees.map((a) => a.displayName);
    expect(names).toContain('Team: Eng');
    expect(names).toContain('Ops; OnCall');
  });

  it('leaves a plain display name unquoted', () => {
    const ics = generateICS({
      uid: 'cn-plain',
      summary: 'S',
      start: '2026-03-15T09:00:00.000Z',
      end: '2026-03-15T10:00:00.000Z',
      organizer: 'Jane Doe',
    });
    expect(ics).toContain('ORGANIZER;CN=Jane Doe:');
    expect(ics).not.toContain('CN="Jane Doe"');
  });
});

describe('extractUid', () => {
  it('extracts the first UID', () => {
    const ics = generateICS({ uid: 'x-uid', summary: 'S', start: '2026-03-15T09:00:00.000Z', end: '2026-03-15T10:00:00.000Z' });
    expect(extractUid(ics)).toBe('x-uid');
  });
  it('returns undefined when no UID present', () => {
    expect(extractUid('BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n')).toBeUndefined();
  });
});
