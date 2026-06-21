// ---------------------------------------------------------------------------
// Input validation, PII-safe digesting, and response shaping for the email
// handler surface. Pure functions only (no I/O, no secrets).
// ---------------------------------------------------------------------------

import { createHash } from 'node:crypto';
import { HandlerError } from '../errors.ts';
import type { ImapEnvelopeSummary, ImapFullMessage } from './imap-connector.ts';

export function asRecord(body: unknown): Record<string, unknown> {
  if (typeof body !== 'object' || body === null) {
    throw new HandlerError('Request body must be an object', 'EMAIL_BAD_INPUT', 400);
  }
  return body as Record<string, unknown>;
}

export function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new HandlerError(`Field '${field}' is required`, 'EMAIL_BAD_INPUT', 400);
  }
  return value;
}

export function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    throw new HandlerError(`Field '${field}' must be a string`, 'EMAIL_BAD_INPUT', 400);
  }
  return value;
}

/**
 * Extract the addr-spec from an RFC 5322 name-addr ("Display <a@b>"). Reads the
 * contents of the LAST <...> pair so a stray '<' inside a quoted display name
 * does not corrupt the result.
 */
export function extractAddrSpec(entry: string): string {
  const open = entry.lastIndexOf('<');
  if (open !== -1) {
    const close = entry.indexOf('>', open + 1);
    if (close !== -1) return entry.slice(open + 1, close).trim();
  }
  return entry.trim();
}

export function validateEmailAddress(value: string, field: string): string {
  const entries = value.split(',').map((s) => s.trim()).filter(Boolean);
  if (entries.length === 0 || entries.some((e) => !/.+@.+\..+/.test(extractAddrSpec(e)))) {
    throw new HandlerError(`Field '${field}' must be a valid email address`, 'EMAIL_BAD_INPUT', 400);
  }
  return value;
}

export function clampLimit(value: unknown): number {
  if (value === undefined || value === null) return 10;
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) {
    throw new HandlerError("Field 'limit' must be a number", 'EMAIL_BAD_INPUT', 400);
  }
  return Math.min(100, Math.max(1, Math.floor(n)));
}

export function validateIsoDate(value: unknown): string | undefined {
  const str = optionalString(value, 'since');
  if (str === undefined) return undefined;
  if (Number.isNaN(new Date(str).getTime())) {
    throw new HandlerError("Field 'since' must be an ISO-8601 date", 'EMAIL_BAD_INPUT', 400);
  }
  return str;
}

export function requireUid(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    throw new HandlerError("Field 'uid' must be a positive integer", 'EMAIL_BAD_INPUT', 400);
  }
  return n;
}

/** Reduce an address to a stable, non-reversible digest for PII-safe logging. */
export function addressDigest(address: string): string {
  return createHash('sha256').update(address.toLowerCase().trim(), 'utf-8').digest('hex').slice(0, 16);
}

// ---------------------------------------------------------------------------
// Response contracts (must match EMAIL_INBOX_MESSAGE_SCHEMA /
// EMAIL_MESSAGE_DETAIL_SCHEMA / {uid,draftId} / {messageId,sentAt}).
// ---------------------------------------------------------------------------

export interface InboxListResponse {
  messages: Array<{
    uid: number;
    from: string;
    subject: string;
    date: string;
    unread: boolean;
    bodyPreview: string;
    messageId: string;
  }>;
  total: number;
}

export interface InboxReadResponse {
  uid: number;
  from: string;
  subject: string;
  date: string;
  messageId: string;
  bodyText: string;
  bodyHtml?: string;
  attachments?: Array<{ filename: string; contentType: string; sizeBytes: number }>;
}

export interface DraftCreateResponse {
  uid: number;
  draftId: string;
}

export interface SendResponse {
  messageId: string;
  sentAt: string;
}

export function toListMessage(m: ImapEnvelopeSummary): InboxListResponse['messages'][number] {
  return {
    uid: m.uid,
    from: m.from,
    subject: m.subject,
    date: m.date,
    unread: m.unread,
    bodyPreview: m.bodyPreview,
    messageId: m.messageId,
  };
}

export function toReadMessage(m: ImapFullMessage): InboxReadResponse {
  return {
    uid: m.uid,
    from: m.from,
    subject: m.subject,
    date: m.date,
    messageId: m.messageId,
    bodyText: m.bodyText,
    ...(m.bodyHtml ? { bodyHtml: m.bodyHtml } : {}),
    ...(m.attachments && m.attachments.length > 0 ? { attachments: m.attachments } : {}),
  };
}
