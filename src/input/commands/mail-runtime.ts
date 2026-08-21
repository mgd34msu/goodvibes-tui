/**
 * mail-runtime.ts, `/mail`, the terminal surface over the daemon's mail
 * capability.
 *
 * This command implements no mail. Every verb here is one call into the
 * gateway method catalog, where `src/daemon/handlers/email/` owns IMAP, SMTP,
 * settings resolution, the credential read, and the confirmation gate. What
 * lives in this file is argument parsing, rendering, and an honest refusal when
 * the capability is not set up, nothing else.
 *
 * ## What is exposed, and what is not
 *
 * Reading (`list`, `read`) and drafting are exposed because checking mail
 * without leaving the terminal is squarely what this product is for, and
 * because a draft changes nothing outside the account's own Drafts folder.
 *
 * Sending is exposed too, a shipped route with no way to reach it is a route
 * that is not wired up, but never in one step. `/mail send` first renders
 * exactly what would leave the machine and stops; only a re-run carrying
 * `--confirm` sets both flags the daemon's gate demands. That mirrors the
 * preview-then-confirm shape `/review` uses for hunk reverts, and it means the
 * dangerous action cannot happen from a typo or a recalled line of history.
 *
 * Message bodies are attacker-controlled text. They are printed as transcript
 * output, which is display-only and never enters the model's message history,
 * so a body cannot smuggle instructions into a turn by being read here.
 */

import type { CommandContext, CommandRegistry } from '../command-registry.ts';
import {
  EXPLICIT_WRITE_INVOCATION_CONTEXT,
  READ_INVOCATION_CONTEXT,
  errorText,
  probeConnection,
  renderConnectionStatus,
} from './connection-status.ts';

/** Inbox summary, exactly the daemon's `email.inbox.list` item shape. */
interface InboxMessage {
  readonly uid: number;
  readonly from: string;
  readonly subject: string;
  readonly date: string;
  readonly unread: boolean;
  readonly bodyPreview: string;
}

/** Full message, exactly the daemon's `email.inbox.read` output shape. */
interface FullMessage {
  readonly uid: number;
  readonly from: string;
  readonly subject: string;
  readonly date: string;
  readonly bodyText?: string;
  readonly attachments?: ReadonlyArray<{ readonly filename: string; readonly sizeBytes: number }>;
}

const DEFAULT_LIST_LIMIT = 15;
const MAX_LIST_LIMIT = 100;

function truncate(value: string, width: number): string {
  const flat = value.replace(/\s+/g, ' ').trim();
  return flat.length <= width ? flat : `${flat.slice(0, width - 1)}…`;
}

export function renderInboxList(messages: readonly InboxMessage[]): string {
  if (messages.length === 0) return 'Inbox is empty (nothing matched).';
  const lines = [`Inbox: ${messages.length} message${messages.length === 1 ? '' : 's'}:`];
  for (const message of messages) {
    const mark = message.unread ? '●' : ' ';
    lines.push(`  ${mark} ${String(message.uid).padStart(6)}  ${truncate(message.from, 28).padEnd(28)}  ${truncate(message.subject, 48)}`);
  }
  lines.push('', '  /mail read <uid>: open one message');
  return lines.join('\n');
}

export function renderMessage(message: FullMessage): string {
  const lines = [
    `From:    ${message.from}`,
    `Subject: ${message.subject}`,
    `Date:    ${message.date}`,
  ];
  const attachments = message.attachments ?? [];
  if (attachments.length > 0) {
    lines.push(`Files:   ${attachments.map((a) => `${a.filename} (${a.sizeBytes} bytes)`).join(', ')}`);
  }
  lines.push('', message.bodyText && message.bodyText.trim().length > 0
    ? message.bodyText.trimEnd()
    : '(no plain-text body)');
  return lines.join('\n');
}

/**
 * Split `to | subject | body` on unescaped pipes.
 *
 * A pipe rather than positional words because a subject and a body both
 * contain spaces, and quoting rules invented per-command are their own bug
 * source. Exactly three fields are required, so a missing one is a clear
 * usage error rather than a message sent with an empty subject.
 */
export function parseComposeArgs(raw: string): { to: string; subject: string; body: string } | null {
  const parts = raw.split('|').map((part) => part.trim());
  if (parts.length !== 3) return null;
  const [to, subject, body] = parts;
  if (!to || !subject || !body) return null;
  return { to, subject, body };
}

function parseLimit(raw: string | undefined): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_LIST_LIMIT;
  return Math.min(MAX_LIST_LIMIT, Math.floor(parsed));
}

const USAGE = [
  'Usage:',
  '  /mail                       connection status and the latest messages',
  '  /mail status                connection status only',
  '  /mail list [n]              list the n most recent messages (default 15)',
  '  /mail read <uid>            open one message',
  '  /mail draft <to | subject | body>   save a draft to the account',
  '  /mail send  <to | subject | body> [--confirm]   preview, then send',
].join('\n');

