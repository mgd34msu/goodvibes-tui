import { describe, expect, test, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkspaceCheckpointManager } from '@pellux/goodvibes-sdk/platform/workspace';
import { readCheckpointGuardSettings, readUpdateSettings, withCheckpointGuardSettings } from '@/config/tui-extension-settings.ts';
import type { ConfigManager } from '@/config/index.ts';

// A minimal stand-in for the ConfigManager surface the reader depends on.
function fakeConfig(raw: Record<string, unknown>): Pick<ConfigManager, 'getRaw'> {
  return { getRaw: () => raw as ReturnType<ConfigManager['getRaw']> };
}

describe('readCheckpointGuardSettings', () => {
  test('returns empty object when the checkpoints namespace is absent', () => {
    expect(readCheckpointGuardSettings(fakeConfig({}))).toEqual({});
  });

  test('returns empty object when checkpoints is malformed (not an object)', () => {
    expect(readCheckpointGuardSettings(fakeConfig({ checkpoints: 'nope' }))).toEqual({});
    expect(readCheckpointGuardSettings(fakeConfig({ checkpoints: [1, 2] }))).toEqual({});
    expect(readCheckpointGuardSettings(fakeConfig({ checkpoints: null }))).toEqual({});
  });

  test('reads all well-typed keys', () => {
    const settings = readCheckpointGuardSettings(fakeConfig({
      checkpoints: {
        preferGitRoot: false,
        allowBroadRoot: true,
        allowLargeFirstSnapshot: true,
        maxFirstSnapshotFiles: 12000,
        autoRetention: false,
      },
    }));
    expect(settings).toEqual({
      preferGitRoot: false,
      allowBroadRoot: true,
      allowLargeFirstSnapshot: true,
      maxFirstSnapshotFiles: 12000,
      autoRetention: false,
    });
  });

  test('drops keys with the wrong type so the SDK default applies', () => {
    const settings = readCheckpointGuardSettings(fakeConfig({
      checkpoints: {
        preferGitRoot: 'true', // wrong type -> dropped
        maxFirstSnapshotFiles: -5, // non-positive -> dropped
        allowBroadRoot: true, // valid -> kept
      },
    }));
    expect(settings).toEqual({ allowBroadRoot: true });
  });

  test('floors a fractional maxFirstSnapshotFiles', () => {
    const settings = readCheckpointGuardSettings(fakeConfig({
      checkpoints: { maxFirstSnapshotFiles: 100.9 },
    }));
    expect(settings).toEqual({ maxFirstSnapshotFiles: 100 });
  });

  test('returns only the subset the user actually set', () => {
    const settings = readCheckpointGuardSettings(fakeConfig({
      checkpoints: { allowBroadRoot: true },
    }));
    expect(settings).toEqual({ allowBroadRoot: true });
  });
});

