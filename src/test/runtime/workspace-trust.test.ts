import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  WorkspaceTrustManager,
  detectPriorWorkspaceState,
  trustGatedAsk,
} from '../../runtime/trust/workspace-trust.ts';

let workspace: string;

function makePaths(root: string) {
  return {
    projectGoodVibesRoot: join(root, '.goodvibes'),
    resolveProjectPath: (...segments: string[]) => join(root, '.goodvibes', ...segments),
  };
}

beforeEach(() => {
  workspace = join(tmpdir(), `gv-trust-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(workspace, { recursive: true });
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

describe('detectPriorWorkspaceState', () => {
  it('is false for a workspace with no .goodvibes', () => {
    expect(detectPriorWorkspaceState(workspace)).toBe(false);
  });

  it('is false for a bare .goodvibes with only committed scaffolding (agents/GOODVIBES.md)', () => {
    mkdirSync(join(workspace, '.goodvibes', 'agents'), { recursive: true });
    writeFileSync(join(workspace, '.goodvibes', 'GOODVIBES.md'), '# scaffold\n');
    expect(detectPriorWorkspaceState(workspace)).toBe(false);
  });

  it('is true when a prior checkpoints index exists', () => {
    mkdirSync(join(workspace, '.goodvibes', 'checkpoints'), { recursive: true });
    writeFileSync(join(workspace, '.goodvibes', 'checkpoints', 'index.json'), '{}');
    expect(detectPriorWorkspaceState(workspace)).toBe(true);
  });

  it('is true when a non-empty sessions dir exists', () => {
    mkdirSync(join(workspace, '.goodvibes', 'sessions'), { recursive: true });
    writeFileSync(join(workspace, '.goodvibes', 'sessions', 's.json'), '{}');
    expect(detectPriorWorkspaceState(workspace)).toBe(true);
  });
});

describe('WorkspaceTrustManager', () => {
  it('a new workspace is undecided and restricted: reads allowed, writes denied', async () => {
    const mgr = new WorkspaceTrustManager({ shellPaths: makePaths(workspace), hadPriorState: false });
    await mgr.load();
    expect(mgr.isDecided()).toBe(false);
    expect(mgr.getLevel()).toBe('restricted');
    expect(mgr.isTrusted()).toBe(false);
    expect(mgr.isCategoryAllowed('read')).toBe(true);
    expect(mgr.isCategoryAllowed('write')).toBe(false);
    expect(mgr.isCategoryAllowed('execute')).toBe(false);
    expect(mgr.isCategoryAllowed('delegate')).toBe(false);
  });

  it('grandfathers a workspace that already had prior state, and persists the decision', async () => {
    const mgr = new WorkspaceTrustManager({ shellPaths: makePaths(workspace), hadPriorState: true });
    await mgr.load();
    expect(mgr.isDecided()).toBe(true);
    expect(mgr.isTrusted()).toBe(true);
    expect(mgr.wasGrandfathered()).toBe(true);
    // Persisted: a fresh manager (even without the prior-state hint) reads trusted.
    const reloaded = new WorkspaceTrustManager({ shellPaths: makePaths(workspace), hadPriorState: false });
    await reloaded.load();
    expect(reloaded.isTrusted()).toBe(true);
  });

  it('setLevel(trusted) allows all categories and persists across reloads', async () => {
    const mgr = new WorkspaceTrustManager({ shellPaths: makePaths(workspace), hadPriorState: false });
    await mgr.load();
    await mgr.setLevel('trusted');
    expect(mgr.isCategoryAllowed('write')).toBe(true);
    expect(mgr.isCategoryAllowed('execute')).toBe(true);
    const reloaded = new WorkspaceTrustManager({ shellPaths: makePaths(workspace), hadPriorState: false });
    await reloaded.load();
    expect(reloaded.isDecided()).toBe(true);
    expect(reloaded.isTrusted()).toBe(true);
    expect(reloaded.wasGrandfathered()).toBe(false);
  });

  it('setLevel(restricted) explicitly keeps writes denied but is a decided state', async () => {
    const mgr = new WorkspaceTrustManager({ shellPaths: makePaths(workspace), hadPriorState: false });
    await mgr.load();
    await mgr.setLevel('restricted');
    expect(mgr.isDecided()).toBe(true);
    expect(mgr.isCategoryAllowed('read')).toBe(true);
    expect(mgr.isCategoryAllowed('write')).toBe(false);
  });
});

describe('trustGatedAsk', () => {
  it('denies non-read tools when restricted without calling the underlying ask', async () => {
    let asked = false;
    const ask = async () => {
      asked = true;
      return { approved: true };
    };
    const restricted = { isCategoryAllowed: (c: string) => c === 'read' };
    const gated = trustGatedAsk(restricted as never, ask);
    const writeReq = { category: 'write' } as never;
    expect(await gated(writeReq)).toEqual({ approved: false });
    expect(asked).toBe(false);
    const readReq = { category: 'read' } as never;
    expect(await gated(readReq)).toEqual({ approved: true });
    expect(asked).toBe(true);
  });

  it('passes every category through when trusted', async () => {
    const ask = async () => ({ approved: true });
    const trusted = { isCategoryAllowed: () => true };
    const gated = trustGatedAsk(trusted as never, ask);
    expect(await gated({ category: 'execute' } as never)).toEqual({ approved: true });
  });
});
