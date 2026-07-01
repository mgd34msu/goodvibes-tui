import { describe, expect, test } from 'bun:test';
import {
  createCalDavClient,
  originOf,
  toRelativeHref,
  parseMultiStatus,
  type CalDavConfig,
  type FetchLike,
} from '../../../daemon/handlers/calendar/caldav-client.ts';
import { HandlerError } from '../../../daemon/handlers/errors.ts';

// Word-style fake credential (NOT a real secret format).
const FAKE_PASSWORD = 'caldav-EXAMPLE-fakepass';

const baseConfig: CalDavConfig = {
  baseUrl: 'https://cal.example.test/dav/user/calendar',
  username: 'user',
  password: FAKE_PASSWORD,
  defaultCalendarId: 'default',
  collectionMap: {},
};

interface RecordedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

function multistatus(events: Array<{ href: string; ics: string }>): string {
  const responses = events
    .map(
      (e) =>
        `<D:response><D:href>${e.href}</D:href><D:propstat><D:prop>`
        + `<C:calendar-data>${e.ics
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')}</C:calendar-data>`
        + `</D:prop></D:propstat></D:response>`,
    )
    .join('');
  return `<?xml version="1.0"?><D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">${responses}</D:multistatus>`;
}

function vevent(uid: string, summary: string, attendeeCn?: string): string {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `SUMMARY:${summary}`,
    'DTSTART:20260101T120000Z',
    'DTEND:20260101T130000Z',
  ];
  if (attendeeCn) lines.push(`ATTENDEE;CN=${attendeeCn}:mailto:person@example.test`);
  lines.push('END:VEVENT', 'END:VCALENDAR');
  return lines.join('\r\n');
}

function makeFetch(
  handler: (req: RecordedRequest) => { ok?: boolean; status?: number; text?: string; location?: string },
): { fetchImpl: FetchLike; calls: RecordedRequest[] } {
  const calls: RecordedRequest[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    const req: RecordedRequest = {
      url,
      method: init?.method ?? 'GET',
      headers: init?.headers ?? {},
      body: init?.body,
    };
    calls.push(req);
    const result = handler(req);
    const status = result.status ?? 200;
    const ok = result.ok ?? (status >= 200 && status < 300);
    return {
      ok,
      status,
      statusText: 'x',
      headers: { get: (name: string) => (name === 'Location' ? result.location ?? null : null) },
      text: async () => result.text ?? '',
    };
  };
  return { fetchImpl, calls };
}

describe('URL helpers', () => {
  test('originOf strips path from an absolute URL', () => {
    expect(originOf('https://cal.example.test/dav/user/calendar')).toBe('https://cal.example.test');
  });

  test('toRelativeHref strips scheme + host', () => {
    expect(toRelativeHref('https://cal.example.test/dav/evt.ics')).toBe('/dav/evt.ics');
  });
});

describe('parseMultiStatus', () => {
  test('extracts hrefs and calendar-data from a 207 document', () => {
    const xml = multistatus([{ href: '/dav/a.ics', ics: vevent('a', 'A') }]);
    const entries = parseMultiStatus(xml);
    expect(entries.length).toBe(1);
    expect(entries[0]!.href).toBe('/dav/a.ics');
    expect(entries[0]!.calendarData).toContain('UID:a');
  });
});

