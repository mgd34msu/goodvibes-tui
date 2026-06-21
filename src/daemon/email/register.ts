// ---------------------------------------------------------------------------
// Email operator-method surface (IMAP / SMTP).
//
// Publishes: email.inbox.list, email.inbox.read, email.draft.create, email.send
//
// Wiring contract: integration calls registerEmailMethods(ctx) exactly once and
// retains the returned Unregister to tear the surface down.
//
// Credential posture: host/user/password and the SMTP From are resolved ONLY
// from the daemon credential store / config manager and are NEVER echoed into
// responses or logs. Sender addresses are reduced to a sha256 digest before
// logging (PII stripping). Draft bodies are encrypted at rest (AES-256-GCM)
// before being persisted to the operator SQLite store.
// ---------------------------------------------------------------------------

import type { ConfigManager } from '@pellux/goodvibes-sdk/platform/config';
import {
  OperatorError,
  createDaemonCredentialStore,
  createAtRestCipher,
  declareOperatorMethods,
  sha256First,
  type AtRestCipher,
  type DaemonCredentialStore,
  type DraftRecord,
  type OperatorContext,
  type Unregister,
} from '../operator/index.ts';
import { OperatorSqliteStore } from '../operator/index.ts';
import {
  ImapConnector,
  type ImapConnectionSettings,
  type ImapEnvelopeSummary,
  type ImapFullMessage,
} from './imap-connector.ts';
import {
  SmtpConnector,
  buildRfc5322Message,
  generateMessageId,
  type SmtpConnectionSettings,
  type SmtpMessage,
  type SmtpSendResult,
} from './smtp-connector.ts';

// ---------------------------------------------------------------------------
// Connector seams (production defaults + injectable for tests)
// ---------------------------------------------------------------------------

/** The IMAP surface the email methods depend on. ImapConnector satisfies this. */
export interface ImapClient {
  connect(): Promise<void>;
  close(): Promise<void>;
  listMessages(options: { limit: number; since?: string; unreadOnly: boolean }): Promise<ImapEnvelopeSummary[]>;
  readMessage(uid: number): Promise<ImapFullMessage>;
  appendDraft(rawMessage: string): Promise<{ uid: number; mailbox: string }>;
}

/** The SMTP surface the email methods depend on. SmtpConnector satisfies this. */
export interface SmtpClient {
  connect(): Promise<void>;
  close(): Promise<void>;
  send(message: SmtpMessage): Promise<SmtpSendResult>;
}

export interface EmailMethodsOptions {
  /** Override the IMAP client factory (used in tests). */
  readonly imapFactory?: (settings: ImapConnectionSettings) => Promise<ImapClient>;
  /** Override the SMTP client factory (used in tests). */
  readonly smtpFactory?: (settings: SmtpConnectionSettings) => Promise<SmtpClient>;
}

const defaultImapFactory = async (settings: ImapConnectionSettings): Promise<ImapClient> => {
  const imap = new ImapConnector(settings);
  await imap.connect();
  return imap;
};

const defaultSmtpFactory = async (settings: SmtpConnectionSettings): Promise<SmtpClient> => {
  const smtp = new SmtpConnector(settings);
  await smtp.connect();
  return smtp;
};

// ---------------------------------------------------------------------------
// Config resolution
// ---------------------------------------------------------------------------

const CONFIG_PREFIX = 'surfaces.email';
const DRAFT_STORE_FILE = 'email-drafts.sqlite';

type ConfigGetKey = Parameters<ConfigManager['get']>[0];

function readConfigString(
  configManager: OperatorContext['configManager'],
  key: string,
): string | undefined {
  const value = configManager.get(key as ConfigGetKey);
  if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  return undefined;
}

function readConfigNumber(
  configManager: OperatorContext['configManager'],
  key: string,
  fallback: number,
): number {
  const value = configManager.get(key as ConfigGetKey);
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function readConfigBool(
  configManager: OperatorContext['configManager'],
  key: string,
  fallback: boolean,
): boolean {
  const value = configManager.get(key as ConfigGetKey);
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    if (/^(true|1|yes)$/i.test(value.trim())) return true;
    if (/^(false|0|no)$/i.test(value.trim())) return false;
  }
  return fallback;
}

export interface ResolvedEmailSettings {
  readonly imap: ImapConnectionSettings;
  readonly smtp: SmtpConnectionSettings;
}

