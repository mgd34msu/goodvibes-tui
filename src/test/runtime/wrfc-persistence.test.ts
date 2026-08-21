import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { RuntimeEventBus, createEventEnvelope } from '@/runtime/index.ts';
import type { WrfcChain } from '@pellux/goodvibes-sdk/platform/agents';
import { createWrfcPersistence } from '@/runtime/wrfc-persistence.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

// ─── Helpers ───────────────────────────────────────────────────────────────

function makeChain(overrides: Partial<WrfcChain> = {}): WrfcChain {
  return {
    id: `chain-${crypto.randomUUID().slice(0, 8)}`,
    state: 'engineering',
    task: 'implement the feature',
    ownerAgentId: 'agent-owner',
    reviewCycles: 0,
    ...overrides,
  } as WrfcChain;
}

function flushTimers(): Promise<void> {
  // Advance past the 250 ms debounce using a real timeout.
  return new Promise((resolve) => setTimeout(resolve, 300));
}

function readSnapshotFile(path: string): { version: number; writtenAt: number; chains: WrfcChain[] } {
  return JSON.parse(readFileSync(path, 'utf-8')) as { version: number; writtenAt: number; chains: WrfcChain[] };
}

function emitWorkflowEvent(
  runtimeBus: RuntimeEventBus,
  type: 'WORKFLOW_CHAIN_CREATED' | 'WORKFLOW_STATE_CHANGED' | 'WORKFLOW_CHAIN_PASSED' | 'WORKFLOW_CHAIN_FAILED',
  chainId: string,
): void {
  runtimeBus.emit(
    'workflows',
    createEventEnvelope(type, { type, chainId } as never, { sessionId: 'test', traceId: 'trace', source: 'test' }),
  );
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('wrfc-persistence', () => {
  let tmpDir: string;
  let snapshotPath: string;
  let runtimeBus: RuntimeEventBus;
  let chains: WrfcChain[];
  let routerMessages: string[];

  const mockRouter = {
    wrfc: (msg: string) => { routerMessages.push(msg); },
  } as unknown as import('@/core/system-message-router.ts').SystemMessageRouter;

  beforeEach(() => {
    tmpDir = makeProjectTempDir('gv-wrfc-persist');
    snapshotPath = join(tmpDir, 'wrfc-chains.json');
    runtimeBus = new RuntimeEventBus();
    chains = [];
    routerMessages = [];
  });

  afterEach(() => {
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── snapshot write on state change (debounced) ─────────────────────────

  test('writes snapshot after debounce on WORKFLOW_STATE_CHANGED', async () => {
    const chain = makeChain({ state: 'reviewing' });
    chains = [chain];

    const persistence = createWrfcPersistence({
      snapshotPath,
      getSystemMessageRouter: () => null,
      controller: { listChains: () => chains },
    });
    const unsubs = persistence.attach(runtimeBus);

    emitWorkflowEvent(runtimeBus, 'WORKFLOW_STATE_CHANGED', chain.id);

    // Snapshot should not exist yet (debounce pending)
    expect(existsSync(snapshotPath)).toBe(false);

    await flushTimers();

    expect(existsSync(snapshotPath)).toBe(true);
    const snap = readSnapshotFile(snapshotPath);
    expect(snap.version).toBe(1);
    expect(snap.chains).toHaveLength(1);
    expect(snap.chains[0]!.id).toBe(chain.id);

    for (const unsub of unsubs) unsub();
  });

  test('collapses multiple events into one write via debounce', async () => {
    const chain = makeChain();
    chains = [chain];
    let writeCount = 0;

    const persistence = createWrfcPersistence({
      snapshotPath,
      getSystemMessageRouter: () => null,
      controller: {
        listChains: () => {
          writeCount++;
          return chains;
        },
      },
    });
    const unsubs = persistence.attach(runtimeBus);

    // Fire 5 events in quick succession
    for (let i = 0; i < 5; i++) {
      emitWorkflowEvent(runtimeBus, 'WORKFLOW_CHAIN_CREATED', chain.id);
    }

    await flushTimers();

    // listChains should only have been called once (trailing debounce)
    expect(writeCount).toBe(1);

    for (const unsub of unsubs) unsub();
  });

  test('flush() writes immediately without waiting for debounce', () => {
    const chain = makeChain();
    chains = [chain];

    const persistence = createWrfcPersistence({
      snapshotPath,
      getSystemMessageRouter: () => null,
      controller: { listChains: () => chains },
    });
    const unsubs = persistence.attach(runtimeBus);

    emitWorkflowEvent(runtimeBus, 'WORKFLOW_CHAIN_CREATED', chain.id);
    // flush before debounce fires
    persistence.flush();

    expect(existsSync(snapshotPath)).toBe(true);
    const snap = readSnapshotFile(snapshotPath);
    expect(snap.chains).toHaveLength(1);

    for (const unsub of unsubs) unsub();
  });

  // ── boot rehydration ────────────────────────────────────────────────

  test('rehydrate surfaces interrupted chains via system message router', () => {
    const interruptedChain = makeChain({ state: 'reviewing', reviewCycles: 2, task: 'fix the thing' });
    const passedChain = makeChain({ state: 'passed', reviewCycles: 1 });

    const snapshot = {
      version: 1,
      writtenAt: Date.now() - 1000,
      chains: [interruptedChain, passedChain],
    };
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(snapshotPath, JSON.stringify(snapshot));

    const persistence = createWrfcPersistence({
      snapshotPath,
      getSystemMessageRouter: () => mockRouter,
      controller: { listChains: () => [] },
    });

    persistence.rehydrate();

    // Only the non-terminal chain is surfaced
    expect(routerMessages).toHaveLength(1);
    expect(routerMessages[0]).toContain(interruptedChain.id.slice(0, 12));
    expect(routerMessages[0]).toContain('fix the thing');
    expect(routerMessages[0]).toContain("state was 'reviewing'");
    expect(routerMessages[0]).toContain('2 review cycles');
  });

  test('interruptedChains accessor returns only non-terminal chains after rehydrate', () => {
    const chain1 = makeChain({ state: 'fixing' });
    const chain2 = makeChain({ state: 'failed' });

    writeFileSync(snapshotPath, JSON.stringify({ version: 1, writtenAt: Date.now(), chains: [chain1, chain2] }));

    const persistence = createWrfcPersistence({
      snapshotPath,
      getSystemMessageRouter: () => null,
      controller: { listChains: () => [] },
    });
    persistence.rehydrate();

    expect(persistence.interruptedChains).toHaveLength(1);
    expect(persistence.interruptedChains[0]!.id).toBe(chain1.id);
  });

  test('rehydrate RETAINS terminal chains on disk as history instead of pruning them', () => {
    const activeChain = makeChain({ state: 'engineering' });
    const terminalChain = makeChain({ state: 'passed' });

    writeFileSync(
      snapshotPath,
      JSON.stringify({ version: 1, writtenAt: Date.now(), chains: [activeChain, terminalChain] }),
    );

    const persistence = createWrfcPersistence({
      snapshotPath,
      getSystemMessageRouter: () => null,
      controller: { listChains: () => [] },
    });
    persistence.rehydrate();

    const snap = readSnapshotFile(snapshotPath);
    const ids = snap.chains.map((c) => c.id);
    expect(ids).toContain(activeChain.id);
    expect(ids).toContain(terminalChain.id);
    // knownChains exposes both the (re-imported) interrupted chain and the
    // retained terminal history, for consumers like the boot resume notice.
    const knownIds = persistence.knownChains.map((c) => c.id);
    expect(knownIds).toContain(activeChain.id);
    expect(knownIds).toContain(terminalChain.id);
  });

  test('rehydrate with no snapshot file is a no-op', () => {
    const persistence = createWrfcPersistence({
      snapshotPath,
      getSystemMessageRouter: () => mockRouter,
      controller: { listChains: () => [] },
    });
    persistence.rehydrate();

    expect(routerMessages).toHaveLength(0);
    expect(persistence.interruptedChains).toHaveLength(0);
  });

  // ── corrupt-file quarantine ─────────────────────────────────────────

  test('quarantines corrupt JSON snapshot by renaming to .unrecognized', () => {
    writeFileSync(snapshotPath, '{ this is not valid json }}}');

    const persistence = createWrfcPersistence({
      snapshotPath,
      getSystemMessageRouter: () => mockRouter,
      controller: { listChains: () => [] },
    });
    persistence.rehydrate();

    expect(existsSync(snapshotPath)).toBe(false);
    expect(existsSync(`${snapshotPath}.unrecognized`)).toBe(true);
    expect(routerMessages).toHaveLength(0);
  });

  test('quarantines snapshot with wrong version', () => {
    writeFileSync(
      snapshotPath,
      JSON.stringify({ version: 99, writtenAt: Date.now(), chains: [] }),
    );

    const persistence = createWrfcPersistence({
      snapshotPath,
      getSystemMessageRouter: () => mockRouter,
      controller: { listChains: () => [] },
    });
    persistence.rehydrate();

    expect(existsSync(snapshotPath)).toBe(false);
    expect(existsSync(`${snapshotPath}.unrecognized`)).toBe(true);
  });

  test('quarantines snapshot that is not an object', () => {
    writeFileSync(snapshotPath, JSON.stringify([1, 2, 3]));

    const persistence = createWrfcPersistence({
      snapshotPath,
      getSystemMessageRouter: () => mockRouter,
      controller: { listChains: () => [] },
    });
    persistence.rehydrate();

    expect(existsSync(`${snapshotPath}.unrecognized`)).toBe(true);
  });

  // ── terminal chain history retention ─────────────────────────────────

  test('all-terminal snapshot: no interrupted-chain messages, but both chains are retained as history', () => {
    const failed = makeChain({ state: 'failed' });
    const passed = makeChain({ state: 'passed' });

    writeFileSync(
      snapshotPath,
      JSON.stringify({ version: 1, writtenAt: Date.now(), chains: [failed, passed] }),
    );

    const persistence = createWrfcPersistence({
      snapshotPath,
      getSystemMessageRouter: () => mockRouter,
      controller: { listChains: () => [] },
    });
    persistence.rehydrate();

    // No "interrupted by a restart" messages for terminal chains.
    expect(routerMessages).toHaveLength(0);
    expect(persistence.interruptedChains).toHaveLength(0);
    // But they are not erased, both survive as retained history.
    const knownIds = persistence.knownChains.map((c) => c.id);
    expect(knownIds).toContain(failed.id);
    expect(knownIds).toContain(passed.id);
  });

  test('killing a chain (mid-session, no restart) retains it as terminal even after it ages out of listChains()', async () => {
    const chain = makeChain({ state: 'engineering' });
    chains = [chain];

    const persistence = createWrfcPersistence({
      snapshotPath,
      getSystemMessageRouter: () => null,
      controller: { listChains: () => chains },
    });
    const unsubs = persistence.attach(runtimeBus);

    // The chain is "killed", WrfcController transitions it to a terminal
    // state and emits WORKFLOW_CHAIN_FAILED (cancelChain's actual signal).
    chain.state = 'failed';
    chain.completedAt = Date.now();
    emitWorkflowEvent(runtimeBus, 'WORKFLOW_CHAIN_FAILED', chain.id);
    await flushTimers();

    let snap = readSnapshotFile(snapshotPath);
    expect(snap.chains.map((c) => c.id)).toContain(chain.id);

    // Simulate WrfcController's own 60s in-memory cleanup (scheduleChainCleanup)
    // dropping the now-terminal chain from listChains() entirely, this is the
    // exact mechanism that used to make the on-disk file forget a killed chain.
    chains = [];
    emitWorkflowEvent(runtimeBus, 'WORKFLOW_STATE_CHANGED', 'unrelated-chain-id');
    await flushTimers();

    snap = readSnapshotFile(snapshotPath);
    expect(snap.chains.map((c) => c.id)).toContain(chain.id);
    expect(snap.chains.find((c) => c.id === chain.id)?.state).toBe('failed');

    for (const unsub of unsubs) unsub();
  });

  test('a reaped zombie chain is not re-imported on the NEXT restart (already terminal, never re-enters candidateInterrupted)', () => {
    const interruptedChain = makeChain({ state: 'engineering' });
    writeFileSync(
      snapshotPath,
      JSON.stringify({ version: 1, writtenAt: Date.now(), chains: [interruptedChain] }),
    );

    let importCalls = 0;
    const persistence = createWrfcPersistence({
      snapshotPath,
      getSystemMessageRouter: () => null,
      controller: {
        listChains: () => [],
        // Simulate WrfcController's zombie-reap: mutate the chain to terminal
        // in place, exactly like reapZombieChain does.
        importChain: (chain) => {
          importCalls++;
          chain.state = 'failed';
          chain.completedAt = Date.now();
          chain.error = 'zombie chain reaped at rehydrate: no member agent survived the restart';
          return true;
        },
      },
    });
    persistence.rehydrate();

    expect(importCalls).toBe(1);
    expect(persistence.interruptedChains).toHaveLength(0);
    expect(persistence.knownChains.map((c) => c.id)).toContain(interruptedChain.id);

    // Second process start: read back what was actually written to disk.
    const importCallsAfterFirstRestart = importCalls;
    const persistence2 = createWrfcPersistence({
      snapshotPath,
      getSystemMessageRouter: () => null,
      controller: {
        listChains: () => [],
        importChain: () => { importCalls++; return true; },
      },
    });
    persistence2.rehydrate();

    // The reaped chain is already terminal on disk, it must never be handed
    // to importChain again (it is history, not a resurrection candidate).
    expect(importCalls).toBe(importCallsAfterFirstRestart);
    expect(persistence2.interruptedChains).toHaveLength(0);
    expect(persistence2.knownChains.map((c) => c.id)).toContain(interruptedChain.id);
  });

  test('terminal history is bounded to the most recent K=20, oldest pruned first', () => {
    const now = Date.now();
    const terminalChains = Array.from({ length: 25 }, (_, i) =>
      makeChain({ state: 'passed', completedAt: now - i * 1000 }), // i=0 is newest
    );

    writeFileSync(
      snapshotPath,
      JSON.stringify({ version: 1, writtenAt: now, chains: terminalChains }),
    );

    const persistence = createWrfcPersistence({
      snapshotPath,
      getSystemMessageRouter: () => null,
      controller: { listChains: () => [] },
    });
    persistence.rehydrate();

    expect(persistence.knownChains).toHaveLength(20);
    const keptIds = new Set(persistence.knownChains.map((c) => c.id));
    // The 20 most recent (i=0..19) are kept; the 5 oldest (i=20..24) are pruned.
    for (let i = 0; i < 20; i++) expect(keptIds.has(terminalChains[i]!.id)).toBe(true);
    for (let i = 20; i < 25; i++) expect(keptIds.has(terminalChains[i]!.id)).toBe(false);

    const snap = readSnapshotFile(snapshotPath);
    expect(snap.chains).toHaveLength(20);
  });

  test('snapshot not rewritten when no pruning is needed (all non-terminal)', () => {
    const chain = makeChain({ state: 'reviewing' });
    const ts = Date.now() - 5000;
    writeFileSync(
      snapshotPath,
      JSON.stringify({ version: 1, writtenAt: ts, chains: [chain] }),
    );

    const persistence = createWrfcPersistence({
      snapshotPath,
      getSystemMessageRouter: () => null,
      controller: { listChains: () => [] },
    });
    persistence.rehydrate();

    // writtenAt should NOT have changed (no rewrite needed)
    const snap = readSnapshotFile(snapshotPath);
    expect(snap.writtenAt).toBe(ts);
  });

  // ── review cycle wording ────────────────────────────────────────────

  test('uses singular cycle wording when reviewCycles is 1', () => {
    const chain = makeChain({ state: 'fixing', reviewCycles: 1 });
    writeFileSync(snapshotPath, JSON.stringify({ version: 1, writtenAt: Date.now(), chains: [chain] }));

    const persistence = createWrfcPersistence({
      snapshotPath,
      getSystemMessageRouter: () => mockRouter,
      controller: { listChains: () => [] },
    });
    persistence.rehydrate();

    expect(routerMessages[0]).toContain('1 review cycle');
    expect(routerMessages[0]).not.toContain('1 review cycles');
  });
});
