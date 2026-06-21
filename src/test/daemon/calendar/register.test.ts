import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { GatewayMethodCatalog } from '@pellux/goodvibes-sdk/platform/control-plane';
import type { GatewayMethodInvocation } from '@pellux/goodvibes-sdk/platform/control-plane';
import type { HandlerContext } from '../../../daemon/handlers/context.ts';
import type { Unregister } from '../../../daemon/handlers/register.ts';
import {
  CALENDAR_METHOD_IDS,
  registerCalendarMethods,
} from '../../../daemon/handlers/calendar/index.ts';
import type {
  CalDavClient,
  CalDavEvent,
} from '../../../daemon/handlers/calendar/caldav-client.ts';
import type { ParsedICalEvent } from '../../../daemon/handlers/calendar/ics.ts';

const LIST = 'calendar.events.list';
const GET = 'calendar.events.get';
const CREATE = 'calendar.events.create';
const IMPORT = 'calendar.ics.import';
const EXPORT = 'calendar.ics.export';

function makeContext(catalog: GatewayMethodCatalog): HandlerContext {
  return {
    catalog,
    credentials: {
      async resolveRef() {
        return null;
      },
      async resolveConfigSecret() {
        return null;
      },
      async put() {},
      async has() {
        return false;
      },
    },
    configManager: {
      get: () => undefined,
      getCategory: () => ({}),
    } as unknown as HandlerContext['configManager'],
    workingDirectory: '/tmp/gv-cal-test',
    homeDirectory: '/tmp/gv-cal-test',
    logger: { info() {}, warn() {}, error() {} },
  };
}

function invocation(body: unknown, opts: { explicit?: boolean } = {}): GatewayMethodInvocation {
  return {
    body,
    query: {},
    context: {
      authToken: 'token',
      principalId: 'op-1',
      admin: true,
      scopes: ['read:calendar', 'write:calendar'],
      metadata: { explicitUserRequest: opts.explicit ?? false },
    },
  } as unknown as GatewayMethodInvocation;
}

function baseParsed(uid: string, summary: string): ParsedICalEvent {
  return {
    uid,
    summary,
    start: '2026-01-01T12:00:00.000Z',
    end: '2026-01-01T13:00:00.000Z',
    allDay: false,
    attendees: [],
    raw: {},
  };
}

/** A stub CalDAV client whose responses include fields the SDK schema forbids,
 *  so the handler's strip-to-schema mapping is actually exercised. */
function makeStubClient(overrides: Partial<CalDavClient> = {}): CalDavClient {
  const richEvent: CalDavEvent = {
    ...baseParsed('evt-1@example', 'Team sync'),
    description: 'agenda',
    location: 'Room 5',
    recurrence: 'FREQ=WEEKLY',
    organizer: 'Boss',
    organizerRaw: 'mailto:boss@example.test',
    attendees: [
      { displayName: 'Jane Doe', rawValue: 'mailto:jane@example.test' },
      { displayName: '', rawValue: 'mailto:noname@example.test' },
    ],
    href: '/dav/evt-1.ics',
    calendarId: 'work',
  };
  return {
    async listCalendars() {
      return [{ calendarId: 'work', displayName: 'Work' }];
    },
    async listEvents() {
      return [richEvent];
    },
    async getEvent(eventId: string) {
      return eventId === 'missing' ? null : richEvent;
    },
    async createEvent() {
      return { eventId: '/dav/new.ics', uid: 'new-uid@goodvibes', createdAt: '2026-01-01T00:00:00.000Z' };
    },
    async importIcs() {
      return { imported: 2, eventIds: ['/dav/i1.ics', '/dav/i2.ics'], errors: [] };
    },
    async exportIcs() {
      return { icsContent: 'BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n', eventCount: 3 };
    },
    ...overrides,
  };
}

