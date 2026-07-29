/**
 * shared-voice-tier.test.ts
 *
 * TUI-side proof for the SDK's shared voice tier (SDK main@03924e3d,
 * ConfigManager's `tts.*` resolution through `~/.goodvibes/shared/settings.json`,
 * see `packages/sdk/src/platform/config/{manager,shared-config-tier}.ts` and the
 * SDK's own `test/config-shared-voice-tier.test.ts`).
 *
 * The TUI's real ConfigManager construction sites (src/cli/entrypoint.ts,
 * src/daemon/cli.ts, src/runtime/legacy-daemon-migration.ts) all pass an
 * explicit `homeDir` + `surfaceRoot: 'tui'` and never override `sharedTierPath`,
 * so this is a mechanical consequence of the SDK's own logic rather than
 * something the TUI implements — this test exists to prove that stays true for
 * THIS surface's exact construction shape, not to re-derive the SDK's
 * resolution-order behavior (already covered by the SDK's own test suite).
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { ConfigManager } from '@pellux/goodvibes-sdk/platform/config';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

const roots: string[] = [];
function home(): string {
  const dir = makeProjectTempDir('gv-tui-shared-voice');
  roots.push(dir);
  return dir;
}
function sharedFile(h: string): string {
  return join(h, '.goodvibes', 'shared', 'settings.json');
}

afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('shared voice tier — TUI ConfigManager construction shape', () => {
  test('a voice set under another surface root resolves in the TUI manager', () => {
    const h = home();
    // Simulate another surface (e.g. the agent) setting the voice first.
    const other = new ConfigManager({ homeDir: h, surfaceRoot: 'agent' });
    other.set('tts.voice', 'rachel');
    other.set('tts.speed', 1.5);

    // The TUI constructs its ConfigManager the same way its real entrypoints do:
    // homeDir + surfaceRoot: 'tui', no sharedTierPath override (see
    // src/cli/entrypoint.ts, src/daemon/cli.ts).
    const tui = new ConfigManager({ homeDir: h, surfaceRoot: 'tui' });
    expect(tui.get('tts.voice')).toBe('rachel');
    expect(tui.get('tts.speed')).toBe(1.5);
    expect(tui.describeConfigKeySource('tts.voice').tier).toBe('shared');
  });

  test('the TUI manager writes tts.* keys to the shared tier, not its own surface silo', () => {
    const h = home();
    const tui = new ConfigManager({ homeDir: h, surfaceRoot: 'tui' });
    tui.set('tts.voice', 'daniel');

    expect(existsSync(sharedFile(h))).toBe(true);
    const shared = JSON.parse(readFileSync(sharedFile(h), 'utf-8')) as { tts?: { voice?: string } };
    expect(shared.tts?.voice).toBe('daniel');

    const surfacePath = tui.getConfigPath();
    if (existsSync(surfacePath)) {
      const surface = JSON.parse(readFileSync(surfacePath, 'utf-8')) as { tts?: { voice?: string } };
      expect(surface.tts?.voice ?? '').not.toBe('daniel');
    }

    // A second TUI-surface-root manager (e.g. a second TUI process on the same
    // home) sees the same write — the tier is keyed on homeDir, not process identity.
    const tuiAgain = new ConfigManager({ homeDir: h, surfaceRoot: 'tui' });
    expect(tuiAgain.get('tts.voice')).toBe('daniel');
  });

  test('a non-shared key set through the TUI manager stays out of the shared tier', () => {
    const h = home();
    const tui = new ConfigManager({ homeDir: h, surfaceRoot: 'tui' });
    tui.set('provider.model', 'openai:gpt-tui-shared-test');

    if (existsSync(sharedFile(h))) {
      const shared = JSON.parse(readFileSync(sharedFile(h), 'utf-8')) as { provider?: unknown };
      expect(shared.provider).toBeUndefined();
    }
    const other = new ConfigManager({ homeDir: h, surfaceRoot: 'agent' });
    expect(other.get('provider.model')).not.toBe('openai:gpt-tui-shared-test');
  });
});
