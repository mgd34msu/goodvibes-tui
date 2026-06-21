import { describe, expect, it } from 'bun:test';
import {
  createCalDavClient,
  parseMultiStatus,
  toRelativeHref,
  type CalDavConfig,
  type FetchLike,
} from '../../../daemon/calendar/caldav-client.ts';

interface RecordedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

function makeFetch(
  responder: (req: RecordedRequest) => { ok?: boolean; status?: number; body?: string; location?: string },
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
    const result = responder(req);
    const status = result.status ?? (result.ok === false ? 500 : 200);
    const ok = result.ok ?? (status >= 200 && status < 300);
    return {
      ok,
      status,
      statusText: ok ? 'OK' : 'ERR',
      headers: {
        get(name: string): string | null {
          if (name.toLowerCase() === 'location' && result.location) return result.location;
          return null;
        },
      },
      text: async () => result.body ?? '',
    };
  };
  return { fetchImpl, calls };
}

const baseConfig: CalDavConfig = {
  baseUrl: 'https://dav.example.com/cal/user/home',
  username: 'alice',
  password: 'super-secret-pw',
  defaultCalendarId: 'default',
  collectionMap: { work: '/cal/user/work/' },
};

function multistatusWithEvents(events: Array<{ href: string; ics: string }>): string {
  const responses = events
    .map(
      (e) =>
        `<d:response><d:href>${e.href}</d:href><d:propstat><d:prop>`
        + `<c:calendar-data>${e.ics
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')}</c:calendar-data>`
        + `</d:prop></d:propstat></d:response>`,
    )
    .join('');
  return `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">${responses}</d:multistatus>`;
}

function sampleVEvent(uid: string, summary: string, start: string): string {
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `SUMMARY:${summary}`,
    `DTSTART:${start}`,
    'DTEND:20260315T100000Z',
    'ATTENDEE;CN=Jane Doe:mailto:jane@example.com',
    'ORGANIZER;CN=The Boss:mailto:boss@example.com',
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');
}

describe('toRelativeHref', () => {
  it('strips scheme and host from absolute URLs', () => {
    expect(toRelativeHref('https://dav.example.com/cal/user/home/evt.ics')).toBe('/cal/user/home/evt.ics');
  });
  it('keeps already-relative hrefs', () => {
    expect(toRelativeHref('/cal/user/home/evt.ics')).toBe('/cal/user/home/evt.ics');
  });
  it('never returns an authenticated absolute URL', () => {
    const rel = toRelativeHref('https://alice:pw@dav.example.com/cal/evt.ics');
    expect(rel.includes('alice')).toBe(false);
    expect(rel.includes('dav.example.com')).toBe(false);
  });
});

describe('parseMultiStatus', () => {
  it('extracts hrefs and calendar-data', () => {
    const xml = multistatusWithEvents([
      { href: '/cal/a.ics', ics: sampleVEvent('a', 'Alpha', '20260315T090000Z') },
    ]);
    const entries = parseMultiStatus(xml);
    expect(entries.length).toBe(1);
    expect(entries[0].href).toBe('/cal/a.ics');
    expect(entries[0].calendarData).toContain('UID:a');
  });
});

describe('CalDavClient.listEvents', () => {
  it('issues a REPORT and returns parsed events sorted by start', async () => {
    const { fetchImpl, calls } = makeFetch(() => ({
      status: 207,
      body: multistatusWithEvents([
        { href: '/cal/b.ics', ics: sampleVEvent('b', 'Beta', '20260316T090000Z') },
        { href: '/cal/a.ics', ics: sampleVEvent('a', 'Alpha', '20260315T090000Z') },
      ]),
    }));
    const client = createCalDavClient({ config: baseConfig, fetchImpl });
    const events = await client.listEvents({});
    expect(calls[0].method).toBe('REPORT');
    expect(calls[0].headers.Authorization.startsWith('Basic ')).toBe(true);
    expect(events.map((e) => e.uid)).toEqual(['a', 'b']);
    expect(events[0].calendarId).toBe('default');
  });

  it('honours the limit', async () => {
    const { fetchImpl } = makeFetch(() => ({
      status: 207,
      body: multistatusWithEvents([
        { href: '/cal/a.ics', ics: sampleVEvent('a', 'A', '20260315T090000Z') },
        { href: '/cal/b.ics', ics: sampleVEvent('b', 'B', '20260316T090000Z') },
        { href: '/cal/c.ics', ics: sampleVEvent('c', 'C', '20260317T090000Z') },
      ]),
    }));
    const client = createCalDavClient({ config: baseConfig, fetchImpl });
    const events = await client.listEvents({ limit: 2 });
    expect(events.length).toBe(2);
  });

  it('maps a logical calendarId to its configured collection path', async () => {
    const { fetchImpl, calls } = makeFetch(() => ({ status: 207, body: multistatusWithEvents([]) }));
    const client = createCalDavClient({ config: baseConfig, fetchImpl });
    await client.listEvents({ calendarId: 'work' });
    expect(calls[0].url).toBe('https://dav.example.com/cal/user/work');
  });
});

