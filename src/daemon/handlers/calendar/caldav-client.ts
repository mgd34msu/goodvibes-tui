// CalDAV client for the calendar handler surface.
//
// Authenticates to the user's CalDAV endpoint using credentials resolved from
// the daemon credential store (config keys under `surfaces.calendar.*`). It
// implements the CalDAV/WebDAV verbs the gateway methods need:
//   - REPORT (calendar-query)  -> list / get events
//   - PUT                      -> create / import events
//   - REPORT (multiget) / GET  -> export a collection
//   - PROPFIND                 -> discover calendar collections
//
// SECURITY POSTURE:
//   * The authenticated CalDAV base URL and credentials NEVER leave this module.
//   * `calendarId` is a LOGICAL identifier. It is mapped internally to a
//     collection path; the authenticated absolute URL is never returned to or
//     accepted from callers.
//   * Event hrefs are returned to callers as opaque relative identifiers, never
//     as fully-qualified authenticated URLs.

import { HandlerError } from '../errors.ts';
import type { HandlerContext } from '../context.ts';
import type { DaemonCredentialStore } from '../credentials.ts';
import {
  generateCalendar,
  generateICS,
  parseICS,
  type GenerateICalInput,
  type ParsedICalEvent,
} from './ics.ts';
import { summarizeError } from '@pellux/goodvibes-sdk/platform/utils';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const CFG_URL = 'surfaces.calendar.caldavUrl';
const CFG_USER = 'surfaces.calendar.caldavUser';
const CFG_PASSWORD = 'surfaces.calendar.caldavPassword';
const CFG_DEFAULT_CALENDAR = 'surfaces.calendar.defaultCalendarId';
const CFG_CALENDARS = 'surfaces.calendar.calendars';

export interface CalDavConfig {
  baseUrl: string;
  username: string;
  password: string;
  defaultCalendarId: string;
  /** logical calendarId -> collection path (relative to baseUrl host). */
  collectionMap: Record<string, string>;
}

export interface CalDavEvent extends ParsedICalEvent {
  /** Opaque, host-relative href identifying the resource (never absolute/authenticated). */
  href: string;
  /** Logical calendar id this event belongs to. */
  calendarId: string;
}

export interface ListEventsOptions {
  calendarId?: string;
  from?: string;
  to?: string;
  limit?: number;
}

export interface CreateEventInput {
  title: string;
  start: string;
  end: string;
  description?: string;
  attendees?: string[];
  location?: string;
  calendarId?: string;
}

export interface CreatedEvent {
  eventId: string; // opaque href or UID
  uid: string;
  createdAt: string;
}

export interface ImportResult {
  imported: number;
  eventIds: string[];
  errors: string[];
}

export interface ExportResult {
  icsContent: string;
  eventCount: number;
}

/** Minimal fetch contract so the client is testable with an injected fetch. */
export type FetchLike = (
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  },
) => Promise<{
  ok: boolean;
  status: number;
  statusText: string;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}>;

export interface CalDavClient {
  listCalendars(): Promise<Array<{ calendarId: string; displayName: string }>>;
  listEvents(opts: ListEventsOptions): Promise<CalDavEvent[]>;
  getEvent(eventId: string, calendarId?: string): Promise<CalDavEvent | null>;
  createEvent(input: CreateEventInput): Promise<CreatedEvent>;
  importIcs(icsContent: string, calendarId?: string): Promise<ImportResult>;
  exportIcs(opts: { calendarId?: string; from?: string; to?: string }): Promise<ExportResult>;
}

/** Subset of the handler context the CalDAV config resolver needs. */
export type CalDavConfigContext = Pick<HandlerContext, 'configManager' | 'credentials'>;

// ---------------------------------------------------------------------------
// Config resolution
// ---------------------------------------------------------------------------

function readConfigString(
  ctx: Pick<HandlerContext, 'configManager'>,
  key: string,
): string | undefined {
  const value = ctx.configManager.get(key as never);
  if (value === undefined || value === null) return undefined;
  const text = String(value).trim();
  return text.length > 0 ? text : undefined;
}

