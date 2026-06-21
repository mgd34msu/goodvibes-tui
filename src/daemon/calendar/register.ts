// Operator-method registration for the CalDAV calendar surface.
//
// Published method IDs (exactly):
//   calendar.events.list   (read-only-network, no confirm)
//   calendar.events.get    (read-only-network, no confirm)
//   calendar.events.create (confirmed-effect, confirm:true + explicitUserRequest)
//   calendar.ics.import    (confirmed-effect, confirm:true)
//   calendar.ics.export    (read-only, no confirm)
//
// Exactly these five IDs are published — matching the SDK handoff contract
// ("the daemon must implement exactly these IDs"). Capability advertisement is
// satisfied by each descriptor's catalog metadata rather than by an extra
// calendar.* operator method.
//
// SECURITY: CalDAV credentials and authenticated URLs NEVER appear in any
// response. `calendarId` is a logical id. Attendees are surfaced as display
// names only (no raw addresses). Organizer is surfaced as a SHA-256 digest.

import {
  declareOperatorMethods,
  OperatorError,
  sha256First,
  type CalendarEventSummary,
  type OperatorContext,
  type OperatorHandler,
  type OperatorMethodDescriptor,
  type Unregister,
} from '../operator/index.ts';
import {
  createCalDavClient,
  resolveCalDavConfig,
  type CalDavClient,
  type CalDavEvent,
} from './caldav-client.ts';

/**
 * The exact set of method IDs this surface publishes. Exposed so integration
 * and tests have a single source of truth for the calendar capability set.
 */
export const CALENDAR_METHOD_IDS = [
  'calendar.events.list',
  'calendar.events.get',
  'calendar.events.create',
  'calendar.ics.import',
  'calendar.ics.export',
] as const;

const CATEGORY = 'calendar';
const TRANSPORT: OperatorMethodDescriptor['transport'] = ['ws', 'internal'];

// ---------------------------------------------------------------------------
// Client factory injection (real client by default; tests inject a stub).
// ---------------------------------------------------------------------------

export type CalDavClientFactory = (ctx: OperatorContext) => Promise<CalDavClient>;

const realClientFactory: CalDavClientFactory = async (ctx) => {
  const config = await resolveCalDavConfig(ctx);
  return createCalDavClient({ config });
};

export interface RegisterCalendarOptions {
  /** Override the CalDAV client factory (for tests). */
  clientFactory?: CalDavClientFactory;
}

// ---------------------------------------------------------------------------
// Input validation helpers
// ---------------------------------------------------------------------------

function asRecord(body: unknown): Record<string, unknown> {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new OperatorError('Request body must be an object.', 'CALENDAR_BAD_INPUT', 400);
  }
  return body as Record<string, unknown>;
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    throw new OperatorError(`Field '${key}' must be a string.`, 'CALENDAR_BAD_INPUT', 400);
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function requiredString(record: Record<string, unknown>, key: string): string {
  const value = optionalString(record, key);
  if (value === undefined) {
    throw new OperatorError(`Field '${key}' is required.`, 'CALENDAR_BAD_INPUT', 400);
  }
  return value;
}

function optionalNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new OperatorError(`Field '${key}' must be a number.`, 'CALENDAR_BAD_INPUT', 400);
  }
  return value;
}

function optionalStringArray(record: Record<string, unknown>, key: string): string[] | undefined {
  const value = record[key];
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new OperatorError(`Field '${key}' must be an array of strings.`, 'CALENDAR_BAD_INPUT', 400);
  }
  return (value as string[]).map((item) => item.trim()).filter((item) => item.length > 0);
}

function validateIsoDate(value: string, field: string): string {
  if (Number.isNaN(new Date(value).getTime())) {
    throw new OperatorError(`Field '${field}' must be a valid ISO-8601 date.`, 'CALENDAR_BAD_INPUT', 400);
  }
  return value;
}

// ---------------------------------------------------------------------------
// Response mapping (credential-free, PII-stripped)
// ---------------------------------------------------------------------------

