import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  installEcosystemCatalogEntry,
  listInstalledEcosystemEntries,
  loadEcosystemCatalog,
  searchEcosystemCatalog,
  uninstallEcosystemCatalogEntry,
} from '../../../runtime/ecosystem/catalog.ts';

describe('ecosystem catalog', () => {
  const originalHome = process.env.HOME;
  let root = '';
  let homeDir = '';

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'gv-ecosystem-'));
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

    const entries = loadEcosystemCatalog('plugin', { cwd: root, homeDir });
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

    const entries = searchEcosystemCatalog('skill', 'release', { cwd: root, homeDir });
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

    const installResult = installEcosystemCatalogEntry('plugin', 'deploy-audit', { cwd: root, homeDir, scope: 'project' });
    expect(installResult.ok).toBe(true);
    if (!installResult.ok) return;
    expect(existsSync(join(root, '.goodvibes', 'plugins', 'deploy-audit', 'manifest.json'))).toBe(true);

    const receipts = listInstalledEcosystemEntries('plugin', { cwd: root, homeDir });
    expect(receipts).toHaveLength(1);
    expect(receipts[0]?.entry.id).toBe('deploy-audit');
    expect(readFileSync(join(root, '.goodvibes', 'tui', 'ecosystem', 'installed', 'plugin-deploy-audit.json'), 'utf-8')).toContain('"scope": "project"');

    const uninstallResult = uninstallEcosystemCatalogEntry('plugin', 'deploy-audit', { cwd: root, homeDir, scope: 'project' });
    expect(uninstallResult.ok).toBe(true);
    expect(existsSync(join(root, '.goodvibes', 'plugins', 'deploy-audit'))).toBe(false);
  });
});
