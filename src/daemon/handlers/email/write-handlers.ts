// ---------------------------------------------------------------------------
// Write handlers: email.draft.create + email.send.
//
// email.draft.create is access:admin (no body.confirm in the SDK contract);
// email.send is dangerous:true and confirmation-gated — index.ts registers it
// with { confirm: true }, so the register wrapper enforces body.confirm===true
// AND explicitUserRequest before this handler runs.
//
// Recipients are validated, sender/recipient addresses are reduced to a digest
// before logging (PII strip), and draft bodies are encrypted at rest by the
// runtime before persistence. No secret or raw address is echoed into a
// response. No descriptor or schema is authored here.
// ---------------------------------------------------------------------------

import type { CatalogHandlerEntry, TypedHandler } from '../register.ts';
import type { EmailRuntime } from './runtime.ts';
import { buildRfc5322Message, generateMessageId } from './smtp-connector.ts';
import {
  asRecord,
  requireString,
  optionalString,
  validateEmailAddress,
  addressDigest,
  type DraftCreateResponse,
  type SendResponse,
} from './validation.ts';

interface DraftCreateBody {
  to?: unknown;
  subject?: unknown;
  body?: unknown;
  inReplyTo?: unknown;
  references?: unknown;
}

interface SendBody {
  to?: unknown;
  subject?: unknown;
  body?: unknown;
  inReplyTo?: unknown;
  confirm?: unknown;
}

function draftCreateHandler(runtime: EmailRuntime): TypedHandler<DraftCreateBody, DraftCreateResponse> {
  return async ({ body }) => {
    const input = asRecord(body);
    const to = validateEmailAddress(requireString(input.to, 'to'), 'to');
    const subject = requireString(input.subject, 'subject');
    const draftBody = requireString(input.body, 'body');
    const inReplyTo = optionalString(input.inReplyTo, 'inReplyTo');
    const references = optionalString(input.references, 'references');

    const from = await runtime.smtpFrom();
    const messageId = generateMessageId(from);
    const raw = buildRfc5322Message({
      from,
      to,
      subject,
      body: draftBody,
      messageId,
      date: new Date(),
      ...(inReplyTo ? { inReplyTo } : {}),
      ...(references ? { references } : {}),
    });
    const appended = await runtime.withImap((imap) => imap.appendDraft(raw));

    const now = new Date().toISOString();
    const draftId = messageId.replace(/[<>]/g, '');
    await runtime.persistDraft({
      id: draftId,
      to,
      subject,
      plaintextBody: draftBody,
      status: 'draft',
      createdAt: now,
      updatedAt: now,
      metadata: { uid: appended.uid, mailbox: appended.mailbox, messageId },
    });

    runtime.logger.info('email.draft.create', {
      uid: appended.uid,
      draftId,
      recipient: addressDigest(to),
    });
    return { uid: appended.uid, draftId };
  };
}

function sendHandler(runtime: EmailRuntime): TypedHandler<SendBody, SendResponse> {
  return async ({ body }) => {
    const input = asRecord(body);
    const to = validateEmailAddress(requireString(input.to, 'to'), 'to');
    const subject = requireString(input.subject, 'subject');
    const sendBody = requireString(input.body, 'body');
    const inReplyTo = optionalString(input.inReplyTo, 'inReplyTo');

    const smtp = await runtime.openSmtp();
    let result: SendResponse;
    try {
      result = await smtp.send({
        to,
        subject,
        body: sendBody,
        ...(inReplyTo ? { inReplyTo } : {}),
      });
    } finally {
      await smtp.close();
    }
    runtime.logger.info('email.send', {
      messageId: result.messageId,
      sentAt: result.sentAt,
      recipient: addressDigest(to),
    });
    return result;
  };
}

/** Build the write-handler catalog entries bound to the shared runtime. */
export function buildWriteHandlerEntries(runtime: EmailRuntime): CatalogHandlerEntry[] {
  return [
    {
      id: 'email.draft.create',
      handler: draftCreateHandler(runtime) as TypedHandler<unknown, unknown>,
    },
    {
      id: 'email.send',
      handler: sendHandler(runtime) as TypedHandler<unknown, unknown>,
      // dangerous:true SDK method — require explicit confirmation (body.confirm
      // === true AND explicitUserRequest) via the register wrapper.
      options: { confirm: true },
    },
  ];
}
