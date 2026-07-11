import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  applyUpdate,
  checkForUpdate,
  detectDaemonServiceManaged,
  type ApplyUpdateOptions,
  type RunCommand,
} from '../../input/commands/update-runtime.ts';
import type { UpdateFetchLike } from '../../runtime/update-check.ts';

// This suite pins fixture versions ('1.0.0' / '1.1.0' / 'v9.9.9') rather than
// the live build VERSION, per this repo's rule that tests must never compare
// against the running package version (which shifts on every release bump).
// All network access goes through a stubbed fetchImpl — nothing here makes a
// live call.

interface FakeResponseSpec {
  readonly ok?: boolean;
  readonly status?: number;
  readonly url?: string;
  readonly location?: string | null;
  readonly text?: string;
  readonly buffer?: Buffer;
}

function fakeResponse(spec: FakeResponseSpec) {
  return {
    ok: spec.ok ?? true,
    status: spec.status ?? 200,
    url: spec.url ?? '',
    headers: { get: (name: string) => (name.toLowerCase() === 'location' ? spec.location ?? null : null) },
    text: async () => spec.text ?? '',
    arrayBuffer: async () => {
      const buf = spec.buffer ?? Buffer.alloc(0);
      return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    },
  };
}

const RELEASES_LATEST_URL = 'https://github.com/mgd34msu/goodvibes-tui/releases/latest';

function buildStubFetch(options: {
  readonly latestTag: string;
  readonly checksumText?: string;
  readonly appBuffer?: Buffer;
  readonly daemonBuffer?: Buffer;
  readonly addonBuffer?: Buffer;
  readonly calls?: string[];
}): UpdateFetchLike {
  const calls = options.calls ?? [];
  return (async (url: string, init?: { method?: string }) => {
    calls.push(`${init?.method ?? 'GET'} ${url}`);
    if (url === RELEASES_LATEST_URL) {
      return fakeResponse({
        status: 302,
        location: `https://github.com/mgd34msu/goodvibes-tui/releases/tag/${options.latestTag}`,
      });
    }
    if (url.endsWith('SHA256SUMS.txt')) {
      return fakeResponse({ text: options.checksumText ?? '' });
    }
    if (url.endsWith('sqlite-vec-linux-x64.so')) {
      return fakeResponse({ buffer: options.addonBuffer ?? Buffer.from('addon-bytes') });
    }
    if (url.endsWith('goodvibes-daemon-linux-x64')) {
      return fakeResponse({ buffer: options.daemonBuffer ?? Buffer.from('daemon-bytes') });
    }
    if (/goodvibes-linux-x64$/.test(url)) {
      return fakeResponse({ buffer: options.appBuffer ?? Buffer.from('app-bytes') });
    }
    throw new Error(`unexpected fetch in test: ${url}`);
  }) as UpdateFetchLike;
}

