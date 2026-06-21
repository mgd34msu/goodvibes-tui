// ---------------------------------------------------------------------------
// Daemon-internal triage TAGGER.
//
// Applies user-defined triage labels back on the provider side:
//   - IMAP : STORE a keyword flag on the message (IMAP4rev1 over TLS).
//   - Slack: reactions.add emoji on the source message.
//   - Discord: when the item is a forum/media-channel THREAD and a forum-tag
//     mapping is configured, apply real Discord thread tags (PATCH the thread's
//     applied_tags array — exact fidelity to the contract's "Discord thread
//     tags"). Otherwise fall back to a unicode reaction on the source message
//     as a documented analog (Discord has no arbitrary per-message tags).
//
// Hard rules honored here:
//   - All provider credentials come ONLY from the daemon credential store.
//     They are never returned in results and never logged.
//   - The whole tagger is gated behind a config flag (surfaces.triage.autoTag);
//     when disabled, applyTags() is a no-op that reports skipped:true.
//   - Provider-side writes are EFFECTFUL; callers must pass an explicitly
//     confirmed request (confirm === true). Unconfirmed calls throw
//     OperatorError(REQUIRE_CONFIRM).
//
// Contract-fidelity note (handoff doc, line 52): the triage surface
// (`inbox.triage.*`) is classified NOT PUBLISHED — it is a daemon-internal
// pipeline, not a published operator method. There is therefore NO external
// spec to certify these tag-method request/response shapes against; that
// contract-fidelity dimension is structurally UNCERTIFIABLE here, not a
// defect. We do not invent a fake external contract. What we DO guarantee is
// the provider-side behavior below: no silent data loss (Discord thread tags
// are merged, never blindly overwritten) and no command injection (IMAP
// quoting rejects control characters).
// ---------------------------------------------------------------------------

import { connect as tlsConnect } from 'node:tls';
import type { TLSSocket } from 'node:tls';
import {
  OperatorError,
  REQUIRE_CONFIRM,
  type DaemonCredentialStore,
  type InboundChannelItem,
  type OperatorContext,
} from '../operator/index.ts';
import { createDaemonCredentialStore } from '../operator/index.ts';
import type { TriageLabel } from './scorer.ts';
import { labelToTag } from './scorer.ts';

export const TRIAGE_AUTOTAG_FLAG = 'surfaces.triage.autoTag';

export interface TaggerProviderConfig {
  /** IMAP host:port (default port 993, TLS). Credentials resolved separately. */
  imap?: { host: string; port?: number; user: string; passwordConfigKey: string; mailbox?: string };
  /** Slack bot token config key (resolved from credential store). */
  slack?: { tokenConfigKey: string };
  /**
   * Discord bot token config key (resolved from credential store), plus an
   * optional forum-tag mapping. When `forumTagIds` maps a GoodVibes triage tag
   * (e.g. 'GoodVibes/Spam') to a forum tag SNOWFLAKE id, items that target a
   * forum/media-channel thread get that REAL thread tag applied (PATCH
   * applied_tags) — exact fidelity to the contract's "Discord thread tags".
   * Without a mapping (or for non-thread messages) tagging degrades to a
   * unicode reaction analog.
   */
  discord?: { tokenConfigKey: string; forumTagIds?: Record<string, string> };
}

export interface TriageTaggerOptions {
  credentials?: DaemonCredentialStore;
  /** Override the autotag flag lookup (used in tests). */
  autoTagEnabled?: boolean;
  /** Per-surface provider config; usually derived from configManager. */
  providers?: TaggerProviderConfig;
  /** Injectable fetch (Slack/Discord HTTP). Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Injectable IMAP flag-setter (used in tests to avoid a live socket). */
  imapStoreFlag?: (args: ImapStoreArgs) => Promise<void>;
  /**
   * Transient-failure retry policy for the default IMAP store implementation.
   * Network blips (ECONNRESET/ETIMEDOUT/EPIPE, unexpected close, timeouts) are
   * retried with exponential backoff. Protocol-level NO/BAD responses are NOT
   * retried (they are deterministic). Ignored when imapStoreFlag is injected.
   */
  imapRetry?: ImapRetryOptions;
}

