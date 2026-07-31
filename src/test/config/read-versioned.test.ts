import { beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeProjectTempDir } from '../helpers/project-temp.ts';
import { readVersioned } from '@pellux/goodvibes-sdk/platform/config';
import type { VersionMigration } from '@pellux/goodvibes-sdk/platform/config';

// ─── Helpers ───────────────────────────────────────────────────────────────

interface V1Payload {
  version: 1;
  name: string;
}

interface V2Payload {
  version: 2;
  name: string;
  label: string;
}

function makeFilePath(dir: string, name = 'data.json'): string {
  return join(dir, name);
}

function writeJson(path: string, data: unknown): void {
  writeFileSync(path, JSON.stringify(data), 'utf-8');
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('readVersioned', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeProjectTempDir('gv-read-versioned');
  });

  // ── missing file ────────────────────────────────────────────────────────

  test('returns null for a missing file', () => {
    const path = makeFilePath(tmpDir, 'nonexistent.json');
    const result = readVersioned<V1Payload & { version: number }>(path, {
      currentVersion: 1,
      onUnknown: 'quarantine',
    });
    expect(result).toBeNull();
    expect(existsSync(path)).toBe(false);
  });

  // ── current version ─────────────────────────────────────────────────────

  test('returns parsed data when version matches currentVersion', () => {
    const path = makeFilePath(tmpDir);
    const data: V1Payload = { version: 1, name: 'hello' };
    writeJson(path, data);

    const result = readVersioned<V1Payload & { version: number }>(path, {
      currentVersion: 1,
      onUnknown: 'quarantine',
    });
    expect(result).not.toBeNull();
    expect(result!.version).toBe(1);
    expect(result!.name).toBe('hello');
  });

  // ── migration ───────────────────────────────────────────────────────────

  test('applies a single migration from version 1 to version 2', () => {
    const path = makeFilePath(tmpDir);
    writeJson(path, { version: 1, name: 'widget' } satisfies V1Payload);

    const migrate: VersionMigration = (d) => ({ ...d, version: 2, label: (d['name'] as string).toUpperCase() });

    const result = readVersioned<V2Payload & { version: number }>(path, {
      currentVersion: 2,
      migrations: { 1: migrate },
      onUnknown: 'quarantine',
    });

    expect(result).not.toBeNull();
    expect(result!.version).toBe(2);
    expect(result!.name).toBe('widget');
    expect(result!.label).toBe('WIDGET');
  });

  test('applies chained migrations stepwise (1 → 2 → 3)', () => {
    const path = makeFilePath(tmpDir);
    writeJson(path, { version: 1, name: 'a' });

    const m1: VersionMigration = (d) => ({ ...d, version: 2, label: 'v2' });
    const m2: VersionMigration = (d) => ({ ...d, version: 3, extra: 'v3' });

    const result = readVersioned<{ version: number; name: string; label: string; extra: string }>(path, {
      currentVersion: 3,
      migrations: { 1: m1, 2: m2 },
      onUnknown: 'quarantine',
    });

    expect(result).not.toBeNull();
    expect(result!.version).toBe(3);
    expect(result!.label).toBe('v2');
    expect(result!.extra).toBe('v3');
  });

  // ── unknown / future version quarantine ─────────────────────────────────

  test('quarantines a file with version higher than currentVersion', () => {
    const path = makeFilePath(tmpDir);
    writeJson(path, { version: 99, name: 'future' });

    const result = readVersioned<V1Payload & { version: number }>(path, {
      currentVersion: 1,
      onUnknown: 'quarantine',
    });

    expect(result).toBeNull();
    expect(existsSync(path)).toBe(false);
    expect(existsSync(`${path}.unrecognized`)).toBe(true);
  });

  test('quarantines a file with a non-numeric version field', () => {
    const path = makeFilePath(tmpDir);
    writeJson(path, { version: 'one', name: 'bad' });

    const result = readVersioned<V1Payload & { version: number }>(path, {
      currentVersion: 1,
      onUnknown: 'quarantine',
    });

    expect(result).toBeNull();
    expect(existsSync(`${path}.unrecognized`)).toBe(true);
  });

  test('quarantines a file with missing version field', () => {
    const path = makeFilePath(tmpDir);
    writeJson(path, { name: 'no-version' });

    const result = readVersioned<V1Payload & { version: number }>(path, {
      currentVersion: 1,
      onUnknown: 'quarantine',
    });

    expect(result).toBeNull();
    expect(existsSync(`${path}.unrecognized`)).toBe(true);
  });

  // ── corrupt JSON quarantine ──────────────────────────────────────────────

  test('quarantines a file with corrupt (unparseable) JSON', () => {
    const path = makeFilePath(tmpDir);
    writeFileSync(path, '{ not valid json }}}');

    const result = readVersioned<V1Payload & { version: number }>(path, {
      currentVersion: 1,
      onUnknown: 'quarantine',
    });

    expect(result).toBeNull();
    expect(existsSync(path)).toBe(false);
    expect(existsSync(`${path}.unrecognized`)).toBe(true);
  });

  test('quarantines a JSON array (not a plain object)', () => {
    const path = makeFilePath(tmpDir);
    writeJson(path, [1, 2, 3]);

    const result = readVersioned<V1Payload & { version: number }>(path, {
      currentVersion: 1,
      onUnknown: 'quarantine',
    });

    expect(result).toBeNull();
    expect(existsSync(`${path}.unrecognized`)).toBe(true);
  });

  test('quarantines a JSON string (not a plain object)', () => {
    const path = makeFilePath(tmpDir);
    writeJson(path, 'just a string');

    const result = readVersioned<V1Payload & { version: number }>(path, {
      currentVersion: 1,
      onUnknown: 'quarantine',
    });

    expect(result).toBeNull();
    expect(existsSync(`${path}.unrecognized`)).toBe(true);
  });

  // ── migration gap quarantine ─────────────────────────────────────────────

  test('quarantines when there is no migration for a version gap', () => {
    const path = makeFilePath(tmpDir);
    writeJson(path, { version: 1, name: 'gap' });

    // No migration provided for version 1 → 2.
    const result = readVersioned<{ version: number; name: string }>(path, {
      currentVersion: 2,
      migrations: {}, // gap
      onUnknown: 'quarantine',
    });

    expect(result).toBeNull();
    expect(existsSync(`${path}.unrecognized`)).toBe(true);
  });

  test('quarantines when a migration function throws', () => {
    const path = makeFilePath(tmpDir);
    writeJson(path, { version: 1, name: 'crash' });

    const crashMigration: VersionMigration = () => { throw new Error('migration failed'); };

    const result = readVersioned<{ version: number }>(path, {
      currentVersion: 2,
      migrations: { 1: crashMigration },
      onUnknown: 'quarantine',
    });

    expect(result).toBeNull();
    expect(existsSync(`${path}.unrecognized`)).toBe(true);
  });
});
