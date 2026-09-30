/**
 * Dependency ranges this repository shares with the SDK must agree, so the
 * lockfile resolves one copy the SDK was built against.
 */
import { describe, test, expect } from 'bun:test';
import { join } from 'node:path';

const repoRoot = join(import.meta.dir, '..', '..', '..');

// ---------------------------------------------------------------------------
// Pin agreement with the platform
// ---------------------------------------------------------------------------

describe('dependency ranges agree with the platform that declares them', () => {
  /**
   * bun.lock resolves exactly ONE copy of a package both this repository and
   * the SDK depend on. When the two declare different ranges the older one can
   * win, and the SDK is then compiled and run against a version older than the
   * one it is written for, which is how an ACP pin five minors behind the
   * SDK's went unnoticed. Nothing observes that at runtime, so it is asserted
   * here on the declarations themselves.
   */
  test('every shared dependency states the same range the SDK declares', async () => {
    const ours = (await import(join(repoRoot, 'package.json'))).default as {
      dependencies?: Record<string, string>;
    };
    const platform = (await import(join(repoRoot, 'node_modules', '@pellux', 'goodvibes-sdk', 'package.json'))).default as {
      dependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
    };
    const declared = {
      ...(platform.dependencies ?? {}),
      ...(platform.peerDependencies ?? {}),
      ...(platform.optionalDependencies ?? {}),
    };
    const { readFileSync } = await import('node:fs');
    const drift = Object.entries(ours.dependencies ?? {})
      .filter(([name, range]) => {
        const platformRange = declared[name];
        if (platformRange === undefined) return false;
        if (!platformRange.startsWith('file:')) return platformRange !== range;
        // A file: declaration means the platform VENDORS the tool inside its
        // own package; the range to agree with is the vendored copy's real
        // version, this repo's caret pin must include it.
        const vendored = JSON.parse(
          readFileSync(
            join(repoRoot, 'node_modules', '@pellux', 'goodvibes-sdk', platformRange.slice('file:'.length), 'package.json'),
            'utf-8',
          ),
        ) as { version: string };
        return range !== `^${vendored.version}`;
      })
      .map(([name, range]) => `${name}: this repo ${range}, platform ${declared[name]}`);
    expect(drift).toEqual([]);
  });
});