/**
 * Resolve all email settings. Secrets (passwords) come exclusively from the
 * daemon credential store; non-secret host/port/user/folder values come from
 * the config manager. Throws OperatorError(EMAIL_NOT_CONFIGURED) when required
 * fields are missing so callers receive a deterministic 400.
 */
export async function resolveEmailSettings(
  configManager: OperatorContext['configManager'],
  credentials: DaemonCredentialStore,
): Promise<ResolvedEmailSettings> {
  const imapHost = readConfigString(configManager, `${CONFIG_PREFIX}.imap.host`)
    ?? readConfigString(configManager, `${CONFIG_PREFIX}.host`);
  const smtpHost = readConfigString(configManager, `${CONFIG_PREFIX}.smtp.host`)
    ?? readConfigString(configManager, `${CONFIG_PREFIX}.host`);
  const user = readConfigString(configManager, `${CONFIG_PREFIX}.user`)
    ?? readConfigString(configManager, `${CONFIG_PREFIX}.username`);
  const from = readConfigString(configManager, `${CONFIG_PREFIX}.from`) ?? user;

  // Password: prefer an explicit secret key, fall back to the config-derived key.
  const password = (await credentials.resolveConfigSecret(`${CONFIG_PREFIX}.password`))
    ?? (await credentials.resolveConfigSecret(`${CONFIG_PREFIX}.imap.password`))
    ?? '';
  const smtpPassword = (await credentials.resolveConfigSecret(`${CONFIG_PREFIX}.smtp.password`))
    ?? password;

  if (!imapHost || !smtpHost || !user) {
    throw new OperatorError(
      'Email is not configured. Set surfaces.email.host, surfaces.email.user, and the email password secret.',
      'EMAIL_NOT_CONFIGURED',
      400,
    );
  }
  if (!password) {
    throw new OperatorError(
      'Email password secret is missing from the daemon credential store.',
      'EMAIL_CREDENTIALS_MISSING',
      400,
    );
  }

  const imap: ImapConnectionSettings = {
    host: imapHost,
    port: readConfigNumber(configManager, `${CONFIG_PREFIX}.imap.port`, 993),
    user,
    password,
    secure: readConfigBool(configManager, `${CONFIG_PREFIX}.imap.secure`, true),
    mailbox: readConfigString(configManager, `${CONFIG_PREFIX}.imap.mailbox`) ?? 'INBOX',
    draftsMailbox: readConfigString(configManager, `${CONFIG_PREFIX}.imap.draftsMailbox`) ?? 'Drafts',
  };
  const smtp: SmtpConnectionSettings = {
    host: smtpHost,
    port: readConfigNumber(configManager, `${CONFIG_PREFIX}.smtp.port`, 465),
    user,
    password: smtpPassword,
    secure: readConfigBool(configManager, `${CONFIG_PREFIX}.smtp.secure`, true),
    from: from ?? user,
  };
  return { imap, smtp };
}

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

function asRecord(body: unknown): Record<string, unknown> {
  if (typeof body !== 'object' || body === null) {
    throw new OperatorError('Request body must be an object', 'EMAIL_BAD_INPUT', 400);
  }
  return body as Record<string, unknown>;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new OperatorError(`Field '${field}' is required`, 'EMAIL_BAD_INPUT', 400);
  }
  return value;
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    throw new OperatorError(`Field '${field}' must be a string`, 'EMAIL_BAD_INPUT', 400);
  }
  return value;
}

function extractAddrSpec(entry: string): string {
  // RFC5322 name-addr form: "Display Name <addr@host>". The angle brackets
  // delimit the addr-spec, so extract the contents of the LAST <...> pair
  // rather than greedily stripping everything around stray '<'/'>' chars
  // (which could appear inside a quoted display name).
  const open = entry.lastIndexOf('<');
  if (open !== -1) {
    const close = entry.indexOf('>', open + 1);
    if (close !== -1) return entry.slice(open + 1, close).trim();
  }
  return entry.trim();
}

function validateEmailAddress(value: string, field: string): string {
  // Accept comma-separated lists; each entry must contain an '@'.
  const entries = value.split(',').map((s) => s.trim()).filter(Boolean);
  if (entries.length === 0 || entries.some((e) => !/.+@.+\..+/.test(extractAddrSpec(e)))) {
    throw new OperatorError(`Field '${field}' must be a valid email address`, 'EMAIL_BAD_INPUT', 400);
  }
  return value;
}

