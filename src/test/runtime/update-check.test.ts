import { describe, expect, test } from 'bun:test';
import {
  compareVersions,
  detectInstallKind,
  fallbackUpdateCommand,
  normalizeVersion,
  parseReleaseTagFromLocation,
  resolveLatestReleaseTag,
  type UpdateFetchLike,
} from '../../runtime/update-check.ts';

describe('normalizeVersion', () => {
  test('strips a leading v', () => {
    expect(normalizeVersion('v1.13.2')).toBe('1.13.2');
  });

  test('leaves a bare version alone', () => {
    expect(normalizeVersion('1.13.2')).toBe('1.13.2');
  });
});

describe('compareVersions', () => {
  test('detects equal versions regardless of a leading v', () => {
    expect(compareVersions('v1.13.1', '1.13.1')).toBe(0);
  });

  test('detects a newer patch version', () => {
    expect(compareVersions('1.13.1', '1.13.2')).toBe(-1);
    expect(compareVersions('1.13.2', '1.13.1')).toBe(1);
  });

  test('detects a newer minor/major version', () => {
    expect(compareVersions('1.13.9', '1.14.0')).toBe(-1);
    expect(compareVersions('1.99.0', '2.0.0')).toBe(-1);
  });

  test('treats a missing trailing component as 0', () => {
    expect(compareVersions('1.2', '1.2.0')).toBe(0);
    expect(compareVersions('1.2', '1.2.1')).toBe(-1);
  });
});

describe('parseReleaseTagFromLocation', () => {
  test('extracts the tag from a releases/tag/ redirect URL', () => {
    expect(parseReleaseTagFromLocation('https://github.com/mgd34msu/goodvibes-tui/releases/tag/v1.13.2')).toBe('v1.13.2');
  });

  test('returns null for a missing location', () => {
    expect(parseReleaseTagFromLocation(null)).toBeNull();
    expect(parseReleaseTagFromLocation(undefined)).toBeNull();
    expect(parseReleaseTagFromLocation('')).toBeNull();
  });
});

function stubFetch(response: { location?: string | null; url?: string }): UpdateFetchLike {
  return async () => ({
    ok: true,
    status: 302,
    url: response.url ?? '',
    headers: { get: (name: string) => (name.toLowerCase() === 'location' ? response.location ?? null : null) },
    text: async () => '',
    arrayBuffer: async () => new ArrayBuffer(0),
  });
}

describe('resolveLatestReleaseTag', () => {
  test('resolves the tag from a stubbed redirect Location header — no live network call', async () => {
    const fetchImpl = stubFetch({ location: 'https://github.com/mgd34msu/goodvibes-tui/releases/tag/v9.9.9' });
    const tag = await resolveLatestReleaseTag(fetchImpl, 'https://github.com/mgd34msu/goodvibes-tui/releases/latest');
    expect(tag).toBe('v9.9.9');
  });

  test('throws honestly when there is no redirect Location to resolve a tag from', async () => {
    const fetchImpl = stubFetch({ location: null, url: 'https://github.com/mgd34msu/goodvibes-tui/releases/latest' });
    await expect(resolveLatestReleaseTag(fetchImpl, 'https://github.com/mgd34msu/goodvibes-tui/releases/latest')).rejects.toThrow(
      /could not resolve the latest release tag/,
    );
  });
});

describe('detectInstallKind', () => {
  test('a standalone compiled binary (install.sh install) is "binary"', () => {
    expect(detectInstallKind('/home/user/.local/bin/goodvibes')).toBe('binary');
  });

  test('running via the bun interpreter directly is "source"', () => {
    expect(detectInstallKind('/home/user/.bun/bin/bun')).toBe('source');
    expect(detectInstallKind('C:\\Users\\user\\.bun\\bin\\bun.exe')).toBe('source');
  });

  test('a vendored binary inside a node_modules install is "bun-global-package"', () => {
    expect(
      detectInstallKind('/home/user/.bun/install/global/node_modules/@pellux/goodvibes-tui/vendor/goodvibes-linux-x64'),
    ).toBe('bun-global-package');
  });
});

describe('fallbackUpdateCommand', () => {
  test('gives the bun global-add command for a bun-global-package install', () => {
    expect(fallbackUpdateCommand('bun-global-package')).toBe('bun add -g @pellux/goodvibes-tui');
  });

  test('gives the curl installer one-liner for a source checkout', () => {
    expect(fallbackUpdateCommand('source')).toBe('curl -fsSL https://goodvibes.sh/install.sh | sh');
  });
});