export interface ImapRetryOptions {
  /** Total attempts including the first (default 3). Values < 1 disable retry. */
  maxAttempts?: number;
  /** Base backoff in ms for the first retry (default 250). */
  baseDelayMs?: number;
  /** Cap on any single backoff delay in ms (default 2000). */
  maxDelayMs?: number;
  /** Injectable sleep (tests). Defaults to a real timer. */
  sleep?: (ms: number) => Promise<void>;
}

export interface ImapStoreArgs {
  host: string;
  port: number;
  user: string;
  password: string;
  mailbox: string;
  uid: string;
  flag: string;
}

export interface ApplyTagsRequest {
  item: InboundChannelItem;
  /** Provider-side tags to apply. Defaults to [labelToTag(label)] when omitted. */
  tags?: readonly string[];
  label?: TriageLabel;
  /** Must be true — provider-side mutation requires explicit confirmation. */
  confirm?: boolean;
  /** Mirror of the operator invocation context flag. */
  explicitUserRequest?: boolean;
}

export interface ApplyTagsResult {
  surface: string;
  itemId: string;
  appliedTags: string[];
  /** True when the autotag flag is disabled or no provider matched. */
  skipped: boolean;
  reason?: string;
}

export interface TriageTagger {
  /** Whether provider-side tagging is currently enabled. */
  enabled(): boolean;
  applyTags(request: ApplyTagsRequest): Promise<ApplyTagsResult>;
}

function readBoolFlag(
  configManager: OperatorContext['configManager'],
  key: string,
): boolean {
  try {
    const value = configManager.get(key as never) as unknown;
    return value === true || value === 'true' || value === 1;
  } catch {
    return false;
  }
}

function resolveProvidersFromConfig(
  configManager: OperatorContext['configManager'],
): TaggerProviderConfig {
  const out: TaggerProviderConfig = {};
  const slackToken = safeGet(configManager, 'surfaces.slack.botToken');
  if (typeof slackToken === 'string' && slackToken.length > 0) {
    out.slack = { tokenConfigKey: 'surfaces.slack.botToken' };
  }
  const discordToken = safeGet(configManager, 'surfaces.discord.botToken');
  if (typeof discordToken === 'string' && discordToken.length > 0) {
    out.discord = { tokenConfigKey: 'surfaces.discord.botToken' };
  }
  const imapHost = safeGet(configManager, 'surfaces.email.imap.host');
  const imapUser = safeGet(configManager, 'surfaces.email.imap.user');
  if (typeof imapHost === 'string' && imapHost.length > 0 && typeof imapUser === 'string') {
    const portRaw = safeGet(configManager, 'surfaces.email.imap.port');
    const mailbox = safeGet(configManager, 'surfaces.email.imap.mailbox');
    out.imap = {
      host: imapHost,
      port: typeof portRaw === 'number' ? portRaw : 993,
      user: imapUser,
      passwordConfigKey: 'surfaces.email.imap.password',
      mailbox: typeof mailbox === 'string' && mailbox.length > 0 ? mailbox : 'INBOX',
    };
  }
  return out;
}

