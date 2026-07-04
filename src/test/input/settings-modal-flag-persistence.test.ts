/**
 * Tests for persistFlagState (settings-modal-mutations.ts) against a REAL
 * ConfigManager on disk.
 *
 * Regression coverage for the Wave-5 replay finding: toggling a flag back to
 * its default left the stale override in settings.json (getCategory clones
 * and mergeCategory only sets keys, so the old delete-then-merge was a silent
 * no-op) — the flag then silently reloaded in the overridden state on the
 * next start. The default-state path must REMOVE the override on disk.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { ConfigManager } from '@pellux/goodvibes-sdk/platform/config';
import { persistFlagState } from '../../input/settings-modal-mutations.ts';

describe('persistFlagState override lifecycle', () => {
  let tmpDir: string;
  let cm: ConfigManager;

  const newManager = () =>
    new ConfigManager({ surfaceRoot: 'tui', workingDir: tmpDir, homeDir: tmpDir, configDir: join(tmpDir, '.goodvibes', 'global-tui') });

  beforeEach(() => {
    tmpDir = join(tmpdir(), `gv-flag-persist-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tmpDir, { recursive: true });
    cm = newManager();
  });

  afterEach(() => {
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  });

  const overrides = () => cm.getCategory('featureFlags') as Record<string, string>;

  test('non-default state writes an override', () => {
    persistFlagState(cm, 'agent-passive-knowledge-injection', 'disabled', 'enabled');
    expect(overrides()['agent-passive-knowledge-injection']).toBe('disabled');
  });

  test('returning to the default REMOVES the override, and the removal survives reload from disk', () => {
    persistFlagState(cm, 'agent-passive-knowledge-injection', 'disabled', 'enabled');
    expect(overrides()['agent-passive-knowledge-injection']).toBe('disabled');

    // The user's "re-enable" action: back to the flag's default state.
    persistFlagState(cm, 'agent-passive-knowledge-injection', 'enabled', 'enabled');
    expect('agent-passive-knowledge-injection' in overrides()).toBe(false);

    // The replay repro read settings.json after restart — model that with a
    // fresh manager over the same config dir.
    const reloaded = newManager();
    const persisted = reloaded.getCategory('featureFlags') as Record<string, string>;
    expect('agent-passive-knowledge-injection' in persisted).toBe(false);
  });

  test('killed state is never persisted', () => {
    persistFlagState(cm, 'some-flag', 'killed', 'enabled');
    expect('some-flag' in overrides()).toBe(false);
  });
});
