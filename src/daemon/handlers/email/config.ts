// ---------------------------------------------------------------------------
// Email settings resolution + connector seams.
//
// Non-secret host/port/user/folder values come from the config manager; the
// IMAP/SMTP passwords come EXCLUSIVELY from the daemon credential store. No
// secret value is ever echoed into a response or logged. Throws
// HandlerError(EMAIL_NOT_CONFIGURED / EMAIL_CREDENTIALS_MISSING, 400) when a
// required field is missing so callers get a deterministic failure.
// ---------------------------------------------------------------------------

import type { ConfigManager } from '@pellux/goodvibes-sdk/platform/config';
import type { HandlerContext } from '../context.ts';
import type { DaemonCredentialStore } from '../credentials.ts';
import { HandlerError } from '../errors.ts';
import {
  ImapConnector,
  type ImapConnectionSettings,
  type ImapEnvelopeSummary,
  type ImapFullMessage,
} from './imap-connector.ts';
import {
  SmtpConnector,
  type SmtpConnectionSettings,
  type SmtpMessage,
  type SmtpSendResult,
} from './smtp-connector.ts';

export const CONFIG_PREFIX = 'surfaces.email';

type ConfigManagerSlice = Pick<ConfigManager, 'get' | 'getCategory'>;
type ConfigGetKey = Parameters<ConfigManager['get']>[0];

/**
 * Read a config value, treating an absent SECTION as an absent value.
 *
 * `surfaces.email.*` is not a CONFIG_SCHEMA section, so on an installation
 * where nothing has ever been set there, `ConfigManager.get()` does not return
 * undefined — it throws `Invalid config path: section 'surfaces.email' does not
 * exist`. Unguarded, that turned "mail has not been set up" into an opaque
 * config-path error surfaced to whoever called the verb, instead of the
 * EMAIL_NOT_CONFIGURED this module exists to return.
 *
 * Only the section-shaped miss is swallowed; the value handling below is
 * unchanged, so a value that IS present behaves exactly as before.
 */
function readConfigValue(configManager: ConfigManagerSlice, key: string): unknown {
  try {
    return configManager.get(key as ConfigGetKey);
  } catch {
    return undefined;
  }
}

function readConfigString(configManager: ConfigManagerSlice, key: string): string | undefined {
  const value = readConfigValue(configManager, key);
  if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  return undefined;
}

function readConfigNumber(configManager: ConfigManagerSlice, key: string, fallback: number): number {
  const value = readConfigValue(configManager, key);
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function readConfigBool(configManager: ConfigManagerSlice, key: string, fallback: boolean): boolean {
  const value = readConfigValue(configManager, key);
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
 * Resolve all email settings. Passwords are read only via the daemon credential
 * store (`resolveConfigSecret`); everything else comes from the config manager.
 */
export async function resolveEmailSettings(
  configManager: ConfigManagerSlice,
  credentials: DaemonCredentialStore,
): Promise<ResolvedEmailSettings> {
  const imapHost = readConfigString(configManager, `${CONFIG_PREFIX}.imap.host`)
    ?? readConfigString(configManager, `${CONFIG_PREFIX}.host`);
  const smtpHost = readConfigString(configManager, `${CONFIG_PREFIX}.smtp.host`)
    ?? readConfigString(configManager, `${CONFIG_PREFIX}.host`);
  const user = readConfigString(configManager, `${CONFIG_PREFIX}.user`)
    ?? readConfigString(configManager, `${CONFIG_PREFIX}.username`);
  const from = readConfigString(configManager, `${CONFIG_PREFIX}.from`) ?? user;

  // Password: prefer an explicit IMAP/SMTP secret key, fall back to the shared one.
  const password = (await credentials.resolveConfigSecret(`${CONFIG_PREFIX}.password`))
    ?? (await credentials.resolveConfigSecret(`${CONFIG_PREFIX}.imap.password`))
    ?? '';
  const smtpPassword = (await credentials.resolveConfigSecret(`${CONFIG_PREFIX}.smtp.password`))
    ?? password;

  if (!imapHost || !smtpHost || !user) {
    throw new HandlerError(
      'Email is not configured. Set surfaces.email.host, surfaces.email.user, and the email password secret.',
      'EMAIL_NOT_CONFIGURED',
      400,
    );
  }
  if (!password) {
    throw new HandlerError(
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
// Connector seams (production defaults + injectable for tests)
// ---------------------------------------------------------------------------

/** The IMAP surface the email handlers depend on. ImapConnector satisfies this. */
export interface ImapClient {
  connect(): Promise<void>;
  close(): Promise<void>;
  listMessages(options: { limit: number; since?: string; unreadOnly: boolean }): Promise<ImapEnvelopeSummary[]>;
  readMessage(uid: number): Promise<ImapFullMessage>;
  appendDraft(rawMessage: string): Promise<{ uid: number; mailbox: string }>;
}

/** The SMTP surface the email handlers depend on. SmtpConnector satisfies this. */
export interface SmtpClient {
  connect(): Promise<void>;
  close(): Promise<void>;
  send(message: SmtpMessage): Promise<SmtpSendResult>;
}

export type ImapFactory = (settings: ImapConnectionSettings) => Promise<ImapClient>;
export type SmtpFactory = (settings: SmtpConnectionSettings) => Promise<SmtpClient>;

export interface EmailMethodsOptions {
  /** Override the IMAP client factory (used in tests). */
  readonly imapFactory?: ImapFactory;
  /** Override the SMTP client factory (used in tests). */
  readonly smtpFactory?: SmtpFactory;
  /** Override the working directory used for the at-rest draft store. */
  readonly workingDirectory?: string;
}

export const defaultImapFactory: ImapFactory = async (settings) => {
  const imap = new ImapConnector(settings);
  await imap.connect();
  return imap;
};

export const defaultSmtpFactory: SmtpFactory = async (settings) => {
  const smtp = new SmtpConnector(settings);
  await smtp.connect();
  return smtp;
};