// End-to-end wiring — that the user's checkpoints.* values flow through
// withCheckpointGuardSettings into WorkspaceCheckpointManager and actually
// change its root-guard behavior. @pellux/goodvibes-sdk 1.6.1's
// WorkspaceCheckpointManagerOptions now declares these guard keys
// (preferGitRoot/allowBroadRoot/allowLargeFirstSnapshot/maxFirstSnapshotFiles/
// autoRetention), so the previously-inert options are live and observable via
// create()'s refusals. Each case runs the REAL manager against a scratch
// workspace, merging the guard settings exactly as services.ts does.
describe('checkpoint root-guard wiring (SDK 1.6.1 options are live)', () => {
  const tempDirs: string[] = [];
  afterEach(() => {
    while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
  });
  function scratch(): string {
    const dir = mkdtempSync(join(tmpdir(), 'gv-guard-wiring-'));
    tempDirs.push(dir);
    return dir;
  }

  test('allowBroadRoot reaches the manager: false refuses a home-directory root, true permits it', async () => {
    // homeDir === workspaceRoot makes the root look "broad"; the guard then
    // hinges purely on the allowBroadRoot key the user set in checkpoints.*.
    const dirRefused = scratch();
    writeFileSync(join(dirRefused, 'f.txt'), 'hello');
    const refusingMgr = new WorkspaceCheckpointManager(
      withCheckpointGuardSettings(
        { workspaceRoot: dirRefused, homeDir: dirRefused },
        fakeConfig({ checkpoints: { allowBroadRoot: false } }),
      ),
    );
    await expect(refusingMgr.create({ kind: 'manual', label: 'x', retentionClass: 'forensic' }))
      .rejects.toThrow(/home directory|refus/i);

    const dirAllowed = scratch();
    writeFileSync(join(dirAllowed, 'f.txt'), 'hello');
    const allowingMgr = new WorkspaceCheckpointManager(
      withCheckpointGuardSettings(
        { workspaceRoot: dirAllowed, homeDir: dirAllowed },
        fakeConfig({ checkpoints: { allowBroadRoot: true } }),
      ),
    );
    const cp = await allowingMgr.create({ kind: 'manual', label: 'x', retentionClass: 'forensic' });
    expect(cp).not.toBeNull();
  });

  test('maxFirstSnapshotFiles + allowLargeFirstSnapshot reach the manager: a tiny ceiling refuses the first snapshot unless the override is set', async () => {
    const dirRefused = scratch();
    for (let i = 0; i < 5; i++) writeFileSync(join(dirRefused, `f${i}.txt`), 'x');
    const tinyCeilingMgr = new WorkspaceCheckpointManager(
      withCheckpointGuardSettings(
        { workspaceRoot: dirRefused },
        fakeConfig({ checkpoints: { maxFirstSnapshotFiles: 2, allowLargeFirstSnapshot: false } }),
      ),
    );
    await expect(tinyCeilingMgr.create({ kind: 'manual', label: 'x', retentionClass: 'forensic' }))
      .rejects.toThrow(/first checkpoint|sweep|refus/i);

    const dirAllowed = scratch();
    for (let i = 0; i < 5; i++) writeFileSync(join(dirAllowed, `f${i}.txt`), 'x');
    const overrideMgr = new WorkspaceCheckpointManager(
      withCheckpointGuardSettings(
        { workspaceRoot: dirAllowed },
        fakeConfig({ checkpoints: { maxFirstSnapshotFiles: 2, allowLargeFirstSnapshot: true } }),
      ),
    );
    const cp = await overrideMgr.create({ kind: 'manual', label: 'x', retentionClass: 'forensic' });
    expect(cp).not.toBeNull();
  });
});

describe('readUpdateSettings', () => {
  test('returns empty object when the update namespace is absent or malformed', () => {
    expect(readUpdateSettings(fakeConfig({}))).toEqual({});
    expect(readUpdateSettings(fakeConfig({ update: 'nope' }))).toEqual({});
    expect(readUpdateSettings(fakeConfig({ update: null }))).toEqual({});
  });

  test('reads an explicit autoUpdateAtLaunch=false (the off switch is a real setting)', () => {
    expect(readUpdateSettings(fakeConfig({ update: { autoUpdateAtLaunch: false } }))).toEqual({ autoUpdateAtLaunch: false });
  });

  test('drops a wrong-typed autoUpdateAtLaunch so the consumer default (on) applies', () => {
    expect(readUpdateSettings(fakeConfig({ update: { autoUpdateAtLaunch: 'yes' } }))).toEqual({});
  });

  test('clamps launchCheckTimeoutMs into [250, 30000] and drops non-positive values', () => {
    expect(readUpdateSettings(fakeConfig({ update: { launchCheckTimeoutMs: 5 } }))).toEqual({ launchCheckTimeoutMs: 250 });
    expect(readUpdateSettings(fakeConfig({ update: { launchCheckTimeoutMs: 120000 } }))).toEqual({ launchCheckTimeoutMs: 30000 });
    expect(readUpdateSettings(fakeConfig({ update: { launchCheckTimeoutMs: 4000 } }))).toEqual({ launchCheckTimeoutMs: 4000 });
    expect(readUpdateSettings(fakeConfig({ update: { launchCheckTimeoutMs: -1 } }))).toEqual({});
  });
});