export function registerMailRuntimeCommands(registry: CommandRegistry): void {
  registry.register({
    name: 'mail',
    aliases: ['email'],
    description: 'Mail over the daemon: connection status, inbox, read, draft, send',
    usage: '[status|list|read|draft|send] …',
    argsHint: '[status|list <n>|read <uid>|draft|send]',
    async handler(args, ctx) {
      const gateway = ctx.workspace.gatewayMethods;
      const sub = (args[0] ?? '').toLowerCase();

      if (sub === 'status') {
        ctx.print(renderConnectionStatus(await probeConnection(gateway, 'mail')));
        return;
      }

      if (!gateway) {
        ctx.print(renderConnectionStatus(await probeConnection(undefined, 'mail')));
        return;
      }

      if (sub === '' || sub === 'list') {
        await listInbox(ctx, gateway, parseLimit(args[1]), sub === '');
        return;
      }
      if (sub === 'read') {
        await readMessage(ctx, gateway, args[1]);
        return;
      }
      if (sub === 'draft' || sub === 'send') {
        await compose(ctx, gateway, sub, args.slice(1));
        return;
      }
      ctx.print(USAGE);
    },
  });
}

type Gateway = NonNullable<CommandContext['workspace']['gatewayMethods']>;

/**
 * Every failure path renders the connection status rather than a bare error:
 * "not configured" is far more often the real cause than a transient fault,
 * and the status carries the exact next step.
 */
async function withStatusOnFailure(
  ctx: CommandContext,
  gateway: Gateway,
  label: string,
  run: () => Promise<void>,
): Promise<void> {
  try {
    await run();
  } catch (error) {
    ctx.print(`[mail ${label}] ${errorText(error)}`);
    ctx.print(renderConnectionStatus(await probeConnection(gateway, 'mail')));
  }
}

async function listInbox(ctx: CommandContext, gateway: Gateway, limit: number, withStatus: boolean): Promise<void> {
  await withStatusOnFailure(ctx, gateway, 'list', async () => {
    const result = await gateway.invoke('email.inbox.list', {
      ...READ_INVOCATION_CONTEXT,
      body: { limit },
    }) as { readonly messages?: readonly InboxMessage[] };
    if (withStatus) {
      ctx.print(renderConnectionStatus({
        surface: 'mail',
        state: 'ready',
        detail: 'Mail is connected: the daemon reached the server and returned a result.',
        nextActions: [],
      }));
    }
    ctx.print(renderInboxList(result.messages ?? []));
  });
}

async function readMessage(ctx: CommandContext, gateway: Gateway, rawUid: string | undefined): Promise<void> {
  const uid = Number(rawUid);
  if (!Number.isFinite(uid) || uid <= 0) {
    ctx.print('Usage: /mail read <uid>; the uid column from /mail list.');
    return;
  }
  await withStatusOnFailure(ctx, gateway, 'read', async () => {
    const message = await gateway.invoke('email.inbox.read', {
      ...READ_INVOCATION_CONTEXT,
      body: { uid },
    }) as FullMessage;
    ctx.print(renderMessage(message));
  });
}

async function compose(ctx: CommandContext, gateway: Gateway, verb: 'draft' | 'send', rest: readonly string[]): Promise<void> {
  const raw = rest.filter((part) => part !== '--confirm').join(' ');
  const confirmed = rest.includes('--confirm');
  const parsed = parseComposeArgs(raw);
  if (parsed === null) {
    ctx.print([
      `Usage: /mail ${verb} <to | subject | body>`,
      '  Three fields separated by |, for example:',
      `  /mail ${verb} me@example.com | Build is green | All gates passed.`,
    ].join('\n'));
    return;
  }

  if (verb === 'draft') {
    await withStatusOnFailure(ctx, gateway, 'draft', async () => {
      // No `confirm` in the body: the SDK contract for draft.create does not
      // declare one (its input schema is closed), and the handler is registered
      // without the confirmation wrapper. Sending one would be a field the
      // schema rejects.
      const result = await gateway.invoke('email.draft.create', {
        ...EXPLICIT_WRITE_INVOCATION_CONTEXT,
        body: { to: parsed.to, subject: parsed.subject, body: parsed.body },
      }) as { readonly uid: number; readonly draftId: string };
      ctx.print(`Draft saved to the account (uid ${result.uid}). Nothing was sent.`);
    });
    return;
  }

  // Send: preview first, always. The daemon would refuse an unconfirmed call
  // anyway; showing exactly what would leave the machine is the point.
  if (!confirmed) {
    ctx.print([
      'This would send:',
      `  To:      ${parsed.to}`,
      `  Subject: ${parsed.subject}`,
      '',
      parsed.body,
      '',
      'Nothing has been sent. Re-run the same line with --confirm to send it.',
    ].join('\n'));
    return;
  }

  await withStatusOnFailure(ctx, gateway, 'send', async () => {
    const result = await gateway.invoke('email.send', {
      ...EXPLICIT_WRITE_INVOCATION_CONTEXT,
      body: { to: parsed.to, subject: parsed.subject, body: parsed.body, confirm: true },
    }) as { readonly messageId: string; readonly sentAt: string };
    ctx.print(`Sent to ${parsed.to} at ${result.sentAt} (message id ${result.messageId}).`);
  });
}
