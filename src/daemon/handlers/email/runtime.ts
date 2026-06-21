// ---------------------------------------------------------------------------
// Shared email runtime: credential-backed settings resolution, the IMAP/SMTP
// connector lifecycle helpers, and the encrypt-at-rest draft store. Built once
// by index.ts and threaded into the read/write handler builders so the surface
// has a single owner for its stateful resources (lazy store, AES key).
// ---------------------------------------------------------------------------

import type { HandlerContext, HandlerLogger } from '../context.ts';
import type { DaemonCredentialStore, AtRestCipher } from '../credentials.ts';
import { createAtRestCipher } from '../credentials.ts';
import { HandlerSqliteStore } from '../sqlite-store.ts';
import {
  resolveEmailSettings,
  defaultImapFactory,
  defaultSmtpFactory,
  type EmailMethodsOptions,
  type ImapClient,
  type ImapFactory,
  type SmtpClient,
  type SmtpFactory,
} from './config.ts';

const DRAFT_STORE_FILE = 'email-drafts.sqlite';

const DRAFT_SCHEMA: string[] = [
  `CREATE TABLE IF NOT EXISTS email_drafts (
    id TEXT PRIMARY KEY,
    surface TEXT NOT NULL,
    recipient TEXT,
    subject TEXT,
    body_ciphertext TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    metadata TEXT
  );`,
];

/** A persisted draft. The plaintext body is NEVER stored — only its ciphertext. */
export interface DraftPersistInput {
  readonly id: string;
  readonly to: string;
  readonly subject: string;
  readonly plaintextBody: string;
  readonly status: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly metadata?: Record<string, unknown>;
}

/**
 * Owner of the email surface's stateful resources. Read and write handler
 * builders receive this instead of reaching into the catalog/context directly.
 */
export interface EmailRuntime {
  readonly logger: HandlerLogger;
  /** Run `fn` with a connected IMAP client; always closes it afterward. */
  withImap<T>(fn: (imap: ImapClient) => Promise<T>): Promise<T>;
  /** Open (or reuse) a connected SMTP client. Caller closes it. */
  openSmtp(): Promise<SmtpClient>;
  /** Resolve the SMTP From / Message-ID domain context without exposing secrets. */
  smtpFrom(): Promise<string>;
  /** Encrypt + persist a draft record (body stored only as ciphertext). */
  persistDraft(input: DraftPersistInput): Promise<void>;
  /** Tear down lazily-created resources (draft store handle). */
  dispose(): void;
}

export function createEmailRuntime(
  ctx: HandlerContext,
  options: EmailMethodsOptions = {},
): EmailRuntime {
  const credentials: DaemonCredentialStore = ctx.credentials;
  const cipher: AtRestCipher = createAtRestCipher(credentials);
  const imapFactory: ImapFactory = options.imapFactory ?? defaultImapFactory;
  const smtpFactory: SmtpFactory = options.smtpFactory ?? defaultSmtpFactory;
  const workingDirectory = options.workingDirectory ?? ctx.workingDirectory;

  let draftStorePromise: Promise<HandlerSqliteStore> | null = null;
  const getDraftStore = (): Promise<HandlerSqliteStore> => {
    if (!draftStorePromise) {
      const store = new HandlerSqliteStore({
        workingDirectory,
        fileName: DRAFT_STORE_FILE,
        schema: DRAFT_SCHEMA,
      });
      draftStorePromise = store.init().then(() => store);
    }
    return draftStorePromise;
  };

  return {
    logger: ctx.logger,
    async withImap<T>(fn: (imap: ImapClient) => Promise<T>): Promise<T> {
      const { imap: settings } = await resolveEmailSettings(ctx.configManager, credentials);
      const imap = await imapFactory(settings);
      try {
        return await fn(imap);
      } finally {
        await imap.close();
      }
    },
    async openSmtp(): Promise<SmtpClient> {
      const { smtp: settings } = await resolveEmailSettings(ctx.configManager, credentials);
      return smtpFactory(settings);
    },
    async smtpFrom(): Promise<string> {
      const { smtp } = await resolveEmailSettings(ctx.configManager, credentials);
      return smtp.from;
    },
    async persistDraft(input: DraftPersistInput): Promise<void> {
      const bodyCiphertext = await cipher.encrypt(input.plaintextBody);
      const store = await getDraftStore();
      store.run(
        `INSERT OR REPLACE INTO email_drafts
           (id, surface, recipient, subject, body_ciphertext, status,
            created_at, updated_at, metadata)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          input.id,
          'email',
          input.to,
          input.subject,
          bodyCiphertext,
          input.status,
          input.createdAt,
          input.updatedAt,
          input.metadata ? JSON.stringify(input.metadata) : null,
        ],
      );
      await store.save();
    },
    dispose(): void {
      if (draftStorePromise) {
        void draftStorePromise.then((store) => store.close()).catch(() => undefined);
        draftStorePromise = null;
      }
    },
  };
}
