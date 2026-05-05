import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  exportEcosystemCatalogBundle,
  importEcosystemCatalogBundle,
  inspectInstalledEcosystemEntry,
  installEcosystemCatalogEntry,
  listInstalledEcosystemEntries,
  loadEcosystemCatalog,
  searchEcosystemCatalog,
  uninstallEcosystemCatalogEntry,
} from '@/runtime/index.ts';

describe('ecosystem catalog', () => {
  const originalHome = process.env.HOME;
  const testTmpRoot = join(import.meta.dir, '../../../../.tmp-tests');
  let root = '';
  let homeDir = '';

  function ecosystemPaths(cwd: string, homeDirectory: string) {
    return {
      cwd,
      homeDir: homeDirectory,
      projectCatalogRoot: join(cwd, '.goodvibes', 'tui', 'ecosystem'),
      userCatalogRoot: join(homeDirectory, '.goodvibes', 'tui', 'ecosystem'),
    } as const;
  }

  beforeEach(() => {
    mkdirSync(testTmpRoot, { recursive: true });
    root = mkdtempSync(join(testTmpRoot, 'gv-ecosystem-'));
    homeDir = join(root, 'home');
    mkdirSync(homeDir, { recursive: true });
    process.env.HOME = homeDir;
    mkdirSync(join(root, '.goodvibes', 'tui', 'ecosystem'), { recursive: true });
  });

  afterEach(() => {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
  });

  test('loads curated plugin entries from project-local catalog files', () => {
    writeFileSync(join(root, '.goodvibes', 'tui', 'ecosystem', 'plugins.json'), JSON.stringify({
      version: 1,
      entries: [
        {
          id: 'deploy-audit',
          kind: 'plugin',
          name: 'Deploy Audit',
          summary: 'Reviews deploy surfaces before release',
          source: 'git+https://example.com/deploy-audit.git',
          tags: ['security', 'release'],
          trustNotes: 'Requires limited trust for manifest inspection',
        },
      ],
    }, null, 2));

    const entries = loadEcosystemCatalog('plugin', ecosystemPaths(root, homeDir));
    expect(entries).toHaveLength(1);
    expect(entries[0]?.id).toBe('deploy-audit');
  });

  test('searches curated skill entries by summary and tags', () => {
    writeFileSync(join(root, '.goodvibes', 'tui', 'ecosystem', 'skills.json'), JSON.stringify({
      version: 1,
      entries: [
        {
          id: 'release-gate',
          kind: 'skill',
          name: 'Release Gate',
          summary: 'Runs release certification and deploy checks',
          source: 'repo:skills/release-gate',
          tags: ['release', 'ops'],
          installHint: 'Copy into .goodvibes/skills/release-gate/SKILL.md',
        },
      ],
    }, null, 2));

    const entries = searchEcosystemCatalog('skill', 'release', ecosystemPaths(root, homeDir));
    expect(entries).toHaveLength(1);
    expect(entries[0]?.name).toBe('Release Gate');
  });

  test('installs and uninstalls curated local-path entries with receipts', () => {
    mkdirSync(join(root, 'catalog', 'plugins', 'deploy-audit'), { recursive: true });
    writeFileSync(join(root, 'catalog', 'plugins', 'deploy-audit', 'manifest.json'), JSON.stringify({
      name: 'deploy-audit',
      version: '1.0.0',
      description: 'Reviews deploy surfaces before release',
    }, null, 2));
    writeFileSync(join(root, 'catalog', 'plugins', 'deploy-audit', 'index.ts'), 'export function init() {}\n');

    writeFileSync(join(root, '.goodvibes', 'tui', 'ecosystem', 'plugins.json'), JSON.stringify({
      version: 1,
      entries: [
        {
          id: 'deploy-audit',
          kind: 'plugin',
          name: 'Deploy Audit',
          summary: 'Reviews deploy surfaces before release',
          source: './catalog/plugins/deploy-audit',
          tags: ['security', 'release'],
        },
      ],
    }, null, 2));

    const installResult = installEcosystemCatalogEntry('plugin', 'deploy-audit', {
      ...ecosystemPaths(root, homeDir),
      scope: 'project',
    });
    expect(installResult.ok).toBe(true);
    if (!installResult.ok) return;
    expect(existsSync(join(root, '.goodvibes', 'plugins', 'deploy-audit', 'manifest.json'))).toBe(true);

    const receipts = listInstalledEcosystemEntries('plugin', ecosystemPaths(root, homeDir));
    expect(receipts).toHaveLength(1);
    expect(receipts[0]?.entry.id).toBe('deploy-audit');
    expect(receipts[0]?.fingerprint).toHaveLength(64);
    expect(readFileSync(join(root, '.goodvibes', 'tui', 'ecosystem', 'installed', 'plugin-deploy-audit.json'), 'utf-8')).toContain('"scope": "project"');

    const inspected = inspectInstalledEcosystemEntry('plugin', 'deploy-audit', {
      ...ecosystemPaths(root, homeDir),
      scope: 'project',
    });
    expect(inspected.ok).toBe(true);
    if (inspected.ok) {
      expect(inspected.receipt.compatibility.appVersion).toBeDefined();
      expect(inspected.receipt.provenanceSummary).toBe('./catalog/plugins/deploy-audit');
    }

    const uninstallResult = uninstallEcosystemCatalogEntry('plugin', 'deploy-audit', {
      ...ecosystemPaths(root, homeDir),
      scope: 'project',
    });
    expect(uninstallResult.ok).toBe(true);
    expect(existsSync(join(root, '.goodvibes', 'plugins', 'deploy-audit'))).toBe(false);
  });

  test('exports and imports ecosystem catalog bundles', () => {
    writeFileSync(join(root, '.goodvibes', 'tui', 'ecosystem', 'plugins.json'), JSON.stringify({
      version: 1,
      entries: [
        {
          id: 'deploy-audit',
          kind: 'plugin',
          name: 'Deploy Audit',
          summary: 'Reviews deploy surfaces before release',
          version: '1.0.0',
          author: 'GoodVibes',
          source: './catalog/plugins/deploy-audit',
          tags: ['security', 'release'],
          provenance: 'curated-local',
        },
      ],
    }, null, 2));
    writeFileSync(join(root, '.goodvibes', 'tui', 'ecosystem', 'skills.json'), JSON.stringify({
      version: 1,
      entries: [
        {
          id: 'release-gate',
          kind: 'skill',
          name: 'Release Gate',
          summary: 'Runs release certification and deploy checks',
          source: './catalog/skills/release-gate',
          tags: ['release'],
          compatibility: { minAppVersion: '0.14.0' },
        },
      ],
    }, null, 2));
    writeFileSync(join(root, '.goodvibes', 'tui', 'ecosystem', 'hook-packs.json'), JSON.stringify({
      version: 1,
      entries: [
        {
          id: 'guard-pack',
          kind: 'hook-pack',
          name: 'Guard Pack',
          summary: 'Shared hook guards for risky tool paths',
          source: './catalog/hooks/guard-pack',
          tags: ['hooks', 'security'],
        },
      ],
    }, null, 2));
    writeFileSync(join(root, '.goodvibes', 'tui', 'ecosystem', 'policy-packs.json'), JSON.stringify({
      version: 1,
      entries: [
        {
          id: 'strict-policy',
          kind: 'policy-pack',
          name: 'Strict Policy',
          summary: 'Operator-reviewed restrictive policy pack',
          source: './catalog/policies/strict-policy',
          tags: ['policy', 'security'],
        },
      ],
    }, null, 2));

    const bundle = exportEcosystemCatalogBundle('project', ecosystemPaths(root, homeDir));
    expect(bundle.entries).toHaveLength(4);

    const importedRoot = join(root, 'imported');
    mkdirSync(join(importedRoot, '.goodvibes', 'tui', 'ecosystem'), { recursive: true });
    const imported = importEcosystemCatalogBundle(bundle, {
      ...ecosystemPaths(importedRoot, homeDir),
      scope: 'project',
    });
    expect(imported.imported).toBe(4);

    const importedPlugins = loadEcosystemCatalog('plugin', ecosystemPaths(importedRoot, homeDir));
    const importedSkills = loadEcosystemCatalog('skill', ecosystemPaths(importedRoot, homeDir));
    const importedHookPacks = loadEcosystemCatalog('hook-pack', ecosystemPaths(importedRoot, homeDir));
    const importedPolicyPacks = loadEcosystemCatalog('policy-pack', ecosystemPaths(importedRoot, homeDir));
    expect(importedPlugins).toHaveLength(1);
    expect(importedSkills).toHaveLength(1);
    expect(importedHookPacks).toHaveLength(1);
    expect(importedPolicyPacks).toHaveLength(1);
    expect(importedPlugins[0]?.author).toBe('GoodVibes');
    expect(importedSkills[0]?.compatibility?.minAppVersion).toBe('0.14.0');
  });
});
