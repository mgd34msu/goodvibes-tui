import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MarketplacePanel } from '../../panels/marketplace-panel.ts';

describe('MarketplacePanel', () => {
  let root: string;
  const originalCwd = process.cwd();
  const originalHome = process.env.HOME;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'gv-marketplace-panel-'));
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
  });

  afterEach(() => {
    process.chdir(originalCwd);
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
  });

  test('renders curated marketplace entries and provenance hints', () => {
    const panel = new MarketplacePanel(undefined, { cwd: root, homeDir: root });
    panel.onActivate();
    const text = panel.render(90, 16).flat().map((cell) => cell.char).join('');
    expect(text).toContain('Marketplace Control Room');
    expect(text).toContain('Deploy Audit');
    expect(text).toContain('Guard Pack');
    expect(text).toContain('curated-local');
    expect(text).toContain('/marketplace open');
  });
});
