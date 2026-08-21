/**
 * Tests for reapQuarantinedFiles, quarantining renames a corrupt file to
 * `<path>.unrecognized` so a human can inspect it, and nothing ever removed
 * the result. These are forensic, so the retention window is long (30 days),
 * but "keep forever" is a leak.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeProjectTempDir } from '../helpers/project-temp.ts';
import {
  QUARANTINE_RETENTION_MS,
  readVersioned,
  reapQuarantinedFiles,
  UNRECOGNIZED_SUFFIX,
} from '@pellux/goodvibes-sdk/platform/config';

let dir: string;
const NOW = 1_800_000_000_000;

beforeEach(() => {
  dir = makeProjectTempDir('gv-quarantine-reap');
});

afterEach(() => {
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
});

function putQuarantined(name: string, ageMs: number): string {
  const path = join(dir, `${name}${UNRECOGNIZED_SUFFIX}`);
  writeFileSync(path, 'corrupt payload');
  const at = new Date(NOW - ageMs);
  utimesSync(path, at, at);
  return path;
}

describe('reapQuarantinedFiles', () => {
  test('a quarantined file past the retention window is reclaimed; one inside it is kept', () => {
    const old = putQuarantined('ancient.json', QUARANTINE_RETENTION_MS + 86_400_000);
    const recent = putQuarantined('yesterday.json', 86_400_000);

    const result = reapQuarantinedFiles([dir], { now: () => NOW });

    expect(result.scanned).toBe(2);
    expect(result.reaped).toBe(1);
    expect(existsSync(old)).toBe(false);
    expect(existsSync(recent)).toBe(true);
  });

  test('the retention window is a month, long enough to survive a holiday', () => {
    expect(QUARANTINE_RETENTION_MS).toBe(30 * 24 * 60 * 60 * 1000);
  });

  test('the count cap bounds a repeating corruption that quarantines on every boot', () => {
    for (let i = 0; i < 6; i++) putQuarantined(`boot-${i}.json`, i * 60_000 + 1_000);

    const result = reapQuarantinedFiles([dir], { now: () => NOW, maxFilesPerDir: 2 });

    expect(result.reaped).toBe(4);
    expect(readdirSync(dir).sort()).toEqual([
      `boot-0.json${UNRECOGNIZED_SUFFIX}`,
      `boot-1.json${UNRECOGNIZED_SUFFIX}`,
    ]);
  });

  test('files without the quarantine suffix are never touched', () => {
    writeFileSync(join(dir, 'settings.json'), '{"version":1}');
    const result = reapQuarantinedFiles([dir], { now: () => NOW, maxAgeMs: 0 });
    expect(result.scanned).toBe(0);
    expect(existsSync(join(dir, 'settings.json'))).toBe(true);
  });

  test('reaping twice in a row is a no-op the second time', () => {
    putQuarantined('a.json', QUARANTINE_RETENTION_MS + 1);
    putQuarantined('b.json', QUARANTINE_RETENTION_MS + 1);

    const first = reapQuarantinedFiles([dir], { now: () => NOW });
    const second = reapQuarantinedFiles([dir], { now: () => NOW });

    expect(first.reaped).toBe(2);
    expect(second).toEqual({ scanned: 0, reaped: 0 });
  });

  test('a missing directory contributes nothing and never throws', () => {
    expect(() => reapQuarantinedFiles([join(dir, 'nope')], { now: () => NOW })).not.toThrow();
    expect(reapQuarantinedFiles([join(dir, 'nope')], { now: () => NOW })).toEqual({ scanned: 0, reaped: 0 });
  });

  test('a directory listed twice is swept once', () => {
    putQuarantined('dupe.json', QUARANTINE_RETENTION_MS + 1);
    const result = reapQuarantinedFiles([dir, dir], { now: () => NOW });
    expect(result.scanned).toBe(1);
    expect(result.reaped).toBe(1);
  });

  test('several directories are swept in one call', () => {
    const other = join(dir, 'nested');
    mkdirSync(other, { recursive: true });
    putQuarantined('here.json', QUARANTINE_RETENTION_MS + 1);
    const otherPath = join(other, `there.json${UNRECOGNIZED_SUFFIX}`);
    writeFileSync(otherPath, 'x');
    const at = new Date(NOW - QUARANTINE_RETENTION_MS - 1);
    utimesSync(otherPath, at, at);

    const result = reapQuarantinedFiles([dir, other], { now: () => NOW });

    expect(result.reaped).toBe(2);
    expect(existsSync(otherPath)).toBe(false);
  });
});

describe('readVersioned rejects crash residue rather than serving it', () => {
  test('a zero-byte file from a partial write is quarantined, not returned', () => {
    const path = join(dir, 'partial.json');
    writeFileSync(path, '');

    expect(readVersioned(path, { currentVersion: 1, onUnknown: 'quarantine' })).toBeNull();
    expect(existsSync(path)).toBe(false);
    expect(existsSync(`${path}${UNRECOGNIZED_SUFFIX}`)).toBe(true);
  });

  test('a truncated JSON file is quarantined, not returned', () => {
    const path = join(dir, 'truncated.json');
    writeFileSync(path, '{"version":1,"items":[{"id"');

    expect(readVersioned(path, { currentVersion: 1, onUnknown: 'quarantine' })).toBeNull();
    expect(existsSync(`${path}${UNRECOGNIZED_SUFFIX}`)).toBe(true);
  });

  test('a quarantined file produced by readVersioned is later reclaimed by the sweep', () => {
    const path = join(dir, 'round-trip.json');
    writeFileSync(path, 'not json at all');
    readVersioned(path, { currentVersion: 1, onUnknown: 'quarantine' });

    const quarantined = `${path}${UNRECOGNIZED_SUFFIX}`;
    expect(existsSync(quarantined)).toBe(true);

    const at = new Date(NOW - QUARANTINE_RETENTION_MS - 1);
    utimesSync(quarantined, at, at);
    expect(reapQuarantinedFiles([dir], { now: () => NOW }).reaped).toBe(1);
    expect(existsSync(quarantined)).toBe(false);
  });
});