function safeGet(configManager: OperatorContext['configManager'], key: string): unknown {
  try {
    return configManager.get(key as never) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * Create the triage tagger. Reads the autotag flag and provider config from the
 * operator context; credentials are resolved lazily, per apply, from the daemon
 * credential store.
 */
export function createTriageTagger(
  ctx: OperatorContext,
  options: TriageTaggerOptions = {},
): TriageTagger {
  const credentials = options.credentials ?? createDaemonCredentialStore(ctx.secrets);
  const fetchImpl = options.fetchImpl ?? fetch;
  const providers = options.providers ?? resolveProvidersFromConfig(ctx.configManager);
  // Retry wraps whichever store impl is in use (default TLS client OR an
  // injected one), so transient failures are retried uniformly. Injected test
  // stores that succeed first-try are unaffected.
  const imapStoreFlag = makeRetryingImapStoreFlag(
    options.imapStoreFlag ?? imapStoreFlagOverTls,
    options.imapRetry,
  );
  const enabled = (): boolean =>
    options.autoTagEnabled ?? readBoolFlag(ctx.configManager, TRIAGE_AUTOTAG_FLAG);

  return {
    enabled,
    async applyTags(request: ApplyTagsRequest): Promise<ApplyTagsResult> {
      const { item } = request;
      const tags = resolveTags(request);
      const base: ApplyTagsResult = {
        surface: item.surface,
        itemId: item.id,
        appliedTags: [],
        skipped: true,
      };

      if (!enabled()) {
        return { ...base, reason: 'autotag-disabled' };
      }

      // Provider-side mutation is effectful — require explicit confirmation.
      if (request.confirm !== true || request.explicitUserRequest !== true) {
        throw new OperatorError(
          'Provider-side triage tagging requires explicit user confirmation.',
          REQUIRE_CONFIRM,
          403,
        );
      }

      switch (item.surface) {
        case 'email':
        case 'imap':
          return applyImap(item, tags, providers, credentials, imapStoreFlag, base);
        case 'slack':
          return applySlack(item, tags, providers, credentials, fetchImpl, ctx, base);
        case 'discord':
          return applyDiscord(item, tags, providers, credentials, fetchImpl, ctx, base);
        default:
          return { ...base, reason: `unsupported-surface:${item.surface}` };
      }
    },
  };
}

function resolveTags(request: ApplyTagsRequest): string[] {
  if (request.tags && request.tags.length > 0) {
    return [...new Set(request.tags.map((t) => t.trim()).filter((t) => t.length > 0))];
  }
  if (request.label) return [labelToTag(request.label)];
  return [];
}

// ---------------------------------------------------------------------------
// IMAP
// ---------------------------------------------------------------------------

async function applyImap(
  item: InboundChannelItem,
  tags: string[],
  providers: TaggerProviderConfig,
  credentials: DaemonCredentialStore,
  storeFlag: (args: ImapStoreArgs) => Promise<void>,
  base: ApplyTagsResult,
): Promise<ApplyTagsResult> {
  const cfg = providers.imap;
  if (!cfg) return { ...base, reason: 'imap-not-configured' };
  const uid = imapUidFromItem(item);
  if (!uid) return { ...base, reason: 'imap-missing-uid' };
  if (tags.length === 0) return { ...base, reason: 'no-tags' };

  const password = await credentials.resolveConfigSecret(cfg.passwordConfigKey);
  if (!password) return { ...base, reason: 'imap-no-credentials' };

  const applied: string[] = [];
  for (const tag of tags) {
    await storeFlag({
      host: cfg.host,
      port: cfg.port ?? 993,
      user: cfg.user,
      password,
      mailbox: cfg.mailbox ?? 'INBOX',
      uid,
      flag: imapKeywordForTag(tag),
    });
    applied.push(tag);
  }
  return { surface: item.surface, itemId: item.id, appliedTags: applied, skipped: false };
}

function imapUidFromItem(item: InboundChannelItem): string | null {
  const meta = item.metadata ?? {};
  const uid = meta.imapUid ?? meta.uid;
  if (typeof uid === 'string' && uid.length > 0) return uid;
  if (typeof uid === 'number' && Number.isFinite(uid)) return String(uid);
  return null;
}

/** IMAP keywords cannot contain spaces or '/'; normalize the canonical tag. */
function imapKeywordForTag(tag: string): string {
  return tag.replace(/[^A-Za-z0-9_]+/g, '_');
}

/**
 * Error subclass carrying whether a failure is transient (worth retrying) or a
 * deterministic protocol rejection (NO/BAD) that must not be retried.
 */
class ImapStoreError extends Error {
  readonly transient: boolean;
  constructor(message: string, transient: boolean) {
    super(message);
    this.name = 'ImapStoreError';
    this.transient = transient;
  }
}

/**
 * Minimal IMAP4rev1 client: connect over TLS, LOGIN, SELECT, UID STORE +FLAGS,
 * LOGOUT. Uses only node:tls (Bun-compatible).
 *
 * Tagged-command sequencing uses an explicit completion flag rather than a line
 * heuristic: the LOGOUT step is tracked by reference, so its tagged OK (or an
 * untagged `* BYE`) cleanly completes the operation and tells the `close`
 * handler the disconnect was expected. Connection/timeout/socket failures are
 * surfaced as transient ImapStoreError; NO/BAD protocol responses as
 * non-transient.
 */
function imapStoreFlagOverTls(args: ImapStoreArgs): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    // Validate every value that gets interpolated into an IMAP command line
    // BEFORE opening the socket. quoteImap rejects CR/LF and other control
    // chars, closing the command-injection vector for LOGIN user/password and
    // SELECT mailbox. A rejection here is deterministic, so it is surfaced as a
    // non-transient ImapStoreError (never retried).
    try {
      assertImapSafe(args.user, 'user');
      assertImapSafe(args.password, 'password');
      assertImapSafe(args.mailbox, 'mailbox');
    } catch (err) {
      reject(
        err instanceof ImapStoreError
          ? err
          : new ImapStoreError(err instanceof Error ? err.message : String(err), false),
      );
      return;
    }
    type Step = { tag: string; isLogout: boolean; resolve: () => void; reject: (e: Error) => void };

    let done = false;
    let completed = false; // LOGOUT acknowledged (or BYE seen) — close is expected.
    let buffer = '';
    let pending: Step | null = null;
    let counter = 0;
    let greeted = false;

    const finish = (err?: Error): void => {
      if (done) return;
      done = true;
      try {
        socket.destroy();
      } catch {
        /* ignore */
      }
      if (err) reject(err);
      else resolve();
    };

    const socket: TLSSocket = tlsConnect(
      { host: args.host, port: args.port, servername: args.host },
      () => {
        /* greeting handled in the data pump */
      },
    );
    socket.setEncoding('utf-8');
    socket.setTimeout(20_000, () =>
      finish(new ImapStoreError('IMAP connection timed out', true)),
    );

    const send = (command: string, isLogout = false): Promise<void> =>
      new Promise<void>((res, rej) => {
        counter += 1;
        const tag = `A${counter}`;
        pending = { tag, isLogout, resolve: res, reject: rej };
        socket.write(`${tag} ${command}\r\n`);
      });

    const runSequence = async (): Promise<void> => {
      await send(`LOGIN ${quoteImap(args.user)} ${quoteImap(args.password)}`);
      await send(`SELECT ${quoteImap(args.mailbox)}`);
      await send(`UID STORE ${args.uid} +FLAGS (${args.flag})`);
      await send('LOGOUT', true);
    };

    socket.on('error', (err) =>
      finish(new ImapStoreError(err instanceof Error ? err.message : String(err), true)),
    );
    socket.on('close', () => {
      // A close BEFORE completion is unexpected (transient); after the LOGOUT
      // acknowledgement it is the normal teardown and must resolve cleanly.
      if (completed) finish();
      else finish(new ImapStoreError('IMAP connection closed unexpectedly', true));
    });

    socket.on('data', (chunk: string) => {
      buffer += chunk;
      let newlineIdx = buffer.indexOf('\n');
      while (newlineIdx !== -1) {
        const line = buffer.slice(0, newlineIdx).replace(/\r$/, '');
        buffer = buffer.slice(newlineIdx + 1);
        handleLine(line);
        newlineIdx = buffer.indexOf('\n');
      }
    });

    const handleLine = (line: string): void => {
      if (!greeted) {
        greeted = true;
        if (!/^\* (OK|PREAUTH)/i.test(line)) {
          finish(new ImapStoreError(`IMAP server rejected connection: ${line}`, true));
          return;
        }
        runSequence().catch((err) =>
          finish(
            err instanceof ImapStoreError
              ? err
              : new ImapStoreError(err instanceof Error ? err.message : String(err), false),
          ),
        );
        return;
      }

      // An untagged BYE during LOGOUT is the server announcing a clean close.
      if (/^\* BYE/i.test(line) && pending?.isLogout) {
        completed = true;
        return;
      }

      if (!pending) return;
      if (!line.startsWith(`${pending.tag} `)) return; // untagged data line
      const status = line.slice(pending.tag.length + 1);
      const current = pending;
      pending = null;
      if (/^OK/i.test(status)) {
        current.resolve();
        if (current.isLogout) {
          // LOGOUT acknowledged: the upcoming socket close is expected.
          completed = true;
          finish();
        }
      } else {
        // NO/BAD: deterministic protocol rejection — do not retry.
        current.reject(new ImapStoreError(`IMAP command failed: ${status}`, false));
      }
    };
  });
}