describe('registerCalendarMethods', () => {
  let catalog: GatewayMethodCatalog;
  let unregister: Unregister;

  beforeEach(() => {
    catalog = new GatewayMethodCatalog();
    unregister = registerCalendarMethods(makeContext(catalog), {
      clientFactory: async () => makeStubClient(),
    });
  });

  afterEach(() => {
    unregister();
  });

  test('publishes exactly the five canonical calendar method IDs', () => {
    expect([...CALENDAR_METHOD_IDS]).toEqual([LIST, GET, CREATE, IMPORT, EXPORT]);
  });

  test('attaches handlers to the SDK-registered descriptors', () => {
    for (const id of CALENDAR_METHOD_IDS) {
      expect(catalog.get(id)).not.toBeNull();
      expect(catalog.hasHandler(id)).toBe(true);
    }
  });

  test('does not re-author the SDK descriptors (scopes/access preserved)', () => {
    expect(catalog.get(LIST)?.scopes).toContain('read:calendar');
    expect(catalog.get(EXPORT)?.scopes).toContain('read:calendar');
    expect(catalog.get(CREATE)?.scopes).toContain('write:calendar');
    expect(catalog.get(CREATE)?.access).toBe('admin');
    expect(catalog.get(IMPORT)?.access).toBe('admin');
  });

  test('events.list returns { events: [...] } matching the SDK summary schema exactly', async () => {
    const result = (await catalog.invoke(LIST, invocation({}))) as {
      events: Array<Record<string, unknown>>;
    };
    expect(result.events.length).toBe(1);
    const summary = result.events[0]!;
    expect(summary.id).toBe('/dav/evt-1.ics');
    expect(summary.title).toBe('Team sync');
    expect(summary.start).toBe('2026-01-01T12:00:00.000Z');
    expect(summary.end).toBe('2026-01-01T13:00:00.000Z');
    expect(summary.location).toBe('Room 5');
    expect(summary.description).toBe('agenda');
    // PII strip: display names only, empty names dropped.
    expect(summary.attendees).toEqual(['Jane Doe']);
    // Fields NOT in the SDK summary schema must be absent (additionalProperties:false).
    expect(Object.keys(summary).sort()).toEqual(
      ['attendees', 'description', 'end', 'id', 'location', 'start', 'title'].sort(),
    );
    expect('calendarId' in summary).toBe(false);
    expect('organizerDigest' in summary).toBe(false);
    expect('allDay' in summary).toBe(false);
  });

  test('events.get returns the detail object directly, keyed to the SDK detail schema', async () => {
    const detail = (await catalog.invoke(GET, invocation({ eventId: 'evt-1@example' }))) as Record<
      string,
      unknown
    >;
    expect(detail.id).toBe('/dav/evt-1.ics');
    expect(detail.uid).toBe('evt-1@example');
    expect(detail.title).toBe('Team sync');
    expect(detail.recurrence).toBe('FREQ=WEEKLY');
    expect(detail.attendees).toEqual(['Jane Doe']);
    // No wrapping { event } and no forbidden fields.
    expect('event' in detail).toBe(false);
    expect('calendarId' in detail).toBe(false);
    expect('organizerDigest' in detail).toBe(false);
    expect(Object.keys(detail).sort()).toEqual(
      ['attendees', 'description', 'end', 'id', 'location', 'recurrence', 'start', 'title', 'uid'].sort(),
    );
  });

  test('events.get throws CALENDAR_NOT_FOUND for a missing event', async () => {
    await expect(catalog.invoke(GET, invocation({ eventId: 'missing' }))).rejects.toThrow(
      /not found/i,
    );
  });

  test('events.get rejects a missing eventId', async () => {
    await expect(catalog.invoke(GET, invocation({}))).rejects.toThrow(/eventId/);
  });

  test('events.create returns { eventId, uid, createdAt } when confirmed', async () => {
    const result = (await catalog.invoke(
      CREATE,
      invocation(
        {
          title: 'Lunch',
          start: '2026-03-01T10:00:00Z',
          end: '2026-03-01T11:00:00Z',
          confirm: true,
        },
        { explicit: true },
      ),
    )) as { eventId: string; uid: string; createdAt: string };
    expect(result.eventId).toBe('/dav/new.ics');
    expect(result.uid).toBe('new-uid@goodvibes');
    expect(result.createdAt).toBe('2026-01-01T00:00:00.000Z');
    expect(Object.keys(result).sort()).toEqual(['createdAt', 'eventId', 'uid']);
  });

  test('events.create is confirm-gated', async () => {
    // confirm missing
    await expect(
      catalog.invoke(
        CREATE,
        invocation(
          { title: 't', start: '2026-03-01T10:00:00Z', end: '2026-03-01T11:00:00Z' },
          { explicit: true },
        ),
      ),
    ).rejects.toThrow(/confirmation/i);
    // confirm:true but not an explicit user request
    await expect(
      catalog.invoke(
        CREATE,
        invocation(
          { title: 't', start: '2026-03-01T10:00:00Z', end: '2026-03-01T11:00:00Z', confirm: true },
          { explicit: false },
        ),
      ),
    ).rejects.toThrow(/confirmation/i);
  });

  test('events.create rejects end before start', async () => {
    await expect(
      catalog.invoke(
        CREATE,
        invocation(
          {
            title: 't',
            start: '2026-03-01T11:00:00Z',
            end: '2026-03-01T10:00:00Z',
            confirm: true,
          },
          { explicit: true },
        ),
      ),
    ).rejects.toThrow(/before/i);
  });

  test('events.create rejects a non-ISO date', async () => {
    await expect(
      catalog.invoke(
        CREATE,
        invocation(
          { title: 't', start: 'nope', end: '2026-03-01T11:00:00Z', confirm: true },
          { explicit: true },
        ),
      ),
    ).rejects.toThrow(/ISO-8601/);
  });

  test('ics.import returns { imported, eventIds, errors } when confirmed', async () => {
    const result = (await catalog.invoke(
      IMPORT,
      invocation({ icsContent: 'BEGIN:VCALENDAR', confirm: true }, { explicit: true }),
    )) as { imported: number; eventIds: string[]; errors: string[] };
    expect(result.imported).toBe(2);
    expect(result.eventIds.length).toBe(2);
    expect(result.errors).toEqual([]);
    expect(Object.keys(result).sort()).toEqual(['errors', 'eventIds', 'imported']);
  });

  test('ics.import is confirm-gated', async () => {
    await expect(
      catalog.invoke(IMPORT, invocation({ icsContent: 'x' }, { explicit: true })),
    ).rejects.toThrow(/confirmation/i);
  });

  test('ics.import rejects a missing icsContent', async () => {
    await expect(
      catalog.invoke(IMPORT, invocation({ confirm: true }, { explicit: true })),
    ).rejects.toThrow(/icsContent/);
  });

  test('ics.export returns { icsContent, eventCount } and requires no confirmation', async () => {
    const result = (await catalog.invoke(EXPORT, invocation({}))) as {
      icsContent: string;
      eventCount: number;
    };
    expect(result.eventCount).toBe(3);
    expect(result.icsContent).toContain('BEGIN:VCALENDAR');
    expect(Object.keys(result).sort()).toEqual(['eventCount', 'icsContent']);
  });

  test('list rejects a non-string calendarId', async () => {
    await expect(catalog.invoke(LIST, invocation({ calendarId: 5 }))).rejects.toThrow(/string/);
  });

  test('list rejects a non-numeric limit', async () => {
    await expect(catalog.invoke(LIST, invocation({ limit: 'ten' }))).rejects.toThrow(/number/);
  });

  test('teardown detaches all five handlers', () => {
    unregister();
    for (const id of CALENDAR_METHOD_IDS) {
      expect(catalog.hasHandler(id)).toBe(false);
    }
    // Replace with a no-op so the afterEach double-teardown is safe (the SDK
    // unregister already removed the catalog entries above).
    unregister = () => {};
  });
});
