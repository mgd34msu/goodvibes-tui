// Handler registration for the CalDAV calendar surface.
//
// Attaches host handlers to the five SDK-registered calendar gateway method
// descriptors BY ID (the SDK auto-registers them with handler:undefined). No
// method id, descriptor, or schema is authored here — `registerCatalogHandlers`
// looks up the canonical descriptor via `catalog.get(id)` and re-registers it
// with the wrapped handler. Method IDs handled (exactly):
//   calendar.events.list   read:calendar   no confirm
//   calendar.events.get    read:calendar   no confirm
//   calendar.events.create write:calendar  confirm:true + explicitUserRequest
//   calendar.ics.import    write:calendar  confirm:true + explicitUserRequest
//   calendar.ics.export    read:calendar   no confirm
//
// SECURITY: CalDAV credentials and authenticated URLs NEVER appear in any
// response. `calendarId` is a logical id. Attendees are surfaced as display
// names only (no raw addresses). Outputs are stripped to exactly the SDK output
// schema fields (the SDK schemas set additionalProperties:false).

import { HandlerError } from '../errors.ts';
import type { HandlerContext } from '../context.ts';
import {
  registerCatalogHandlers,
  type CatalogHandlerEntry,
  type TypedHandler,
  type Unregister,
} from '../register.ts';
import {
  createCalDavClient,
  resolveCalDavConfig,
  type CalDavClient,
  type CalDavConfigContext,
  type CalDavEvent,
} from './caldav-client.ts';

/**
 * The exact set of method IDs this surface publishes — a single source of truth
 * for the calendar capability set, consumed by integration wiring and tests.
 */
export const CALENDAR_METHOD_IDS = [
  'calendar.events.list',
  'calendar.events.get',
  'calendar.events.create',
  'calendar.ics.import',
  'calendar.ics.export',
] as const;

// ---------------------------------------------------------------------------
// Client factory injection (real client by default; tests inject a stub).
// ---------------------------------------------------------------------------

export type CalDavClientFactory = (ctx: CalDavConfigContext) => Promise<CalDavClient>;

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
    throw new HandlerError('Request body must be an object.', 'CALENDAR_BAD_INPUT', 400);
  }
  return body as Record<string, unknown>;
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    throw new HandlerError(`Field '${key}' must be a string.`, 'CALENDAR_BAD_INPUT', 400);
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function requiredString(record: Record<string, unknown>, key: string): string {
  const value = optionalString(record, key);
  if (value === undefined) {
    throw new HandlerError(`Field '${key}' is required.`, 'CALENDAR_BAD_INPUT', 400);
  }
  return value;
}

function optionalNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new HandlerError(`Field '${key}' must be a number.`, 'CALENDAR_BAD_INPUT', 400);
  }
  return value;
}

function optionalStringArray(record: Record<string, unknown>, key: string): string[] | undefined {
  const value = record[key];
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new HandlerError(`Field '${key}' must be an array of strings.`, 'CALENDAR_BAD_INPUT', 400);
  }
  return (value as string[]).map((item) => item.trim()).filter((item) => item.length > 0);
}

function validateIsoDate(value: string, field: string): string {
  if (Number.isNaN(new Date(value).getTime())) {
    throw new HandlerError(`Field '${field}' must be a valid ISO-8601 date.`, 'CALENDAR_BAD_INPUT', 400);
  }
  return value;
}

// ---------------------------------------------------------------------------
// Response mapping (credential-free, PII-stripped, schema-exact)
// ---------------------------------------------------------------------------

/**
 * Wire shape for `calendar.events.list` items — EXACTLY the SDK
 * CALENDAR_EVENT_SUMMARY_SCHEMA (additionalProperties:false). Optional fields
 * are present only when populated. `calendarId`/`allDay`/organizer are NOT in
 * the SDK schema and are intentionally dropped.
 */
export interface CalendarEventSummary {
  id: string;
  title: string;
  start: string;
  end: string;
  location?: string;
  description?: string;
  attendees?: string[];
}

function displayAttendees(event: CalDavEvent): string[] {
  return event.attendees.map((a) => a.displayName).filter((name) => name.length > 0);
}

function toSummary(event: CalDavEvent): CalendarEventSummary {
  const attendees = displayAttendees(event);
  const summary: CalendarEventSummary = {
    id: event.href || event.uid,
    title: event.summary,
    start: event.start,
    end: event.end,
  };
  if (event.location !== undefined) summary.location = event.location;
  if (event.description !== undefined) summary.description = event.description;
  if (attendees.length > 0) summary.attendees = attendees;
  return summary;
}

