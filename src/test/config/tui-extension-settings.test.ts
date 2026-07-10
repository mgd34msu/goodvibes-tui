import { describe, expect, test } from 'bun:test';
import { readCheckpointGuardSettings } from '@/config/tui-extension-settings.ts';
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

// End-to-end wiring — that the values flow into WorkspaceCheckpointManager and
// actually change its root-guard behavior — is deliberately NOT exercised here.
// The pinned platform SDK (@pellux/goodvibes-sdk 1.6.1) predates these options:
// its constructor reads only workspaceRoot/checkpointDir/runtimeBus/retention/now
// and silently ignores the guard keys. Re-enable this once the SDK is upgraded
// to a build whose WorkspaceCheckpointManagerOptions declares them.
describe.skip('checkpoint root-guard wiring (pending SDK upgrade)', () => {
  test('preferGitRoot/allowBroadRoot change the effective snapshot root', () => {
    // Intentionally empty: see the note above.
  });
});
