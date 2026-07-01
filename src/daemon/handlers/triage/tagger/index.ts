// ---------------------------------------------------------------------------
// Daemon-internal triage TAGGER (composition).
//
// Applies user-defined triage labels back on the provider side:
//   - IMAP : STORE a keyword flag on the message (IMAP4rev1 over TLS).
//   - Slack: reactions.add emoji on the source message.
//   - Discord: real forum thread tags (PATCH applied_tags, merge) when a
//     forum-tag mapping is configured, else a unicode reaction analog.
//
// Hard rules honored here:
//   - All provider credentials come ONLY from the daemon credential store.
//     They are never returned in results and never logged.
//   - The whole tagger is gated behind a config flag (surfaces.triage.autoTag);
//     when disabled, applyTags() is a no-op that reports skipped:true.
//   - Provider-side writes are EFFECTFUL; callers must pass an explicitly
//     confirmed request (confirm === true && explicitUserRequest === true).
//     Unconfirmed calls throw HandlerError(REQUIRE_CONFIRM).
//
// Contract-fidelity note: the triage surface (`inbox.triage.*`) is daemon-
// internal and NOT a published operator method, so there is no external
// request/response schema to certify these tag shapes against. What is
// guaranteed is the provider-side behavior: no silent data loss (Discord thread
// tags are merged, never blindly overwritten) and no command injection (IMAP
// quoting rejects control characters).
// ---------------------------------------------------------------------------

import type { HandlerContext } from '../../context.ts';
import type { DaemonCredentialStore } from '../../credentials.ts';
import { HandlerError, REQUIRE_CONFIRM } from '../../errors.ts';
import { labelToTag } from '../scorer.ts';
import { applyImap, imapStoreFlagOverTls, makeRetryingImapStoreFlag } from './imap.ts';
import type { ImapRetryOptions, ImapStoreFlag } from './imap.ts';
import { applySlack } from './slack.ts';
import { applyDiscord } from './discord.ts';
import type { ApplyTagsRequest, ApplyTagsResult, TaggerProviderConfig } from './shared.ts';

export type {
  ApplyTagsRequest,
  ApplyTagsResult,
  TaggerProviderConfig,
} from './shared.ts';
export type { ImapRetryOptions, ImapStoreArgs, ImapStoreFlag } from './imap.ts';

export const TRIAGE_AUTOTAG_FLAG = 'surfaces.triage.autoTag';

export interface TriageTaggerOptions {
  credentials?: DaemonCredentialStore;
  /** Override the autotag flag lookup (used in tests). */
  autoTagEnabled?: boolean;
  /** Per-surface provider config; usually derived from configManager. */
  providers?: TaggerProviderConfig;
  /** Injectable fetch (Slack/Discord HTTP). Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Injectable IMAP flag-setter (used in tests to avoid a live socket). */
  imapStoreFlag?: ImapStoreFlag;
  /**
   * Transient-failure retry policy for the default IMAP store implementation.
   * Ignored when imapStoreFlag is injected and succeeds first-try.
   */
  imapRetry?: ImapRetryOptions;
}

export interface TriageTagger {
  /** Whether provider-side tagging is currently enabled. */
  enabled(): boolean;
  applyTags(request: ApplyTagsRequest): Promise<ApplyTagsResult>;
}

function readBoolFlag(
  configManager: HandlerContext['configManager'],
  key: string,
): boolean {
  try {
    const value = configManager.get(key as never) as unknown;
    return value === true || value === 'true' || value === 1;
  } catch {
    return false;
  }
}

function safeGet(configManager: HandlerContext['configManager'], key: string): unknown {
  try {
    return configManager.get(key as never) as unknown;
  } catch {
    return undefined;
  }
}

function resolveProvidersFromConfig(
  configManager: HandlerContext['configManager'],
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

function resolveTags(request: ApplyTagsRequest): string[] {
  if (request.tags && request.tags.length > 0) {
    return [...new Set(request.tags.map((t) => t.trim()).filter((t) => t.length > 0))];
  }
  if (request.label) return [labelToTag(request.label)];
  return [];
}

/**
 * Create the triage tagger. Reads the autotag flag and provider config from the
 * handler context; credentials are resolved lazily, per apply, from the daemon
 * credential store.
 */
export function createTriageTagger(
  ctx: HandlerContext,
  options: TriageTaggerOptions = {},
): TriageTagger {
  const credentials = options.credentials ?? ctx.credentials;
  const fetchImpl = options.fetchImpl ?? fetch;
  const providers = options.providers ?? resolveProvidersFromConfig(ctx.configManager);
  // Retry wraps whichever store impl is in use (default TLS client OR an
  // injected one), so transient failures are retried uniformly.
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
        throw new HandlerError(
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