function parseCollectionMap(raw: string | undefined): Record<string, string> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const map: Record<string, string> = {};
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof v === 'string' && v.length > 0) map[k] = v;
      }
      return map;
    }
  } catch {
    // Ignore malformed config; fall back to default-calendar-only behaviour.
  }
  return {};
}

/**
 * Resolve the full CalDAV configuration from config + credential store.
 * The password is resolved from the daemon credential store — either as a
 * goodvibes://secrets/ reference stored in config, or the config-key-derived
 * secret. Throws HandlerError when the surface is not configured. The resolved
 * password is held only in memory and never returned to callers.
 */
export async function resolveCalDavConfig(
  ctx: CalDavConfigContext,
): Promise<CalDavConfig> {
  const credentials: DaemonCredentialStore = ctx.credentials;
  const baseUrl = readConfigString(ctx, CFG_URL);
  const username = readConfigString(ctx, CFG_USER);
  if (!baseUrl || !username) {
    throw new HandlerError(
      'CalDAV is not configured. Set surfaces.calendar.caldavUrl and surfaces.calendar.caldavUser.',
      'CALENDAR_NOT_CONFIGURED',
      412,
    );
  }

  const passwordConfig = readConfigString(ctx, CFG_PASSWORD);
  let password: string | null = null;
  if (passwordConfig) {
    // Config may hold a goodvibes://secrets/ ref or a raw secret key.
    password = await credentials.resolveRef(passwordConfig);
  }
  if (!password) {
    // Fall back to the config-key-derived secret.
    password = await credentials.resolveConfigSecret(CFG_PASSWORD);
  }
  if (!password) {
    throw new HandlerError(
      'CalDAV password is not available in the credential store.',
      'CALENDAR_CREDENTIALS_MISSING',
      412,
    );
  }

  const defaultCalendarId = readConfigString(ctx, CFG_DEFAULT_CALENDAR) ?? 'default';
  const collectionMap = parseCollectionMap(readConfigString(ctx, CFG_CALENDARS));

  return { baseUrl, username, password, defaultCalendarId, collectionMap };
}

// ---------------------------------------------------------------------------
// URL helpers (logical id <-> collection path; never expose absolute URLs)
// ---------------------------------------------------------------------------

function stripTrailingSlash(value: string): string {
  return value.endsWith('/') ? value.slice(0, -1) : value;
}

function joinUrl(base: string, segment: string): string {
  const cleanBase = stripTrailingSlash(base);
  const cleanSegment = segment.startsWith('/') ? segment : `/${segment}`;
  return `${cleanBase}${cleanSegment}`;
}

/** Extract the scheme+host origin from an absolute URL (no trailing slash). */
export function originOf(url: string): string {
  const match = /^(https?:\/\/[^/]+)/i.exec(url.trim());
  return match ? match[1]! : stripTrailingSlash(url);
}

/**
 * Resolve a configured collection path. A host-absolute path (starting with
 * '/') is resolved against the origin of the base URL; any other value is
 * treated as a child segment relative to the base URL.
 */
function resolveCollectionUrl(baseUrl: string, path: string): string {
  if (path.startsWith('/')) {
    return `${originOf(baseUrl)}${stripTrailingSlash(path)}`;
  }
  return joinUrl(baseUrl, stripTrailingSlash(path));
}

/**
 * Convert an absolute or host-relative href returned by the server into an
 * opaque, host-relative identifier. Strips scheme + host so authenticated URLs
 * never leak to callers.
 */
export function toRelativeHref(href: string): string {
  const trimmed = href.trim();
  const schemeMatch = /^https?:\/\/[^/]+(\/.*)$/i.exec(trimmed);
  if (schemeMatch) return schemeMatch[1]!;
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}

// ---------------------------------------------------------------------------
// REPORT / PROPFIND body builders
// ---------------------------------------------------------------------------

