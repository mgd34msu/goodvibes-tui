import type { ConfigModalActionContext, ConfigModalSurface, ConfigModalView } from '../../input/config-modal-types.ts';
import type { ServiceInspectionQuery, SubscriptionAccessQuery } from '@/runtime/index.ts';
import type { ServiceConfig, ServiceInspection, ServiceConnectionTestResult } from '@pellux/goodvibes-sdk/platform/config';
import { summarizeError } from '@pellux/goodvibes-sdk/platform/utils';
import { toneStyle, statusGlyph, pad, postureLine, kv, type Tone } from './modal-surface-helpers.ts';

interface Entry {
  readonly name: string;
  readonly inspection: ServiceInspection | null;
  lastTest?: ServiceConnectionTestResult;
}

function statusLabel(e: Entry): string {
  if (!e.inspection) return 'INSPECT FAILED';
  if (!e.inspection.hasPrimaryCredential) return 'UNCONFIGURED';
  if (e.lastTest?.ok) return 'HEALTHY';
  if (e.lastTest && !e.lastTest.ok) return 'ERROR';
  return 'CONFIGURED';
}

function statusTone(e: Entry): Tone {
  const label = statusLabel(e);
  if (label === 'HEALTHY') return 'good';
  if (label === 'ERROR' || label === 'INSPECT FAILED') return 'bad';
  if (label === 'CONFIGURED') return 'warn';
  return 'dim';
}

function statusDotTone(e: Entry): Tone {
  const label = statusLabel(e);
  if (label === 'HEALTHY') return 'good';
  if (label === 'ERROR' || label === 'INSPECT FAILED') return 'bad';
  return 'dim';
}

// Ported verbatim from ServicesPanel.authSummary (the retired panel's derivation).
function authSummary(config: ServiceConfig, manager: SubscriptionAccessQuery): string {
  const provider = config.providerId ?? config.name;
  const hasOverride = manager.getAccessToken(provider) != null;
  switch (config.authType) {
    case 'bearer': return hasOverride ? 'bearer+subscription' : 'bearer';
    case 'basic': return 'basic';
    case 'api-key': return hasOverride ? 'oauth-override' : config.apiKeyHeader ? `api-key:${config.apiKeyHeader}` : 'api-key';
    case 'oauth': return manager.get(provider) != null ? 'oauth(active)' : 'oauth';
  }
}

/**
 * Services config-modal surface (migrated from the `services` panel). Reads the
 * same ServiceInspectionQuery — getAll() is sync but inspect()/testConnection()
 * are async, so an inspection cache is refreshed on open / `r` and read
 * synchronously by buildView (mirrors the panel's own refresh contract).
 * Actions map onto their existing behaviours; `s` jumps to the subscription
 * surface, `t`/`T` run the same live connection tests, `r` re-inspects.
 */
class ServicesModalSurface implements ConfigModalSurface {
  readonly name = 'services-modal';
  readonly title = 'Services';
  private entries: Entry[] = [];
  private loading = false;
  private error = '';
  private requestRender: () => void = () => {};

  constructor(
    private readonly registry: ServiceInspectionQuery,
    private readonly manager: SubscriptionAccessQuery,
  ) {}

  readonly actions = [
    { key: 'r', id: 'refresh', label: 'refresh' },
    { key: 't', id: 'test', label: 'test' },
    { key: 'T', id: 'test-all', label: 'test all' },
    { key: 's', id: 'subscription', label: 'subscription' },
  ];

  onOpen(requestRender: () => void): void {
    this.requestRender = requestRender;
    if (this.entries.length === 0 && !this.loading) void this.refresh();
  }

  buildView(): ConfigModalView {
    const counts = { healthy: 0, error: 0, unconfigured: 0 };
    for (const e of this.entries) {
      const label = statusLabel(e);
      if (label === 'HEALTHY') counts.healthy++;
      else if (label === 'ERROR') counts.error++;
      else if (label !== 'CONFIGURED') counts.unconfigured++;
    }
    const header = [postureLine([
      kv('services', this.entries.length),
      kv('healthy', counts.healthy),
      kv('errors', counts.error),
      kv('unconfigured', counts.unconfigured),
    ])];

    const rows = this.entries.map((e) => {
      const auth = e.inspection ? authSummary(e.inspection.config, this.manager) : 'n/a';
      const base = e.inspection ? (e.inspection.config.baseUrl ?? '(no baseUrl)') : '(inspection failed)';
      return {
        id: `svc:${e.name}`,
        label: `${statusGlyph(statusDotTone(e))} ${pad(e.name, 16)} ${pad(statusLabel(e), 13)} ${pad(auth, 18)} ${base}`,
        style: toneStyle(statusTone(e)),
      };
    });

    return {
      title: this.loading && this.entries.length === 0 ? 'Services (loading…)' : 'Services',
      degraded: this.error || undefined,
      tabs: [{
        id: 'services',
        label: 'Services',
        header,
        rows,
        emptyText: this.loading ? 'Loading configured services…' : 'No services configured. Try /services auth-review.',
      }],
    };
  }

  onAction(id: string, ctx: ConfigModalActionContext): void {
    if (id === 'refresh') void this.refresh();
    else if (id === 'test') void this.testOne(ctx);
    else if (id === 'test-all') void this.testAll();
    else if (id === 'subscription') ctx.openModal?.('subscription-modal');
  }

  private nameOf(rowId: string | undefined): string | null {
    return rowId?.startsWith('svc:') ? rowId.slice('svc:'.length) : null;
  }

  private async refresh(): Promise<void> {
    this.loading = true;
    this.error = '';
    this.requestRender();
    try {
      const configs = this.registry.getAll();
      const names = Object.keys(configs).sort((a, b) => a.localeCompare(b));
      const inspections = await Promise.all(names.map(async (name) => ({ name, inspection: await this.registry.inspect(name) })));
      const prev = new Map(this.entries.map((e) => [e.name, e.lastTest] as const));
      this.entries = inspections.map((e) => ({ ...e, lastTest: prev.get(e.name) }));
    } catch (e) {
      this.error = `Refresh failed: ${summarizeError(e)}`;
    } finally {
      this.loading = false;
      this.requestRender();
    }
  }

  private async testOne(ctx: ConfigModalActionContext): Promise<void> {
    const name = this.nameOf(ctx.row?.id);
    if (!name) return;
    try {
      const result = await this.registry.testConnection(name);
      this.entries = this.entries.map((e) => (e.name === name ? { ...e, lastTest: result } : e));
      ctx.setStatus(`${name}: ${result.ok ? 'ok' : `failed (${result.status ?? 'n/a'})`}`);
    } catch (e) {
      ctx.setStatus(`Test failed: ${summarizeError(e)}`);
    }
    this.requestRender();
  }

  private async testAll(): Promise<void> {
    for (const entry of this.entries) {
      try {
        const result = await this.registry.testConnection(entry.name);
        this.entries = this.entries.map((e) => (e.name === entry.name ? { ...e, lastTest: result } : e));
      } catch (e) {
        this.error = `Test failed for ${entry.name}: ${summarizeError(e)}`;
      }
      this.requestRender();
    }
  }
}

export function createServicesModalSurface(
  registry: ServiceInspectionQuery,
  manager: SubscriptionAccessQuery,
): ConfigModalSurface {
  return new ServicesModalSurface(registry, manager);
}