describe('CalDavClient.getEvent', () => {
  it('finds an event by UID', async () => {
    const { fetchImpl } = makeFetch(() => ({
      status: 207,
      body: multistatusWithEvents([
        { href: '/cal/home/a.ics', ics: sampleVEvent('a', 'Alpha', '20260315T090000Z') },
      ]),
    }));
    const client = createCalDavClient({ config: baseConfig, fetchImpl });
    const event = await client.getEvent('a');
    expect(event).not.toBeNull();
    expect(event?.uid).toBe('a');
    expect(event?.attendees[0].displayName).toBe('Jane Doe');
  });

  it('returns null when no event matches', async () => {
    const { fetchImpl } = makeFetch(() => ({ status: 207, body: multistatusWithEvents([]) }));
    const client = createCalDavClient({ config: baseConfig, fetchImpl });
    expect(await client.getEvent('missing')).toBeNull();
  });

  it('targets a single resource with GET when the id is href-like', async () => {
    const { fetchImpl, calls } = makeFetch(() => ({
      status: 200,
      body: sampleVEvent('a', 'Alpha', '20260315T090000Z'),
    }));
    const client = createCalDavClient({ config: baseConfig, fetchImpl });
    const event = await client.getEvent('/cal/home/a.ics');
    expect(event?.uid).toBe('a');
    // A single-event fetch must use GET, not a collection-wide REPORT scan.
    expect(calls.length).toBe(1);
    expect(calls[0].method).toBe('GET');
    // The returned href is opaque and host-relative, never the absolute URL.
    expect(event?.href).toBe('/cal/home/a.ics');
  });

  it('maps a 404 on a direct GET to a null result', async () => {
    const { fetchImpl } = makeFetch(() => ({ status: 404 }));
    const client = createCalDavClient({ config: baseConfig, fetchImpl });
    expect(await client.getEvent('/cal/home/gone.ics')).toBeNull();
  });

  it('uses a server-side UID prop-filter REPORT for a bare UID (no full scan)', async () => {
    const { fetchImpl, calls } = makeFetch(() => ({
      status: 207,
      body: multistatusWithEvents([
        { href: '/cal/home/a.ics', ics: sampleVEvent('a', 'Alpha', '20260315T090000Z') },
      ]),
    }));
    const client = createCalDavClient({ config: baseConfig, fetchImpl });
    const event = await client.getEvent('a');
    expect(event?.uid).toBe('a');
    expect(calls[0].method).toBe('REPORT');
    // The REPORT body must scope the query to the requested UID server-side.
    expect(calls[0].body).toContain('prop-filter');
    expect(calls[0].body).toContain('>a<');
  });
});

describe('CalDavClient.createEvent', () => {
  it('PUTs a generated .ics and returns a relative href, never an absolute URL', async () => {
    const { fetchImpl, calls } = makeFetch(() => ({ status: 201 }));
    const client = createCalDavClient({ config: baseConfig, fetchImpl });
    const created = await client.createEvent({
      title: 'New Event',
      start: '2026-03-15T09:00:00.000Z',
      end: '2026-03-15T10:00:00.000Z',
      attendees: ['jane@example.com'],
    });
    expect(calls[0].method).toBe('PUT');
    expect(calls[0].body).toContain('SUMMARY:New Event');
    expect(calls[0].headers['Content-Type']).toContain('text/calendar');
    expect(created.uid.length).toBeGreaterThan(0);
    expect(created.eventId.includes('dav.example.com')).toBe(false);
    expect(created.eventId.includes(baseConfig.password)).toBe(false);
    expect(typeof created.createdAt).toBe('string');
  });

  it('prefers a server Location header for the href', async () => {
    const { fetchImpl } = makeFetch(() => ({ status: 201, location: 'https://dav.example.com/cal/user/home/server-assigned.ics' }));
    const client = createCalDavClient({ config: baseConfig, fetchImpl });
    const created = await client.createEvent({
      title: 'X',
      start: '2026-03-15T09:00:00.000Z',
      end: '2026-03-15T10:00:00.000Z',
    });
    expect(created.eventId).toBe('/cal/user/home/server-assigned.ics');
  });
});

