/**
 * Tests for scripts/test-temp-manifest.ts, the race-free half of the temp
 * cleanup, run by scripts/run-tests.ts after a child test process has exited.
 *
 * Both directions matter. It has to remove what a manifest names, and it has to
 * refuse to remove anything when the manifest is missing or malformed: this code
 * runs `rmSync(..., { recursive: true })` on whatever the file says, so a parser
 * that turned garbage into a plausible path would delete it.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeProjectTempDir } from '../helpers/project-temp.ts';
import {
  TEST_TEMP_MANIFEST_ENV,
  parseTempManifest,
  removeManifestedTempDirs,
} from '../../../scripts/test-temp-manifest.ts';

function scratch(): string {
  return makeProjectTempDir('temp-manifest-spec');
}

describe('parseTempManifest', () => {
  test('returns the string entries of a JSON array', () => {
    expect(parseTempManifest('["/a","/b"]')).toEqual(['/a', '/b']);
  });

  test('drops entries that are not non-empty strings', () => {
    expect(parseTempManifest('["/a", "", 3, null, {"p":"/b"}, "/c"]')).toEqual(['/a', '/c']);
  });

  test('returns nothing for input that is not a JSON array of paths', () => {
    // The negative half. A truncated write is the realistic failure, and the
    // only safe reading of it is "delete nothing".
    expect(parseTempManifest('')).toEqual([]);
    expect(parseTempManifest('["/a"')).toEqual([]);
    expect(parseTempManifest('{"dirs":["/a"]}')).toEqual([]);
    expect(parseTempManifest('"/a"')).toEqual([]);
    expect(parseTempManifest('null')).toEqual([]);
  });
});

describe('removeManifestedTempDirs', () => {
  test('removes the directories a manifest names, then the manifest', () => {
    const base = scratch();
    const a = join(base, 'a');
    const b = join(base, 'b');
    mkdirSync(a, { recursive: true });
    mkdirSync(b, { recursive: true });
    writeFileSync(join(a, 'file.txt'), 'content', 'utf8');
    const manifest = join(base, 'manifest.json');
    writeFileSync(manifest, JSON.stringify([a, b]), 'utf8');

    const removed = removeManifestedTempDirs(manifest);

    expect(removed).toEqual([a, b]);
    expect(existsSync(a)).toBe(false);
    expect(existsSync(b)).toBe(false);
    expect(existsSync(manifest)).toBe(false);
  });

  test('removes nothing when the manifest does not exist', () => {
    const base = scratch();
    const kept = join(base, 'kept');
    mkdirSync(kept, { recursive: true });

    const removed = removeManifestedTempDirs(join(base, 'no-such-manifest.json'));

    expect(removed).toEqual([]);
    expect(existsSync(kept)).toBe(true);
  });

  test('removes nothing when the manifest is malformed', () => {
    // Proof the removal is driven by parsed content, not by "the file existed".
    const base = scratch();
    const kept = join(base, 'kept');
    mkdirSync(kept, { recursive: true });
    const manifest = join(base, 'manifest.json');
    writeFileSync(manifest, `[${JSON.stringify(kept)}`, 'utf8'); // truncated

    const removed = removeManifestedTempDirs(manifest);

    expect(removed).toEqual([]);
    expect(existsSync(kept)).toBe(true);
    rmSync(manifest, { force: true });
  });

  test('a path already gone is not an error', () => {
    const base = scratch();
    const gone = join(base, 'gone');
    const manifest = join(base, 'manifest.json');
    writeFileSync(manifest, JSON.stringify([gone]), 'utf8');
    expect(() => removeManifestedTempDirs(manifest)).not.toThrow();
  });
});

describe('the manifest handover is actually wired up', () => {
  test('the runner passes the env var the preload reads', () => {
    const runner = Bun.file(
      join(import.meta.dir, '..', '..', '..', 'scripts', 'run-tests.ts'),
    );
    const preload = Bun.file(join(import.meta.dir, '..', 'preload', 'temp-cleanup.ts'));
    return Promise.all([runner.text(), preload.text()]).then(([runnerSrc, preloadSrc]) => {
      // Both sides reference the shared constant rather than spelling the name
      // out, so a rename cannot silently disconnect them.
      expect(runnerSrc).toContain('TEST_TEMP_MANIFEST_ENV');
      expect(runnerSrc).toContain('removeManifestedTempDirs(manifestPath)');
      expect(preloadSrc).toContain('process.env[TEST_TEMP_MANIFEST_ENV]');
      expect(TEST_TEMP_MANIFEST_ENV).toBe('GOODVIBES_TEST_TEMP_MANIFEST');
    });
  });
});
