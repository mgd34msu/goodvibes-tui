import type {
  ConfigModalActionContext,
  ConfigModalRow,
  ConfigModalSurface,
  ConfigModalView,
} from '../../input/config-modal-types.ts';
import { MODAL_TONES } from './modal-theme.ts';
import { infoRow } from './modal-surface-helpers.ts';
import {
  loadEcosystemCatalog,
  listInstalledEcosystemEntries,
  reviewEcosystemCatalogEntry,
  type EcosystemCatalogEntry,
  type EcosystemCatalogPathOptions,
  type EcosystemEntryKind,
} from '@/runtime/index.ts';
import type { UiMarketplaceSnapshot, UiReadModel } from '../../runtime/ui-read-models.ts';
import { summarizeError } from '@pellux/goodvibes-sdk/platform/utils';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Live deps the marketplace modal captures (mirrors the panel factory). */
export interface MarketplaceModalDeps {
  readonly readModel?: UiReadModel<UiMarketplaceSnapshot>;
  readonly ecosystemPaths?: EcosystemCatalogPathOptions;
}

type MarketplaceReview = ReturnType<typeof reviewEcosystemCatalogEntry>;

interface MarketplaceRow {
  readonly kind: EcosystemEntryKind;
  readonly entry: EcosystemCatalogEntry;
  readonly installed: boolean;
  readonly review: MarketplaceReview;
}

const KINDS: readonly EcosystemEntryKind[] = ['plugin', 'skill', 'hook-pack', 'policy-pack'];

/**
 * Marketplace → config-modal surface (group-B port). Local-first
 * publish/import catalog (NOT a remote store) with provenance, compatibility,
 * and install posture. Disk catalog loads happen in refresh() (never in
 * buildView), mirroring the panel's explicit render()/refresh() split.
 * Install/uninstall route to the `/marketplace` command path (charter: no
 * destructive confirm folded into a modal).
 *
 * Honest empty-state: the panel's original "No curated marketplace
 * entries found yet." copy implied a curated remote catalog. It isn't one,
 * loadEcosystemCatalog only ever reads .goodvibes/ecosystem/<kind>s.json under
 * the project/home, populated solely by `/marketplace publish` and
 * `/marketplace bundle import`. The empty-state copy below (locked byte-for-byte
 * in the golden) names that reality. Selection-blind port: the panel's
 * selected-entry compatibility/risk/state detail is folded into each row label.
 */
class MarketplaceModalSurface implements ConfigModalSurface {
  readonly name = 'marketplace-modal';
  readonly title = 'Marketplace';
  private rows: MarketplaceRow[] = [];
  private loadError: string | null = null;
  private requestRender: () => void = () => {};
  private unsub: (() => void) | null = null;

  constructor(private readonly deps: MarketplaceModalDeps) {}

  readonly actions = [
    { key: 'i', id: 'install', label: 'install', enabledFor: (row: ConfigModalRow | null) => this.canInstall(row) },
    { key: 'u', id: 'uninstall', label: 'uninstall', enabledFor: (row: ConfigModalRow | null) => this.canUninstall(row) },
    { key: 'r', id: 'refresh', label: 'refresh' },
  ];

  onOpen(requestRender: () => void): void {
    this.requestRender = requestRender;
    this.refresh();
    if (this.deps.readModel && !this.unsub) this.unsub = this.deps.readModel.subscribe(() => this.requestRender());
  }

  onClose(): void {
    this.unsub?.();
    this.unsub = null;
  }

  private refresh(): void {
    const paths = this.deps.ecosystemPaths;
    if (!paths) { this.rows = []; this.loadError = null; return; }
    try {
      const built: MarketplaceRow[] = [];
      for (const kind of KINDS) {
        const installed = new Set(listInstalledEcosystemEntries(kind, paths).map((receipt) => receipt.entry.id));
        for (const entry of loadEcosystemCatalog(kind, paths)) {
          built.push({ kind, entry, installed: installed.has(entry.id), review: reviewEcosystemCatalogEntry(entry, paths) });
        }
      }
      this.rows = built.sort((a, b) => a.entry.name.localeCompare(b.entry.name));
      this.loadError = null;
    } catch (e) {
      this.rows = [];
      this.loadError = `Catalog load failed: ${summarizeError(e)}`;
    }
  }

  private entryFor(row: ConfigModalRow | null): MarketplaceRow | undefined {
    if (!row) return undefined;
    return this.rows.find((r) => `${r.kind}:${r.entry.id}` === row.id);
  }

  private canInstall(row: ConfigModalRow | null): boolean {
    const entry = this.entryFor(row);
    return Boolean(entry && !entry.installed);
  }

  private canUninstall(row: ConfigModalRow | null): boolean {
    const entry = this.entryFor(row);
    return Boolean(entry && entry.installed);
  }

