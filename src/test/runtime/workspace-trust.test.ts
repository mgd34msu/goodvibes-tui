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
    const mgr = new WorkspaceTrustManager({ shellPaths: makePaths(workspace) });
    await mgr.load();
    expect(mgr.isDecided()).toBe(false);
    expect(mgr.getLevel()).toBe('restricted');
    expect(mgr.isTrusted()).toBe(false);
    expect(mgr.isCategoryAllowed('read')).toBe(true);
    expect(mgr.isCategoryAllowed('write')).toBe(false);
    expect(mgr.isCategoryAllowed('execute')).toBe(false);
    expect(mgr.isCategoryAllowed('delegate')).toBe(false);
  });

  // The grandfather-by-side-effect is gone: a workspace that already
  // carries prior GoodVibes runtime state gets NO special treatment anymore —
  // it stays undecided just like any other new WorkspaceTrustManager, and the
  // first non-read tool request is what raises the real question (via
  // trustGatedAsk's requestTrustDecision callback), never a silent
  // side-effect of the state already sitting on disk.
  it('prior GoodVibes runtime state no longer grandfathers trust — the workspace still starts undecided', async () => {
    mkdirSync(join(workspace, '.goodvibes', 'sessions'), { recursive: true });
    writeFileSync(join(workspace, '.goodvibes', 'sessions', 's.json'), '{}');
    expect(detectPriorWorkspaceState(workspace)).toBe(true);

    const mgr = new WorkspaceTrustManager({ shellPaths: makePaths(workspace) });
    await mgr.load();
    expect(mgr.isDecided()).toBe(false);
    expect(mgr.isTrusted()).toBe(false);
    expect(mgr.wasGrandfathered()).toBe(false);
  });

  it('setLevel(trusted) allows all categories and persists across reloads', async () => {
    const mgr = new WorkspaceTrustManager({ shellPaths: makePaths(workspace) });
    await mgr.load();
    await mgr.setLevel('trusted');
    expect(mgr.isCategoryAllowed('write')).toBe(true);
    expect(mgr.isCategoryAllowed('execute')).toBe(true);
    const reloaded = new WorkspaceTrustManager({ shellPaths: makePaths(workspace) });
    await reloaded.load();
    expect(reloaded.isDecided()).toBe(true);
    expect(reloaded.isTrusted()).toBe(true);
    expect(reloaded.wasGrandfathered()).toBe(false);
  });

  it('setLevel(restricted) explicitly keeps writes denied but is a decided state', async () => {
    const mgr = new WorkspaceTrustManager({ shellPaths: makePaths(workspace) });
    await mgr.load();
    await mgr.setLevel('restricted');
    expect(mgr.isDecided()).toBe(true);
    expect(mgr.isCategoryAllowed('read')).toBe(true);
    expect(mgr.isCategoryAllowed('write')).toBe(false);
  });

  it('an already-persisted grandfathered decision (from before this fix) still reads honestly', async () => {
    // Simulates a trust.json written by the old grandfathering behavior —
    // reading it must not crash or silently re-decide it.
    mkdirSync(join(workspace, '.goodvibes', 'tui'), { recursive: true });
    writeFileSync(
      join(workspace, '.goodvibes', 'tui', 'trust.json'),
      JSON.stringify({ level: 'trusted', decidedAt: new Date().toISOString(), grandfathered: true }),
    );
    const mgr = new WorkspaceTrustManager({ shellPaths: makePaths(workspace) });
    await mgr.load();
    expect(mgr.isDecided()).toBe(true);
    expect(mgr.isTrusted()).toBe(true);
    expect(mgr.wasGrandfathered()).toBe(true);
  });
});

