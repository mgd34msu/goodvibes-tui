import { describe, expect, test } from 'bun:test';
import {
  escapeText,
  unescapeText,
  foldLine,
  unfoldLines,
  formatICalDate,
  formatICalDateTime,
  parseICalDate,
  parseICS,
  generateICS,
  generateCalendar,
  extractUid,
  attendeeDisplayName,
} from '../../../daemon/handlers/calendar/ics.ts';

const UTF8 = new TextEncoder();
const octets = (s: string): number => UTF8.encode(s).length;

describe('foldLine (RFC 5545 §3.1)', () => {
  test('leaves short lines untouched', () => {
    expect(foldLine('SUMMARY:hi')).toBe('SUMMARY:hi');
  });

  test('folds long ASCII lines so every physical line is <= 75 octets', () => {
    const long = `DESCRIPTION:${'a'.repeat(400)}`;
    const folded = foldLine(long);
    const physical = folded.split('\r\n');
    expect(physical.length).toBeGreaterThan(1);
    for (const line of physical) {
      expect(octets(line)).toBeLessThanOrEqual(75);
    }
    // Continuation lines begin with a single leading space.
    for (let i = 1; i < physical.length; i += 1) {
      expect(physical[i]!.startsWith(' ')).toBe(true);
    }
  });

  test('never splits a multi-byte codepoint across a fold boundary', () => {
    // Emoji is 4 UTF-8 octets; a run of them must fold on whole-codepoint edges.
    const long = `SUMMARY:${'\u{1F600}'.repeat(40)}`;
    const folded = foldLine(long);
    for (const line of folded.split('\r\n')) {
      expect(octets(line)).toBeLessThanOrEqual(75);
      const payload = line.startsWith(' ') ? line.slice(1) : line.replace(/^SUMMARY:/, '');
      // Each emoji survives intact (no lone surrogate / replacement char).
      expect(payload.includes('�')).toBe(false);
    }
  });

  test('unfold inverts fold for a long value', () => {
    const original = `DESCRIPTION:${'x'.repeat(300)}`;
    const rejoined = unfoldLines(foldLine(original)).join('');
    expect(rejoined).toBe(original);
  });
});

describe('text escaping (RFC 5545 §3.3.11)', () => {
  test('escapes backslash, semicolon, comma, and newline', () => {
    expect(escapeText('a;b,c\\d\ne')).toBe('a\\;b\\,c\\\\d\\ne');
  });

  test('round-trips through unescape', () => {
    const raw = 'Meet: a, b; c\\ d\nline2';
    expect(unescapeText(escapeText(raw))).toBe(raw);
  });

  test('preserves a literal backslash followed by an unknown escape char', () => {
    expect(unescapeText('a\\qb')).toBe('a\\qb');
  });
});

describe('date/time formatting (RFC 5545 §3.3.4 / §3.3.5)', () => {
  test('formats a UTC datetime as YYYYMMDDTHHMMSSZ', () => {
    expect(formatICalDateTime('2026-03-04T05:06:07Z')).toBe('20260304T050607Z');
  });

  test('all-day DATE reflects the input offset wall-clock day, not the UTC instant', () => {
    // 2026-12-25T00:00:00+09:00 is the 24th in UTC, but the 25th as written.
    expect(formatICalDate('2026-12-25T00:00:00+09:00')).toBe('20261225');
  });

  test('parses a bare DATE as all-day', () => {
    const parsed = parseICalDate('20260101');
    expect(parsed.allDay).toBe(true);
    expect(parsed.iso.startsWith('2026-01-01')).toBe(true);
  });

  test('parses a UTC date-time as not-all-day', () => {
    const parsed = parseICalDate('20260101T120000Z');
    expect(parsed.allDay).toBe(false);
    expect(parsed.iso).toBe('2026-01-01T12:00:00.000Z');
  });

  test('rejects an unrecognised date value', () => {
    expect(() => parseICalDate('not-a-date')).toThrow(/Unrecognised/);
  });
});

describe('attendeeDisplayName', () => {
  test('prefers the CN parameter', () => {
    expect(attendeeDisplayName({ CN: 'Jane Doe' }, 'mailto:jane@example.com')).toBe('Jane Doe');
  });

  test('falls back to the mailbox local-part', () => {
    expect(attendeeDisplayName({}, 'mailto:jane@example.com')).toBe('jane');
  });
});