function sha256Hex(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

function baseApplyOptions(overrides: Partial<ApplyUpdateOptions>): ApplyUpdateOptions {
  const printed: string[] = [];
  return {
    fetchImpl: buildStubFetch({ latestTag: 'v1.0.0' }),
    execPath: '/home/user/.local/bin/goodvibes',
    platform: 'linux',
    arch: 'x64',
    currentVersion: '1.0.0',
    print: (line) => printed.push(line),
    configManager: { get: () => undefined },
    swap: () => {},
    writeAddon: () => {},
    fileExists: () => false,
    ...overrides,
  };
}

describe('applyUpdate — non-binary install kinds never attempt a swap', () => {
  test('running from source prints the curl installer one-liner and makes no download calls', async () => {
    const printed: string[] = [];
    const calls: string[] = [];
    await applyUpdate(
      baseApplyOptions({
        execPath: '/home/user/.bun/bin/bun',
        fetchImpl: buildStubFetch({ latestTag: 'v9.9.9', calls }),
        print: (line) => printed.push(line),
      }),
    );
    expect(calls).toEqual([]); // never even checks the network for a non-binary install
    expect(printed.join('\n')).toContain('curl -fsSL https://goodvibes.sh/install.sh | sh');
    expect(printed.join('\n')).toContain('running from source');
  });

  test('a bun-global package install prints the bun add -g command and makes no download calls', async () => {
    const printed: string[] = [];
    const calls: string[] = [];
    await applyUpdate(
      baseApplyOptions({
        execPath: '/home/user/.bun/install/global/node_modules/@pellux/goodvibes-tui/vendor/goodvibes-linux-x64',
        fetchImpl: buildStubFetch({ latestTag: 'v9.9.9', calls }),
        print: (line) => printed.push(line),
      }),
    );
    expect(calls).toEqual([]);
    expect(printed.join('\n')).toContain('bun add -g @pellux/goodvibes-tui');
  });
});

describe('applyUpdate — binary install, version comparison', () => {
  test('reports already current honestly and does not download artifacts', async () => {
    const printed: string[] = [];
    const calls: string[] = [];
    await applyUpdate(
      baseApplyOptions({
        currentVersion: '1.0.0',
        fetchImpl: buildStubFetch({ latestTag: 'v1.0.0', calls }),
        print: (line) => printed.push(line),
      }),
    );
    expect(calls).toEqual([`HEAD ${RELEASES_LATEST_URL}`]);
    expect(printed.join('\n')).toContain('Already current');
    expect(printed.join('\n')).toContain('1.0.0');
  });

  test('reports already current when the running build is even newer than the latest tag', async () => {
    const printed: string[] = [];
    await applyUpdate(
      baseApplyOptions({
        currentVersion: '2.0.0',
        fetchImpl: buildStubFetch({ latestTag: 'v1.9.9' }),
        print: (line) => printed.push(line),
      }),
    );
    expect(printed.join('\n')).toContain('Already current');
  });
});

describe('applyUpdate — binary install, checksum verification', () => {
  test('a missing manifest entry hard-fails the update and never swaps either binary', async () => {
    const swapCalls: Array<{ target: string; length: number }> = [];
    const checksumText = ''; // no entries at all for either artifact
    const options = baseApplyOptions({
      currentVersion: '1.0.0',
      fetchImpl: buildStubFetch({ latestTag: 'v1.1.0', checksumText }),
      swap: (target, buffer) => swapCalls.push({ target, length: buffer.length }),
      fileExists: () => true,
    });
    await expect(applyUpdate(options)).rejects.toThrow(/no checksum entry for goodvibes-linux-x64/);
    expect(swapCalls).toEqual([]);
  });

  test('a checksum mismatch on the daemon artifact hard-fails and never swaps either binary, even though the app checksum matched', async () => {
    const appBuffer = Buffer.from('app-bytes');
    const daemonBuffer = Buffer.from('daemon-bytes');
    const appHash = sha256Hex(appBuffer);
    const checksumText = [`${appHash}  goodvibes-linux-x64`, `${'0'.repeat(64)}  goodvibes-daemon-linux-x64`].join('\n');
    const swapCalls: string[] = [];
    const options = baseApplyOptions({
      currentVersion: '1.0.0',
      fetchImpl: buildStubFetch({ latestTag: 'v1.1.0', checksumText, appBuffer, daemonBuffer }),
      swap: (target) => swapCalls.push(target),
      fileExists: () => true,
    });
    await expect(applyUpdate(options)).rejects.toThrow(/checksum mismatch for goodvibes-daemon-linux-x64/);
    expect(swapCalls).toEqual([]);
  });

  test('matching checksums for both artifacts swap both binaries atomically and place the sqlite-vec addon', async () => {
    const appBuffer = Buffer.from('new-app-bytes');
    const daemonBuffer = Buffer.from('new-daemon-bytes');
    const addonBuffer = Buffer.from('new-addon-bytes');
    const checksumText = [
      `${sha256Hex(appBuffer)}  goodvibes-linux-x64`,
      `${sha256Hex(daemonBuffer)}  goodvibes-daemon-linux-x64`,
      `${sha256Hex(addonBuffer)}  sqlite-vec-linux-x64.so`,
    ].join('\n');
    const swapCalls: Array<{ target: string; content: string }> = [];
    const addonCalls: Array<{ target: string; content: string }> = [];
    const printed: string[] = [];
    const options = baseApplyOptions({
      execPath: '/home/user/.local/bin/goodvibes',
      currentVersion: '1.0.0',
      fetchImpl: buildStubFetch({ latestTag: 'v1.1.0', checksumText, appBuffer, daemonBuffer, addonBuffer }),
      swap: (target, buffer) => swapCalls.push({ target, content: buffer.toString() }),
      writeAddon: (target, buffer) => addonCalls.push({ target, content: buffer.toString() }),
      fileExists: () => true,
      print: (line) => printed.push(line),
    });
    await applyUpdate(options);
    expect(swapCalls).toEqual([
      { target: '/home/user/.local/bin/goodvibes', content: 'new-app-bytes' },
      { target: '/home/user/.local/bin/goodvibes-daemon', content: 'new-daemon-bytes' },
    ]);
    // The addon lands at <execDir>/lib/sqlite-vec-<os>-<arch>/vec0.<suffix> — the
    // exact path the SDK's loader resolves next to the running binary.
    expect(addonCalls).toEqual([
      { target: '/home/user/.local/bin/lib/sqlite-vec-linux-x64/vec0.so', content: 'new-addon-bytes' },
    ]);
    expect(printed.join('\n')).toContain('Updated to v1.1.0');
    expect(printed.join('\n')).toContain('/home/user/.local/bin/lib/sqlite-vec-linux-x64/vec0.so');
  });

  test('a missing manifest entry for the sqlite-vec addon hard-fails and never swaps a binary or writes the addon', async () => {
    const appBuffer = Buffer.from('new-app-bytes');
    const daemonBuffer = Buffer.from('new-daemon-bytes');
    // Binaries have valid entries; the addon has none — a missing addon entry is
    // as fatal as a missing binary entry.
    const checksumText = [
      `${sha256Hex(appBuffer)}  goodvibes-linux-x64`,
      `${sha256Hex(daemonBuffer)}  goodvibes-daemon-linux-x64`,
    ].join('\n');
    const swapCalls: string[] = [];
    const addonCalls: string[] = [];
    const options = baseApplyOptions({
      currentVersion: '1.0.0',
      fetchImpl: buildStubFetch({ latestTag: 'v1.1.0', checksumText, appBuffer, daemonBuffer }),
      swap: (target) => swapCalls.push(target),
      writeAddon: (target) => addonCalls.push(target),
      fileExists: () => true,
    });
    await expect(applyUpdate(options)).rejects.toThrow(/no checksum entry for sqlite-vec-linux-x64\.so/);
    expect(swapCalls).toEqual([]);
    expect(addonCalls).toEqual([]);
  });

  test('a checksum mismatch on the sqlite-vec addon hard-fails and never swaps a binary or writes the addon', async () => {
    const appBuffer = Buffer.from('new-app-bytes');
    const daemonBuffer = Buffer.from('new-daemon-bytes');
    const addonBuffer = Buffer.from('new-addon-bytes');
    const checksumText = [
      `${sha256Hex(appBuffer)}  goodvibes-linux-x64`,
      `${sha256Hex(daemonBuffer)}  goodvibes-daemon-linux-x64`,
      `${'0'.repeat(64)}  sqlite-vec-linux-x64.so`,
    ].join('\n');
    const swapCalls: string[] = [];
    const addonCalls: string[] = [];
    const options = baseApplyOptions({
      currentVersion: '1.0.0',
      fetchImpl: buildStubFetch({ latestTag: 'v1.1.0', checksumText, appBuffer, daemonBuffer, addonBuffer }),
      swap: (target) => swapCalls.push(target),
      writeAddon: (target) => addonCalls.push(target),
      fileExists: () => true,
    });
    await expect(applyUpdate(options)).rejects.toThrow(/checksum mismatch for sqlite-vec-linux-x64\.so/);
    expect(swapCalls).toEqual([]);
    expect(addonCalls).toEqual([]);
  });

  test('when the daemon binary is not present at its expected sibling location, only the app binary is swapped and the message says so honestly', async () => {
    const appBuffer = Buffer.from('new-app-bytes');
    const addonBuffer = Buffer.from('new-addon-bytes');
    const checksumText = [
      `${sha256Hex(appBuffer)}  goodvibes-linux-x64`,
      `${sha256Hex(addonBuffer)}  sqlite-vec-linux-x64.so`,
    ].join('\n');
    const swapCalls: string[] = [];
    const addonCalls: string[] = [];
    const printed: string[] = [];
    const options = baseApplyOptions({
      currentVersion: '1.0.0',
      fetchImpl: buildStubFetch({ latestTag: 'v1.1.0', checksumText, appBuffer, addonBuffer }),
      swap: (target) => swapCalls.push(target),
      writeAddon: (target) => addonCalls.push(target),
      fileExists: () => false, // no daemon binary next to the app binary
      print: (line) => printed.push(line),
    });
    await applyUpdate(options);
    expect(swapCalls).toEqual(['/home/user/.local/bin/goodvibes']);
    // The addon is refreshed regardless of whether the daemon binary is present —
    // it serves the app binary too.
    expect(addonCalls).toEqual(['/home/user/.local/bin/lib/sqlite-vec-linux-x64/vec0.so']);
    expect(printed.join('\n')).toContain('not found at');
    expect(printed.join('\n')).toContain('left untouched');
  });
});

describe('checkForUpdate', () => {
  test('reports isCurrent=true when the running version matches the latest tag', async () => {
    const result = await checkForUpdate(buildStubFetch({ latestTag: 'v1.0.0' }), '1.0.0');
    expect(result).toEqual({ latestTag: 'v1.0.0', isCurrent: true });
  });

  test('reports isCurrent=false and the real latest tag when a newer release exists', async () => {
    const result = await checkForUpdate(buildStubFetch({ latestTag: 'v1.2.0' }), '1.0.0');
    expect(result).toEqual({ latestTag: 'v1.2.0', isCurrent: false });
  });
});

describe('detectDaemonServiceManaged', () => {
  const activeRunner: RunCommand = () => ({ status: 0, stdout: 'active\n' });
  const inactiveRunner: RunCommand = () => ({ status: 3, stdout: 'inactive\n' });

  test('reports managed with the real restart command when systemctl reports the unit active on Linux', () => {
    const info = detectDaemonServiceManaged('linux', { get: () => undefined }, activeRunner);
    expect(info.managed).toBe(true);
    expect(info.restartCommand).toBe('systemctl --user restart goodvibes.service');
  });

  test('reports not managed when the unit is not active', () => {
    const info = detectDaemonServiceManaged('linux', { get: () => undefined }, inactiveRunner);
    expect(info.managed).toBe(false);
  });

  test('honors a configured non-default service name', () => {
    const info = detectDaemonServiceManaged('linux', { get: (key) => (key === 'service.serviceName' ? 'my-goodvibes' : undefined) }, activeRunner);
    expect(info.restartCommand).toBe('systemctl --user restart my-goodvibes.service');
  });

  test('reports not managed on non-Linux platforms without shelling out at all', () => {
    let called = false;
    const info = detectDaemonServiceManaged('darwin', { get: () => undefined }, () => {
      called = true;
      return { status: 0, stdout: 'active' };
    });
    expect(info.managed).toBe(false);
    expect(called).toBe(false);
  });
});
