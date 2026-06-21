// Public surface barrel for the CalDAV calendar connector.
//
// Integration registers the surface by calling registerCalendarMethods(ctx).
// All other exports are types / helpers for consumers and tests.

export { registerCalendarMethods, CALENDAR_METHOD_IDS } from './register.ts';
export type {
  RegisterCalendarOptions,
  CalDavClientFactory,
  CalendarEventDetail,
  CalendarEventSummaryResult,
} from './register.ts';

export {
  createCalDavClient,
  resolveCalDavConfig,
  toRelativeHref,
  parseMultiStatus,
} from './caldav-client.ts';
export type {
  CalDavClient,
  CalDavConfig,
  CalDavEvent,
  CreateCalDavClientOptions,
  CreateEventInput,
  CreatedEvent,
  ImportResult,
  ExportResult,
  ListEventsOptions,
  FetchLike,
} from './caldav-client.ts';

export {
  parseICS,
  generateICS,
  generateCalendar,
  foldLine,
  unfoldLines,
  escapeText,
  unescapeText,
  formatICalDate,
  formatICalDateTime,
  parseICalDate,
  attendeeDisplayName,
  eventToVEvent,
  extractUid,
} from './ics.ts';
export type {
  ParsedICalEvent,
  ICalAttendee,
  GenerateICalInput,
} from './ics.ts';