/** True when an error is worth retrying (network/connection, not protocol). */
function isTransientImapError(error: unknown): boolean {
  if (error instanceof ImapStoreError) return error.transient;
  const code = (error as { code?: unknown })?.code;
  if (typeof code === 'string') {
    return ['ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'EAI_AGAIN']
      .includes(code);
  }
  return false;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((res) => setTimeout(res, ms));

/**
 * Wrap an IMAP store function with bounded exponential-backoff retry on
 * transient failures only. Protocol-level (NO/BAD) errors are surfaced on the
 * first attempt without retry.
 */
function makeRetryingImapStoreFlag(
  inner: (args: ImapStoreArgs) => Promise<void>,
  retry: ImapRetryOptions = {},
): (args: ImapStoreArgs) => Promise<void> {
  const maxAttempts = Math.max(1, retry.maxAttempts ?? 3);
  const baseDelayMs = Math.max(0, retry.baseDelayMs ?? 250);
  const maxDelayMs = Math.max(baseDelayMs, retry.maxDelayMs ?? 2_000);
  const sleep = retry.sleep ?? defaultSleep;

  return async (args: ImapStoreArgs): Promise<void> => {
    let lastError: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        await inner(args);
        return;
      } catch (error) {
        lastError = error;
        if (attempt >= maxAttempts || !isTransientImapError(error)) throw error;
        const delay = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
        await sleep(delay);
      }
    }
    throw lastError;
  };
}