  buildView(): ConfigModalView {
    const snapshot = this.deps.readModel?.getSnapshot();
    const rows: ConfigModalRow[] = [];

    // Honest empty / degraded state. loadError → degraded banner.
    if (this.loadError) {
      return { title: 'Marketplace', degraded: this.loadError, tabs: [{ id: 'catalog', label: 'Catalog', rows: [] }] };
    }
    if (this.rows.length === 0) {
      if (!this.deps.ecosystemPaths) {
        rows.push(infoRow('empty:unwired', "Marketplace catalog roots aren't wired into this session, so there's nothing to read yet."));
      } else {
        rows.push(infoRow('empty:0', 'This is your local plugin, skill, hook-pack, and policy-pack catalog; not a remote store.'));
        rows.push(infoRow('empty:1', "It's empty because nothing has been published or imported into this workspace yet. Entries appear here once you publish a local component or import a bundle."));
      }
      rows.push(infoRow('empty:title', 'Populate it', { bold: true }));
      rows.push(infoRow('empty:publish', '/marketplace publish <kind> <path>  — publish local plugins/skills into the catalog', { dim: true }));
      rows.push(infoRow('empty:import', '/marketplace bundle import <path>   — import a catalog bundle from disk', { dim: true }));
      rows.push(infoRow('empty:review', '/marketplace catalog review         — inspect the current local catalog posture', { dim: true }));
      return {
        title: 'Marketplace',
        tabs: [{ id: 'catalog', label: 'Catalog', rows, emptyText: '' }],
        hints: ['local publish/import catalog'],
      };
    }

    // Posture summary header.
    const installedCount = this.rows.filter((r) => r.installed).length;
    const count = (k: EcosystemEntryKind): number => this.rows.filter((r) => r.kind === k).length;
    const header = [
      `catalog ${this.rows.length}  installed ${installedCount}  plugins ${count('plugin')}  skills ${count('skill')}  hooks ${count('hook-pack')}  policies ${count('policy-pack')}`,
    ];

    const startupIssues = snapshot?.startupIssues ?? [];
    for (const [i, issue] of startupIssues.slice(0, 3).entries()) {
      rows.push(infoRow(`issue:${i}`, `⚠ ${issue}`, { fg: MODAL_TONES.warn }));
    }

    // Catalog list, selection-blind: fold provenance/compat/risk/state into the label.
    for (const row of this.rows) {
      const review = row.review;
      const provenance = row.entry.provenance ?? 'local';
      rows.push({
        id: `${row.kind}:${row.entry.id}`,
        label: `${row.kind.padEnd(11)} ${row.entry.name.padEnd(22)} ${provenance.padEnd(14)} ${row.installed ? 'INSTALLED' : 'local    '} ${row.entry.version ?? 'n/a'} · compat ${review.compatibility.status} risk ${review.riskLevel}`,
      });
    }

    // Recommendations (displayed with their command; digit-jump dropped).
    const recommendations = snapshot?.recommendations ?? [];
    if (recommendations.length > 0) {
      rows.push(infoRow('rec:title', 'Recommended', { bold: true }));
      for (const [i, rec] of recommendations.slice(0, 3).entries()) {
        rows.push(infoRow(`rec:${i}`, `${rec.title}: ${rec.command}`, { dim: true }));
      }
    }

    return {
      title: 'Marketplace',
      tabs: [{
        id: 'catalog',
        label: 'Catalog',
        header,
        rows,
        hints: ['local publish/import catalog'],
      }],
    };
  }

  onAction(id: string, ctx: ConfigModalActionContext): void {
    if (id === 'refresh') { this.refresh(); ctx.setStatus('Refreshing catalog…'); return; }
    const entry = this.entryFor(ctx.row);
    if (!entry) return;
    if (id === 'install' && !entry.installed) {
      void ctx.executeCommand?.('marketplace', ['install', entry.kind, entry.entry.id]);
      ctx.setStatus(`Dispatched /marketplace install ${entry.kind} ${entry.entry.id} (see transcript).`);
    } else if (id === 'uninstall' && entry.installed) {
      void ctx.executeCommand?.('marketplace', ['uninstall', entry.kind, entry.entry.id]);
      ctx.setStatus(`Dispatched /marketplace uninstall ${entry.kind} ${entry.entry.id} (see transcript).`);
    }
  }
}

export function createMarketplaceModalSurface(deps: MarketplaceModalDeps): ConfigModalSurface {
  return new MarketplaceModalSurface(deps);
}

/**
 * Deterministic golden fixture: catalog roots wired at a fresh tmp path that is
 * removed immediately (loadEcosystemCatalog/listInstalledEcosystemEntries guard
 * missing paths with existsSync → [], so refresh() finds nothing and renders the
 * honest empty-state copy). The random tmp path never appears in the
 * rendered lines (the empty-state copy is static), so the golden is byte-stable.
 *
 * This is production code (ships in the real binary), not test scratch, so
 * it stays rooted at the real OS temp dir rather than the test-only
 * makeProjectTempDir helper. Created and removed synchronously in the same
 * call, so the on-disk window is negligible.
 */
export function marketplaceModalGoldenSurface(): ConfigModalSurface {
  const root = mkdtempSync(join(tmpdir(), 'gv-marketplace-golden-'));
  const surface = createMarketplaceModalSurface({
    ecosystemPaths: { cwd: root, homeDir: root, projectCatalogRoot: join(root, 'ecosystem') },
  });
  rmSync(root, { recursive: true, force: true });
  return surface;
}
