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

  test('rehydrate prunes terminal chains from snapshot on disk', () => {
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
    expect(snap.chains).toHaveLength(1);
    expect(snap.chains[0]!.id).toBe(activeChain.id);
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

  // ── terminal chain pruning ──────────────────────────────────────────

  test('all-terminal snapshot results in empty chains after rehydrate', () => {
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

    // No messages for terminal chains
    expect(routerMessages).toHaveLength(0);
    expect(persistence.interruptedChains).toHaveLength(0);
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
