import { MODAL_TONES } from './modal-theme.ts';
import {
  loadEcosystemCatalog,
  listInstalledEcosystemEntries,
  reviewEcosystemCatalogEntry,
  type EcosystemCatalogEntry,
  type EcosystemCatalogPathOptions,
  type EcosystemEntryKind,
} from '@/runtime/index.ts';
import type { ModalConfig, ModalSection, ModalListItem } from '../../renderer/modal-factory.ts';
import type { UiMarketplaceSnapshot, UiReadModel } from '../../runtime/ui-read-models.ts';
import type { BoundModalSurface, ModalAction, ModalViewState } from './modal-surface.ts';
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

function matchesQuery(row: MarketplaceRow, q: string): boolean {
  if (q === '') return true;
  const needle = q.toLowerCase();
  return row.kind.toLowerCase().includes(needle)
    || row.entry.name.toLowerCase().includes(needle)
    || (row.entry.provenance ?? 'local').toLowerCase().includes(needle);
}

/**
 * Marketplace → modal. Local-first publish/import catalog (NOT a remote store)
 * with provenance, compatibility, and install posture. Disk catalog loads
 * happen in refresh() (never in buildConfig), mirroring the panel's explicit
 * render()/refresh() split. Install/uninstall route to the `/marketplace`
 * command path rather than folding a destructive confirm into the modal.
 *
 * B30 (honest empty-state): the panel's "No curated marketplace entries found
 * yet." / "…catalog paths are not wired into this panel yet." copy implied a
 * curated remote catalog. It isn't one — loadEcosystemCatalog only ever reads
 * .goodvibes/ecosystem/<kind>s.json under the project/home, populated solely by
 * `/marketplace publish` and `/marketplace bundle import`. The empty-state copy
 * below names that reality.
 */
