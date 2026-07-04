import type { ConfigModalActionContext, ConfigModalRow, ConfigModalSurface, ConfigModalView } from '../../input/config-modal-types.ts';
import type { UiReadModel, UiProvidersSnapshot } from '../../runtime/ui-read-models.ts';
import type { ProviderRuntimeSnapshot } from '@pellux/goodvibes-sdk/platform/providers';
import { toneStyle, statusGlyph, pad, postureLine, kv } from './modal-surface-helpers.ts';

/** The slice of ProviderRuntimeInspectionQuery this surface consumes. */
export interface ProviderRuntimeInspect {
  listProviderIds(): readonly string[];
  inspectAll(): Promise<readonly ProviderRuntimeSnapshot[]>;
}

/**
 * Provider-health config-modal surface (migrated from the `provider-health`
 * panel — the charter's live-modal exemplar; also the target of the `providers`
 * and `accounts` redirects). providerRuntime.inspectAll() is async, so its
 * result is cached and refreshed on open, on `r`, and on a 3s live tick (the
 * panel's display-tick cadence); buildView reads the cache synchronously so
 * live status/model-count values update in place with a stable layout.
 *
 * Fidelity boundary (stated divergence): the panel's per-request latency
 * timelines, auth-route table, and 8 repair-domain posture blocks are driven by
 * an event-fed tracker + account-posture snapshots; those deep views remain on
 * the `/health` and `/accounts` commands (which print them in full). The modal
 * ports the live provider status list + the panel's one dispatch action
 * (Enter → `/accounts repair <provider>`), across a Health and an Accounts tab.
 */
class ProviderHealthModalSurface implements ConfigModalSurface {
  readonly name = 'providers-modal';
  readonly title = 'Providers';
  private requestRender: () => void = () => {};
  private cache = new Map<string, ProviderRuntimeSnapshot>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private unsub: (() => void) | null = null;
  private loaded = false;

  constructor(
    private readonly providerRuntime: ProviderRuntimeInspect,
    private readonly providersReadModel?: UiReadModel<UiProvidersSnapshot>,
  ) {}

  readonly actions = [
    { key: 'enter', id: 'repair', label: 'repair' },
    { key: 'r', id: 'refresh', label: 'refresh posture' },
  ];

  onOpen(requestRender: () => void): void {
    this.requestRender = requestRender;
    void this.reinspect();
    if (this.providersReadModel && !this.unsub) this.unsub = this.providersReadModel.subscribe(() => this.requestRender());
    if (this.timer === null) this.timer = setInterval(() => { void this.reinspect(); }, 3_000);
  }

  onClose(): void {
    if (this.timer !== null) { clearInterval(this.timer); this.timer = null; }
    this.unsub?.();
    this.unsub = null;
  }

  private providerIds(): string[] {
    const ids = new Set<string>([
      ...(this.providersReadModel?.getSnapshot().providerIds ?? []),
      ...this.providerRuntime.listProviderIds(),
      ...this.cache.keys(),
    ]);
    return [...ids].sort((a, b) => a.localeCompare(b));
  }

  buildView(): ConfigModalView {
    const ids = this.providerIds();
    const active = ids.filter((id) => this.cache.get(id)?.active).length;
    const header = [postureLine([
      kv('providers', ids.length),
      kv('active', active),
      kv('inspected', this.cache.size),
    ])];

    const rowFor = (id: string): ConfigModalRow => {
      const snap = this.cache.get(id);
      const isActive = Boolean(snap?.active);
      return {
        id: `provider:${id}`,
        label: `${statusGlyph(isActive ? 'good' : 'dim')} ${pad(id, 18)} ${pad(isActive ? 'ACTIVE' : 'idle', 8)} models=${snap?.modelCount ?? '—'}`,
        style: toneStyle(isActive ? 'good' : 'dim'),
      };
    };

    const rows = ids.map(rowFor);
    const emptyText = ids.length === 0
      ? (this.loaded ? 'No providers registered. Try /provider or /subscription.' : 'Inspecting providers…')
      : undefined;

    return {
      title: 'Providers',
      tabs: [
        { id: 'health', label: 'Health', header, rows, emptyText, hints: ['r refresh posture', '/health for latency & routes'] },
        { id: 'accounts', label: 'Accounts', header, rows: ids.map(rowFor), emptyText, hints: ['Enter repair', '/accounts routes <p> for detail'] },
      ],
    };
  }

  onAction(id: string, ctx: ConfigModalActionContext): void {
    if (id === 'refresh') {
      void this.reinspect();
      ctx.setStatus('Refreshing provider posture…');
      return;
    }
    if (id === 'repair') {
      const provider = ctx.row?.id.startsWith('provider:') ? ctx.row.id.slice('provider:'.length) : null;
      if (!provider) return;
      void ctx.executeCommand?.('accounts', ['repair', provider]);
      ctx.setStatus(`Dispatched /accounts repair ${provider} (see transcript).`);
    }
  }

  private async reinspect(): Promise<void> {
    try {
      const snapshots = await this.providerRuntime.inspectAll();
      const next = new Map<string, ProviderRuntimeSnapshot>();
      for (const s of snapshots) next.set(s.providerId, s);
      this.cache = next;
    } catch {
      // Leave the last-known cache in place; a transient inspect failure should
      // not blank the live table (honest degraded behaviour).
    } finally {
      this.loaded = true;
      this.requestRender();
    }
  }
}

export function createProviderHealthModalSurface(
  providerRuntime: ProviderRuntimeInspect,
  providersReadModel?: UiReadModel<UiProvidersSnapshot>,
): ConfigModalSurface {
  return new ProviderHealthModalSurface(providerRuntime, providersReadModel);
}
