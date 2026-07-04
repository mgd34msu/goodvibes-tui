import type { ConfigModalActionContext, ConfigModalSurface, ConfigModalView } from '../../input/config-modal-types.ts';
import type { ServiceInspectionQuery, SubscriptionAccessQuery } from '../../runtime/ui-service-queries.ts';
import type { ProviderSubscription, PendingSubscriptionLogin } from '@pellux/goodvibes-sdk/platform/config';
import { listBuiltinSubscriptionProviders } from '@pellux/goodvibes-sdk/platform/config';
import { formatElapsed } from '../../utils/format-elapsed.ts';
import { toneStyle, statusGlyph, pad, postureLine, kv, type Tone } from './modal-surface-helpers.ts';

interface Row {
  readonly provider: string;
  readonly hasOAuthConfig: boolean;
  readonly subscription: ProviderSubscription | null;
  readonly pending: PendingSubscriptionLogin | null;
}

type Status = 'active' | 'pending' | 'available' | 'unconfigured';

function statusOf(row: Row): Status {
  if (row.subscription) return 'active';
  if (row.pending) return 'pending';
  return row.hasOAuthConfig ? 'available' : 'unconfigured';
}

function statusTone(status: Status): Tone {
  switch (status) {
    case 'active': return 'good';
    case 'pending': return 'warn';
    case 'available': return 'info';
    case 'unconfigured': return 'dim';
  }
}

const EXPIRING_SOON_MS = 24 * 60 * 60 * 1000;

function isExpiringSoon(sub: ProviderSubscription | null): boolean {
  if (!sub?.expiresAt) return false;
  const remaining = sub.expiresAt - Date.now();
  return remaining > 0 && remaining <= EXPIRING_SOON_MS;
}

/**
 * Subscription config-modal surface (migrated from the `subscription` panel).
 * All reads are synchronous (serviceRegistry.getAll + subscription-manager
 * queries) so buildView reads them live each tick; a 5s timer keeps an
 * externally-completed browser OAuth handshake visible without a keypress, the
 * same cadence the panel used. Enter signs out (surface-managed confirm,
 * matching the panel's ConfirmState) on an active row, or starts login via the
 * existing `/subscription login <p> start` command on an available row.
 */
class SubscriptionModalSurface implements ConfigModalSurface {
  readonly name = 'subscription-modal';
  readonly title = 'Subscriptions';
  private requestRender: () => void = () => {};
  private timer: ReturnType<typeof setInterval> | null = null;
  /** Provider awaiting a second Enter to confirm sign-out (surface-managed so
   *  only a destructive sign-out is confirm-gated, not a login start). */
  private pendingLogout: string | null = null;

  constructor(
    private readonly serviceRegistry: Pick<ServiceInspectionQuery, 'getAll'>,
    private readonly manager: SubscriptionAccessQuery,
  ) {}

  readonly actions = [
    { key: 'enter', id: 'primary', label: 'sign in / out' },
    { key: 'r', id: 'refresh', label: 'refresh' },
  ];

  onOpen(requestRender: () => void): void {
    this.requestRender = requestRender;
    this.pendingLogout = null;
    if (this.timer === null) this.timer = setInterval(() => this.requestRender(), 5_000);
  }

  onClose(): void {
    if (this.timer !== null) { clearInterval(this.timer); this.timer = null; }
    this.pendingLogout = null;
  }

  private buildRows(): Row[] {
    const services = this.serviceRegistry.getAll();
    const builtin = listBuiltinSubscriptionProviders();
    const providers = new Set<string>([
      ...builtin.map((p) => p.provider),
      ...Object.values(services).filter((s) => s.authType === 'oauth' && s.oauth).map((s) => s.providerId ?? s.name),
      ...this.manager.list().map((e) => e.provider),
      ...this.manager.listPending().map((e) => e.provider),
    ]);
    return [...providers].sort((a, b) => a.localeCompare(b)).map((provider) => {
      const service = Object.values(services).find((s) => (s.providerId ?? s.name) === provider && s.authType === 'oauth' && s.oauth);
      const builtinEntry = builtin.find((e) => e.provider === provider);
      return {
        provider,
        hasOAuthConfig: Boolean(service?.oauth) || Boolean(builtinEntry),
        subscription: this.manager.get(provider),
        pending: this.manager.getPending(provider),
      } satisfies Row;
    });
  }

  buildView(): ConfigModalView {
    const rows = this.buildRows();
    const active = rows.filter((r) => r.subscription).length;
    const pending = rows.filter((r) => r.pending).length;
    const configured = rows.filter((r) => r.hasOAuthConfig).length;
    const header = [postureLine([
      kv('configured', configured),
      kv('active', active),
      kv('pending', pending),
      kv('providers', rows.length),
    ])];

    return {
      title: 'Subscriptions',
      tabs: [{
        id: 'subscriptions',
        label: 'Subscriptions',
        header,
        rows: rows.map((row) => {
          const status = statusOf(row);
          const expiring = isExpiringSoon(row.subscription);
          const marker = expiring ? ' expiring soon' : '';
          return {
            id: `sub:${row.provider}`,
            label: `${statusGlyph(statusTone(status))} ${pad(row.provider, 16)} ${pad(status.toUpperCase(), 12)} oauth=${row.hasOAuthConfig ? 'yes' : 'no'}  override=${row.subscription ? 'active' : 'off'}${marker}`,
            style: toneStyle(expiring ? 'warn' : statusTone(status)),
          };
        }),
        emptyText: 'No provider subscriptions yet. Try /subscription login openai start.',
        hints: ['Enter sign in/out', 'r refresh'],
      }],
    };
  }

  onAction(id: string, ctx: ConfigModalActionContext): void {
    if (id === 'refresh') { this.pendingLogout = null; ctx.setStatus('refreshed'); this.requestRender(); return; }
    if (id !== 'primary') return;
    const provider = ctx.row?.id.startsWith('sub:') ? ctx.row.id.slice('sub:'.length) : null;
    if (!provider) return;
    const rows = this.buildRows();
    const row = rows.find((r) => r.provider === provider);
    if (!row) return;
    const status = statusOf(row);
    if (status === 'active') {
      // Surface-managed confirm, guarded by provider match so a stale confirm
      // can never sign out the wrong row.
      if (this.pendingLogout === provider) {
        this.pendingLogout = null;
        this.manager.logout(provider);
        ctx.setStatus(`Signed out ${provider}.`);
      } else {
        this.pendingLogout = provider;
        ctx.setStatus(`Sign out ${provider}? Press Enter again to confirm.`);
      }
    } else if (status === 'available') {
      this.pendingLogout = null;
      void ctx.executeCommand?.('subscription', ['login', provider, 'start']);
      ctx.setStatus(`Starting login for ${provider}…`);
    } else if (status === 'pending' && row.pending) {
      ctx.setStatus(`Login pending (${formatElapsed(Date.now() - row.pending.createdAt)} ago). Finish with /subscription login ${provider} finish <code>.`);
    } else {
      ctx.setStatus(`${provider} has no OAuth config. Add one or enable a built-in subscription provider.`);
    }
    this.requestRender();
  }
}

export function createSubscriptionModalSurface(
  serviceRegistry: Pick<ServiceInspectionQuery, 'getAll'>,
  manager: SubscriptionAccessQuery,
): ConfigModalSurface {
  return new SubscriptionModalSurface(serviceRegistry, manager);
}
