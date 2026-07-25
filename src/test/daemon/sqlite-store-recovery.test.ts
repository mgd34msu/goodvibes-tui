/**
 * sqlite-store-recovery.test.ts — the daemon SQLite base opens a store by
 * validating its CONTENT, not by `existsSync`.
 *
 * The defect this covers: `init()` did
 * `const existing = existsSync(path) ? readFileSync(path) : undefined;
 *  this.db = existing ? new SQL.Database(existing) : new SQL.Database();`
 * so a file that exists but holds no usable database — zero bytes from an
 * interrupted write, a truncated restore, a filesystem that recovered the inode
 * but not the data — was handed straight to sql.js, which threw out of `init()`
 * and took every daemon store built on this class down with it (inbox,
 * channel routes, drafts, peer registry, triage, email drafts). There was no
 * way back short of a human deleting the file.
 *
 * The fix: check the SQLite file header, try the open, and on failure move the
 * unusable file aside (never delete it — an operator may be able to salvage it),
 * start a clean database, and SAY SO. The quarantine copies are themselves
 * bounded by an age TTL and a keep-newest count, reaped on the next init.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { existsSync, mkdirSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { logger } from '@pellux/goodvibes-sdk/platform/utils';
import { HandlerSqliteStore } from '../../daemon/handlers/sqlite-store.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

const FILE_NAME = 'recovery-probe.sqlite';
const SCHEMA = ['CREATE TABLE IF NOT EXISTS probe (id TEXT PRIMARY KEY, value TEXT)'];

let tmpDir: string;

beforeEach(() => { tmpDir = makeProjectTempDir('gv-sqlite-store-recovery'); });
afterEach(() => { if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true }); });

function makeStore(): HandlerSqliteStore {
  return new HandlerSqliteStore({ workingDirectory: tmpDir, fileName: FILE_NAME, schema: SCHEMA });
}

function storeDir(): string {
  return join(tmpDir, '.goodvibes', 'tui', 'operator');
}

function storePath(): string {
  return join(storeDir(), FILE_NAME);
}

/** Write raw bytes to the store path, standing in for whatever a crash left behind. */
function seedRawStoreFile(contents: Buffer | string): void {
  mkdirSync(storeDir(), { recursive: true });
  writeFileSync(storePath(), contents);
}

function quarantineFiles(): string[] {
  try {
    return readdirSync(storeDir()).filter((name) => name.startsWith(`${FILE_NAME}.corrupt-`));
  } catch {
    return [];
  }
}

function withCapturedLogs<T>(fn: () => Promise<T>): Promise<{
  result: T;
  infos: Array<{ message: string; data?: Record<string, unknown> | undefined }>;
  warns: Array<{ message: string; data?: Record<string, unknown> | undefined }>;
}> {
  const infos: Array<{ message: string; data?: Record<string, unknown> | undefined }> = [];
  const warns: Array<{ message: string; data?: Record<string, unknown> | undefined }> = [];
  const infoSpy = spyOn(logger, 'info').mockImplementation(((message: string, data?: Record<string, unknown>) => {
    infos.push({ message, data });
  }) as never);
  const warnSpy = spyOn(logger, 'warn').mockImplementation(((message: string, data?: Record<string, unknown>) => {
    warns.push({ message, data });
  }) as never);
  return fn()
    .then((result) => ({ result, infos, warns }))
    .finally(() => { infoSpy.mockRestore(); warnSpy.mockRestore(); });
}

describe('a healthy store round-trips', () => {
  test('rows written before a restart are read back after it', async () => {
    const first = makeStore();
    await first.init();
    first.run('INSERT INTO probe (id, value) VALUES (?, ?)', ['a', 'kept']);
    await first.save();
    first.close();

    const second = makeStore();
    await second.init();
    expect(second.get<{ value: string }>('SELECT value FROM probe WHERE id = ?', ['a'])?.value).toBe('kept');
    second.close();
    // A clean open quarantines nothing.
    expect(quarantineFiles()).toEqual([]);
  });
});