describe('CalDavClient.importIcs', () => {
  it('imports each VEVENT and reports counts', async () => {
    const { fetchImpl, calls } = makeFetch(() => ({ status: 201 }));
    const client = createCalDavClient({ config: baseConfig, fetchImpl });
    const ics = [
      'BEGIN:VCALENDAR',
      'BEGIN:VEVENT',
      'UID:imp-1',
      'SUMMARY:Imported',
      'DTSTART:20260315T090000Z',
      'DTEND:20260315T100000Z',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');
    const result = await client.importIcs(ics);
    expect(result.imported).toBe(1);
    expect(result.errors).toEqual([]);
    expect(result.eventIds.length).toBe(1);
    expect(calls.every((c) => c.method === 'PUT')).toBe(true);
  });

  it('collects per-event errors without aborting the batch', async () => {
    let count = 0;
    const { fetchImpl } = makeFetch(() => {
      count += 1;
      return count === 1 ? { status: 403 } : { status: 201 };
    });
    const client = createCalDavClient({ config: baseConfig, fetchImpl });
    const ics = [
      'BEGIN:VCALENDAR',
      'BEGIN:VEVENT\r\nUID:e1\r\nSUMMARY:One\r\nDTSTART:20260315T090000Z\r\nDTEND:20260315T100000Z\r\nEND:VEVENT',
      'BEGIN:VEVENT\r\nUID:e2\r\nSUMMARY:Two\r\nDTSTART:20260316T090000Z\r\nDTEND:20260316T100000Z\r\nEND:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');
    const result = await client.importIcs(ics);
    expect(result.imported).toBe(1);
    expect(result.errors.length).toBe(1);
    expect(result.errors[0]).toContain('e1');
  });

  it('throws when no VEVENT is present', async () => {
    const { fetchImpl } = makeFetch(() => ({ status: 201 }));
    const client = createCalDavClient({ config: baseConfig, fetchImpl });
    await expect(client.importIcs('BEGIN:VCALENDAR\r\nEND:VCALENDAR')).rejects.toThrow();
  });

  it('redacts the CalDAV host/raw fetch detail from caller-visible errors on network failure', async () => {
    // Simulate a DNS/connection failure: the underlying fetch throws an Error
    // whose message embeds the CalDAV hostname (the classic info-leak).
    const rawLeak = `getaddrinfo ENOTFOUND ${new URL(baseConfig.baseUrl).hostname}`;
    const fetchImpl: FetchLike = async () => {
      throw new Error(rawLeak);
    };
    const client = createCalDavClient({ config: baseConfig, fetchImpl });
    const ics = [
      'BEGIN:VCALENDAR',
      'BEGIN:VEVENT',
      'UID:net-1',
      'SUMMARY:Net',
      'DTSTART:20260315T090000Z',
      'DTEND:20260315T100000Z',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');
    const result = await client.importIcs(ics);
    expect(result.imported).toBe(0);
    expect(result.errors.length).toBe(1);
    const surfaced = result.errors.join('\n');
    // The per-event error still identifies WHICH event failed (its UID).
    expect(surfaced).toContain('net-1');
    // But it must NOT disclose the host, URL, or raw fetch detail.
    expect(surfaced).not.toContain(new URL(baseConfig.baseUrl).hostname);
    expect(surfaced).not.toContain(baseConfig.baseUrl);
    expect(surfaced).not.toContain('getaddrinfo');
    expect(surfaced).not.toContain('ENOTFOUND');
    expect(surfaced).not.toContain(rawLeak);
  });
});

describe('CalDavClient.exportIcs', () => {
  it('exports a calendar as a single .ics document', async () => {
    const { fetchImpl } = makeFetch(() => ({
      status: 207,
      body: multistatusWithEvents([
        { href: '/cal/a.ics', ics: sampleVEvent('a', 'Alpha', '20260315T090000Z') },
        { href: '/cal/b.ics', ics: sampleVEvent('b', 'Beta', '20260316T090000Z') },
      ]),
    }));
    const client = createCalDavClient({ config: baseConfig, fetchImpl });
    const result = await client.exportIcs({});
    expect(result.eventCount).toBe(2);
    expect(result.icsContent).toContain('BEGIN:VCALENDAR');
    expect(result.icsContent).toContain('UID:a');
    expect(result.icsContent).toContain('UID:b');
    // Exported payload must not contain credentials.
    expect(result.icsContent.includes(baseConfig.password)).toBe(false);
  });
});

describe('CalDavClient auth failures', () => {
  it('maps HTTP 401 to a credential-free auth error', async () => {
    const { fetchImpl } = makeFetch(() => ({ status: 401, body: 'Unauthorized' }));
    const client = createCalDavClient({ config: baseConfig, fetchImpl });
    await expect(client.listEvents({})).rejects.toMatchObject({ code: 'CALENDAR_AUTH_FAILED' });
  });

  it('never includes the password in error messages', async () => {
    const { fetchImpl } = makeFetch(() => ({ status: 500, body: `error for ${baseConfig.password}` }));
    const client = createCalDavClient({ config: baseConfig, fetchImpl });
    try {
      await client.listEvents({});
      throw new Error('expected to throw');
    } catch (error) {
      expect((error as Error).message.includes(baseConfig.password)).toBe(false);
    }
  });
});
