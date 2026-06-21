import { describe, expect, it } from 'bun:test';
import { registerCalendarMethods } from '../../../daemon/calendar/register.ts';
import type {
  CalDavClient,
  CalDavEvent,
  CreatedEvent,
  ExportResult,
  ImportResult,
  ListEventsOptions,
} from '../../../daemon/calendar/caldav-client.ts';
import type { OperatorContext } from '../../../daemon/operator/index.ts';

// ---------------------------------------------------------------------------
// Minimal in-memory catalog + context harness
// ---------------------------------------------------------------------------

interface RegisteredMethod {
  descriptor: Record<string, unknown>;
  handler: (input: { body: unknown; context: { principalId?: string; metadata?: Record<string, unknown> } }) => Promise<unknown>;
}

function makeHarness(client: CalDavClient): {
  ctx: OperatorContext;
  methods: Map<string, RegisteredMethod>;
  unregister: () => void;
} {
  const methods = new Map<string, RegisteredMethod>();
  const catalog = {
    register(descriptor: Record<string, unknown>, handler: RegisteredMethod['handler']): () => void {
      const id = String(descriptor.id);
      methods.set(id, { descriptor, handler });
      return () => {
        methods.delete(id);
      };
    },
  };
  const ctx = {
    catalog: catalog as unknown as OperatorContext['catalog'],
    secrets: {} as OperatorContext['secrets'],
    configManager: { get: () => undefined, getCategory: () => ({}) } as unknown as OperatorContext['configManager'],
    workingDirectory: '/tmp/work',
    homeDirectory: '/tmp/home',
    logger: { info() {}, warn() {}, error() {} },
  } satisfies OperatorContext;
  const unregister = registerCalendarMethods(ctx, { clientFactory: async () => client });
  return { ctx, methods, unregister };
}

function invoke(
  methods: Map<string, RegisteredMethod>,
  id: string,
  body: unknown,
  opts?: { explicitUserRequest?: boolean },
): Promise<unknown> {
  const method = methods.get(id);
  if (!method) throw new Error(`method not registered: ${id}`);
  return method.handler({
    body,
    context: {
      principalId: 'user-1',
      metadata: opts?.explicitUserRequest ? { explicitUserRequest: true } : {},
    },
  });
}

function sampleEvent(overrides: Partial<CalDavEvent> = {}): CalDavEvent {
  return {
    uid: 'uid-1',
    summary: 'Standup',
    start: '2026-03-15T09:00:00.000Z',
    end: '2026-03-15T09:30:00.000Z',
    allDay: false,
    status: 'confirmed',
    description: 'Daily sync',
    location: 'Room 1',
    recurrence: 'FREQ=DAILY',
    attendees: [
      { displayName: 'Jane Doe', rawValue: 'mailto:jane@example.com' },
      { displayName: 'bob', rawValue: 'mailto:bob@example.com' },
    ],
    organizer: 'The Boss',
    organizerRaw: 'mailto:boss@example.com',
    raw: {},
    href: '/cal/home/uid-1.ics',
    calendarId: 'default',
    ...overrides,
  };
}