/**
 * Wire shape returned by `calendar.events.list`. Extends the shared operator
 * `CalendarEventSummary` with the two fields the daemon handoff I/O contract
 * requires on the summary (`description` and display-name-only `attendees`),
 * which the base operator type leaves to its open `metadata` slot. Keeping them
 * as first-class fields makes the response an exact match for the handoff
 * `CalendarEventSummary` block rather than a partial subset.
 */
export interface CalendarEventSummaryResult extends CalendarEventSummary {
  /** Free-text DESCRIPTION, when present. */
  description?: string;
  /** Display names only — never raw addresses. Omitted when there are none. */
  attendees?: string[];
}

function toSummary(event: CalDavEvent): CalendarEventSummaryResult {
  const attendees = event.attendees.map((a) => a.displayName).filter((name) => name.length > 0);
  return {
    id: event.href || event.uid,
    calendarId: event.calendarId,
    title: event.summary,
    start: event.start,
    end: event.end,
    allDay: event.allDay,
    description: event.description,
    location: event.location,
    attendees: attendees.length > 0 ? attendees : undefined,
    organizerDigest: event.organizerRaw ? sha256First(event.organizerRaw, 16) : undefined,
    status: event.status,
  };
}

export interface CalendarEventDetail {
  id: string;
  calendarId: string;
  uid: string;
  title: string;
  start: string;
  end: string;
  allDay: boolean;
  description?: string;
  location?: string;
  status?: string;
  recurrence?: string;
  /** Display names only — never raw addresses. */
  attendees: string[];
  organizerDigest?: string;
}

function toDetail(event: CalDavEvent): CalendarEventDetail {
  return {
    id: event.href || event.uid,
    calendarId: event.calendarId,
    uid: event.uid,
    title: event.summary,
    start: event.start,
    end: event.end,
    allDay: event.allDay,
    description: event.description,
    location: event.location,
    status: event.status,
    recurrence: event.recurrence,
    attendees: event.attendees.map((a) => a.displayName),
    organizerDigest: event.organizerRaw ? sha256First(event.organizerRaw, 16) : undefined,
  };
}

// ---------------------------------------------------------------------------
// JSON Schemas
// ---------------------------------------------------------------------------

const calendarEventSummarySchema: Record<string, unknown> = {
  type: 'object',
  required: ['id', 'title', 'start', 'end'],
  properties: {
    id: { type: 'string' },
    calendarId: { type: 'string' },
    title: { type: 'string' },
    start: { type: 'string', format: 'date-time' },
    end: { type: 'string', format: 'date-time' },
    allDay: { type: 'boolean' },
    description: { type: 'string' },
    location: { type: 'string' },
    attendees: { type: 'array', items: { type: 'string' } },
    organizerDigest: { type: 'string' },
    status: { type: 'string' },
  },
};

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

interface ListBody {
  calendarId?: string;
  from?: string;
  to?: string;
  limit?: number;
}

interface GetBody {
  eventId: string;
  calendarId?: string;
}

interface CreateBody {
  title: string;
  start: string;
  end: string;
  description?: string;
  attendees?: string[];
  location?: string;
  calendarId?: string;
  confirm: true;
}

interface ImportBody {
  icsContent: string;
  calendarId?: string;
  confirm: true;
}

interface ExportBody {
  calendarId?: string;
  from?: string;
  to?: string;
}

/**
 * Register all five calendar operator methods against the catalog. Returns a
 * single Unregister that tears all of them down.
 */