function calendarQueryBody(from?: string, to?: string): string {
  const timeFilter = from || to
    ? `<C:time-range${from ? ` start="${toCalDavStamp(from)}"` : ''}${to ? ` end="${toCalDavStamp(to)}"` : ''}/>`
    : '';
  return [
    '<?xml version="1.0" encoding="utf-8" ?>',
    '<C:calendar-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">',
    '  <D:prop>',
    '    <D:getetag/>',
    '    <C:calendar-data/>',
    '  </D:prop>',
    '  <C:filter>',
    '    <C:comp-filter name="VCALENDAR">',
    `      <C:comp-filter name="VEVENT">${timeFilter}</C:comp-filter>`,
    '    </C:comp-filter>',
    '  </C:filter>',
    '</C:calendar-query>',
  ].join('\n');
}

/**
 * Build a calendar-query REPORT body that matches a single VEVENT by UID using
 * a server-side text-match prop-filter. This lets the server return only the
 * one matching resource instead of the entire collection, so a UID lookup is
 * O(1) on the wire and cannot silently miss an event truncated from a large
 * unfiltered listing.
 */
function calendarQueryByUidBody(uid: string): string {
  // Escape XML metacharacters in the UID before embedding it in the filter.
  const safeUid = uid
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
  return [
    '<?xml version="1.0" encoding="utf-8" ?>',
    '<C:calendar-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">',
    '  <D:prop>',
    '    <D:getetag/>',
    '    <C:calendar-data/>',
    '  </D:prop>',
    '  <C:filter>',
    '    <C:comp-filter name="VCALENDAR">',
    '      <C:comp-filter name="VEVENT">',
    `        <C:prop-filter name="UID"><C:text-match collation="i;octet">${safeUid}</C:text-match></C:prop-filter>`,
    '      </C:comp-filter>',
    '    </C:comp-filter>',
    '  </C:filter>',
    '</C:calendar-query>',
  ].join('\n');
}

function propfindCalendarsBody(): string {
  return [
    '<?xml version="1.0" encoding="utf-8" ?>',
    '<D:propfind xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">',
    '  <D:prop>',
    '    <D:displayname/>',
    '    <D:resourcetype/>',
    '  </D:prop>',
    '</D:propfind>',
  ].join('\n');
}

function toCalDavStamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    throw new HandlerError(`Invalid date range value: ${iso}`, 'CALENDAR_BAD_RANGE', 400);
  }
  const pad = (n: number): string => (n < 10 ? `0${n}` : String(n));
  return (
    `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}`
    + `T${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`
  );
}

// ---------------------------------------------------------------------------
// Multistatus (207) response parsing
// ---------------------------------------------------------------------------