describe('trustGatedAsk', () => {
  it('denies non-read tools when EXPLICITLY restricted (a real prior decision), without calling ask or raising the trust prompt', async () => {
    let asked = false;
    let promptRaised = false;
    const ask = async () => {
      asked = true;
      return { approved: true };
    };
    const restricted = {
      isCategoryAllowed: (c: string) => c === 'read',
      isDecided: () => true,
      setLevel: async () => {},
    };
    const gated = trustGatedAsk(restricted as never, ask, async () => {
      promptRaised = true;
      return 'restricted';
    });
    const writeReq = { category: 'write' } as never;
    expect(await gated(writeReq)).toEqual({ approved: false });
    expect(asked).toBe(false);
    expect(promptRaised).toBe(false);
    const readReq = { category: 'read' } as never;
    expect(await gated(readReq)).toEqual({ approved: true });
    expect(asked).toBe(true);
  });

  it('passes every category through when trusted, without ever raising the trust prompt', async () => {
    const ask = async () => ({ approved: true });
    let promptRaised = false;
    const trusted = { isCategoryAllowed: () => true, isDecided: () => true, setLevel: async () => {} };
    const gated = trustGatedAsk(trusted as never, ask, async () => {
      promptRaised = true;
      return 'trusted';
    });
    expect(await gated({ category: 'execute' } as never)).toEqual({ approved: true });
    expect(promptRaised).toBe(false);
  });

  // The actual fix: an UNDECIDED workspace's first non-read request no
  // longer silently denies without a prompt — it raises requestTrustDecision,
  // persists the answer via setLevel, and forwards the ORIGINAL request to ask
  // when the answer is 'trusted' (so the thing the user just approved
  // actually happens instead of failing anyway).
  describe('undecided workspace (no decision yet)', () => {
    function makeUndecidedManager(initialLevel: 'trusted' | 'restricted' | null = null) {
      let level = initialLevel;
      const setLevelCalls: string[] = [];
      const manager = {
        isCategoryAllowed: (c: string) => (level === 'trusted' ? true : c === 'read'),
        isDecided: () => level !== null,
        setLevel: async (l: 'trusted' | 'restricted') => {
          level = l;
          setLevelCalls.push(l);
        },
      };
      return { manager, setLevelCalls, getLevel: () => level };
    }

    it('raises the trust prompt on the first non-read request, and denies when the answer is restricted', async () => {
      const { manager, setLevelCalls } = makeUndecidedManager();
      let asked = false;
      const ask = async () => { asked = true; return { approved: true }; };
      let promptCalls = 0;
      const gated = trustGatedAsk(manager as never, ask, async () => { promptCalls += 1; return 'restricted'; });

      const result = await gated({ category: 'write' } as never);
      expect(promptCalls).toBe(1);
      expect(setLevelCalls).toEqual(['restricted']);
      expect(result).toEqual({ approved: false });
      expect(asked).toBe(false);
    });

    it('raises the trust prompt on the first non-read request, and forwards the ORIGINAL request to ask when the answer is trusted', async () => {
      const { manager, setLevelCalls } = makeUndecidedManager();
      let askedWith: unknown;
      const ask = async (req: unknown) => { askedWith = req; return { approved: true }; };
      let promptCalls = 0;
      const gated = trustGatedAsk(manager as never, ask, async () => { promptCalls += 1; return 'trusted'; });

      const writeReq = { category: 'write', tool: 'write_file' } as never;
      const result = await gated(writeReq);
      expect(promptCalls).toBe(1);
      expect(setLevelCalls).toEqual(['trusted']);
      expect(result).toEqual({ approved: true });
      expect(askedWith).toBe(writeReq);
    });

    it('does not raise a second trust prompt for a later request once the workspace is decided', async () => {
      const { manager } = makeUndecidedManager();
      const ask = async () => ({ approved: true });
      let promptCalls = 0;
      const gated = trustGatedAsk(manager as never, ask, async () => { promptCalls += 1; return 'trusted'; });

      await gated({ category: 'write' } as never);
      await gated({ category: 'execute' } as never);
      expect(promptCalls).toBe(1);
    });

    it('coalesces concurrent requests into ONE trust prompt, not one per request', async () => {
      const { manager } = makeUndecidedManager();
      const ask = async () => ({ approved: true });
      let promptCalls = 0;
      let resolvePrompt!: (level: 'trusted' | 'restricted') => void;
      const gated = trustGatedAsk(manager as never, ask, () => {
        promptCalls += 1;
        return new Promise((resolve) => { resolvePrompt = resolve; });
      });

      const first = gated({ category: 'write' } as never);
      const second = gated({ category: 'execute' } as never);
      // Both requests arrived before the prompt resolved.
      expect(promptCalls).toBe(1);
      resolvePrompt('trusted');
      const [firstResult, secondResult] = await Promise.all([first, second]);
      expect(firstResult).toEqual({ approved: true });
      expect(secondResult).toEqual({ approved: true });
      expect(promptCalls).toBe(1);
    });
  });
});
