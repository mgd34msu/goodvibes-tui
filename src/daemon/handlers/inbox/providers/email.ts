// ---------------------------------------------------------------------------
// Email (IMAP) inbound adapter.
//
// Uses the dependency-free ImapClient (node:tls) to pull recent INBOX messages.
// Connection params resolve through the daemon credential store (env/secrets
// backend) so nothing sensitive is read from plaintext config:
//   surfaces.email.imapHost      (e.g. imap.fastmail.com)
//   surfaces.email.imapPort      (default 993)
//   surfaces.email.imapUser
//   surfaces.email.imapPassword  (app password / token)
//
// Any missing required field => state 'unavailable' WITH an explanatory error.
// Cadence: 60s (email tier).
// ---------------------------------------------------------------------------

import type {
  AdapterContext,
  InboundChannelItem,
  InboundProviderAdapter,
  ProviderPollOptions,
  ProviderPollResult,
} from '../provider-adapter.ts';
import { POLL_CADENCE_MS } from '../provider-adapter.ts';
import { digestSender, toBodyPreview, toSubjectPreview } from '../mapping.ts';
import { resolveRouteId } from './route-util.ts';
import { ImapClient } from './imap-client.ts';
import type { ImapConfig, ImapEnvelope } from './imap-client.ts';

export const EMAIL_PROVIDER_ID = 'email';
export const EMAIL_HOST_KEY = 'surfaces.email.imapHost';
export const EMAIL_PORT_KEY = 'surfaces.email.imapPort';
export const EMAIL_USER_KEY = 'surfaces.email.imapUser';
export const EMAIL_PASSWORD_KEY = 'surfaces.email.imapPassword';

/**
 * Injectable client factory so tests can substitute a fake IMAP client without
 * opening a TLS socket. Production default constructs the real ImapClient.
 */
export interface ImapLike {
  connect(): Promise<void>;
  login(): Promise<void>;
  select(mailbox?: string): Promise<void>;
  searchUids(since?: number): Promise<number[]>;
  fetchEnvelopes(uids: readonly number[]): Promise<ImapEnvelope[]>;
  logout(): Promise<void>;
  close(): void;
}

export type ImapClientFactory = (cfg: ImapConfig) => ImapLike;

const defaultFactory: ImapClientFactory = (cfg) => new ImapClient(cfg);

export function createEmailAdapter(
  ctx: AdapterContext,
  factory: ImapClientFactory = defaultFactory,
): InboundProviderAdapter {
  return {
    id: EMAIL_PROVIDER_ID,
    pollIntervalMs: POLL_CADENCE_MS.email,
    async poll(opts: ProviderPollOptions): Promise<ProviderPollResult> {
      let host: string | null;
      let user: string | null;
      let password: string | null;
      let portRaw: string | null;
      try {
        [host, portRaw, user, password] = await Promise.all([
          ctx.credentials.resolveConfigSecret(EMAIL_HOST_KEY),
          ctx.credentials.resolveConfigSecret(EMAIL_PORT_KEY),
          ctx.credentials.resolveConfigSecret(EMAIL_USER_KEY),
          ctx.credentials.resolveConfigSecret(EMAIL_PASSWORD_KEY),
        ]);
      } catch (error) {
        return unavailable(`credential lookup failed: ${errMsg(error)}`);
      }

      const missing: string[] = [];
      if (!host) missing.push('imapHost');
      if (!user) missing.push('imapUser');
      if (!password) missing.push('imapPassword');
      if (missing.length > 0) {
        return unavailable(`missing email IMAP credentials: ${missing.join(', ')}`);
      }
      const port = portRaw ? Number.parseInt(portRaw, 10) : 993;
      if (!Number.isFinite(port) || port <= 0) {
        return unavailable(`invalid surfaces.email.imapPort: ${portRaw}`);
      }

      const client = factory({
        host: host!,
        port,
        user: user!,
        password: password!,
      });

      try {
        await client.connect();
        await client.login();
        await client.select('INBOX');
        const uids = await client.searchUids(opts.since);
        // Newest UIDs first, capped at limit.
        const selected = uids.sort((a, b) => b - a).slice(0, opts.limit);
        const envelopes = await client.fetchEnvelopes(selected);
        const items: InboundChannelItem[] = [];
        for (const env of envelopes) {
          const receivedAt = env.date > 0 ? env.date : Date.now();
          if (opts.since && receivedAt <= opts.since) continue;
          const fromDigest = digestSender(`email:${normalizeAddress(env.from)}`);
          const kind = 'dm';
          const item: InboundChannelItem = {
            id: `email:${user}:${env.uid}`,
            provider: EMAIL_PROVIDER_ID,
            kind,
            fromDigest,
            subjectPreview: toSubjectPreview(env.subject),
            bodyPreview: toBodyPreview(env.bodyPreview),
            receivedAt,
            unread: !env.seen,
          };
          const routeId = await resolveRouteId(ctx, EMAIL_PROVIDER_ID, fromDigest, kind);
          if (routeId) item.routeId = routeId;
          items.push(item);
        }
        return { items, state: items.length > 0 ? 'ready' : 'empty' };
      } catch (error) {
        return unavailable(errMsg(error));
      } finally {
        try {
          await client.logout();
        } catch {
          // ignore
        }
        client.close();
      }
    },
  };
}

/** Extract a bare address from a `Name <addr@host>` From header for digesting. */
function normalizeAddress(from: string): string {
  const angle = /<([^>]+)>/.exec(from);
  const addr = (angle ? angle[1]! : from).trim().toLowerCase();
  return addr.length > 0 ? addr : from.trim().toLowerCase();
}

function unavailable(error: string): ProviderPollResult {
  return { items: [], state: 'unavailable', error };
}

function errMsg(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