function stubClient(overrides: Partial<CalDavClient> = {}): CalDavClient {
  return {
    async listCalendars() {
      return [{ calendarId: 'default', displayName: 'Default' }];
    },
    async listEvents(_opts: ListEventsOptions): Promise<CalDavEvent[]> {
      return [sampleEvent()];
    },
    async getEvent(): Promise<CalDavEvent | null> {
      return sampleEvent();
    },
    async createEvent(): Promise<CreatedEvent> {
      return { eventId: '/cal/home/uid-new.ics', uid: 'uid-new', createdAt: '2026-03-15T08:00:00.000Z' };
    },
    async importIcs(): Promise<ImportResult> {
      return { imported: 1, eventIds: ['/cal/home/uid-imp.ics'], errors: [] };
    },
    async exportIcs(): Promise<ExportResult> {
      return { icsContent: 'BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n', eventCount: 0 };
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Registration / descriptor metadata
// ---------------------------------------------------------------------------

describe('registerCalendarMethods', () => {
  it('registers exactly the five published method IDs', () => {
    const { methods, unregister } = makeHarness(stubClient());
    expect([...methods.keys()].sort()).toEqual(
      [
        'calendar.events.create',
        'calendar.events.get',
        'calendar.events.list',
        'calendar.ics.export',
        'calendar.ics.import',
      ].sort(),
    );
    unregister();
    expect(methods.size).toBe(0);
  });

  it('maps access operator->admin and source daemon->builtin in catalog descriptors', () => {
    const { methods, unregister } = makeHarness(stubClient());
    const list = methods.get('calendar.events.list')!;
    expect(list.descriptor.access).toBe('admin');
    expect(list.descriptor.source).toBe('builtin');
    // effect/confirm are stripped before catalog registration.
    expect(list.descriptor.effect).toBeUndefined();
    expect(list.descriptor.confirm).toBeUndefined();
    expect(list.descriptor.scopes).toEqual(['calendar:read']);
    unregister();
  });
});

// ---------------------------------------------------------------------------
// Read methods (no confirmation)
// ---------------------------------------------------------------------------

describe('calendar.events.list', () => {
  it('returns event summaries with display-name redaction and organizer digest', async () => {
    const { methods, unregister } = makeHarness(stubClient());
    const result = (await invoke(methods, 'calendar.events.list', {})) as {
      events: Array<Record<string, unknown>>;
    };
    expect(result.events.length).toBe(1);
    const summary = result.events[0];
    expect(summary.title).toBe('Standup');
    expect(summary.id).toBe('/cal/home/uid-1.ics');
    // organizerDigest is a 16-char hash, not the raw address.
    expect(typeof summary.organizerDigest).toBe('string');
    expect((summary.organizerDigest as string).length).toBe(16);
    expect(JSON.stringify(summary).includes('boss@example.com')).toBe(false);
    unregister();
  });

  it('includes description and display-name-only attendees per the handoff summary contract', async () => {
    const { methods, unregister } = makeHarness(stubClient());
    const result = (await invoke(methods, 'calendar.events.list', {})) as {
      events: Array<Record<string, unknown>>;
    };
    const summary = result.events[0];
    // Handoff CalendarEventSummary requires description + attendees (display names).
    expect(summary.description).toBe('Daily sync');
    expect(summary.attendees).toEqual(['Jane Doe', 'bob']);
    // Raw addresses must never leak into the summary.
    expect(JSON.stringify(summary).includes('jane@example.com')).toBe(false);
    unregister();
  });

  it('advertises the summary schema with attendees and description', () => {
    const { methods, unregister } = makeHarness(stubClient());
    const list = methods.get('calendar.events.list')!;
    const output = list.descriptor.outputSchema as {
      properties: { events: { items: { properties: Record<string, unknown> } } };
    };
    const itemProps = output.properties.events.items.properties;
    expect(itemProps.description).toBeDefined();
    expect(itemProps.attendees).toBeDefined();
    unregister();
  });

  it('clamps the limit into [1,200]', async () => {
    let seenLimit = -1;
    const client = stubClient({
      async listEvents(opts) {
        seenLimit = opts.limit ?? -1;
        return [];
      },
    });
    const { methods, unregister } = makeHarness(client);
    await invoke(methods, 'calendar.events.list', { limit: 9999 });
    expect(seenLimit).toBe(200);
    unregister();
  });

  it('rejects an invalid from date', async () => {
    const { methods, unregister } = makeHarness(stubClient());
    await expect(invoke(methods, 'calendar.events.list', { from: 'not-a-date' })).rejects.toMatchObject({
      code: 'CALENDAR_BAD_INPUT',
    });
    unregister();
  });
});

describe('calendar.events.get', () => {
  it('returns a full event with attendees as display names only', async () => {
    const { methods, unregister } = makeHarness(stubClient());
    const result = (await invoke(methods, 'calendar.events.get', { eventId: 'uid-1' })) as {
      event: Record<string, unknown>;
    };
    expect(result.event.uid).toBe('uid-1');
    expect(result.event.attendees).toEqual(['Jane Doe', 'bob']);
    expect(JSON.stringify(result.event).includes('jane@example.com')).toBe(false);
    expect(result.event.recurrence).toBe('FREQ=DAILY');
    unregister();
  });

  it('requires eventId', async () => {
    const { methods, unregister } = makeHarness(stubClient());
    await expect(invoke(methods, 'calendar.events.get', {})).rejects.toMatchObject({ code: 'CALENDAR_BAD_INPUT' });
    unregister();
  });

  it('returns 404 when the event is missing', async () => {
    const client = stubClient({ async getEvent() { return null; } });
    const { methods, unregister } = makeHarness(client);
    await expect(invoke(methods, 'calendar.events.get', { eventId: 'missing' })).rejects.toMatchObject({
      code: 'CALENDAR_NOT_FOUND',
    });
    unregister();
  });
});

describe('calendar.ics.export', () => {
  it('returns ics content and event count without confirmation', async () => {
    const client = stubClient({
      async exportIcs() {
        return { icsContent: 'BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n', eventCount: 3 };
      },
    });
    const { methods, unregister } = makeHarness(client);
    const result = (await invoke(methods, 'calendar.ics.export', {})) as ExportResult;
    expect(result.eventCount).toBe(3);
    expect(result.icsContent).toContain('BEGIN:VCALENDAR');
    unregister();
  });
});

// ---------------------------------------------------------------------------
// Effectful methods (confirmation enforced)
// ---------------------------------------------------------------------------

describe('calendar.events.create confirmation', () => {
  const validBody = {
    title: 'New Event',
    start: '2026-03-15T09:00:00.000Z',
    end: '2026-03-15T10:00:00.000Z',
    confirm: true,
  };

  it('rejects when confirm is missing', async () => {
    const { methods, unregister } = makeHarness(stubClient());
    const { confirm: _omit, ...noConfirm } = validBody;
    await expect(
      invoke(methods, 'calendar.events.create', noConfirm, { explicitUserRequest: true }),
    ).rejects.toMatchObject({ code: 'OPERATOR_CONFIRMATION_REQUIRED' });
    unregister();
  });

  it('rejects when explicitUserRequest is absent even with confirm:true', async () => {
    const { methods, unregister } = makeHarness(stubClient());
    await expect(
      invoke(methods, 'calendar.events.create', validBody, { explicitUserRequest: false }),
    ).rejects.toMatchObject({ code: 'OPERATOR_CONFIRMATION_REQUIRED' });
    unregister();
  });

  it('creates the event and returns a certified receipt when confirmed', async () => {
    const { methods, unregister } = makeHarness(stubClient());
    const result = (await invoke(methods, 'calendar.events.create', validBody, {
      explicitUserRequest: true,
    })) as CreatedEvent;
    expect(result.eventId).toBe('/cal/home/uid-new.ics');
    expect(result.uid).toBe('uid-new');
    expect(typeof result.createdAt).toBe('string');
    unregister();
  });

  it('rejects when end precedes start', async () => {
    const { methods, unregister } = makeHarness(stubClient());
    await expect(
      invoke(
        methods,
        'calendar.events.create',
        { ...validBody, start: '2026-03-15T10:00:00.000Z', end: '2026-03-15T09:00:00.000Z' },
        { explicitUserRequest: true },
      ),
    ).rejects.toMatchObject({ code: 'CALENDAR_BAD_INPUT' });
    unregister();
  });
});

describe('calendar.ics.import confirmation', () => {
  const icsBody = { icsContent: 'BEGIN:VCALENDAR...', confirm: true };

  it('rejects when not confirmed', async () => {
    const { methods, unregister } = makeHarness(stubClient());
    await expect(
      invoke(methods, 'calendar.ics.import', { icsContent: 'x' }, { explicitUserRequest: true }),
    ).rejects.toMatchObject({ code: 'OPERATOR_CONFIRMATION_REQUIRED' });
    unregister();
  });

  it('imports when confirmed and returns counts', async () => {
    const { methods, unregister } = makeHarness(stubClient());
    const result = (await invoke(methods, 'calendar.ics.import', icsBody, {
      explicitUserRequest: true,
    })) as ImportResult;
    expect(result.imported).toBe(1);
    expect(result.eventIds).toEqual(['/cal/home/uid-imp.ics']);
    expect(result.errors).toEqual([]);
    unregister();
  });

  it('propagates per-event errors and a partial count on a partial import', async () => {
    // The import is best-effort: some events succeed while others fail to parse or
    // PUT. The handler must surface a non-empty errors[] alongside the partial
    // imported count and the eventIds that did land, never silently swallow them.
    const client = stubClient({
      async importIcs(): Promise<ImportResult> {
        return {
          imported: 1,
          eventIds: ['/cal/home/uid-ok.ics'],
          errors: ['uid-bad: Unrecognised iCalendar date value: not-a-date'],
        };
      },
    });
    const { methods, unregister } = makeHarness(client);
    const result = (await invoke(methods, 'calendar.ics.import', icsBody, {
      explicitUserRequest: true,
    })) as ImportResult;
    expect(result.imported).toBe(1);
    expect(result.eventIds).toEqual(['/cal/home/uid-ok.ics']);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('uid-bad');
    unregister();
  });
});
