import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { WorkspaceRegistrationStore } from '@pellux/goodvibes-sdk/platform/workspace';
import { WorkspaceRegistrationManager } from '../../runtime/trust/workspace-registration.ts';
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
  it('a never-seen project directory resolves unknown and offers registration', async () => {
    const project = join(home, 'projects', 'app');
    mkdirSync(project, { recursive: true });
    const mgr = new WorkspaceRegistrationManager({
      shellPaths: makeShellPaths(home, project),
      store: memoryStore(home),
    });
    const evaluation = await mgr.evaluate();
    expect(evaluation.status).toBe('unknown');
    expect(evaluation.broad).toBe(false);
    expect(evaluation.offerRegister).toBe(true);
  });

  it('registering flips resolution to covered and stops offering', async () => {
    const project = join(home, 'projects', 'app');
    mkdirSync(project, { recursive: true });
    const store = memoryStore(home);
    const mgr = new WorkspaceRegistrationManager({ shellPaths: makeShellPaths(home, project), store });
    const outcome = await mgr.register();
    expect(outcome.registered).toBe(true);
    const evaluation = await mgr.evaluate();
    expect(evaluation.status).toBe('covered');
    expect(evaluation.coveredBy).toBe(project);
    expect(evaluation.offerRegister).toBe(false);
  });

  it('coverage flows down a registered root to a child directory', async () => {
    const parent = join(home, 'projects', 'app');
    const child = join(parent, 'packages', 'core');
    mkdirSync(child, { recursive: true });
    const store = memoryStore(home);
    await new WorkspaceRegistrationManager({ shellPaths: makeShellPaths(home, parent), store }).register();
    const childMgr = new WorkspaceRegistrationManager({ shellPaths: makeShellPaths(home, child), store });
    const evaluation = await childMgr.evaluate();
    expect(evaluation.status).toBe('covered');
    expect(evaluation.coveredBy).toBe(parent);
    expect(evaluation.offerRegister).toBe(false);
  });

  it('a declined directory resolves declined and never re-offers', async () => {
    const project = join(home, 'projects', 'app');
    mkdirSync(project, { recursive: true });
    const store = memoryStore(home);
    const mgr = new WorkspaceRegistrationManager({ shellPaths: makeShellPaths(home, project), store });
    await mgr.decline();
    const evaluation = await mgr.evaluate();
    expect(evaluation.status).toBe('declined');
    expect(evaluation.offerRegister).toBe(false);
  });

  it('a broad root (the home directory) is never offered and the store refuses it', async () => {
    const mgr = new WorkspaceRegistrationManager({
      shellPaths: makeShellPaths(home, home),
      store: memoryStore(home),
    });
    const evaluation = await mgr.evaluate();
    expect(evaluation.broad).toBe(true);
    expect(evaluation.offerRegister).toBe(false);
    const outcome = await mgr.register();
    expect(outcome.registered).toBe(false);
    if (!outcome.registered) expect(outcome.refusedReason).toContain('refusing to register');
  });

  it('the filesystem root is treated as broad', async () => {
    const mgr = new WorkspaceRegistrationManager({
      shellPaths: makeShellPaths(home, '/'),
      store: memoryStore(home),
    });
    const evaluation = await mgr.evaluate();
    expect(evaluation.broad).toBe(true);
    expect(evaluation.offerRegister).toBe(false);
  });

  it('describe() reports honest posture for each status', async () => {
    const project = join(home, 'projects', 'app');
    mkdirSync(project, { recursive: true });
    const store = memoryStore(home);
    const mgr = new WorkspaceRegistrationManager({ shellPaths: makeShellPaths(home, project), store });
    expect(await mgr.describe()).toContain('never asked');
    await mgr.register();
    expect(await mgr.describe()).toContain('registered');
  });

  it('register stamps origin and never marks a record checkpoint-eligible', async () => {
    const project = join(home, 'projects', 'app');
    mkdirSync(project, { recursive: true });
    const store = memoryStore(home);
    const mgr = new WorkspaceRegistrationManager({ shellPaths: makeShellPaths(home, project), store });

    await mgr.register('via TUI', 'tui');

    const record = (await store.snapshot()).workspaces.find((w) => w.root.endsWith('/app'));
    expect(record).toBeDefined();
    expect(record!.origin).toBe('tui');
    expect(record!.label).toBe('via TUI');
    // Absent means false — a TUI self-record must never widen the checkpoint boundary.
    expect(record!.checkpointEligible ?? false).toBe(false);
  });

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