/**
 * Wire shape for `calendar.events.get` — EXACTLY the SDK
 * CALENDAR_EVENT_DETAIL_SCHEMA (additionalProperties:false), returned directly
 * (not wrapped). `uid` carries the raw iCalendar UID; attendees are display
 * names only.
 */
export interface CalendarEventDetail {
  id: string;
  uid: string;
  title: string;
  start: string;
  end: string;
  location?: string;
  description?: string;
  attendees?: string[];
  recurrence?: string;
}

function toDetail(event: CalDavEvent): CalendarEventDetail {
  const attendees = displayAttendees(event);
  const detail: CalendarEventDetail = {
    id: event.href || event.uid,
    uid: event.uid,
    title: event.summary,
    start: event.start,
    end: event.end,
  };
  if (event.location !== undefined) detail.location = event.location;
  if (event.description !== undefined) detail.description = event.description;
  if (attendees.length > 0) detail.attendees = attendees;
  if (event.recurrence !== undefined) detail.recurrence = event.recurrence;
  return detail;
}

// ---------------------------------------------------------------------------
// Handler bodies
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

interface ExportBody {
  calendarId?: string;
  from?: string;
  to?: string;
}

/**
 * Register all five calendar handlers against the SDK catalog held by `ctx`.
 * Returns a single Unregister that detaches them in reverse order.
 */
export function registerCalendarMethods(
  ctx: HandlerContext,
  options: RegisterCalendarOptions = {},
): Unregister {
  const clientFactory = options.clientFactory ?? realClientFactory;
  const getClient = (): Promise<CalDavClient> => clientFactory(ctx);

  const listHandler: TypedHandler<unknown, { events: CalendarEventSummary[] }> = async ({ body }) => {
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

  const getHandler: TypedHandler<unknown, CalendarEventDetail> = async ({ body }) => {
    const record = asRecord(body);
    const input: GetBody = {
      eventId: requiredString(record, 'eventId'),
      calendarId: optionalString(record, 'calendarId'),
    };
    const client = await getClient();
    const event = await client.getEvent(input.eventId, input.calendarId);
    if (!event) {
      throw new HandlerError(`Event not found: ${input.eventId}`, 'CALENDAR_NOT_FOUND', 404);
    }
    return toDetail(event);
  };

  const createHandler: TypedHandler<unknown, { eventId: string; uid: string; createdAt: string }> = async ({ body }) => {
    const record = asRecord(body);
    const title = requiredString(record, 'title');
    const start = validateIsoDate(requiredString(record, 'start'), 'start');
    const end = validateIsoDate(requiredString(record, 'end'), 'end');
    if (new Date(end).getTime() < new Date(start).getTime()) {
      throw new HandlerError("Field 'end' must not be before 'start'.", 'CALENDAR_BAD_INPUT', 400);
    }
    const client = await getClient();
    const created = await client.createEvent({
      title,
      start,
      end,
      description: optionalString(record, 'description'),
      attendees: optionalStringArray(record, 'attendees'),
      location: optionalString(record, 'location'),
      calendarId: optionalString(record, 'calendarId'),
    });
    return { eventId: created.eventId, uid: created.uid, createdAt: created.createdAt };
  };

  const importHandler: TypedHandler<unknown, { imported: number; eventIds: string[]; errors: string[] }> = async ({ body }) => {
    const record = asRecord(body);
    const icsContent = requiredString(record, 'icsContent');
    const calendarId = optionalString(record, 'calendarId');
    const client = await getClient();
    return client.importIcs(icsContent, calendarId);
  };

  const exportHandler: TypedHandler<unknown, { icsContent: string; eventCount: number }> = async ({ body }) => {
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

  const entries: CatalogHandlerEntry[] = [
    { id: 'calendar.events.list', handler: listHandler as TypedHandler<unknown, unknown> },
    { id: 'calendar.events.get', handler: getHandler as TypedHandler<unknown, unknown> },
    {
      id: 'calendar.events.create',
      handler: createHandler as TypedHandler<unknown, unknown>,
      options: { confirm: true },
    },
    {
      id: 'calendar.ics.import',
      handler: importHandler as TypedHandler<unknown, unknown>,
      options: { confirm: true },
    },
    { id: 'calendar.ics.export', handler: exportHandler as TypedHandler<unknown, unknown> },
  ];

  return registerCatalogHandlers(ctx.catalog, entries);
}

/** SurfaceRegister-compatible entry point used by the daemon composition root. */
export function registerCalendar(ctx: HandlerContext): Unregister {
  return registerCalendarMethods(ctx);
}
