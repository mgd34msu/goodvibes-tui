import { describe, test, expect } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createMarketplaceModalSurface } from '../../../panels/modals/marketplace-modal.ts';
import type { UiMarketplaceSnapshot, UiReadModel } from '../../../runtime/ui-read-models.ts';
import type { EcosystemCatalogEntry, EcosystemCatalogPathOptions, EcosystemEntryKind } from '@/runtime/index.ts';
import { actionCtx, captureCommands, findAction, open, tabRows, tabText } from './modal-surface-test-helpers.ts';
import { makeProjectTempDir } from '../../helpers/project-temp.ts';

function fixedReadModel(snapshot: UiMarketplaceSnapshot): UiReadModel<UiMarketplaceSnapshot> {
  return { getSnapshot: () => snapshot, subscribe: () => () => {} };
}
function makeEntry(kind: EcosystemEntryKind, id: string, name: string, sourcePath: string): EcosystemCatalogEntry {
  return { id, kind, name, summary: `${name} summary`, source: sourcePath, tags: [], provenance: 'local', version: '1.0.0' };
}
function seedCatalog(entriesByKind: Partial<Record<EcosystemEntryKind, EcosystemCatalogEntry[]>>): { paths: EcosystemCatalogPathOptions; cleanup: () => void } {
  const root = makeProjectTempDir('gv-marketplace-modal');
  const catalogRoot = join(root, 'ecosystem');
  mkdirSync(catalogRoot, { recursive: true });
  const plural: Record<EcosystemEntryKind, string> = { plugin: 'plugins', skill: 'skills', 'hook-pack': 'hook-packs', 'policy-pack': 'policy-packs' };
  for (const [kind, entries] of Object.entries(entriesByKind)) {
    writeFileSync(join(catalogRoot, `${plural[kind as EcosystemEntryKind]}.json`), JSON.stringify({ version: 1, entries }));
  }
  return { paths: { cwd: root, homeDir: root, projectCatalogRoot: catalogRoot, userCatalogRoot: join(root, 'user-ecosystem') }, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

describe('marketplace modal surface', () => {
  test('surface identity', () => {
    expect(createMarketplaceModalSurface({}).name).toBe('marketplace-modal');
  });

  test('honest empty-state copy is byte-preserved (local publish/import catalog, not a remote store)', () => {
    const { paths, cleanup } = seedCatalog({}); // roots wired, catalog empty
    try {
      const view = open(createMarketplaceModalSurface({ ecosystemPaths: paths }));
      const labels = tabRows(view, 'catalog').map((r) => r.label);
      // Byte-for-byte: the exact locked copy (straight quotes, em-dash separators, alignment spacing).
      expect(labels).toContain('This is your local plugin, skill, hook-pack, and policy-pack catalog; not a remote store.');
      expect(labels).toContain("It's empty because nothing has been published or imported into this workspace yet. Entries appear here once you publish a local component or import a bundle.");
      expect(labels).toContain('Populate it');
      expect(labels).toContain('/marketplace publish <kind> <path>  — publish local plugins/skills into the catalog');
      expect(labels).toContain('/marketplace bundle import <path>   — import a catalog bundle from disk');
      expect(labels).toContain('/marketplace catalog review         — inspect the current local catalog posture');
      // No stale "curated" framing survives.
      expect(tabText(view, 'catalog')).not.toContain('No curated marketplace entries found yet');
    } finally { cleanup(); }
  });

  test('degraded (no catalog roots) states roots are not wired', () => {
    const view = open(createMarketplaceModalSurface({ readModel: fixedReadModel({ startupIssues: [], recommendations: [] }) }));
    expect(tabText(view, 'catalog')).toContain("aren't wired into this session");
    // No selectable catalog rows.
    expect(tabRows(view, 'catalog').every((r) => r.selectable === false)).toBe(true);
  });

  test('populated catalog lists entries with install posture and folded compat/risk detail', () => {
    const { paths, cleanup } = seedCatalog({ plugin: [makeEntry('plugin', 'formatter', 'Formatter', '/tmp/x')] });
    try {
      const view = open(createMarketplaceModalSurface({ ecosystemPaths: paths }));
      const text = tabText(view, 'catalog');
      expect(text).toContain('Formatter');
      expect(text).toContain('local');
      expect(text).toContain('catalog 1'); // posture header
      expect(text).toContain('compat'); // folded selection-detail
      expect(tabRows(view, 'catalog').some((r) => r.id === 'plugin:formatter')).toBe(true);
    } finally { cleanup(); }
  });

  test('install routes to the /marketplace command path; uninstall on an un-installed entry is a no-op', () => {
    const { paths, cleanup } = seedCatalog({ plugin: [makeEntry('plugin', 'formatter', 'Formatter', '/tmp/x')] });
    try {
      const surface = createMarketplaceModalSurface({ ecosystemPaths: paths });
      open(surface);
      const row = { id: 'plugin:formatter', label: '' };
      const install = captureCommands();
      surface.onAction?.('install', actionCtx(row, install.extra));
      expect(install.calls).toEqual([['marketplace', ['install', 'plugin', 'formatter']]]);
      // enabledFor gates uninstall off an un-installed entry.
      expect(findAction(surface, 'uninstall')?.enabledFor?.(row, 'catalog')).toBe(false);
      const uninstall = captureCommands();
      surface.onAction?.('uninstall', actionCtx(row, uninstall.extra));
      expect(uninstall.calls).toEqual([]);
    } finally { cleanup(); }
  });

  test('read-model recommendations and startup issues surface in the view', () => {
    const { paths, cleanup } = seedCatalog({ plugin: [makeEntry('plugin', 'formatter', 'Formatter', '/tmp/x')] });
    try {
      const snapshot: UiMarketplaceSnapshot = {
        startupIssues: ['plugin foo failed to load'],
        recommendations: [{ id: 'rec1', title: 'Install bar', reason: 'used often', kind: 'plugin', entry: makeEntry('plugin', 'bar', 'Bar', '/tmp/bar'), command: '/marketplace install plugin bar' }],
      };
      const text = tabText(open(createMarketplaceModalSurface({ ecosystemPaths: paths, readModel: fixedReadModel(snapshot) })), 'catalog');
      expect(text).toContain('plugin foo failed to load');
      expect(text).toContain('Install bar');
      expect(text).toContain('/marketplace install plugin bar');
    } finally { cleanup(); }
  });
});
