/**
 * calendar-runtime.ts, `/calendar`, the terminal surface over the daemon's
 * calendar capability.
 *
 * As with `/mail`, no calendar logic lives here. CalDAV, ICS parsing, settings
 * resolution and the confirmation gate are all in
 * `src/daemon/handlers/calendar/`; this file parses arguments, renders results,
 * and refuses honestly when the capability is not set up.
 *
 * ## What is exposed, and what is not
 *
 * `list` (the agenda) and `get` are exposed: knowing what is next without
 * leaving the terminal is the whole value of a calendar on this surface.
 * `create` is exposed behind the same preview-then-`--confirm` step `/mail
 * send` uses, because the daemon gates it on both `body.confirm` and an
 * explicit user request, and because an event created by a typo is a real
 * nuisance to undo.
 *
 * `calendar.ics.import` and `calendar.ics.export` are deliberately NOT given a
 * command. They are bulk file-level transfers of a whole calendar, an
 * operation whose natural home is a file path and a scheduled job, not a line
 * typed into a coding session. They stay available to any surface through the
 * same catalog; this product simply does not claim to be the right place for
 * them. That is a scoping decision, recorded here so it reads as a choice
 * rather than an omission.
 */

import type { CommandContext, CommandRegistry } from '../command-registry.ts';
import {
  EXPLICIT_WRITE_INVOCATION_CONTEXT,
  READ_INVOCATION_CONTEXT,
  errorText,
  probeConnection,
  renderConnectionStatus,
} from './connection-status.ts';

/** Agenda item, exactly the daemon's `calendar.events.list` item shape. */
interface CalendarEvent {
  readonly id: string;
  readonly title: string;
  readonly start: string;
  readonly end: string;
  readonly location?: string;
  readonly description?: string;
  readonly attendees?: readonly string[];
}

const DEFAULT_LIST_LIMIT = 20;
const MAX_LIST_LIMIT = 200;

/**
 * Render a timestamp for a terminal agenda.
 *
 * An unparseable value is printed verbatim rather than replaced with a
 * placeholder, showing what the server actually returned is more useful than
 * hiding it behind "invalid date".
 */
export function formatWhen(raw: string): string {
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return raw;
  const date = parsed.toISOString().slice(0, 10);
  const time = parsed.toISOString().slice(11, 16);
  return `${date} ${time}`;
}

function truncate(value: string, width: number): string {
  const flat = value.replace(/\s+/g, ' ').trim();
  return flat.length <= width ? flat : `${flat.slice(0, width - 1)}…`;
}

export function renderAgenda(events: readonly CalendarEvent[]): string {
  if (events.length === 0) return 'No events in this window.';
  const lines = [`Agenda: ${events.length} event${events.length === 1 ? '' : 's'}:`];
  for (const event of events) {
    const where = event.location ? `  @ ${truncate(event.location, 24)}` : '';
    lines.push(`  ${formatWhen(event.start)}  ${truncate(event.title, 44).padEnd(44)}${where}`);
  }
  lines.push('', '  /calendar get <id>: open one event');
  return lines.join('\n');
}

export function renderEvent(event: CalendarEvent): string {
  const lines = [
    `Title:  ${event.title}`,
    `Start:  ${formatWhen(event.start)}`,
    `End:    ${formatWhen(event.end)}`,
  ];
  if (event.location) lines.push(`Where:  ${event.location}`);
  const attendees = event.attendees ?? [];
  if (attendees.length > 0) lines.push(`With:   ${attendees.join(', ')}`);
  if (event.description && event.description.trim().length > 0) {
    lines.push('', event.description.trimEnd());
  }
  return lines.join('\n');
}

/**
 * Split `title | start | end` on unescaped pipes, same separator rule as
 * `/mail`, for the same reason: titles contain spaces and per-command quoting
 * conventions are their own bug source.
 */
export function parseEventArgs(raw: string): { title: string; start: string; end: string } | null {
  const parts = raw.split('|').map((part) => part.trim());
  if (parts.length !== 3) return null;
  const [title, start, end] = parts;
  if (!title || !start || !end) return null;
  return { title, start, end };
}

function parseLimit(raw: string | undefined): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_LIST_LIMIT;
  return Math.min(MAX_LIST_LIMIT, Math.floor(parsed));
}

const USAGE = [
  'Usage:',
  '  /calendar                   connection status and the agenda ahead',
  '  /calendar status            connection status only',
  '  /calendar list [n]          the next n events (default 20)',
  '  /calendar get <id>          open one event',
  '  /calendar create <title | start | end> [--confirm]   preview, then create',
  '',
  '  Times are ISO-8601, e.g. 2026-08-01T14:00:00Z',
].join('\n');

