import { describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { verifyPackageCliInstall } from '../../cli/package-verification.ts';

describe('package CLI install verification', () => {
  test('package exposes runnable GoodVibes bin wrappers and a safe npm tarball contract', () => {
    const report = verifyPackageCliInstall(resolve(import.meta.dir, '../../..'));

    expect(report.packageName).toBe('@pellux/goodvibes-tui');
    expect(report.issues).toEqual([]);
    expect(report.bins.map((bin) => bin.command)).toEqual(['goodvibes', 'goodvibes-daemon']);
    expect(report.bins.every((bin) => bin.exists && bin.executable)).toBe(true);
    expect(report.bins.every((bin) => bin.usesBunShebang)).toBe(true);
    expect(report.bins.every((bin) => bin.hasLocalPlatformBuildFallback)).toBe(true);
    expect(report.bins.every((bin) => bin.hasLocalBuildFallback)).toBe(true);
    expect(report.bins.every((bin) => bin.hasVendoredBinaryFallback)).toBe(true);
    expect(report.bins.every((bin) => bin.hasSourceFallback)).toBe(true);
    expect(report.tarball.requiredPathsPresent).toContain('bin/goodvibes');
    expect(report.tarball.requiredPathsPresent).toContain('bin/goodvibes-daemon');
    expect(report.tarball.requiredPathsPresent).toContain('scripts/check-bun.sh');
    expect(report.tarball.forbiddenPaths).toEqual([]);
  }, 30_000);
});
