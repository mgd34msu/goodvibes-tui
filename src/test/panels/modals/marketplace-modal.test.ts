import { describe, test, expect } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bindMarketplaceModal } from '../../../panels/modals/marketplace-modal.ts';
import { EMPTY_VIEW, type ModalViewState } from '../../../panels/modals/modal-surface.ts';
import type { ModalConfig } from '../../../renderer/modal-factory.ts';
import type { UiMarketplaceSnapshot, UiReadModel } from '../../../runtime/ui-read-models.ts';
import type { EcosystemCatalogEntry, EcosystemCatalogPathOptions, EcosystemEntryKind } from '@/runtime/index.ts';

/** Flatten a ModalConfig's text/list/title content into one searchable string. */
function configText(config: ModalConfig): string {
  const parts: string[] = [config.title];
  if (config.search !== undefined) parts.push(config.search);
  for (const section of config.sections) {
    if (section.content) parts.push(section.content);
    for (const item of section.items ?? []) parts.push(item.label);
  }
  for (const hint of config.hints ?? []) parts.push(hint);
  if (config.footer) parts.push(config.footer);
  return parts.join('\n');
}

function fixedReadModel(snapshot: UiMarketplaceSnapshot): UiReadModel<UiMarketplaceSnapshot> {
  return { getSnapshot: () => snapshot, subscribe: () => () => {} };
}

function makeEntry(kind: EcosystemEntryKind, id: string, name: string, sourcePath: string): EcosystemCatalogEntry {
  return { id, kind, name, summary: `${name} summary`, source: sourcePath, tags: [], provenance: 'local', version: '1.0.0' };
}

/** Write catalog files under a fresh tmp catalog root and return path options. */
function seedCatalog(entriesByKind: Partial<Record<EcosystemEntryKind, EcosystemCatalogEntry[]>>): {
  paths: EcosystemCatalogPathOptions;
  cleanup: () => void;
} {
  const root = mkdtempSync(join(tmpdir(), 'gv-marketplace-modal-'));
  const catalogRoot = join(root, 'ecosystem');
  mkdirSync(catalogRoot, { recursive: true });
  const plural: Record<EcosystemEntryKind, string> = {
    plugin: 'plugins', skill: 'skills', 'hook-pack': 'hook-packs', 'policy-pack': 'policy-packs',
  };
  for (const [kind, entries] of Object.entries(entriesByKind)) {
    writeFileSync(join(catalogRoot, `${plural[kind as EcosystemEntryKind]}.json`), JSON.stringify({ version: 1, entries }));
  }
  return {
    paths: { cwd: root, homeDir: root, projectCatalogRoot: catalogRoot, userCatalogRoot: join(root, 'user-ecosystem') },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

describe('marketplace modal builder', () => {
  test('B30: honest empty-state names it a local publish/import catalog (not a remote store)', () => {
    // Catalog roots ARE wired (production case) but the catalog is empty.
    const { paths, cleanup } = seedCatalog({});
    try {
      const surface = bindMarketplaceModal({ ecosystemPaths: paths });
      surface.refresh();
      const text = configText(surface.buildConfig(EMPTY_VIEW));
      expect(text).toContain('not a remote store');
      expect(text).toContain('published or imported');
      // Existing action hints preserved.
      expect(text).toContain('/marketplace publish');
      expect(text).toContain('/marketplace bundle import');
      expect(text).toContain('/marketplace catalog review');
      // No stale "curated" framing.
      expect(text).not.toContain('No curated marketplace entries found yet');
    } finally {
      cleanup();
    }
  });

  test('degraded (no catalog roots) states roots are not wired', () => {
    const surface = bindMarketplaceModal({ readModel: fixedReadModel({ startupIssues: [], recommendations: [] }) });
    surface.refresh();
    const text = configText(surface.buildConfig(EMPTY_VIEW));
    expect(text.toLowerCase()).toContain('wired into this session');
    expect(surface.rowIds(EMPTY_VIEW)).toHaveLength(0);
  });

  test('populated catalog lists entries with install posture and selected detail', () => {
    const { paths, cleanup } = seedCatalog({
      plugin: [makeEntry('plugin', 'formatter', 'Formatter', '/tmp/x')],
    });
    try {
      const surface = bindMarketplaceModal({ ecosystemPaths: paths });
      surface.refresh();
      const config = surface.buildConfig(EMPTY_VIEW);
      const text = configText(config);
      expect(text).toContain('Formatter');
      expect(text).toContain('local'); // provenance
      // posture summary present
      expect(text).toContain('catalog 1');
      // selected-entry detail rendered
      expect(text).toContain('compatibility');
      expect(surface.rowIds(EMPTY_VIEW)).toEqual(['plugin:formatter']);
    } finally {
      cleanup();
    }
  });

  test('install action routes to the /marketplace command path (no modal-ized confirm)', () => {
    const { paths, cleanup } = seedCatalog({
      plugin: [makeEntry('plugin', 'formatter', 'Formatter', '/tmp/x')],
    });
    try {
      const surface = bindMarketplaceModal({ ecosystemPaths: paths });
      surface.refresh();
      const outcome = surface.actions.install!(EMPTY_VIEW);
      expect(outcome).toEqual({ kind: 'runCommand', command: '/marketplace install plugin formatter' });
      // refresh action re-renders live
      expect(surface.actions.refresh!(EMPTY_VIEW)).toEqual({ kind: 'refresh' });
      // uninstall on an un-installed entry is a no-op
      expect(surface.actions.uninstall!(EMPTY_VIEW)).toEqual({ kind: 'none' });
    } finally {
      cleanup();
    }
  });

  test('read-model recommendations and startup issues surface in the config', () => {
    const { paths, cleanup } = seedCatalog({
      plugin: [makeEntry('plugin', 'formatter', 'Formatter', '/tmp/x')],
    });
    try {
      const snapshot: UiMarketplaceSnapshot = {
        startupIssues: ['plugin foo failed to load'],
        recommendations: [{
          id: 'rec1', title: 'Install bar', reason: 'used often', kind: 'plugin',
          entry: makeEntry('plugin', 'bar', 'Bar', '/tmp/bar'), command: '/marketplace install plugin bar',
        }],
      };
      const surface = bindMarketplaceModal({ ecosystemPaths: paths, readModel: fixedReadModel(snapshot) });
      surface.refresh();
      const text = configText(surface.buildConfig({ ...EMPTY_VIEW } as ModalViewState));
      expect(text).toContain('plugin foo failed to load');
      expect(text).toContain('Install bar');
      expect(text).toContain('/marketplace install plugin bar');
    } finally {
      cleanup();
    }
  });
});