describe('a crash-damaged database is rejected rather than served', () => {
  test('a ZERO-BYTE file does not throw out of init — it is set aside and a clean store starts', async () => {
    seedRawStoreFile('');
    const store = makeStore();
    const { warns } = await withCapturedLogs(async () => { await store.init(); });

    // init survived, and the schema is usable.
    store.run('INSERT INTO probe (id, value) VALUES (?, ?)', ['fresh', 'ok']);
    expect(store.get<{ value: string }>('SELECT value FROM probe WHERE id = ?', ['fresh'])?.value).toBe('ok');
    store.close();

    // The unusable file was preserved, not deleted...
    expect(quarantineFiles()).toHaveLength(1);
    // ...and the loss was disclosed.
    const disclosure = warns.find((entry) => entry.message.includes('could not be opened'));
    expect(disclosure).toBeDefined();
    expect(String(disclosure?.data?.reason)).toContain('zero-byte');
    expect(disclosure?.data?.store).toBe(FILE_NAME);
  });

  test('a file with no SQLite header is set aside instead of being handed to sql.js', async () => {
    seedRawStoreFile('this is definitely not a database\n');
    const store = makeStore();
    const { warns } = await withCapturedLogs(async () => { await store.init(); });
    store.close();

    expect(quarantineFiles()).toHaveLength(1);
    expect(String(warns.find((e) => e.message.includes('could not be opened'))?.data?.reason))
      .toContain('SQLite file header');
  });

  test('a TRUNCATED database (valid header, cut-off body) is set aside', async () => {
    // Build a real database first, then cut it in half — exactly what a crash
    // partway through a copy or a restore leaves.
    const seeded = makeStore();
    await seeded.init();
    for (let index = 0; index < 40; index += 1) {
      seeded.run('INSERT INTO probe (id, value) VALUES (?, ?)', [`row-${index}`, 'x'.repeat(64)]);
    }
    await seeded.save();
    seeded.close();

    const { readFileSync } = await import('node:fs');
    const full = readFileSync(storePath());
    expect(full.length).toBeGreaterThan(1024);
    seedRawStoreFile(full.subarray(0, Math.floor(full.length / 3)));

    const store = makeStore();
    const { warns } = await withCapturedLogs(async () => { await store.init(); });
    // The store is usable rather than dead.
    expect(store.all('SELECT * FROM probe')).toEqual([]);
    store.close();

    expect(quarantineFiles()).toHaveLength(1);
    expect(warns.some((entry) => entry.message.includes('could not be opened'))).toBe(true);
  });

  test('the damaged file is preserved, never deleted', async () => {
    seedRawStoreFile('salvageable-by-hand');
    const store = makeStore();
    await store.init();
    store.close();

    const [quarantine] = quarantineFiles();
    expect(quarantine).toBeDefined();
    const { readFileSync } = await import('node:fs');
    expect(readFileSync(join(storeDir(), quarantine!), 'utf-8')).toBe('salvageable-by-hand');
  });
});

describe('the quarantine directory is bounded and the reap is disclosed', () => {
  /**
   * Drop `count` quarantine files roughly `ageDays` old, each one MINUTE newer
   * than the last. Distinct mtimes matter: the keep-newest cap sorts on them,
   * and identical stamps would make the assertion below depend on readdir order
   * rather than on the rule under test.
   */
  function seedQuarantines(count: number, ageDays: number): string[] {
    mkdirSync(storeDir(), { recursive: true });
    const made: string[] = [];
    const base = Date.now() - ageDays * 24 * 60 * 60 * 1000;
    for (let index = 0; index < count; index += 1) {
      const path = join(storeDir(), `${FILE_NAME}.corrupt-${1_000_000 + index}`);
      writeFileSync(path, `old-${index}`);
      const when = new Date(base + index * 60_000);
      utimesSync(path, when, when);
      made.push(path);
    }
    return made;
  }

  test('quarantines past the age TTL are reclaimed on the next init, and the count is disclosed', async () => {
    seedQuarantines(2, 30); // well past the 14-day TTL
    const store = makeStore();
    const { infos } = await withCapturedLogs(async () => { await store.init(); });
    store.close();

    expect(quarantineFiles()).toEqual([]);
    const disclosure = infos.find((entry) => entry.message.includes('reclaimed quarantined copies'));
    expect(disclosure).toBeDefined();
    expect(disclosure?.data?.reclaimedFiles).toBe(2);
    expect(disclosure?.data?.ttlDays).toBe(14);
  });

  test('recent quarantines survive the TTL but are still capped by count, newest kept', async () => {
    seedQuarantines(6, 1); // one day old: inside the TTL, over the keep-newest cap
    const store = makeStore();
    await store.init();
    store.close();

    const remaining = quarantineFiles();
    expect(remaining).toHaveLength(3);
    // The newest survive — the seeds are numbered ascending and written in order.
    expect(remaining.some((name) => name.endsWith('1000005'))).toBe(true);
    expect(remaining.some((name) => name.endsWith('1000000'))).toBe(false);
  });

  test('a reap with nothing to reclaim says nothing', async () => {
    seedQuarantines(2, 1);
    const store = makeStore();
    const { infos } = await withCapturedLogs(async () => { await store.init(); });
    store.close();
    expect(infos.some((entry) => entry.message.includes('reclaimed quarantined copies'))).toBe(false);
  });

  test('the reap is idempotent — a second init reclaims nothing further', async () => {
    seedQuarantines(5, 30);
    const first = makeStore();
    await first.init();
    first.close();
    expect(quarantineFiles()).toEqual([]);

    const second = makeStore();
    const { infos } = await withCapturedLogs(async () => { await second.init(); });
    second.close();
    expect(infos.some((entry) => entry.message.includes('reclaimed quarantined copies'))).toBe(false);
  });

  test('a quarantine file removed by another process mid-reap is not an error', async () => {
    const seeded = seedQuarantines(3, 30);
    // Simulate the race: the file is gone before this process gets to unlink it.
    rmSync(seeded[1]!, { force: true });

    const store = makeStore();
    await store.init(); // must not throw
    store.close();
    expect(quarantineFiles()).toEqual([]);
  });
});

describe('saving is crash-safe', () => {
  test('a save leaves no temp file behind and the result opens cleanly', async () => {
    const store = makeStore();
    await store.init();
    store.run('INSERT INTO probe (id, value) VALUES (?, ?)', ['x', 'y']);
    await store.save();
    store.close();

    const leftovers = readdirSync(storeDir()).filter((name) => name.endsWith('.tmp'));
    expect(leftovers).toEqual([]);

    const reopened = makeStore();
    await reopened.init();
    expect(reopened.get<{ value: string }>('SELECT value FROM probe WHERE id = ?', ['x'])?.value).toBe('y');
    reopened.close();
    expect(quarantineFiles()).toEqual([]);
  });
});