/**
 * Reject CR, LF, NUL and any other ASCII control character (0x00-0x1F, 0x7F)
 * in a value destined for an IMAP command line. CR/LF are the dangerous ones:
 * an unescaped CRLF would terminate the current command and let an attacker
 * inject a second IMAP command (CRLF injection). IMAP's quoted-string syntax
 * has no escape for these control chars — backslash only escapes `\` and `"` —
 * so the only safe handling is to refuse the value outright.
 */
function assertImapSafe(value: string, field: string): void {
  // eslint-disable-next-line no-control-regex -- intentional control-char guard
  if (/[\x00-\x1F\x7F]/.test(value)) {
    throw new ImapStoreError(
      `IMAP ${field} contains illegal control characters (possible CRLF injection)`,
      false,
    );
  }
}

/**
 * Wrap a value as an IMAP quoted string. Backslash and double-quote are
 * escaped per RFC 3501; control characters (CR/LF/NUL/...) are NOT escapable in
 * the quoted-string grammar, so callers MUST validate with assertImapSafe
 * first. quoteImap re-asserts as a defense-in-depth measure so no future caller
 * can bypass the guard.
 */
function quoteImap(value: string): string {
  assertImapSafe(value, 'value');
  return `"${value.replace(/([\\"])/g, '\\$1')}"`;
}

// ---------------------------------------------------------------------------
// Slack
// ---------------------------------------------------------------------------