describe('parseICS', () => {
  const sample = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'BEGIN:VEVENT',
    'UID:evt-1@example',
    'SUMMARY:Team sync',
    'DESCRIPTION:Weekly\\, recurring',
    'LOCATION:Room 5',
    'DTSTART:20260101T120000Z',
    'DTEND:20260101T130000Z',
    'RRULE:FREQ=WEEKLY;COUNT=10',
    'STATUS:CONFIRMED',
    'ATTENDEE;CN=Jane Doe:mailto:jane@example.com',
    'ORGANIZER;CN=Boss:mailto:boss@example.com',
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');

  test('parses a single VEVENT with all modelled properties', () => {
    const [event] = parseICS(sample);
    expect(event!.uid).toBe('evt-1@example');
    expect(event!.summary).toBe('Team sync');
    expect(event!.description).toBe('Weekly, recurring');
    expect(event!.location).toBe('Room 5');
    expect(event!.recurrence).toBe('FREQ=WEEKLY;COUNT=10');
    expect(event!.status).toBe('confirmed');
    expect(event!.allDay).toBe(false);
    expect(event!.attendees[0]!.displayName).toBe('Jane Doe');
    expect(event!.organizer).toBe('Boss');
  });

  test('detects an all-day event via VALUE=DATE', () => {
    const allDay = [
      'BEGIN:VEVENT',
      'UID:a',
      'SUMMARY:Holiday',
      'DTSTART;VALUE=DATE:20260704',
      'DTEND;VALUE=DATE:20260705',
      'END:VEVENT',
    ].join('\r\n');
    const [event] = parseICS(allDay);
    expect(event!.allDay).toBe(true);
  });

  test('rejects a VEVENT with mismatched DTSTART/DTEND VALUE types', () => {
    const bad = [
      'BEGIN:VEVENT',
      'UID:b',
      'DTSTART;VALUE=DATE:20260704',
      'DTEND:20260705T120000Z',
      'END:VEVENT',
    ].join('\r\n');
    expect(() => parseICS(bad)).toThrow(/mismatched VALUE/);
  });

  test('preserves unknown properties in the raw map', () => {
    const withExtra = [
      'BEGIN:VEVENT',
      'UID:c',
      'DTSTART:20260101T120000Z',
      'DTEND:20260101T130000Z',
      'X-CUSTOM-FLAG:hello',
      'END:VEVENT',
    ].join('\r\n');
    const [event] = parseICS(withExtra);
    expect(event!.raw['X-CUSTOM-FLAG']).toBe('hello');
  });
});

describe('generateICS / generateCalendar', () => {
  test('emits a VCALENDAR with CRLF endings and a VEVENT', () => {
    const ics = generateICS({
      uid: 'gen-1',
      summary: 'Lunch',
      start: '2026-01-01T12:00:00Z',
      end: '2026-01-01T13:00:00Z',
    });
    expect(ics).toContain('BEGIN:VCALENDAR');
    expect(ics).toContain('BEGIN:VEVENT');
    expect(ics).toContain('UID:gen-1');
    expect(ics.endsWith('\r\n')).toBe(true);
    expect(ics.includes('\r\n')).toBe(true);
  });

  test('round-trips a generated event back through the parser', () => {
    const ics = generateICS({
      uid: 'rt-1',
      summary: 'Design review',
      description: 'agenda; notes, items',
      location: 'HQ',
      start: '2026-02-03T09:00:00Z',
      end: '2026-02-03T10:00:00Z',
      recurrence: 'FREQ=DAILY;COUNT=3',
      attendees: ['alice@example.com'],
    });
    const [event] = parseICS(ics);
    expect(event!.uid).toBe('rt-1');
    expect(event!.summary).toBe('Design review');
    expect(event!.description).toBe('agenda; notes, items');
    expect(event!.recurrence).toBe('FREQ=DAILY;COUNT=3');
    expect(event!.attendees[0]!.displayName).toBe('alice');
  });

  test('quotes a CN containing a comma so the line parses correctly', () => {
    const ics = generateICS({
      uid: 'cn-1',
      summary: 's',
      start: '2026-01-01T12:00:00Z',
      end: '2026-01-01T13:00:00Z',
      attendees: ['Doe, Jane'],
    });
    expect(ics).toContain('CN="Doe, Jane"');
    const [event] = parseICS(ics);
    expect(event!.attendees[0]!.displayName).toBe('Doe, Jane');
  });

  test('emits all-day DATE values when allDay is set', () => {
    const ics = generateICS({
      uid: 'ad-1',
      summary: 'Holiday',
      start: '2026-07-04T00:00:00Z',
      end: '2026-07-05T00:00:00Z',
      allDay: true,
    });
    expect(ics).toContain('DTSTART;VALUE=DATE:20260704');
    expect(ics).toContain('DTEND;VALUE=DATE:20260705');
  });

  test('generateCalendar wraps multiple events in one VCALENDAR', () => {
    const ics = generateCalendar([
      { uid: 'm-1', summary: 'a', start: '2026-01-01T12:00:00Z', end: '2026-01-01T13:00:00Z' },
      { uid: 'm-2', summary: 'b', start: '2026-01-02T12:00:00Z', end: '2026-01-02T13:00:00Z' },
    ]);
    expect(parseICS(ics).length).toBe(2);
  });
});

describe('extractUid', () => {
  test('returns the first UID in a document', () => {
    const ics = ['BEGIN:VEVENT', 'UID:first@x', 'END:VEVENT'].join('\r\n');
    expect(extractUid(ics)).toBe('first@x');
  });

  test('returns undefined when no UID is present', () => {
    expect(extractUid('BEGIN:VEVENT\r\nEND:VEVENT')).toBeUndefined();
  });
});