export function bindMarketplaceModal(deps: MarketplaceModalDeps): BoundModalSurface {
  let rows: MarketplaceRow[] = [];
  let loadError: string | null = null;

  const refresh = (): void => {
    const paths = deps.ecosystemPaths;
    if (!paths) { rows = []; loadError = null; return; }
    try {
      const built: MarketplaceRow[] = [];
      for (const kind of KINDS) {
        const installed = new Set(
          listInstalledEcosystemEntries(kind, paths).map((receipt) => receipt.entry.id),
        );
        for (const entry of loadEcosystemCatalog(kind, paths)) {
          built.push({
            kind,
            entry,
            installed: installed.has(entry.id),
            review: reviewEcosystemCatalogEntry(entry, paths),
          });
        }
      }
      rows = built.sort((a, b) => a.entry.name.localeCompare(b.entry.name));
      loadError = null;
    } catch (e) {
      rows = [];
      loadError = `Catalog load failed: ${summarizeError(e)}`;
    }
  };

  const visibleRows = (view: ModalViewState): MarketplaceRow[] => rows.filter((row) => matchesQuery(row, view.query));

  const selectedRow = (view: ModalViewState): MarketplaceRow | undefined => {
    const visible = visibleRows(view);
    return visible[Math.max(0, Math.min(view.selectedIndex, visible.length - 1))];
  };

  const buildConfig = (view: ModalViewState): ModalConfig => {
    const snapshot = deps.readModel?.getSnapshot();
    const sections: ModalSection[] = [];

    // Honest empty / degraded state (B30).
    if (rows.length === 0) {
      if (loadError) {
        sections.push({ type: 'text', content: loadError, style: { fg: MODAL_TONES.bad } });
      } else if (!deps.ecosystemPaths) {
        sections.push({ type: 'text', content: 'Marketplace catalog roots aren’t wired into this session, so there’s nothing to read yet.' });
      } else {
        sections.push({ type: 'text', content: 'This is your local plugin, skill, hook-pack, and policy-pack catalog — not a remote store.' });
        sections.push({ type: 'text', content: 'It’s empty because nothing has been published or imported into this workspace yet. Entries appear here once you publish a local component or import a bundle.' });
      }
      sections.push({ type: 'separator' });
      sections.push({ type: 'title', content: 'Populate it' });
      sections.push({ type: 'text', content: '/marketplace publish <kind> <path>  — publish local plugins/skills into the catalog', style: { dim: true } });
      sections.push({ type: 'text', content: '/marketplace bundle import <path>   — import a catalog bundle from disk', style: { dim: true } });
      sections.push({ type: 'text', content: '/marketplace catalog review         — inspect the current local catalog posture', style: { dim: true } });
      return {
        title: 'Marketplace',
        width: 76,
        sections,
        footer: 'local publish/import catalog · esc close',
      };
    }

    // Posture summary.
    const installedCount = rows.filter((r) => r.installed).length;
    const count = (k: EcosystemEntryKind): number => rows.filter((r) => r.kind === k).length;
    sections.push({
      type: 'text',
      content: `catalog ${rows.length}  installed ${installedCount}  plugins ${count('plugin')}  skills ${count('skill')}  hooks ${count('hook-pack')}  policies ${count('policy-pack')}`,
      style: { dim: true },
    });

    const startupIssues = snapshot?.startupIssues ?? [];
    for (const issue of startupIssues.slice(0, 3)) {
      sections.push({ type: 'text', content: `⚠ ${issue}`, style: { fg: MODAL_TONES.warn } });
    }

    sections.push({ type: 'separator' });

    // Catalog list (filtered).
    const visible = visibleRows(view);
    const items: ModalListItem[] = visible.map((row, index) => ({
      label: `${row.kind.padEnd(11)} ${row.entry.name.padEnd(22)} ${(row.entry.provenance ?? 'local').padEnd(14)} ${row.installed ? 'INSTALLED' : 'local    '} ${row.entry.version ?? 'n/a'}`,
      selected: index === Math.max(0, Math.min(view.selectedIndex, visible.length - 1)),
    }));
    if (items.length === 0) {
      sections.push({ type: 'text', content: `No entries match “${view.query}”.`, style: { dim: true } });
    } else {
      sections.push({ type: 'list', items });
    }

    // Selected-entry detail.
    const selected = selectedRow(view);
    if (selected) {
      sections.push({ type: 'separator' });
      const review = selected.review;
      sections.push({ type: 'text', content: `provenance ${selected.entry.provenance ?? '(none)'}  source ${selected.entry.source}`, style: { dim: true } });
      sections.push({
        type: 'text',
        content: `compatibility ${review.compatibility.status}  risk ${review.riskLevel}  state ${selected.installed ? 'installed' : 'local'}`,
      });
      if (view.expanded?.has(selected.entry.id)) {
        sections.push({ type: 'text', content: `source path ${review.sourcePath} (${review.sourceExists ? 'exists' : 'missing'})`, style: { dim: true } });
        sections.push({ type: 'text', content: `runtime fit ${review.runtimeFit.status}${review.runtimeFit.reasons.length > 0 ? ` — ${review.runtimeFit.reasons.join('; ')}` : ''}` });
      }
    }

    // Recommendations (displayed with their command; digit-jump dropped).
    const recommendations = snapshot?.recommendations ?? [];
    if (recommendations.length > 0) {
      sections.push({ type: 'title', content: 'Recommended' });
      for (const rec of recommendations.slice(0, 3)) {
        sections.push({ type: 'text', content: `${rec.title} — ${rec.command}`, style: { dim: true } });
      }
    }

    return {
      title: 'Marketplace',
      width: 76,
      search: view.query,
      sections,
      hints: [
        'up/down move',
        'enter detail',
        ...(selected && !selected.installed ? ['i install'] : []),
        ...(selected && selected.installed ? ['u uninstall'] : []),
        'r refresh',
        '/ filter',
      ],
    };
  };

  const install: ModalAction = (view) => {
    const row = selectedRow(view);
    if (!row || row.installed) return { kind: 'none' };
    return { kind: 'runCommand', command: `/marketplace install ${row.kind} ${row.entry.id}` };
  };
  const uninstall: ModalAction = (view) => {
    const row = selectedRow(view);
    if (!row || !row.installed) return { kind: 'none' };
    return { kind: 'runCommand', command: `/marketplace uninstall ${row.kind} ${row.entry.id}` };
  };

  return {
    name: 'marketplace',
    title: 'Marketplace',
    refresh,
    buildConfig,
    rowIds: (view) => visibleRows(view).map((row) => `${row.kind}:${row.entry.id}`),
    actions: {
      refresh: () => ({ kind: 'refresh' }),
      install,
      uninstall,
    },
  };
}

/**
 * Deterministic golden fixture: catalog roots wired at a fresh empty tmp path
 * (so refresh() finds nothing), rendering the B30 honest empty-state copy —
 * the load-bearing change. The random tmp path never appears in the rendered
 * lines (the empty-state copy is static), so the golden is byte-stable; the
 * dir is removed after refresh() since buildConfig() never touches disk.
 */
export function marketplaceModalGoldenSurface(): BoundModalSurface {
  const root = mkdtempSync(join(tmpdir(), 'gv-marketplace-golden-'));
  const surface = bindMarketplaceModal({ ecosystemPaths: { cwd: root, homeDir: root, projectCatalogRoot: join(root, 'ecosystem') } });
  surface.refresh();
  rmSync(root, { recursive: true, force: true });
  return surface;
}