export function registerCalendarMethods(
  ctx: OperatorContext,
  options: RegisterCalendarOptions = {},
): Unregister {
  const clientFactory = options.clientFactory ?? realClientFactory;
  const getClient = (): Promise<CalDavClient> => clientFactory(ctx);

  const listHandler: OperatorHandler<unknown, { events: CalendarEventSummaryResult[] }> = async ({ body }) => {
    const record = body === undefined || body === null ? {} : asRecord(body);
    const input: ListBody = {
      calendarId: optionalString(record, 'calendarId'),
      from: optionalString(record, 'from'),
      to: optionalString(record, 'to'),
      limit: optionalNumber(record, 'limit'),
    };
    if (input.from) validateIsoDate(input.from, 'from');
    if (input.to) validateIsoDate(input.to, 'to');
    const limit = input.limit !== undefined ? Math.max(1, Math.min(200, Math.floor(input.limit))) : 20;
    const client = await getClient();
    const events = await client.listEvents({ ...input, limit });
    return { events: events.map(toSummary) };
  };

  const getHandler: OperatorHandler<unknown, { event: CalendarEventDetail }> = async ({ body }) => {
    const record = asRecord(body);
    const input: GetBody = {
      eventId: requiredString(record, 'eventId'),
      calendarId: optionalString(record, 'calendarId'),
    };
    const client = await getClient();
    const event = await client.getEvent(input.eventId, input.calendarId);
    if (!event) {
      throw new OperatorError(`Event not found: ${input.eventId}`, 'CALENDAR_NOT_FOUND', 404);
    }
    return { event: toDetail(event) };
  };

  const createHandler: OperatorHandler<unknown, { eventId: string; uid: string; createdAt: string }> = async ({ body }) => {
    const record = asRecord(body);
    const input: CreateBody = {
      title: requiredString(record, 'title'),
      start: validateIsoDate(requiredString(record, 'start'), 'start'),
      end: validateIsoDate(requiredString(record, 'end'), 'end'),
      description: optionalString(record, 'description'),
      attendees: optionalStringArray(record, 'attendees'),
      location: optionalString(record, 'location'),
      calendarId: optionalString(record, 'calendarId'),
      confirm: true,
    };
    if (new Date(input.end).getTime() < new Date(input.start).getTime()) {
      throw new OperatorError("Field 'end' must not be before 'start'.", 'CALENDAR_BAD_INPUT', 400);
    }
    const client = await getClient();
    const created = await client.createEvent({
      title: input.title,
      start: input.start,
      end: input.end,
      description: input.description,
      attendees: input.attendees,
      location: input.location,
      calendarId: input.calendarId,
    });
    return { eventId: created.eventId, uid: created.uid, createdAt: created.createdAt };
  };

  const importHandler: OperatorHandler<unknown, { imported: number; eventIds: string[]; errors: string[] }> = async ({ body }) => {
    const record = asRecord(body);
    const input: ImportBody = {
      icsContent: requiredString(record, 'icsContent'),
      calendarId: optionalString(record, 'calendarId'),
      confirm: true,
    };
    const client = await getClient();
    return client.importIcs(input.icsContent, input.calendarId);
  };

  const exportHandler: OperatorHandler<unknown, { icsContent: string; eventCount: number }> = async ({ body }) => {
    const record = body === undefined || body === null ? {} : asRecord(body);
    const input: ExportBody = {
      calendarId: optionalString(record, 'calendarId'),
      from: optionalString(record, 'from'),
      to: optionalString(record, 'to'),
    };
    if (input.from) validateIsoDate(input.from, 'from');
    if (input.to) validateIsoDate(input.to, 'to');
    const client = await getClient();
    return client.exportIcs(input);
  };

  return declareOperatorMethods(ctx, [
    {
      descriptor: {
        id: 'calendar.events.list',
        title: 'List calendar events',
        description: 'List events from a CalDAV calendar within an optional time range.',
        category: CATEGORY,
        source: 'daemon',
        access: 'operator',
        transport: TRANSPORT,
        scopes: ['calendar:read'],
        effect: 'read-only-network',
        confirm: false,
        inputSchema: {
          type: 'object',
          properties: {
            calendarId: { type: 'string' },
            from: { type: 'string', format: 'date-time' },
            to: { type: 'string', format: 'date-time' },
            limit: { type: 'number', minimum: 1, maximum: 200, default: 20 },
          },
        },
        outputSchema: {
          type: 'object',
          required: ['events'],
          properties: { events: { type: 'array', items: calendarEventSummarySchema } },
        },
      },
      handler: listHandler as OperatorHandler<unknown, unknown>,
    },
    {
      descriptor: {
        id: 'calendar.events.get',
        title: 'Get calendar event',
        description: 'Fetch a single calendar event with attendees, recurrence, and iCal UID.',
        category: CATEGORY,
        source: 'daemon',
        access: 'operator',
        transport: TRANSPORT,
        scopes: ['calendar:read'],
        effect: 'read-only-network',
        confirm: false,
        inputSchema: {
          type: 'object',
          required: ['eventId'],
          properties: {
            eventId: { type: 'string' },
            calendarId: { type: 'string' },
          },
        },
        outputSchema: {
          type: 'object',
          required: ['event'],
          properties: {
            event: {
              type: 'object',
              required: ['id', 'uid', 'title', 'start', 'end', 'attendees'],
              properties: {
                id: { type: 'string' },
                calendarId: { type: 'string' },
                uid: { type: 'string' },
                title: { type: 'string' },
                start: { type: 'string', format: 'date-time' },
                end: { type: 'string', format: 'date-time' },
                allDay: { type: 'boolean' },
                description: { type: 'string' },
                location: { type: 'string' },
                status: { type: 'string' },
                recurrence: { type: 'string' },
                attendees: { type: 'array', items: { type: 'string' } },
                organizerDigest: { type: 'string' },
              },
            },
          },
        },
      },
      handler: getHandler as OperatorHandler<unknown, unknown>,
    },
    {
      descriptor: {
        id: 'calendar.events.create',
        title: 'Create calendar event',
        description: 'Create an event on the user’s CalDAV calendar. Requires explicit confirmation.',
        category: CATEGORY,
        source: 'daemon',
        access: 'operator',
        transport: TRANSPORT,
        scopes: ['calendar:write'],
        effect: 'confirmed-effect',
        confirm: true,
        inputSchema: {
          type: 'object',
          required: ['title', 'start', 'end', 'confirm'],
          properties: {
            title: { type: 'string' },
            start: { type: 'string', format: 'date-time' },
            end: { type: 'string', format: 'date-time' },
            description: { type: 'string' },
            attendees: { type: 'array', items: { type: 'string' } },
            location: { type: 'string' },
            calendarId: { type: 'string' },
            confirm: { const: true },
          },
        },
        outputSchema: {
          type: 'object',
          required: ['eventId', 'uid', 'createdAt'],
          properties: {
            eventId: { type: 'string' },
            uid: { type: 'string' },
            createdAt: { type: 'string', format: 'date-time' },
          },
        },
      },
      handler: createHandler as OperatorHandler<unknown, unknown>,
    },
    {
      descriptor: {
        id: 'calendar.ics.import',
        title: 'Import .ics to calendar',
        description: 'Import one or more events from a raw RFC 5545 .ics object. Requires confirmation.',
        category: CATEGORY,
        source: 'daemon',
        access: 'operator',
        transport: TRANSPORT,
        scopes: ['calendar:write'],
        effect: 'confirmed-effect',
        confirm: true,
        inputSchema: {
          type: 'object',
          required: ['icsContent', 'confirm'],
          properties: {
            icsContent: { type: 'string' },
            calendarId: { type: 'string' },
            confirm: { const: true },
          },
        },
        outputSchema: {
          type: 'object',
          required: ['imported', 'eventIds', 'errors'],
          properties: {
            imported: { type: 'number' },
            eventIds: { type: 'array', items: { type: 'string' } },
            errors: { type: 'array', items: { type: 'string' } },
          },
        },
      },
      handler: importHandler as OperatorHandler<unknown, unknown>,
    },
    {
      descriptor: {
        id: 'calendar.ics.export',
        title: 'Export calendar as .ics',
        description: 'Export a CalDAV calendar (optionally within a time range) as an RFC 5545 .ics document.',
        category: CATEGORY,
        source: 'daemon',
        access: 'operator',
        transport: TRANSPORT,
        scopes: ['calendar:read'],
        effect: 'read-only',
        confirm: false,
        inputSchema: {
          type: 'object',
          properties: {
            calendarId: { type: 'string' },
            from: { type: 'string', format: 'date-time' },
            to: { type: 'string', format: 'date-time' },
          },
        },
        outputSchema: {
          type: 'object',
          required: ['icsContent', 'eventCount'],
          properties: {
            icsContent: { type: 'string' },
            eventCount: { type: 'number' },
          },
        },
      },
      handler: exportHandler as OperatorHandler<unknown, unknown>,
    },
  ]);
}
