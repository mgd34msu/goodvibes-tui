// ---------------------------------------------------------------------------
// Read handlers: email.inbox.list + email.inbox.read.
//
// Both are read-only (scopes read:email, no confirmation). They attach to the
// SDK-registered descriptors by id; no descriptor or schema is authored here.
// Outputs match EMAIL_INBOX_MESSAGE_SCHEMA / EMAIL_MESSAGE_DETAIL_SCHEMA.
// ---------------------------------------------------------------------------

import type { CatalogHandlerEntry, TypedHandler } from '../register.ts';
import type { EmailRuntime } from './runtime.ts';
import {
  asRecord,
  clampLimit,
  requireUid,
  validateIsoDate,
  addressDigest,
  toListMessage,
  toReadMessage,
  type InboxListResponse,
  type InboxReadResponse,
} from './validation.ts';

interface InboxListBody {
  limit?: unknown;
  since?: unknown;
  unreadOnly?: unknown;
}

interface InboxReadBody {
  uid?: unknown;
}

function inboxListHandler(runtime: EmailRuntime): TypedHandler<InboxListBody, InboxListResponse> {
  return async ({ body }) => {
    const input = asRecord(body ?? {});
    const limit = clampLimit(input.limit);
    const since = validateIsoDate(input.since);
    const unreadOnly = input.unreadOnly === undefined ? true : input.unreadOnly === true;
    const messages = await runtime.withImap((imap) =>
      imap.listMessages({ limit, since, unreadOnly }),
    );
    runtime.logger.info('email.inbox.list', {
      count: messages.length,
      unreadOnly,
      senders: messages.map((m) => addressDigest(m.from)),
    });
    return { messages: messages.map(toListMessage), total: messages.length };
  };
}

function inboxReadHandler(runtime: EmailRuntime): TypedHandler<InboxReadBody, InboxReadResponse> {
  return async ({ body, query }) => {
    const input = asRecord(body ?? {});
    // uid arrives in the body for in-process calls and as the `{uid}` path
    // segment (surfaced via query) for the HTTP binding — accept either.
    const uid = requireUid(input.uid ?? query.uid);
    const message = await runtime.withImap((imap) => imap.readMessage(uid));
    runtime.logger.info('email.inbox.read', {
      uid,
      from: addressDigest(message.from),
      hasHtml: Boolean(message.bodyHtml),
      attachments: message.attachments?.length ?? 0,
    });
    return toReadMessage(message);
  };
}

/** Build the read-handler catalog entries bound to the shared runtime. */
export function buildReadHandlerEntries(runtime: EmailRuntime): CatalogHandlerEntry[] {
  return [
    {
      id: 'email.inbox.list',
      handler: inboxListHandler(runtime) as TypedHandler<unknown, unknown>,
    },
    {
      id: 'email.inbox.read',
      handler: inboxReadHandler(runtime) as TypedHandler<unknown, unknown>,
    },
  ];
}
