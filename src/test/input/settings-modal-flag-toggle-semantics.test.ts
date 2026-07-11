/**
 * Flag-toggle semantics against the live config→flag bridge (SDK 1.6.1).
 *
 * Verifies the TUI's toggle path (applyFlagState, used by the settings modal)
 * and the /flags overview keep persisted config and live manager state
 * consistent, and honestly distinguish the two flag classes:
 *
 *   - runtime-toggleable flag  → applies live (manager state flips) AND is
 *     persisted as an override; no restart pending.
 *   - startup-gated flag       → persisted as an override AND marked
 *     pending-restart; the effective manager state is UNCHANGED until the next
 *     launch (never faked live).
 *
 * Uses a real FeatureFlagManager and a real on-disk ConfigManager — no mocks —
 * so the persistence and bridge behavior are exercised for real.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ConfigManager } from '@pellux/goodvibes-sdk/platform/config';
import { createFeatureFlagManager } from '../../runtime/index.ts';
import type { FeatureFlagManager } from '../../runtime/index.ts';
import { buildFlagEntries } from '../../input/settings-modal-data.ts';
import { applyFlagState } from '../../input/settings-modal-mutations.ts';
import { formatFlagsOverview, type FlagSnapshotEntry } from '../../input/commands/flags-runtime.ts';
import type { FlagEntry } from '../../input/settings-modal-types.ts';

// A flag that flips live, and one gated to startup — both default to a known
// state so the toggle direction is unambiguous.
const RUNTIME_FLAG = 'hitl-ux-modes'; // runtimeToggleable, default disabled
const STARTUP_FLAG = 'permissions-policy-engine'; // startup-gated, default disabled

describe('flag-toggle semantics — applyFlagState + config bridge', () => {
  let tmpDir: string;
  let cm: ConfigManager;
  let manager: FeatureFlagManager;

  const newManager = () =>
    new ConfigManager({
      surfaceRoot: 'tui',
      workingDir: tmpDir,
      homeDir: tmpDir,
      configDir: join(tmpDir, '.goodvibes', 'global-tui'),
    });

  const overrides = () => cm.getCategory('featureFlags') as Record<string, string>;
  const entryFor = (id: string): FlagEntry => {
    const entry = buildFlagEntries(manager).find((e) => e.flag.id === id);
    if (!entry) throw new Error(`test flag ${id} not registered`);
    return entry;
  };

  beforeEach(() => {
    tmpDir = join(tmpdir(), `gv-flag-toggle-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tmpDir, { recursive: true });
    cm = newManager();
    manager = createFeatureFlagManager();
    manager.loadFromConfig({ flags: {} });
  });

  afterEach(() => {
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  });

  test('runtime-toggleable flag: live effect AND persisted, no restart pending', () => {
    expect(manager.isEnabled(RUNTIME_FLAG)).toBe(false);
    const entry = entryFor(RUNTIME_FLAG);

    applyFlagState(entry, 'enabled', manager, cm);

    // Live effect: the manager sees it enabled now.
    expect(manager.isEnabled(RUNTIME_FLAG)).toBe(true);
    expect(manager.getState(RUNTIME_FLAG)).toBe('enabled');
    expect(manager.hasPendingRestart(RUNTIME_FLAG)).toBe(false);

    // Persisted: the override is written to disk and survives reload.
    expect(overrides()[RUNTIME_FLAG]).toBe('enabled');
    const reloaded = newManager();
    expect((reloaded.getCategory('featureFlags') as Record<string, string>)[RUNTIME_FLAG]).toBe('enabled');

    // The FlagEntry mirrors the manager's real state.
    expect(entry.state).toBe('enabled');
    expect(entry.pendingRestart).toBe(false);
    expect(entry.persistedState).toBe('enabled');
  });

  test('startup-gated flag: persisted + pendingRestart, effective state unchanged', () => {
    expect(manager.getState(STARTUP_FLAG)).toBe('disabled');
    const entry = entryFor(STARTUP_FLAG);

    applyFlagState(entry, 'enabled', manager, cm);

    // Effective state is NOT faked live — still disabled until restart.
    expect(manager.getState(STARTUP_FLAG)).toBe('disabled');
    expect(manager.isEnabled(STARTUP_FLAG)).toBe(false);

    // But the change is recorded as pending a restart, with the target value.
    expect(manager.hasPendingRestart(STARTUP_FLAG)).toBe(true);
    expect(manager.getPendingRestartState(STARTUP_FLAG)).toBe('enabled');

    // And it is persisted so the next launch picks it up.
    expect(overrides()[STARTUP_FLAG]).toBe('enabled');
    const reloaded = newManager();
    expect((reloaded.getCategory('featureFlags') as Record<string, string>)[STARTUP_FLAG]).toBe('enabled');

    // The FlagEntry reflects the unchanged effective state plus the pending marker.
    expect(entry.state).toBe('disabled');
    expect(entry.pendingRestart).toBe(true);
    expect(entry.persistedState).toBe('enabled');
  });

  test('a fresh runtime that loads the persisted startup-gated override applies it with no pending marker', () => {
    // First session persists the startup-gated flag on.
    applyFlagState(entryFor(STARTUP_FLAG), 'enabled', manager, cm);

    // Next launch: a new manager seeded from the same on-disk config.
    const reloadedCm = newManager();
    const nextManager = createFeatureFlagManager();
    nextManager.loadFromConfig({
      flags: reloadedCm.getCategory('featureFlags') as Record<string, 'enabled' | 'disabled' | 'killed'>,
    });

    // Now the flag is genuinely effective, and nothing is pending.
    expect(nextManager.getState(STARTUP_FLAG)).toBe('enabled');
    expect(nextManager.hasPendingRestart(STARTUP_FLAG)).toBe(false);
  });

  test('/flags overview surfaces the pending-restart marker for a startup-gated flag', () => {
    applyFlagState(entryFor(STARTUP_FLAG), 'enabled', manager, cm);

    const snapshot: FlagSnapshotEntry[] = Array.from(manager.getAll().values()).map(
      ({ flag, state, persistedState, pendingRestart }) => ({ flag, state, persistedState, pendingRestart }),
    );
    const text = formatFlagsOverview(snapshot);

    expect(text).toContain('restart pending: saved enabled');
    expect(text).toContain('still disabled until next launch');
  });
});