function clampLimit(value: unknown): number {
  if (value === undefined || value === null) return 10;
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) {
    throw new OperatorError("Field 'limit' must be a number", 'EMAIL_BAD_INPUT', 400);
  }
  return Math.min(100, Math.max(1, Math.floor(n)));
}

function validateIsoDate(value: unknown): string | undefined {
  const str = optionalString(value, 'since');
  if (str === undefined) return undefined;
  if (Number.isNaN(new Date(str).getTime())) {
    throw new OperatorError("Field 'since' must be an ISO-8601 date", 'EMAIL_BAD_INPUT', 400);
  }
  return str;
}

function requireUid(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    throw new OperatorError("Field 'uid' must be a positive integer", 'EMAIL_BAD_INPUT', 400);
  }
  return n;
}

// ---------------------------------------------------------------------------
// Logging helpers (PII-safe)
// ---------------------------------------------------------------------------

/** Reduce a sender/recipient address to a stable, non-reversible digest. */
function addressDigest(address: string): string {
  return sha256First(address.toLowerCase().trim(), 16);
}

// ---------------------------------------------------------------------------
// Output shaping (response contracts)
// ---------------------------------------------------------------------------

interface InboxListResponse {
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

interface InboxReadResponse {
  uid: number;
  from: string;
  subject: string;
  date: string;
  messageId: string;
  bodyText: string;
  bodyHtml?: string;
  attachments?: Array<{ filename: string; contentType: string; sizeBytes: number }>;
}

interface DraftCreateResponse {
  uid: number;
  draftId: string;
}

interface SendResponse {
  messageId: string;
  sentAt: string;
}

function toListMessage(m: ImapEnvelopeSummary): InboxListResponse['messages'][number] {
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

function toReadMessage(m: ImapFullMessage): InboxReadResponse {
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

// ---------------------------------------------------------------------------
// Draft-at-rest persistence
// ---------------------------------------------------------------------------

const DRAFT_SCHEMA: string[] = [
  `CREATE TABLE IF NOT EXISTS email_drafts (
    id TEXT PRIMARY KEY,
    surface TEXT NOT NULL,
    account_id TEXT,
    conversation_id TEXT,
    recipient TEXT,
    subject TEXT,
    body_ciphertext TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    metadata TEXT
  );`,
];

async function persistDraftRecord(
  store: OperatorSqliteStore,
  cipher: AtRestCipher,
  record: Omit<DraftRecord, 'bodyCiphertext'> & { plaintextBody: string },
): Promise<void> {
  const bodyCiphertext = await cipher.encrypt(record.plaintextBody);
  store.run(
    `INSERT OR REPLACE INTO email_drafts
       (id, surface, account_id, conversation_id, recipient, subject,
        body_ciphertext, status, created_at, updated_at, metadata)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      record.id,
      record.surface,
      record.accountId ?? null,
      record.conversationId ?? null,
      record.to ?? null,
      record.subject ?? null,
      bodyCiphertext,
      record.status,
      record.createdAt,
      record.updatedAt,
      record.metadata ? JSON.stringify(record.metadata) : null,
    ],
  );
  await store.save();
}

// ---------------------------------------------------------------------------
// Surface registration
// ---------------------------------------------------------------------------

const INBOX_LIST_INPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    limit: { type: 'number', minimum: 1, maximum: 100, default: 10 },
    since: { type: 'string', format: 'date-time' },
    unreadOnly: { type: 'boolean', default: true },
  },
};

const INBOX_LIST_OUTPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  required: ['messages', 'total'],
  properties: {
    messages: {
      type: 'array',
      items: {
        type: 'object',
        required: ['uid', 'from', 'subject', 'date', 'unread', 'bodyPreview', 'messageId'],
        properties: {
          uid: { type: 'number' },
          from: { type: 'string' },
          subject: { type: 'string' },
          date: { type: 'string' },
          unread: { type: 'boolean' },
          bodyPreview: { type: 'string' },
          messageId: { type: 'string' },
        },
      },
    },
    total: { type: 'number' },
  },
};

const INBOX_READ_INPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['uid'],
  properties: { uid: { type: 'number', minimum: 1 } },
};

const INBOX_READ_OUTPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  required: ['uid', 'from', 'subject', 'date', 'messageId', 'bodyText'],
  properties: {
    uid: { type: 'number' },
    from: { type: 'string' },
    subject: { type: 'string' },
    date: { type: 'string' },
    messageId: { type: 'string' },
    bodyText: { type: 'string' },
    bodyHtml: { type: 'string' },
    attachments: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          filename: { type: 'string' },
          contentType: { type: 'string' },
          sizeBytes: { type: 'number' },
        },
      },
    },
  },
};

const DRAFT_CREATE_INPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['to', 'subject', 'body', 'confirm'],
  properties: {
    to: { type: 'string' },
    subject: { type: 'string' },
    body: { type: 'string' },
    inReplyTo: { type: 'string' },
    references: { type: 'string' },
    confirm: { const: true },
  },
};

const DRAFT_CREATE_OUTPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  required: ['uid', 'draftId'],
  properties: {
    uid: { type: 'number' },
    draftId: { type: 'string' },
  },
};

const SEND_INPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['to', 'subject', 'body', 'confirm'],
  properties: {
    to: { type: 'string' },
    subject: { type: 'string' },
    body: { type: 'string' },
    inReplyTo: { type: 'string' },
    confirm: { const: true },
  },
};

const SEND_OUTPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  required: ['messageId', 'sentAt'],
  properties: {
    messageId: { type: 'string' },
    sentAt: { type: 'string' },
  },
};

/**
 * Register the email operator-method surface against the catalog in ctx.
 * Returns an Unregister that removes every method.
 */
export function registerEmailMethods(
  ctx: OperatorContext,
  options: EmailMethodsOptions = {},
): Unregister {
  const credentials = createDaemonCredentialStore(ctx.secrets);
  const cipher = createAtRestCipher(credentials);
  const imapFactory = options.imapFactory ?? defaultImapFactory;
  const smtpFactory = options.smtpFactory ?? defaultSmtpFactory;

  // Lazily-initialized draft store (only touched by email.draft.create).
  let draftStorePromise: Promise<OperatorSqliteStore> | null = null;
  const getDraftStore = (): Promise<OperatorSqliteStore> => {
    if (!draftStorePromise) {
      const store = new OperatorSqliteStore({
        workingDirectory: ctx.workingDirectory,
        fileName: DRAFT_STORE_FILE,
        schema: DRAFT_SCHEMA,
      });
      draftStorePromise = store.init().then(() => store);
    }
    return draftStorePromise;
  };

  const withImap = async <T>(fn: (imap: ImapClient) => Promise<T>): Promise<T> => {
    const { imap: settings } = await resolveEmailSettings(ctx.configManager, credentials);
    const imap = await imapFactory(settings);
    try {
      return await fn(imap);
    } finally {
      await imap.close();
    }
  };

  const teardown = declareOperatorMethods(ctx, [
    // ---- email.inbox.list --------------------------------------------------
    {
      descriptor: {
        id: 'email.inbox.list',
        title: 'List inbox messages',
        description: 'List recent IMAP inbox messages (read-only; does not mark messages as read).',
        category: 'email',
        source: 'daemon',
        access: 'operator',
        transport: ['ws', 'internal'],
        scopes: ['email:read'],
        effect: 'read-only-network',
        inputSchema: INBOX_LIST_INPUT_SCHEMA,
        outputSchema: INBOX_LIST_OUTPUT_SCHEMA,
      },
      handler: async ({ body }): Promise<InboxListResponse> => {
        const input = asRecord(body ?? {});
        const limit = clampLimit(input.limit);
        const since = validateIsoDate(input.since);
        const unreadOnly = input.unreadOnly === undefined ? true : input.unreadOnly === true;
        const messages = await withImap((imap) =>
          imap.listMessages({ limit, since, unreadOnly }),
        );
        ctx.logger.info('email.inbox.list', {
          count: messages.length,
          unreadOnly,
          senders: messages.map((m) => addressDigest(m.from)),
        });
        return { messages: messages.map(toListMessage), total: messages.length };
      },
    },
    // ---- email.inbox.read --------------------------------------------------
    {
      descriptor: {
        id: 'email.inbox.read',
        title: 'Read inbox message',
        description: 'Fetch a full IMAP message body by UID using BODY.PEEK (does not mark as read).',
        category: 'email',
        source: 'daemon',
        access: 'operator',
        transport: ['ws', 'internal'],
        scopes: ['email:read'],
        effect: 'read-only-network',
        inputSchema: INBOX_READ_INPUT_SCHEMA,
        outputSchema: INBOX_READ_OUTPUT_SCHEMA,
      },
      handler: async ({ body }): Promise<InboxReadResponse> => {
        const input = asRecord(body);
        const uid = requireUid(input.uid);
        const message = await withImap((imap) => imap.readMessage(uid));
        ctx.logger.info('email.inbox.read', {
          uid,
          from: addressDigest(message.from),
          hasHtml: Boolean(message.bodyHtml),
          attachments: message.attachments?.length ?? 0,
        });
        return toReadMessage(message);
      },
    },
    // ---- email.draft.create ------------------------------------------------
    {
      descriptor: {
        id: 'email.draft.create',
        title: 'Create email draft',
        description: 'Append a draft message to the IMAP Drafts mailbox. Requires confirmation.',
        category: 'email',
        source: 'daemon',
        access: 'operator',
        transport: ['ws', 'internal'],
        scopes: ['email:write'],
        effect: 'confirmed-effect',
        confirm: true,
        inputSchema: DRAFT_CREATE_INPUT_SCHEMA,
        outputSchema: DRAFT_CREATE_OUTPUT_SCHEMA,
      },
      handler: async ({ body }): Promise<DraftCreateResponse> => {
        const input = asRecord(body);
        const to = validateEmailAddress(requireString(input.to, 'to'), 'to');
        const subject = requireString(input.subject, 'subject');
        const draftBody = requireString(input.body, 'body');
        const inReplyTo = optionalString(input.inReplyTo, 'inReplyTo');
        const references = optionalString(input.references, 'references');

        const { smtp } = await resolveEmailSettings(ctx.configManager, credentials);
        const messageId = generateMessageId(smtp.from);
        const raw = buildRfc5322Message({
          from: smtp.from,
          to,
          subject,
          body: draftBody,
          messageId,
          date: new Date(),
          ...(inReplyTo ? { inReplyTo } : {}),
          ...(references ? { references } : {}),
        });
        const appended = await withImap((imap) => imap.appendDraft(raw));

        const now = new Date().toISOString();
        const draftId = messageId.replace(/[<>]/g, '');
        const store = await getDraftStore();
        await persistDraftRecord(store, cipher, {
          id: draftId,
          surface: 'email',
          to,
          subject,
          plaintextBody: draftBody,
          status: 'draft',
          createdAt: now,
          updatedAt: now,
          metadata: { uid: appended.uid, mailbox: appended.mailbox, messageId },
        });

        ctx.logger.info('email.draft.create', {
          uid: appended.uid,
          draftId,
          recipient: addressDigest(to),
        });
        return { uid: appended.uid, draftId };
      },
    },
    // ---- email.send --------------------------------------------------------
    {
      descriptor: {
        id: 'email.send',
        title: 'Send email',
        description: 'Send an email via SMTP. Irreversible external effect — requires confirmation.',
        category: 'email',
        source: 'daemon',
        access: 'operator',
        transport: ['ws', 'internal'],
        scopes: ['email:send'],
        effect: 'confirmed-effect',
        confirm: true,
        inputSchema: SEND_INPUT_SCHEMA,
        outputSchema: SEND_OUTPUT_SCHEMA,
      },
      handler: async ({ body }): Promise<SendResponse> => {
        const input = asRecord(body);
        const to = validateEmailAddress(requireString(input.to, 'to'), 'to');
        const subject = requireString(input.subject, 'subject');
        const sendBody = requireString(input.body, 'body');
        const inReplyTo = optionalString(input.inReplyTo, 'inReplyTo');

        const { smtp: settings } = await resolveEmailSettings(ctx.configManager, credentials);
        const smtp = await smtpFactory(settings);
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
        ctx.logger.info('email.send', {
          messageId: result.messageId,
          sentAt: result.sentAt,
          recipient: addressDigest(to),
        });
        return result;
      },
    },
  ]);

  return () => {
    teardown();
    if (draftStorePromise) {
      void draftStorePromise.then((store) => store.close()).catch(() => undefined);
      draftStorePromise = null;
    }
  };
}
