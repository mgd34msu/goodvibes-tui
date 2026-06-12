/**
 * Schema-version gating for the WRFC chain snapshot.
 *
 * Covers the contract introduced in TASK-033 (session-schema-version):
 *   - Round-trip: written snapshot is re-read correctly.
 *   - Unversioned-legacy accepted: existing files with version: 1 are accepted
 *     without migration (they are already at currentVersion).
 *   - Corrupt JSON → quarantine to .unrecognized, clean default on rehydrate.
 *   - Future schema version (version > 1) → quarantine to .unrecognized.
 *   - Missing version field → quarantine to .unrecognized.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { WrfcChain } from '@pellux/goodvibes-sdk/platform/agents';
import { createWrfcPersistence } from '@/runtime/wrfc-persistence.ts';
import { RuntimeEventBus } from '@/runtime/index.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

// ─── Helpers ────────────────────────────────────────────────────────────────

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

function readSnapshotFile(path: string): { version: number; writtenAt: number; chains: WrfcChain[] } {
  return JSON.parse(readFileSync(path, 'utf-8')) as { version: number; writtenAt: number; chains: WrfcChain[] };
}

function makeRouterMessages(): { messages: string[]; router: import('@/core/system-message-router.ts').SystemMessageRouter } {
  const messages: string[] = [];
  return {
    messages,
    router: { wrfc: (m: string) => { messages.push(m); } } as unknown as import('@/core/system-message-router.ts').SystemMessageRouter,
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('wrfc-schema-version', () => {
  let tmpDir: string;
  let snapshotPath: string;

  beforeEach(() => {
    tmpDir = makeProjectTempDir('gv-wrfc-schema-version');
    snapshotPath = join(tmpDir, 'wrfc-chains.json');
  });

  afterEach(() => {
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── round-trip ──────────────────────────────────────────────────────────

  test('round-trip: flush writes version: 1 that rehydrate reads back', async () => {
    const chain = makeChain({ state: 'reviewing', reviewCycles: 3, task: 'build the thing' });
    const runtimeBus = new RuntimeEventBus();
    const { messages, router } = makeRouterMessages();

    const writer = createWrfcPersistence({
      snapshotPath,
      getSystemMessageRouter: () => null,
      controller: { listChains: () => [chain] },
    });
    writer.flush();

    // Verify what was written on disk.
    const snap = readSnapshotFile(snapshotPath);
    expect(snap.version).toBe(1);
    expect(snap.chains).toHaveLength(1);
    expect(snap.chains[0]!.id).toBe(chain.id);

    // Now read it back via a fresh instance.
    const reader = createWrfcPersistence({
      snapshotPath,
      getSystemMessageRouter: () => router,
      controller: { listChains: () => [] },
    });
    reader.rehydrate();

    expect(reader.interruptedChains).toHaveLength(1);
    expect(reader.interruptedChains[0]!.id).toBe(chain.id);
    expect(messages[0]).toContain('build the thing');

    void runtimeBus; // referenced to avoid unused warning
  });

  // ── existing v1 files accepted without migration ─────────────────────────

  test('existing v1 files (no migration needed) are accepted and surfaced', () => {
    const chain = makeChain({ state: 'fixing', reviewCycles: 1 });
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(
      snapshotPath,
      JSON.stringify({ version: 1, writtenAt: Date.now() - 2000, chains: [chain] }),
    );

    const { messages, router } = makeRouterMessages();
    const persistence = createWrfcPersistence({
      snapshotPath,
      getSystemMessageRouter: () => router,
      controller: { listChains: () => [] },
    });
    persistence.rehydrate();

    // File must remain accessible (not quarantined).
    expect(existsSync(snapshotPath)).toBe(true);
    expect(persistence.interruptedChains).toHaveLength(1);
    expect(persistence.interruptedChains[0]!.id).toBe(chain.id);
    expect(messages[0]).toContain(chain.id.slice(0, 12));
  });

  // ── corrupt JSON → quarantine to .unrecognized ───────────────────────────

  test('corrupt JSON snapshot is quarantined to .unrecognized, rehydrate returns empty', () => {
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(snapshotPath, '{ this is not valid json at all }}}');

    const { messages, router } = makeRouterMessages();
    const persistence = createWrfcPersistence({
      snapshotPath,
      getSystemMessageRouter: () => router,
      controller: { listChains: () => [] },
    });
    persistence.rehydrate();

    expect(existsSync(snapshotPath)).toBe(false);
    expect(existsSync(`${snapshotPath}.unrecognized`)).toBe(true);
    expect(persistence.interruptedChains).toHaveLength(0);
    expect(messages).toHaveLength(0);
  });

  // ── future schema version → quarantine to .unrecognized ──────────────────

  test('future schema version quarantined to .unrecognized', () => {
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(
      snapshotPath,
      JSON.stringify({ version: 999, writtenAt: Date.now(), chains: [] }),
    );

    const { messages, router } = makeRouterMessages();
    const persistence = createWrfcPersistence({
      snapshotPath,
      getSystemMessageRouter: () => router,
      controller: { listChains: () => [] },
    });
    persistence.rehydrate();

    expect(existsSync(snapshotPath)).toBe(false);
    expect(existsSync(`${snapshotPath}.unrecognized`)).toBe(true);
    expect(persistence.interruptedChains).toHaveLength(0);
    expect(messages).toHaveLength(0);
  });

  // ── missing version field → quarantine to .unrecognized ──────────────────

  test('snapshot with missing version field is quarantined to .unrecognized', () => {
    const chain = makeChain({ state: 'reviewing' });
    mkdirSync(tmpDir, { recursive: true });
    // Deliberately omit the version field to simulate a corrupt/unversioned file.
    writeFileSync(
      snapshotPath,
      JSON.stringify({ writtenAt: Date.now(), chains: [chain] }),
    );

    const { messages, router } = makeRouterMessages();
    const persistence = createWrfcPersistence({
      snapshotPath,
      getSystemMessageRouter: () => router,
      controller: { listChains: () => [] },
    });
    persistence.rehydrate();

    expect(existsSync(snapshotPath)).toBe(false);
    expect(existsSync(`${snapshotPath}.unrecognized`)).toBe(true);
    expect(persistence.interruptedChains).toHaveLength(0);
    expect(messages).toHaveLength(0);
  });

  // ── clean default after quarantine ──────────────────────────────────────

  test('after quarantine, next flush writes a clean version: 1 snapshot', () => {
    mkdirSync(tmpDir, { recursive: true });
    // Corrupt file that will be quarantined.
    writeFileSync(snapshotPath, '{ invalid }');

    const activeChain = makeChain({ state: 'engineering' });
    const persistence = createWrfcPersistence({
      snapshotPath,
      getSystemMessageRouter: () => null,
      controller: { listChains: () => [activeChain] },
    });
    persistence.rehydrate();

    // Original corrupted → quarantined.
    expect(existsSync(`${snapshotPath}.unrecognized`)).toBe(true);

    // Now flush a new clean snapshot.
    persistence.flush();

    expect(existsSync(snapshotPath)).toBe(true);
    const snap = readSnapshotFile(snapshotPath);
    expect(snap.version).toBe(1);
    expect(snap.chains).toHaveLength(1);
    expect(snap.chains[0]!.id).toBe(activeChain.id);
  });
});
