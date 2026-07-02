import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MarketplacePanel } from '../../panels/marketplace-panel.ts';

describe('MarketplacePanel', () => {
  let root: string;
  const originalCwd = process.cwd();
  const originalHome = process.env.HOME;

  beforeEach(() => {
    const tempRoot = join(process.cwd(), '.tmp-tests');
    mkdirSync(tempRoot, { recursive: true });
    root = mkdtempSync(join(tempRoot, 'gv-marketplace-panel-'));
    process.chdir(root);
    process.env.HOME = root;
    mkdirSync(join(root, '.goodvibes', 'tui', 'ecosystem'), { recursive: true });
    writeFileSync(join(root, '.goodvibes', 'tui', 'ecosystem', 'plugins.json'), JSON.stringify({
      version: 1,
      entries: [{
        id: 'deploy-audit',
        kind: 'plugin',
        name: 'Deploy Audit',
        summary: 'Reviews deploy surfaces before release',
        source: './catalog/plugins/deploy-audit',
        tags: ['security'],
        provenance: 'curated-local',
      }],
    }, null, 2));
    writeFileSync(join(root, '.goodvibes', 'tui', 'ecosystem', 'hook-packs.json'), JSON.stringify({
      version: 1,
      entries: [{
        id: 'guard-pack',
        kind: 'hook-pack',
        name: 'Guard Pack',
        summary: 'Shared hook guards for risky tool paths',
        source: './catalog/hooks/guard-pack',
        tags: ['hooks'],
      }],
    }, null, 2));
    // Install source paths must exist on disk for installEcosystemCatalogEntry
    // to succeed (see catalog.js reviewEcosystemCatalogEntry.sourceExists).
    mkdirSync(join(root, 'catalog', 'plugins', 'deploy-audit'), { recursive: true });
    writeFileSync(join(root, 'catalog', 'plugins', 'deploy-audit', 'plugin.json'), '{}');
    mkdirSync(join(root, 'catalog', 'hooks', 'guard-pack'), { recursive: true });
    writeFileSync(join(root, 'catalog', 'hooks', 'guard-pack', 'hooks.json'), '{}');
  });

  afterEach(() => {
    process.chdir(originalCwd);
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    rmSync(root, { recursive: true, force: true });
  });

  function makePaths() {
    return {
      cwd: root,
      homeDir: root,
      projectCatalogRoot: join(root, '.goodvibes', 'tui', 'ecosystem'),
      userCatalogRoot: join(root, '.goodvibes', 'tui', 'ecosystem'),
    };
  }

  test('renders curated marketplace entries and provenance hints', () => {
    const panel = new MarketplacePanel(undefined, makePaths());
    panel.onActivate();
    const text = panel.render(90, 16).flat().map((cell) => cell.char).join('');
    expect(text).toContain('Marketplace Control Room');
    expect(text).toContain('Deploy Audit');
    expect(text).toContain('Guard Pack');
    expect(text).toContain('curated-local');
    expect(text).toContain('/marketplace open');
    // Curated (not-installed) selection surfaces a real 'i' install key hint,
    // not a printed slash-command signpost.
    expect(text).toContain('install');
  });

  test('render() does not reload the catalogs from disk (refresh only happens on activate/r)', () => {
    const panel = new MarketplacePanel(undefined, makePaths());
    panel.onActivate();
    panel.render(90, 16);
    const rowsBefore = (panel as unknown as { rows: unknown[] }).rows.length;
    // Remove a catalog file after activation; if render() still reloaded from
    // disk per frame, the row count would drop on this next render() call.
    writeFileSync(join(root, '.goodvibes', 'tui', 'ecosystem', 'hook-packs.json'), JSON.stringify({ version: 1, entries: [] }, null, 2));
    panel.render(90, 16);
    const rowsAfter = (panel as unknown as { rows: unknown[] }).rows.length;
    expect(rowsAfter).toBe(rowsBefore);
  });

  test('r re-reads the catalogs from disk', () => {
    const panel = new MarketplacePanel(undefined, makePaths());
    panel.onActivate();
    writeFileSync(join(root, '.goodvibes', 'tui', 'ecosystem', 'hook-packs.json'), JSON.stringify({ version: 1, entries: [] }, null, 2));
    panel.handleInput('r');
    const text = panel.render(90, 16).flat().map((cell) => cell.char).join('');
    expect(text).not.toContain('Guard Pack');
  });

  test('i installs the selected curated entry with ConfirmState, and receipts show up as installed', () => {
    const panel = new MarketplacePanel(undefined, makePaths());
    panel.onActivate();
    // Rows sort by name: 'Deploy Audit' before 'Guard Pack'; select Deploy Audit (plugin).
    expect(panel.handleInput('i')).toBe(true);
    let text = panel.render(90, 16).flat().map((cell) => cell.char).join('');
    expect(text).toContain('Install');
    expect(text).toContain('Deploy Audit');
    expect(panel.handleInput('enter')).toBe(true);
    text = panel.render(90, 16).flat().map((cell) => cell.char).join('');
    expect(text).toContain('INSTALLED');
  });

  test('u uninstalls a previously installed entry with ConfirmState', () => {
    const panel = new MarketplacePanel(undefined, makePaths());
    panel.onActivate();
    panel.handleInput('i');
    panel.handleInput('enter');
    let text = panel.render(90, 16).flat().map((cell) => cell.char).join('');
    expect(text).toContain('INSTALLED');
    expect(panel.handleInput('u')).toBe(true);
    expect(panel.handleInput('enter')).toBe(true);
    text = panel.render(90, 16).flat().map((cell) => cell.char).join('');
    expect(text).toContain('CURATED');
  });

  test('Enter expands full review detail for the selected entry', () => {
    const panel = new MarketplacePanel(undefined, makePaths());
    panel.onActivate();
    panel.render(90, 20);
    expect(panel.handleInput('enter')).toBe(true);
    const text = panel.render(90, 20).flat().map((cell) => cell.char).join('');
    expect(text).toContain('Source path');
    expect(text).toContain('Recommended scope');
  });
});