describe('CalDavClient over an injected fetch', () => {
  test('listEvents issues a REPORT and returns relative hrefs (no host leak)', async () => {
    const { fetchImpl, calls } = makeFetch(() => ({
      status: 207,
      text: multistatus([
        { href: 'https://cal.example.test/dav/a.ics', ics: vevent('a', 'Alpha') },
        { href: 'https://cal.example.test/dav/b.ics', ics: vevent('b', 'Bravo') },
      ]),
    }));
    const client = createCalDavClient({ config: baseConfig, fetchImpl });
    const events = await client.listEvents({});
    expect(calls[0]!.method).toBe('REPORT');
    expect(calls[0]!.headers.Depth).toBe('1');
    expect(events.length).toBe(2);
    for (const event of events) {
      expect(event.href.startsWith('/')).toBe(true);
      expect(event.href.includes('cal.example.test')).toBe(false);
      expect(event.calendarId).toBe('default');
    }
  });

  test('listEvents applies the limit and sorts by start', async () => {
    const { fetchImpl } = makeFetch(() => ({
      status: 207,
      text: multistatus([
        { href: '/dav/a.ics', ics: vevent('a', 'A') },
        { href: '/dav/b.ics', ics: vevent('b', 'B') },
        { href: '/dav/c.ics', ics: vevent('c', 'C') },
      ]),
    }));
    const client = createCalDavClient({ config: baseConfig, fetchImpl });
    const events = await client.listEvents({ limit: 2 });
    expect(events.length).toBe(2);
  });

  test('getEvent by href does a direct GET', async () => {
    const { fetchImpl, calls } = makeFetch(() => ({
      status: 200,
      text: vevent('evt-1', 'Single'),
    }));
    const client = createCalDavClient({ config: baseConfig, fetchImpl });
    const event = await client.getEvent('/dav/evt-1.ics');
    expect(calls[0]!.method).toBe('GET');
    expect(event?.uid).toBe('evt-1');
    expect(event?.href).toBe('/dav/evt-1.ics');
  });

  test('getEvent by bare UID uses a REPORT prop-filter and confirms the UID', async () => {
    const { fetchImpl, calls } = makeFetch(() => ({
      status: 207,
      text: multistatus([{ href: '/dav/evt-1.ics', ics: vevent('evt-1', 'Found') }]),
    }));
    const client = createCalDavClient({ config: baseConfig, fetchImpl });
    const event = await client.getEvent('evt-1');
    expect(calls[0]!.method).toBe('REPORT');
    expect(calls[0]!.body).toContain('UID');
    expect(event?.uid).toBe('evt-1');
  });

  test('getEvent returns null when the bare UID is not in the collection', async () => {
    const { fetchImpl } = makeFetch(() => ({
      status: 207,
      text: multistatus([{ href: '/dav/other.ics', ics: vevent('other', 'Other') }]),
    }));
    const client = createCalDavClient({ config: baseConfig, fetchImpl });
    expect(await client.getEvent('missing-uid')).toBeNull();
  });

  test('createEvent PUTs an .ics with If-None-Match and returns a relative href', async () => {
    const { fetchImpl, calls } = makeFetch(() => ({ status: 201 }));
    const client = createCalDavClient({ config: baseConfig, fetchImpl });
    const created = await client.createEvent({
      title: 'New event',
      start: '2026-03-01T10:00:00Z',
      end: '2026-03-01T11:00:00Z',
    });
    const put = calls[0]!;
    expect(put.method).toBe('PUT');
    expect(put.headers['If-None-Match']).toBe('*');
    expect(put.body).toContain('SUMMARY:New event');
    expect(created.uid.endsWith('@goodvibes')).toBe(true);
    expect(created.eventId.startsWith('/')).toBe(true);
    expect(created.eventId.includes('cal.example.test')).toBe(false);
  });

  test('importIcs PUTs each VEVENT and reports per-event errors without leaking the host', async () => {
    let putCount = 0;
    const { fetchImpl } = makeFetch((req) => {
      if (req.method === 'PUT') {
        putCount += 1;
        // Fail the second PUT to exercise the errors[] path.
        if (putCount === 2) return { status: 403 };
      }
      return { status: 201 };
    });
    const client = createCalDavClient({ config: baseConfig, fetchImpl });
    const ics = [
      'BEGIN:VCALENDAR',
      'BEGIN:VEVENT\r\nUID:imp-1\r\nSUMMARY:One\r\nDTSTART:20260101T120000Z\r\nDTEND:20260101T130000Z\r\nEND:VEVENT',
      'BEGIN:VEVENT\r\nUID:imp-2\r\nSUMMARY:Two\r\nDTSTART:20260102T120000Z\r\nDTEND:20260102T130000Z\r\nEND:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');
    const result = await client.importIcs(ics);
    expect(result.imported).toBe(1);
    expect(result.eventIds.length).toBe(1);
    expect(result.errors.length).toBe(1);
    // The error text must not contain the CalDAV host or credentials.
    expect(result.errors[0]!.includes('cal.example.test')).toBe(false);
    expect(result.errors[0]!.includes(FAKE_PASSWORD)).toBe(false);
  });

  test('importIcs rejects content with no VEVENT', async () => {
    const { fetchImpl } = makeFetch(() => ({ status: 201 }));
    const client = createCalDavClient({ config: baseConfig, fetchImpl });
    await expect(client.importIcs('BEGIN:VCALENDAR\r\nEND:VCALENDAR')).rejects.toThrow(/VEVENT/);
  });

  test('exportIcs serialises the collection and counts events', async () => {
    const { fetchImpl } = makeFetch(() => ({
      status: 207,
      text: multistatus([
        { href: '/dav/a.ics', ics: vevent('a', 'A') },
        { href: '/dav/b.ics', ics: vevent('b', 'B') },
      ]),
    }));
    const client = createCalDavClient({ config: baseConfig, fetchImpl });
    const result = await client.exportIcs({});
    expect(result.eventCount).toBe(2);
    expect(result.icsContent).toContain('BEGIN:VCALENDAR');
  });

  test('maps a 401 to CALENDAR_AUTH_FAILED without leaking the URL', async () => {
    const { fetchImpl } = makeFetch(() => ({ status: 401 }));
    const client = createCalDavClient({ config: baseConfig, fetchImpl });
    try {
      await client.listEvents({});
      throw new Error('expected throw');
    } catch (error) {
      expect(error).toBeInstanceOf(HandlerError);
      const handlerError = error as HandlerError;
      expect(handlerError.code).toBe('CALENDAR_AUTH_FAILED');
      expect(handlerError.message.includes('cal.example.test')).toBe(false);
    }
  });

  test('maps a thrown fetch (DNS failure) to a redacted network error', async () => {
    const fetchImpl: FetchLike = async () => {
      throw new Error('getaddrinfo ENOTFOUND cal.example.test');
    };
    const client = createCalDavClient({ config: baseConfig, fetchImpl });
    try {
      await client.listEvents({});
      throw new Error('expected throw');
    } catch (error) {
      expect(error).toBeInstanceOf(HandlerError);
      const handlerError = error as HandlerError;
      expect(handlerError.code).toBe('CALENDAR_NETWORK_ERROR');
      expect(handlerError.message.includes('cal.example.test')).toBe(false);
    }
  });

  test('sends a Basic auth header and never echoes the password in the body', async () => {
    const { fetchImpl, calls } = makeFetch(() => ({ status: 207, text: multistatus([]) }));
    const client = createCalDavClient({ config: baseConfig, fetchImpl });
    await client.listEvents({});
    expect(calls[0]!.headers.Authorization?.startsWith('Basic ')).toBe(true);
    expect(calls[0]!.body?.includes(FAKE_PASSWORD)).toBeFalsy();
  });
});
