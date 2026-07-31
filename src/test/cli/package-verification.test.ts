import { describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { parseNpmPackJson, verifyPackageCliInstall } from '../../cli/package-verification.ts';

describe('package CLI install verification', () => {
  test('package exposes runnable GoodVibes bin wrappers and a safe npm tarball contract', () => {
    const report = verifyPackageCliInstall(resolve(import.meta.dir, '../../..'));

    expect(report.packageName).toBe('@pellux/goodvibes-tui');
    expect(report.issues).toEqual([]);
    // One bin. The daemon ships as its own package with its own binary; this
    // package carrying a second wrapper is what let two daemons exist.
    expect(report.bins.map((bin) => bin.command)).toEqual(['goodvibes']);
    expect(report.bins.every((bin) => bin.exists && bin.executable)).toBe(true);
    expect(report.bins.every((bin) => bin.usesBunShebang)).toBe(true);
    expect(report.bins.every((bin) => bin.hasLocalPlatformBuildFallback)).toBe(true);
    expect(report.bins.every((bin) => bin.hasLocalBuildFallback)).toBe(true);
    expect(report.bins.every((bin) => bin.hasVendoredBinaryFallback)).toBe(true);
    expect(report.bins.every((bin) => bin.hasSourceFallback)).toBe(true);
    expect(report.tarball.requiredPathsPresent).toContain('bin/goodvibes');
    expect(report.tarball.requiredPathsPresent).toContain('scripts/check-bun.sh');
    expect(report.tarball.forbiddenPaths).toEqual([]);
  }, 30_000);
});

describe('npm pack --json output parsing', () => {
  const arrayShape = JSON.stringify([
    { id: 'pkg@1.0.0', name: 'pkg', unpackedSize: 42, entryCount: 2, files: [{ path: 'README.md' }, { path: 'package.json' }] },
  ]);
  const objectShape = JSON.stringify({
    pkg: { id: 'pkg@1.0.0', name: 'pkg', unpackedSize: 42, entryCount: 2, files: [{ path: 'README.md' }, { path: 'package.json' }] },
  });

  test('reads the array shape emitted by npm 10 and npm 11', () => {
    expect(parseNpmPackJson(arrayShape)).toEqual({ files: ['README.md', 'package.json'], entryCount: 2, unpackedSize: 42 });
  });

  test('reads the package-name-keyed object shape emitted by npm 12', () => {
    expect(parseNpmPackJson(objectShape)).toEqual({ files: ['README.md', 'package.json'], entryCount: 2, unpackedSize: 42 });
  });

  test('reads a bare pack-result object', () => {
    expect(parseNpmPackJson(JSON.stringify({ entryCount: 1, unpackedSize: 7, files: [{ path: 'a.txt' }] }))).toEqual({
      files: ['a.txt'],
      entryCount: 1,
      unpackedSize: 7,
    });
  });

  test('ignores npm notice lines printed around the JSON document', () => {
    const noisy = `npm notice run \`npm audit\` for details\n${objectShape}\nnpm notice done\n`;
    expect(parseNpmPackJson(noisy)).toEqual({ files: ['README.md', 'package.json'], entryCount: 2, unpackedSize: 42 });
  });

  test('keeps braces inside file paths from truncating the document', () => {
    const braced = JSON.stringify({ pkg: { entryCount: 1, unpackedSize: 3, files: [{ path: 'src/{weird}/file.ts' }] } });
    expect(parseNpmPackJson(`npm notice packing\n${braced}`)).toEqual({
      files: ['src/{weird}/file.ts'],
      entryCount: 1,
      unpackedSize: 3,
    });
  });

  test('reports what npm actually emitted when there is no JSON document', () => {
    expect(() => parseNpmPackJson('npm error code ENOENT\nnpm error enoent\n')).toThrow(/printed no JSON document.*npm error code ENOENT/s);
  });

  test('reports what npm actually emitted when the output is empty', () => {
    expect(() => parseNpmPackJson('   \n')).toThrow(/printed no JSON document.*no output at all/s);
  });

  test('reports what npm actually emitted when the JSON is malformed', () => {
    expect(() => parseNpmPackJson('{"pkg": {files: [1, 2]}}')).toThrow(/could not be parsed/);
  });

  test('reports an unrecognized JSON shape rather than crashing', () => {
    expect(() => parseNpmPackJson(JSON.stringify({ error: { code: 'E404', summary: 'not found' } }))).toThrow(
      /unrecognized JSON shape.*E404/s,
    );
  });
});
