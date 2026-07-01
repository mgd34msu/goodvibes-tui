// Shared test doubles for the email handler surface. Word-style fake secrets
// only — never secret-shaped strings.

import type { HandlerContext, HandlerLogger } from '../../../daemon/handlers/context.ts';
import type { DaemonCredentialStore } from '../../../daemon/handlers/credentials.ts';
import type {
  ImapClient,
  SmtpClient,
} from '../../../daemon/handlers/email/config.ts';
import type {
  ImapEnvelopeSummary,
  ImapFullMessage,
} from '../../../daemon/handlers/email/imap-connector.ts';
import type { SmtpMessage, SmtpSendResult } from '../../../daemon/handlers/email/smtp-connector.ts';

export interface LogEntry {
  readonly message: string;
  readonly meta?: unknown;
}

export function makeLogger(sink: LogEntry[]): HandlerLogger {
  return {
    info: (message, meta) => sink.push({ message, meta }),
    warn: (message, meta) => sink.push({ message, meta }),
    error: (message, meta) => sink.push({ message, meta }),
  };
}

/** In-memory config slice. */
export function makeConfig(values: Record<string, unknown>): HandlerContext['configManager'] {
  return {
    get: ((key: string) => values[key]) as HandlerContext['configManager']['get'],
    getCategory: (() => ({})) as HandlerContext['configManager']['getCategory'],
  };
}

/** In-memory credential store. secretMap maps config-derived keys to plaintext. */
export function makeCredentials(secretMap: Record<string, string>): DaemonCredentialStore {
  return {
    async resolveRef(ref) {
      return secretMap[ref] ?? null;
    },
    async resolveConfigSecret(configKey) {
      return secretMap[configKey] ?? null;
    },
    async put(secretKey, value) {
      secretMap[secretKey] = value;
    },
    async has(secretKey) {
      return Boolean(secretMap[secretKey]);
    },
  };
}

export interface FakeImapState {
  listed: number;
  read: number;
  appended: string[];
  closed: number;
}

export interface FakeImapOptions {
  readonly summaries?: ImapEnvelopeSummary[];
  readonly message?: ImapFullMessage;
  readonly appendUid?: number;
}

export function makeImapFactory(
  state: FakeImapState,
  opts: FakeImapOptions = {},
): (settings: unknown) => Promise<ImapClient> {
  return async () => ({
    async connect() {},
    async close() {
      state.closed += 1;
    },
    async listMessages() {
      state.listed += 1;
      return opts.summaries ?? [];
    },
    async readMessage() {
      state.read += 1;
      if (!opts.message) throw new Error('not found');
      return opts.message;
    },
    async appendDraft(raw: string) {
      state.appended.push(raw);
      return { uid: opts.appendUid ?? 7, mailbox: 'Drafts' };
    },
  });
}

export interface FakeSmtpState {
  sent: SmtpMessage[];
  closed: number;
}

export function makeSmtpFactory(
  state: FakeSmtpState,
  result?: SmtpSendResult,
): (settings: unknown) => Promise<SmtpClient> {
  return async () => ({
    async connect() {},
    async close() {
      state.closed += 1;
    },
    async send(message: SmtpMessage) {
      state.sent.push(message);
      return result ?? { messageId: '<sent@example.com>', sentAt: '2024-01-01T00:00:00.000Z' };
    },
  });
}