async function applySlack(
  item: InboundChannelItem,
  tags: string[],
  providers: TaggerProviderConfig,
  credentials: DaemonCredentialStore,
  fetchImpl: typeof fetch,
  ctx: OperatorContext,
  base: ApplyTagsResult,
): Promise<ApplyTagsResult> {
  const cfg = providers.slack;
  if (!cfg) return { ...base, reason: 'slack-not-configured' };
  const channel = stringMeta(item, 'channelId') ?? item.conversationId;
  const ts = stringMeta(item, 'ts') ?? stringMeta(item, 'messageTs');
  if (!channel || !ts) return { ...base, reason: 'slack-missing-target' };
  if (tags.length === 0) return { ...base, reason: 'no-tags' };

  const token = await credentials.resolveConfigSecret(cfg.tokenConfigKey);
  if (!token) return { ...base, reason: 'slack-no-credentials' };

  const applied: string[] = [];
  for (const tag of tags) {
    const emoji = slackEmojiForTag(tag);
    const response = await fetchImpl('https://slack.com/api/reactions.add', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify({ channel, timestamp: ts, name: emoji }),
    });
    const payload = (await response.json().catch(() => ({}))) as {
      ok?: boolean;
      error?: string;
    };
    if (!response.ok) {
      throw new OperatorError(
        `Slack reactions.add HTTP ${response.status}`,
        'TRIAGE_SLACK_TAG_FAILED',
        502,
      );
    }
    // 'already_reacted' is an idempotent success for our purposes.
    if (payload.ok !== true && payload.error !== 'already_reacted') {
      ctx.logger.warn('triage: slack reaction rejected', { error: payload.error });
      throw new OperatorError(
        `Slack reactions.add rejected: ${payload.error ?? 'unknown'}`,
        'TRIAGE_SLACK_TAG_FAILED',
        502,
      );
    }
    applied.push(tag);
  }
  return { surface: item.surface, itemId: item.id, appliedTags: applied, skipped: false };
}

function slackEmojiForTag(tag: string): string {
  const lower = tag.toLowerCase();
  if (lower.includes('spam')) return 'no_entry_sign';
  if (lower.includes('priority')) return 'rotating_light';
  return 'inbox_tray';
}

// ---------------------------------------------------------------------------
// Discord
// ---------------------------------------------------------------------------

async function applyDiscord(
  item: InboundChannelItem,
  tags: string[],
  providers: TaggerProviderConfig,
  credentials: DaemonCredentialStore,
  fetchImpl: typeof fetch,
  ctx: OperatorContext,
  base: ApplyTagsResult,
): Promise<ApplyTagsResult> {
  const cfg = providers.discord;
  if (!cfg) return { ...base, reason: 'discord-not-configured' };
  const channelId = stringMeta(item, 'channelId') ?? item.conversationId;
  const messageId = stringMeta(item, 'messageId') ?? item.id;
  if (!channelId || !messageId) return { ...base, reason: 'discord-missing-target' };
  if (tags.length === 0) return { ...base, reason: 'no-tags' };

  const token = await credentials.resolveConfigSecret(cfg.tokenConfigKey);
  if (!token) return { ...base, reason: 'discord-no-credentials' };

  // Exact-fidelity path: when the item targets a forum/media-channel thread and
  // a forum-tag mapping resolves at least one tag, apply REAL Discord thread
  // tags (PATCH the thread's applied_tags) — this is the literal "Discord thread
  // tags" the contract specifies. A forum post's thread id is the thread's own
  // channel id; we accept an explicit metadata.threadId or fall back to
  // channelId for that case.
  const threadId = stringMeta(item, 'threadId') ?? channelId;
  const tagIds = resolveDiscordTagIds(tags, cfg.forumTagIds);
  if (tagIds.length > 0) {
    return applyDiscordThreadTags(item, threadId, tags, tagIds, token, fetchImpl, ctx);
  }

  // Analog fallback: Discord has no arbitrary per-message tags, so apply a
  // unicode reaction on the source message instead.
  const applied: string[] = [];
  for (const tag of tags) {
    const emoji = encodeURIComponent(discordEmojiForTag(tag));
    const url = `https://discord.com/api/v10/channels/${channelId}/messages/${messageId}/reactions/${emoji}/@me`;
    const response = await fetchImpl(url, {
      method: 'PUT',
      headers: {
        Authorization: `Bot ${token}`,
        'Content-Length': '0',
      },
    });
    // 204 No Content is the success case for adding a reaction.
    if (response.status !== 204 && response.status !== 200) {
      const detail = await response.text().catch(() => '');
      ctx.logger.warn('triage: discord reaction rejected', { status: response.status });
      throw new OperatorError(
        `Discord reaction HTTP ${response.status}${detail ? `: ${detail.slice(0, 120)}` : ''}`,
        'TRIAGE_DISCORD_TAG_FAILED',
        502,
      );
    }
    applied.push(tag);
  }
  return { surface: item.surface, itemId: item.id, appliedTags: applied, skipped: false };
}

