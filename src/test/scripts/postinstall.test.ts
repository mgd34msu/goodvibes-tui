import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CHECKSUM_MANIFEST_NAME,
  parseChecksumFile,
  resolveArtifactNames,
  sha256,
  verifyChecksum,
} from '../../runtime/release-artifacts.ts';
// postinstall.js re-exports these same bindings (its download-verify loop
// calls them directly), importing it here proves that wiring holds, and
// is safe: import.meta.main is only true when the file is the process
// entry point, so this import does not trigger its network install.
import * as postinstall from '../../../scripts/postinstall.js';

describe('verifyChecksum', () => {
  test('passes silently when the checksum matches', () => {
    expect(() => verifyChecksum('goodvibes-linux-x64', 'abc123', 'abc123')).not.toThrow();
  });

  test('throws on a mismatching checksum', () => {
    expect(() => verifyChecksum('goodvibes-linux-x64', 'abc123', 'def456')).toThrow(
      /checksum mismatch for goodvibes-linux-x64: expected def456, got abc123/,
    );
  });

  test('throws when the manifest has NO entry for the artifact; a missing entry is a hard failure, not a skip', () => {
    expect(() => verifyChecksum('goodvibes-linux-x64', 'abc123', undefined)).toThrow(
      /no checksum entry for goodvibes-linux-x64/,
    );
  });

  test('missing-entry error names both the artifact and the manifest', () => {
    let thrown: unknown;
    try {
      verifyChecksum('goodvibes-daemon-linux-arm64', 'deadbeef', undefined);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    expect(message).toContain('goodvibes-daemon-linux-arm64');
    expect(message).toContain(CHECKSUM_MANIFEST_NAME);
  });

  test('missing-entry error names a caller-supplied manifest name', () => {
    expect(() => verifyChecksum('goodvibes-macos-x64', 'abc123', undefined, 'custom-manifest.txt')).toThrow(
      /custom-manifest\.txt/,
    );
  });

  test('an empty-string expected checksum is still a real (mismatching) entry, not a missing one', () => {
    // Guards against a `if (expected)` style falsy check silently treating
    // an entry with an empty checksum the same as no entry at all.
    expect(() => verifyChecksum('goodvibes-linux-x64', 'abc123', '')).toThrow(/checksum mismatch/);
  });
});

describe('parseChecksumFile', () => {
  test('parses standard sha256sum output lines', () => {
    const contents = [
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa  goodvibes-linux-x64',
      'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb  goodvibes-daemon-linux-x64',
    ].join('\n');
    const checksums = parseChecksumFile(contents);
    expect(checksums.get('goodvibes-linux-x64')).toBe('a'.repeat(64));
    expect(checksums.get('goodvibes-daemon-linux-x64')).toBe('b'.repeat(64));
  });

  test('an artifact absent from the file has no map entry at all', () => {
    const contents = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa  goodvibes-linux-x64';
    const checksums = parseChecksumFile(contents);
    expect(checksums.has('goodvibes-daemon-linux-x64')).toBe(false);
    expect(checksums.get('goodvibes-daemon-linux-x64')).toBeUndefined();
  });

  test('ignores blank lines and tolerates a leading "*" binary-mode marker', () => {
    const contents = [
      '',
      `${'c'.repeat(64)} *goodvibes-macos-arm64`,
      '',
    ].join('\n');
    const checksums = parseChecksumFile(contents);
    expect(checksums.get('goodvibes-macos-arm64')).toBe('c'.repeat(64));
  });
});

describe('resolveArtifactNames', () => {
  test('resolves known platform/arch pairs', () => {
    expect(resolveArtifactNames('linux', 'x64')).toEqual({
      app: 'goodvibes-linux-x64',
      daemon: 'goodvibes-daemon-linux-x64',
    });
    expect(resolveArtifactNames('darwin', 'arm64')).toEqual({
      app: 'goodvibes-macos-arm64',
      daemon: 'goodvibes-daemon-macos-arm64',
    });
  });

  test('returns null for unsupported platform/arch pairs', () => {
    expect(resolveArtifactNames('win32', 'x64')).toBeNull();
  });
});

describe('postinstall.js wiring', () => {
  test('re-exports the same verification functions it uses internally', () => {
    // Guards against postinstall.js drifting back to its own copy of this
    // logic instead of the shared src/runtime/release-artifacts.ts module.
    expect(postinstall.verifyChecksum).toBe(verifyChecksum);
    expect(postinstall.parseChecksumFile).toBe(parseChecksumFile);
    expect(postinstall.sha256).toBe(sha256);
    expect(postinstall.resolveArtifactNames).toBe(resolveArtifactNames);
    expect(postinstall.CHECKSUM_MANIFEST_NAME).toBe(CHECKSUM_MANIFEST_NAME);
  });
});

describe('end-to-end: the download-verify loop shape from installPlatformBinaries', () => {
  test('a missing manifest entry hard-fails instead of installing unverified', () => {
    const manifestText = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa  goodvibes-linux-x64';
    const checksums = parseChecksumFile(manifestText);

    const downloadedBuffer = Buffer.from('fake daemon binary bytes');
    const actual = sha256(downloadedBuffer);
    // goodvibes-daemon-linux-x64 has no entry in the manifest above.
    const expected = checksums.get('goodvibes-daemon-linux-x64');

    expect(() => verifyChecksum('goodvibes-daemon-linux-x64', actual, expected)).toThrow(
      /no checksum entry for goodvibes-daemon-linux-x64/,
    );
  });
});

/**
 * The wake-word model is installed as part of installing, and the rule that
 * makes that acceptable is that it can never fail the install. These cover the
 * TUI's own seam; the policy's never-throw contract (offline, DNS, HTTP error,
 * unwritable tree, a provisioner that itself threw) is exercised in the SDK.
 */
describe('the wake-word model install step in postinstall', () => {
  test('postinstall exposes the step, and running it in a source checkout is a stated skip', async () => {
    expect(typeof postinstall.installWakeWordModel).toBe('function');
    // This repository IS a source checkout, so the step must decline rather than
    // pull 6 MB into the developer's home on every `bun install`, the same rule
    // the release-binary install already follows.
    await expect(postinstall.installWakeWordModel()).resolves.toBeUndefined();
  });

  test('it calls the SDK policy, derives the managed root from the SDK, and cannot throw out of main()', () => {
    const source = readFileSync(join(import.meta.dir, '../../../scripts/postinstall.js'), 'utf8');
    // The pins stay in the SDK's manifest: this file must not carry a URL or a
    // checksum of its own for the wake artifacts.
    expect(source).toContain('provisionWakeWordModelsAtInstall');
    // And the managed root comes from the SDK's one derivation, not a hand-written
    // join, an installer writing to a directory the daemon does not read would
    // report success and provision nothing usable.
    expect(source).toContain('resolveManagedVoiceRoot(home)');
    expect(source).not.toContain('voice-runtimes-v1');
    // Even a failed dynamic import is caught: reaching main()'s caller with an
    // exception here would abort an install over an optional model.
    const step = source.slice(source.indexOf('async function installWakeWordModel'), source.indexOf('async function main'));
    expect(step).toContain('try {');
    expect(step).toContain('} catch (error) {');
    expect(step).toContain('/voice wake setup');
    // It runs after the binaries, so a failure cannot preempt the real install.
    const main = source.slice(source.indexOf('async function main'));
    expect(main.indexOf('installPlatformBinaries')).toBeLessThan(main.indexOf('installWakeWordModel'));
  });

  test('it honours the same skip switches as the binary install', () => {
    const source = readFileSync(join(import.meta.dir, '../../../scripts/postinstall.js'), 'utf8');
    const step = source.slice(source.indexOf('async function installWakeWordModel'), source.indexOf('async function main'));
    expect(step).toContain('noDownload');
    expect(step).toContain('isSourceCheckout()');
  });
});
