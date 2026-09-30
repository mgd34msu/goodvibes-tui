import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { WorkspaceRegistrationStore } from '@pellux/goodvibes-sdk/platform/workspace';
import { WorkspaceRegistrationManager } from '@pellux/goodvibes-sdk/platform/runtime/operations';
import { selfRecordWorkspaceRegistration } from '../../cli/tui-startup.ts';

let home: string;

function makeShellPaths(root: string, workingDirectory: string) {
  const userRoot = join(root, '.goodvibes');
  return {
    workingDirectory,
    homeDirectory: root,
    resolveUserPath: (...segments: string[]) => join(userRoot, ...segments),
  };
}

/** An in-memory store configured exactly like the manager's default (shared roots). */
function memoryStore(root: string): WorkspaceRegistrationStore {
  const daemonStateDir = join(root, '.goodvibes');
  return new WorkspaceRegistrationStore({
    path: ':memory:',
    homeDir: dirname(daemonStateDir),
    daemonStateDir,
  });
}

beforeEach(() => {
  home = join(tmpdir(), `gv-reg-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(home, { recursive: true });
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe('WorkspaceRegistrationManager', () => {

  it('a TUI self-record stamps origin "tui" and stays checkpoint-ineligible', async () => {
    const project = join(home, 'projects', 'app');
    mkdirSync(project, { recursive: true });
    const store = memoryStore(home);
    const mgr = new WorkspaceRegistrationManager({ shellPaths: makeShellPaths(home, project), store });

    await selfRecordWorkspaceRegistration(mgr);

    const record = (await store.snapshot()).workspaces.find((w) => w.root.endsWith('/app'));
    expect(record).toBeDefined();
    expect(record!.origin).toBe('tui');
    expect(record!.checkpointEligible ?? false).toBe(false);
  });
});