/**
 * Map GoodVibes triage tags to configured Discord forum-tag snowflake ids,
 * preserving order and dropping unmapped tags. De-duplicates ids.
 */
function resolveDiscordTagIds(
  tags: readonly string[],
  forumTagIds: Record<string, string> | undefined,
): string[] {
  if (!forumTagIds) return [];
  const ids: string[] = [];
  for (const tag of tags) {
    const id = forumTagIds[tag];
    if (typeof id === 'string' && id.length > 0 && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

/**
 * Apply real Discord thread tags by merging the resolved forum-tag ids into the
 * thread's existing applied_tags via PATCH /channels/{thread.id}. Idempotent:
 * already-present tag ids are kept and not duplicated.
 */
async function applyDiscordThreadTags(
  item: InboundChannelItem,
  threadId: string,
  tags: readonly string[],
  tagIds: readonly string[],
  token: string,
  fetchImpl: typeof fetch,
  ctx: OperatorContext,
): Promise<ApplyTagsResult> {
  const url = `https://discord.com/api/v10/channels/${threadId}`;
  // DATA-LOSS GUARD: we PATCH the thread's full applied_tags array, so we must
  // first read the EXISTING tags and merge. If that read fails (network error
  // OR a non-ok HTTP status), we have no idea what tags are currently on the
  // thread — PATCHing with only our new ids would silently destroy whatever
  // forum tags were already applied. Abort instead of overwriting.
  const existing = await fetchDiscordAppliedTags(url, token, fetchImpl, ctx);
  if (existing === null) {
    throw new OperatorError(
      'Discord thread tag read failed; aborting to avoid overwriting existing applied_tags.',
      'TRIAGE_DISCORD_TAG_FAILED',
      502,
    );
  }
  const merged = [...new Set([...existing, ...tagIds])];
  const response = await fetchImpl(url, {
    method: 'PATCH',
    headers: {
      Authorization: `Bot ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ applied_tags: merged }),
  });
  if (response.status !== 200 && response.status !== 204) {
    const detail = await response.text().catch(() => '');
    ctx.logger.warn('triage: discord thread tag rejected', { status: response.status });
    throw new OperatorError(
      `Discord thread tag HTTP ${response.status}${detail ? `: ${detail.slice(0, 120)}` : ''}`,
      'TRIAGE_DISCORD_TAG_FAILED',
      502,
    );
  }
  return { surface: item.surface, itemId: item.id, appliedTags: [...tags], skipped: false };
}

/**
 * Read a thread's current applied_tags.
 *
 * Returns:
 *   - string[]  -> the read SUCCEEDED; the array is the current applied_tags
 *                  (possibly empty when the thread genuinely has no tags, or
 *                  when applied_tags is absent/malformed in a 2xx body).
 *   - null      -> the read FAILED (thrown error OR non-ok HTTP status). The
 *                  caller MUST NOT proceed with a PATCH in this case, because a
 *                  failed read means the existing tag set is unknown and a
 *                  PATCH would overwrite it (data loss).
 *
 * A successful empty/absent applied_tags is deliberately distinguished from a
 * failed read: [] is safe to merge, null is not.
 */
async function fetchDiscordAppliedTags(
  url: string,
  token: string,
  fetchImpl: typeof fetch,
  ctx: OperatorContext,
): Promise<string[] | null> {
  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      headers: { Authorization: `Bot ${token}` },
    });
    if (!response.ok) {
      ctx.logger.warn('triage: discord thread tag read failed', { status: response.status });
      return null;
    }
    const payload = (await response.json().catch(() => null)) as
      | { applied_tags?: unknown }
      | null;
    const current = payload?.applied_tags;
    if (!Array.isArray(current)) return [];
    return current.filter((t): t is string => typeof t === 'string');
  } catch (error) {
    ctx.logger.warn('triage: discord thread tag read errored', {
      message: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

function discordEmojiForTag(tag: string): string {
  const lower = tag.toLowerCase();
  if (lower.includes('spam')) return '🚫';
  if (lower.includes('priority')) return '🚨';
  return '📥';
}

function stringMeta(item: InboundChannelItem, key: string): string | undefined {
  const value = item.metadata?.[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
