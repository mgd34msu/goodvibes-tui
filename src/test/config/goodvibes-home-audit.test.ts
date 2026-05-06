import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  auditGoodVibesHome,
  diffHomeSnapshots,
  findDisallowedHomeMutations,
  renderGoodVibesHomeAuditMarkdown,
  snapshotGoodVibesHome,
} from '../../config/goodvibes-home-audit.ts';

function makeTempHome(): string {
  const root = join(tmpdir(), `gv-home-audit-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(root, 'tui'), { recursive: true });
  mkdirSync(join(root, 'daemon', '.goodvibes', 'tui'), { recursive: true });
  mkdirSync(join(root, 'archive'), { recursive: true });
  return root;
}

function writeJson(path: string, value: unknown, mode?: number): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode });
}

describe('GoodVibes home audit', () => {
  let home = '';

  afterEach(() => {
    if (home) rmSync(home, { recursive: true, force: true });
    home = '';
  });

  test('classifies current, dynamic, default-only, and stale TUI settings', async () => {
    home = makeTempHome();
    writeJson(join(home, 'tui', 'settings.json'), {
      provider: {
        model: 'openai:gpt-5.5',
        provider: 'openai',
      },
      danger: {
        daemon: true,
        agentRecursion: true,
      },
      featureFlags: {
        'web-surface': 'enabled',
      },
      notifications: {
        webhookUrls: [],
      },
      surfaces: {
        matrix: {
          enabled: false,
          homeserverUrl: '',
          accessToken: '',
          setupVersion: 0,
        },
      },
    });
    writeFileSync(join(home, 'tui', 'secrets.enc'), 'encrypted', { mode: 0o644 });
    writeFileSync(join(home, 'OpenAI.api.json'), '{}\n');
    writeFileSync(join(home, 'archive', 'old.txt'), 'legacy\n');

    const audit = await auditGoodVibesHome({ homeDir: home });
    const byKey = new Map(audit.settings.keys.map((entry) => [entry.key, entry.classification]));

    expect(byKey.get('provider.model')).toBe('current-schema');
    expect(byKey.get('featureFlags.web-surface')).toBe('known-dynamic');
    expect(byKey.get('notifications.webhookUrls')).toBe('known-dynamic');
    expect(byKey.get('surfaces.matrix.setupVersion')).toBe('default-config-dynamic');
    expect(byKey.get('provider.provider')).toBe('unknown-stale-candidate');
    expect(byKey.get('danger.agentRecursion')).toBe('unknown-stale-candidate');
    expect(audit.settings.staleCandidates).toEqual(expect.arrayContaining([
      'danger.agentRecursion',
      'provider.provider',
    ]));
    expect(audit.findings.some((finding) => finding.code === 'sensitive-file-permissions')).toBe(true);
    expect(audit.summaries.map((summary) => summary.owner)).toEqual(expect.arrayContaining([
      'tui',
      'foreign-goodvibes-product',
    ]));
  });

  test('detects duplicate profile prefix patterns without deleting profiles', async () => {
    home = makeTempHome();
    mkdirSync(join(home, 'tui', 'profiles'), { recursive: true });
    writeJson(join(home, 'tui', 'settings.json'), {});
    writeJson(join(home, 'tui', 'profiles', 'team-release.json'), {});
    writeJson(join(home, 'tui', 'profiles', 'team-team-release.json'), {});
    writeJson(join(home, 'tui', 'profiles', 'team-team-team-ops.json'), {});

    const audit = await auditGoodVibesHome({ homeDir: home });

    expect(audit.duplicateProfilePatterns).toContainEqual({
      normalizedName: 'team-release.json',
      count: 2,
    });
  });

  test('snapshots and flags writes outside approved TUI/daemon roots', async () => {
    home = makeTempHome();
    writeJson(join(home, 'tui', 'settings.json'), { provider: { model: 'openai:gpt-5.5' } });
    writeFileSync(join(home, 'HomeAssistant.api.json'), '{}\n');

    const before = await snapshotGoodVibesHome(home);
    writeJson(join(home, 'tui', 'settings.json'), { provider: { model: 'openai:gpt-5.4' } });
    writeFileSync(join(home, 'HomeAssistant.api.json'), '{"changed":true}\n');
    const after = await snapshotGoodVibesHome(home);

    const diff = diffHomeSnapshots(before, after);
    expect(diff.changed).toEqual(expect.arrayContaining([
      'HomeAssistant.api.json',
      'tui/settings.json',
    ]));
    expect(findDisallowedHomeMutations(diff)).toEqual(['HomeAssistant.api.json']);
  });

  test('renders a markdown audit report for human review', async () => {
    home = makeTempHome();
    writeJson(join(home, 'tui', 'settings.json'), {
      danger: { agentRecursion: true },
    });

    const audit = await auditGoodVibesHome({ homeDir: home });
    const markdown = renderGoodVibesHomeAuditMarkdown(audit);

    expect(markdown).toContain('# GoodVibes Home Audit');
    expect(markdown).toContain('Stale Setting Candidates');
    expect(markdown).toContain('danger.agentRecursion');
  });
});