interface MultiStatusEntry {
  href: string;
  calendarData?: string;
  displayName?: string;
  isCalendar: boolean;
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function tagContent(block: string, localName: string): string | undefined {
  // Match <ns:local ...>content</ns:local> or <local>content</local>.
  const re = new RegExp(
    `<(?:[a-zA-Z0-9]+:)?${localName}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[a-zA-Z0-9]+:)?${localName}>`,
    'i',
  );
  const match = re.exec(block);
  return match ? match[1] : undefined;
}

function hasTag(block: string, localName: string): boolean {
  const re = new RegExp(`<(?:[a-zA-Z0-9]+:)?${localName}(?:\\s[^>]*)?\\/?>`, 'i');
  return re.test(block);
}

/** Parse a WebDAV 207 multistatus document into per-resource entries. */
export function parseMultiStatus(xml: string): MultiStatusEntry[] {
  const entries: MultiStatusEntry[] = [];
  const responseRe = /<(?:[a-zA-Z0-9]+:)?response(?:\s[^>]*)?>([\s\S]*?)<\/(?:[a-zA-Z0-9]+:)?response>/gi;
  let match: RegExpExecArray | null;
  while ((match = responseRe.exec(xml)) !== null) {
    const block = match[1]!;
    const hrefRaw = tagContent(block, 'href');
    if (!hrefRaw) continue;
    const href = decodeXmlEntities(hrefRaw.trim());
    const calendarDataRaw = tagContent(block, 'calendar-data');
    const displayNameRaw = tagContent(block, 'displayname');
    const isCalendar = hasTag(block, 'calendar');
    entries.push({
      href,
      calendarData: calendarDataRaw ? decodeXmlEntities(calendarDataRaw) : undefined,
      displayName: displayNameRaw ? decodeXmlEntities(displayNameRaw.trim()) : undefined,
      isCalendar,
    });
  }
  return entries;
}

// ---------------------------------------------------------------------------
// Client implementation
// ---------------------------------------------------------------------------

export interface CreateCalDavClientOptions {
  config: CalDavConfig;
  fetchImpl?: FetchLike;
}

const defaultFetch: FetchLike = (input, init) =>
  fetch(input, init as RequestInit) as unknown as ReturnType<FetchLike>;

export function createCalDavClient(options: CreateCalDavClientOptions): CalDavClient {
  const { config } = options;
  const doFetch = options.fetchImpl ?? defaultFetch;
  const authHeader = `Basic ${Buffer.from(`${config.username}:${config.password}`).toString('base64')}`;

  const collectionPathFor = (calendarId: string | undefined): string => {
    const id = calendarId && calendarId.length > 0 ? calendarId : config.defaultCalendarId;
    const mapped = config.collectionMap[id];
    if (mapped) return mapped;
    if (id === config.defaultCalendarId) return ''; // base URL is the default collection
    // Unknown logical id with no mapping: treat the id as a child collection name.
    return `/${encodeURIComponent(id)}/`;
  };

  const collectionUrlFor = (calendarId: string | undefined): string => {
    const path = collectionPathFor(calendarId);
    return path.length > 0 ? resolveCollectionUrl(config.baseUrl, path) : stripTrailingSlash(config.baseUrl);
  };

  const request = async (
    url: string,
    method: string,
    body?: string,
    extraHeaders?: Record<string, string>,
  ): Promise<{ status: number; text: string; headers: { get(n: string): string | null } }> => {
    let response;
    try {
      response = await doFetch(url, {
        method,
        headers: {
          Authorization: authHeader,
          ...(body !== undefined
            ? { 'Content-Type': method === 'PUT' ? 'text/calendar; charset=utf-8' : 'application/xml; charset=utf-8' }
            : {}),
          ...extraHeaders,
        },
        body,
      });
    } catch {
      // Redact like the HTTP-status branch below: the raw fetch error
      // (e.g. "getaddrinfo ENOTFOUND cal.example.com") leaks the CalDAV
      // hostname/URL into caller-visible output (importIcs errors[]).
      // Never include creds/URL/host or raw fetch detail.
      throw new HandlerError('CalDAV request failed: network error.', 'CALENDAR_NETWORK_ERROR', 502);
    }
    const text = await response.text();
    if (!response.ok) {
      // Map auth/permission/not-found to handler errors. Never include creds/URL.
      const status = response.status;
      const code = status === 401 || status === 403
        ? 'CALENDAR_AUTH_FAILED'
        : status === 404
          ? 'CALENDAR_NOT_FOUND'
          : 'CALENDAR_REQUEST_FAILED';
      throw new HandlerError(
        `CalDAV server returned HTTP ${status}.`,
        code,
        status >= 400 && status < 500 ? status : 502,
      );
    }
    return { status: response.status, text, headers: response.headers };
  };

  const buildEvents = (
    entries: MultiStatusEntry[],
    calendarId: string,
  ): CalDavEvent[] => {
    const events: CalDavEvent[] = [];
    for (const entry of entries) {
      if (!entry.calendarData) continue;
      const parsed = parseICS(entry.calendarData);
      for (const event of parsed) {
        events.push({ ...event, href: toRelativeHref(entry.href), calendarId });
      }
    }
    return events;
  };

  return {
    async listCalendars() {
      const url = stripTrailingSlash(config.baseUrl);
      const { text } = await request(url, 'PROPFIND', propfindCalendarsBody(), { Depth: '1' });
      const entries = parseMultiStatus(text);
      const calendars: Array<{ calendarId: string; displayName: string }> = [];
      const seen = new Set<string>();
      for (const entry of entries) {
        if (!entry.isCalendar) continue;
        const rel = toRelativeHref(entry.href);
        // Derive a stable logical id from the last path segment.
        const segments = rel.split('/').filter((s) => s.length > 0);
        const logical = segments.length > 0 ? decodeURIComponent(segments[segments.length - 1]!) : config.defaultCalendarId;
        if (seen.has(logical)) continue;
        seen.add(logical);
        calendars.push({ calendarId: logical, displayName: entry.displayName ?? logical });
      }
      if (calendars.length === 0) {
        calendars.push({ calendarId: config.defaultCalendarId, displayName: config.defaultCalendarId });
      }
      return calendars;
    },

    async listEvents(opts) {
      const calendarId = opts.calendarId && opts.calendarId.length > 0 ? opts.calendarId : config.defaultCalendarId;
      const url = collectionUrlFor(calendarId);
      const { text } = await request(url, 'REPORT', calendarQueryBody(opts.from, opts.to), { Depth: '1' });
      const entries = parseMultiStatus(text);
      let events = buildEvents(entries, calendarId);
      events.sort((a, b) => a.start.localeCompare(b.start));
      const limit = opts.limit && opts.limit > 0 ? opts.limit : 20;
      if (events.length > limit) events = events.slice(0, limit);
      return events;
    },

    async getEvent(eventId, calendarId) {
      const id = calendarId && calendarId.length > 0 ? calendarId : config.defaultCalendarId;
      const collectionUrl = collectionUrlFor(id);

      // Strategy 1 — href-like identifiers (a relative path, or a *.ics
      // resource name): resolve to a single resource URL and GET it directly.
      // This is a true single-event fetch, not a collection scan.
      if (isHrefLike(eventId)) {
        const resourceUrl = resolveResourceUrl(collectionUrl, config.baseUrl, eventId);
        let single;
        try {
          single = await request(resourceUrl, 'GET', undefined, { Depth: '0' });
        } catch (error) {
          // A 404 maps to "not found"; any other failure propagates.
          if (error instanceof HandlerError && error.code === 'CALENDAR_NOT_FOUND') {
            return null;
          }
          throw error;
        }
        const parsed = parseICS(single.text);
        if (parsed.length === 0) return null;
        const relHref = toRelativeHref(eventId);
        return { ...parsed[0]!, href: relHref, calendarId: id };
      }

      // Strategy 2 — bare UID: ask the server for ONLY the matching resource via
      // a UID prop-filter calendar-query. The server does the matching, so this
      // is O(1) on the wire and cannot miss an event hidden past a list cutoff.
      const { text } = await request(
        collectionUrl,
        'REPORT',
        calendarQueryByUidBody(eventId),
        { Depth: '1' },
      );
      const entries = parseMultiStatus(text);
      const events = buildEvents(entries, id);
      // Some servers ignore unsupported prop-filters and return the collection;
      // confirm the exact UID match client-side so we never return a wrong event.
      const found = events.find((event) => event.uid === eventId);
      return found ?? null;
    },

    async createEvent(input) {
      const calendarId = input.calendarId && input.calendarId.length > 0 ? input.calendarId : config.defaultCalendarId;
      const uid = `${crypto.randomUUID()}@goodvibes`;
      const createdAt = new Date().toISOString();
      const ics = generateICS({
        uid,
        summary: input.title,
        start: input.start,
        end: input.end,
        description: input.description,
        location: input.location,
        attendees: input.attendees,
        status: 'confirmed',
        dtStamp: createdAt,
      });
      const resourcePath = `${uid}.ics`;
      const collectionUrl = collectionUrlFor(calendarId);
      const resourceUrl = joinUrl(collectionUrl, resourcePath);
      const { headers } = await request(resourceUrl, 'PUT', ics, { 'If-None-Match': '*' });
      // Prefer the server-assigned location; otherwise the relative resource path.
      const location = headers.get('Location');
      const href = location ? toRelativeHref(location) : toRelativeHref(joinUrl(collectionPathOrRoot(collectionUrl, config.baseUrl), resourcePath));
      return { eventId: href, uid, createdAt };
    },

    async importIcs(icsContent, calendarId) {
      const id = calendarId && calendarId.length > 0 ? calendarId : config.defaultCalendarId;
      const parsed = parseICS(icsContent);
      if (parsed.length === 0) {
        throw new HandlerError('No VEVENT components found in .ics content.', 'CALENDAR_EMPTY_ICS', 400);
      }
      const collectionUrl = collectionUrlFor(id);
      const eventIds: string[] = [];
      const errors: string[] = [];
      let imported = 0;
      for (const event of parsed) {
        const uid = event.uid && event.uid.length > 0 ? event.uid : `${crypto.randomUUID()}@goodvibes`;
        try {
          const ics = generateICS(parsedToGenerateInput(event, uid));
          const resourcePath = `${uid}.ics`;
          const resourceUrl = joinUrl(collectionUrl, resourcePath);
          await request(resourceUrl, 'PUT', ics);
          eventIds.push(toRelativeHref(joinUrl(collectionPathOrRoot(collectionUrl, config.baseUrl), resourcePath)));
          imported += 1;
        } catch (error) {
          const message = error instanceof HandlerError ? error.message : summarizeError(error);
          errors.push(`${uid}: ${message}`);
        }
      }
      return { imported, eventIds, errors };
    },

    async exportIcs(opts) {
      const id = opts.calendarId && opts.calendarId.length > 0 ? opts.calendarId : config.defaultCalendarId;
      const url = collectionUrlFor(id);
      const { text } = await request(url, 'REPORT', calendarQueryBody(opts.from, opts.to), { Depth: '1' });
      const entries = parseMultiStatus(text);
      const inputs: GenerateICalInput[] = [];
      for (const entry of entries) {
        if (!entry.calendarData) continue;
        for (const event of parseICS(entry.calendarData)) {
          inputs.push(parsedToGenerateInput(event, event.uid || `${crypto.randomUUID()}@goodvibes`));
        }
      }
      const icsContent = generateCalendar(inputs);
      return { icsContent, eventCount: inputs.length };
    },
  };
}

/**
 * Heuristic: does an event identifier look like a resource href rather than a
 * bare iCalendar UID? Hrefs contain a path separator or end in `.ics`; UIDs
 * are opaque tokens (often `uuid@host`) without a path component.
 */
function isHrefLike(eventId: string): boolean {
  return eventId.includes('/') || /\.ics$/i.test(eventId);
}

/**
 * Resolve an href-like identifier to an absolute, authenticated resource URL
 * for a direct GET. A host-absolute href (starting with '/') is resolved
 * against the base URL origin; any other value is treated as a resource name
 * within the target collection.
 */
function resolveResourceUrl(collectionUrl: string, baseUrl: string, eventId: string): string {
  const trimmed = eventId.trim();
  if (trimmed.startsWith('/')) {
    return `${originOf(baseUrl)}${trimmed}`;
  }
  return joinUrl(collectionUrl, trimmed);
}

/** Compute the host-relative collection path from an absolute collection URL. */
function collectionPathOrRoot(collectionUrl: string, baseUrl: string): string {
  const rel = toRelativeHref(collectionUrl);
  if (rel.length > 0) return rel;
  return toRelativeHref(baseUrl);
}

function parsedToGenerateInput(event: ParsedICalEvent, uid: string): GenerateICalInput {
  return {
    uid,
    summary: event.summary,
    start: event.start,
    end: event.end,
    description: event.description,
    location: event.location,
    // Re-emit attendees by their raw value so import preserves the original
    // addressing; display-name-only redaction applies to handler responses,
    // not to server-side payloads.
    attendees: event.attendees.map((a) => a.rawValue),
    organizer: event.organizerRaw,
    status: event.status,
    recurrence: event.recurrence,
    allDay: event.allDay,
  };
}