export function registerCalendarRuntimeCommands(registry: CommandRegistry): void {
  registry.register({
    name: 'calendar',
    aliases: ['cal'],
    description: 'Calendar over the daemon: connection status, agenda, event detail, create',
    usage: '[status|list|get|create] …',
    argsHint: '[status|list <n>|get <id>|create]',
    async handler(args, ctx) {
      const gateway = ctx.workspace.gatewayMethods;
      const sub = (args[0] ?? '').toLowerCase();

      if (sub === 'status') {
        ctx.print(renderConnectionStatus(await probeConnection(gateway, 'calendar')));
        return;
      }

      if (!gateway) {
        ctx.print(renderConnectionStatus(await probeConnection(undefined, 'calendar')));
        return;
      }

      if (sub === '' || sub === 'list') {
        await listEvents(ctx, gateway, parseLimit(args[1]), sub === '');
        return;
      }
      if (sub === 'get') {
        await getEvent(ctx, gateway, args[1]);
        return;
      }
      if (sub === 'create') {
        await createEvent(ctx, gateway, args.slice(1));
        return;
      }
      ctx.print(USAGE);
    },
  });
}

type Gateway = NonNullable<CommandContext['workspace']['gatewayMethods']>;

async function withStatusOnFailure(
  ctx: CommandContext,
  gateway: Gateway,
  label: string,
  run: () => Promise<void>,
): Promise<void> {
  try {
    await run();
  } catch (error) {
    ctx.print(`[calendar ${label}] ${errorText(error)}`);
    ctx.print(renderConnectionStatus(await probeConnection(gateway, 'calendar')));
  }
}

async function listEvents(ctx: CommandContext, gateway: Gateway, limit: number, withStatus: boolean): Promise<void> {
  await withStatusOnFailure(ctx, gateway, 'list', async () => {
    const result = await gateway.invoke('calendar.events.list', {
      ...READ_INVOCATION_CONTEXT,
      body: { limit, from: new Date().toISOString() },
    }) as { readonly events?: readonly CalendarEvent[] };
    if (withStatus) {
      ctx.print(renderConnectionStatus({
        surface: 'calendar',
        state: 'ready',
        detail: 'Calendar is connected: the daemon reached the server and returned a result.',
        nextActions: [],
      }));
    }
    ctx.print(renderAgenda(result.events ?? []));
  });
}

async function getEvent(ctx: CommandContext, gateway: Gateway, eventId: string | undefined): Promise<void> {
  if (!eventId) {
    ctx.print('Usage: /calendar get <id>; the id from /calendar list.');
    return;
  }
  await withStatusOnFailure(ctx, gateway, 'get', async () => {
    const event = await gateway.invoke('calendar.events.get', {
      ...READ_INVOCATION_CONTEXT,
      body: { eventId },
    }) as CalendarEvent;
    ctx.print(renderEvent(event));
  });
}

async function createEvent(ctx: CommandContext, gateway: Gateway, rest: readonly string[]): Promise<void> {
  const raw = rest.filter((part) => part !== '--confirm').join(' ');
  const confirmed = rest.includes('--confirm');
  const parsed = parseEventArgs(raw);
  if (parsed === null) {
    ctx.print([
      'Usage: /calendar create <title | start | end>',
      '  Three fields separated by |, for example:',
      '  /calendar create Design review | 2026-08-01T14:00:00Z | 2026-08-01T15:00:00Z',
    ].join('\n'));
    return;
  }

  if (!confirmed) {
    ctx.print([
      'This would create:',
      `  Title: ${parsed.title}`,
      `  Start: ${formatWhen(parsed.start)}`,
      `  End:   ${formatWhen(parsed.end)}`,
      '',
      'Nothing has been created. Re-run the same line with --confirm to create it.',
    ].join('\n'));
    return;
  }

  await withStatusOnFailure(ctx, gateway, 'create', async () => {
    const result = await gateway.invoke('calendar.events.create', {
      ...EXPLICIT_WRITE_INVOCATION_CONTEXT,
      body: { title: parsed.title, start: parsed.start, end: parsed.end, confirm: true },
    }) as { readonly eventId: string; readonly createdAt: string };
    ctx.print(`Created "${parsed.title}" (event id ${result.eventId}, at ${result.createdAt}).`);
  });
}
