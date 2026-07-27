import { describe, expect, test } from 'bun:test';
import {
  runReachabilityCheck,
  resolveSelfDirectory,
} from '../../runtime/path-shadow-startup.ts';
import { buildReachabilityNotices, reachabilityNoticeLines } from '../../runtime/reachability-notice.ts';
import { scanCommandShadows } from '../../runtime/path-shadow.ts';

/**
 * The startup reachability check: does this running build say so when the
 * shell reaches a different copy, and when it is behind the current release?
 *
 * Both failure modes look identical from the outside — an old build answering
 * as if it were the new one — which is how a leftover `~/.bun/bin` link at
 * PATH position 2 kept answering while `~/.local/bin` at position 21 was
 * dutifully upgraded twice. Every host touch is injected here: no PATH is
 * read, no file is stat'ed, no process is spawned, and no release lookup
 * leaves the machine.
 */

const HOME = '/home/owner';
const INSTALL_DIR = `${HOME}/.local/bin`;
const BUN_BIN = `${HOME}/.bun/bin`;
const BUN_PACKAGE = `${HOME}/.bun/install/global/node_modules/@pellux/goodvibes-agent/bin/goodvibes-agent`;

interface FakeHost {
  readonly files: Record<string, { readonly link?: string; readonly version?: string }>;
  readonly probes: string[];
}

function hostIo(host: FakeHost) {
  return {
    isExecutableFile: (path: string) => Object.hasOwn(host.files, path),
    realPath: (path: string) => host.files[path]?.link ?? path,
    probeVersion: (path: string) => {
      host.probes.push(path);
      return host.files[path]?.version;
    },
  };
}

describe('the startup check fires on an earlier-PATH copy', () => {
  test('it names both copies, both versions, and the exact fix', async () => {
    const host: FakeHost = {
      probes: [],
      files: {
        [`${BUN_BIN}/goodvibes`]: { link: BUN_PACKAGE, version: 'goodvibes 1.18.1' },
        [`${INSTALL_DIR}/goodvibes`]: { version: 'goodvibes 1.25.0' },
      },
    };
    const result = await runReachabilityCheck({
      execPath: `${INSTALL_DIR}/goodvibes`,
      pathValue: `${BUN_BIN}:/usr/bin:${INSTALL_DIR}`,
      homeDir: HOME,
      runningVersion: '1.25.0',
      commandName: 'goodvibes',
      resolveLatest: async () => '1.25.0',
      ...hostIo(host),
    });

    const text = reachabilityNoticeLines(result.notices).join('\n');
    expect(result.notices.some((notice) => notice.kind === 'shadowed')).toBe(true);
    expect(text).toContain(`${BUN_BIN}/goodvibes`);
    expect(text).toContain('version 1.18.1');
    expect(text).toContain(`${INSTALL_DIR}/goodvibes`);
    expect(text).toContain('version 1.25.0');
    expect(text).toContain('bun remove -g @pellux/goodvibes-agent');
  });

  test('a shadow reports both problems at once when the build is also behind', async () => {
    const host: FakeHost = {
      probes: [],
      files: {
        [`${BUN_BIN}/goodvibes`]: { link: BUN_PACKAGE, version: 'goodvibes 1.18.1' },
        [`${INSTALL_DIR}/goodvibes`]: { version: 'goodvibes 1.21.0' },
      },
    };
    const result = await runReachabilityCheck({
      execPath: `${INSTALL_DIR}/goodvibes`,
      pathValue: `${BUN_BIN}:${INSTALL_DIR}`,
      homeDir: HOME,
      runningVersion: '1.21.0',
      commandName: 'goodvibes',
      resolveLatest: async () => 'v1.25.0',
      ...hostIo(host),
    });

    expect(result.notices.map((notice) => notice.kind)).toEqual(['shadowed', 'behind']);
    const text = reachabilityNoticeLines(result.notices).join('\n');
    expect(text).toContain('This build is v1.21.0. The current release is v1.25.0');
    expect(text).toContain('curl -fsSL https://goodvibes.sh/install.sh | sh');
  });
});

describe('the startup check stays silent when there is nothing to say', () => {
  test('one copy, first on PATH, current version', async () => {
    const host: FakeHost = {
      probes: [],
      files: { [`${INSTALL_DIR}/goodvibes`]: { version: 'goodvibes 1.25.0' } },
    };
    const result = await runReachabilityCheck({
      execPath: `${INSTALL_DIR}/goodvibes`,
      pathValue: `${INSTALL_DIR}:/usr/bin`,
      homeDir: HOME,
      runningVersion: '1.25.0',
      commandName: 'goodvibes',
      resolveLatest: async () => {
        throw new Error('the release lookup must not run for a healthy binary install');
      },
      ...hostIo(host),
    });

    expect(result.notices).toEqual([]);
    // Nothing is spawned while there is nothing to report.
    expect(host.probes).toEqual([]);
  });

  test('a second copy later on PATH loses, so it is not reported', async () => {
    const host: FakeHost = {
      probes: [],
      files: {
        [`${INSTALL_DIR}/goodvibes`]: { version: 'goodvibes 1.25.0' },
        [`${BUN_BIN}/goodvibes`]: { link: BUN_PACKAGE, version: 'goodvibes 1.18.1' },
      },
    };
    const result = await runReachabilityCheck({
      execPath: `${INSTALL_DIR}/goodvibes`,
      pathValue: `${INSTALL_DIR}:${BUN_BIN}`,
      homeDir: HOME,
      runningVersion: '1.25.0',
      commandName: 'goodvibes',
      resolveLatest: async () => '1.25.0',
      ...hostIo(host),
    });
    expect(result.notices).toEqual([]);
  });

  test('a source checkout is not an install and is never flagged', async () => {
    const host: FakeHost = {
      probes: [],
      files: { [`${BUN_BIN}/goodvibes`]: { link: BUN_PACKAGE, version: 'goodvibes 1.18.1' } },
    };
    const result = await runReachabilityCheck({
      execPath: '/usr/local/bin/bun',
      pathValue: `${BUN_BIN}:${INSTALL_DIR}`,
      homeDir: HOME,
      runningVersion: '1.25.0',
      commandName: 'goodvibes',
      resolveLatest: async () => {
        throw new Error('a source checkout must not reach the network');
      },
      ...hostIo(host),
    });
    expect(result.notices).toEqual([]);
  });

  test('a package-managed install running from inside node_modules says nothing about PATH', async () => {
    const host: FakeHost = {
      probes: [],
      files: { [BUN_PACKAGE]: { version: 'goodvibes 1.18.1' } },
    };
    const result = await runReachabilityCheck({
      execPath: BUN_PACKAGE,
      pathValue: '/usr/bin',
      homeDir: HOME,
      runningVersion: '1.18.1',
      commandName: 'goodvibes',
      resolveLatest: async () => '1.25.0',
      ...hostIo(host),
    });
    expect(result.notices.map((notice) => notice.kind)).not.toContain('not-on-path');
  });
});

describe('being behind is stated plainly, and only when it is known', () => {
  test('a package-managed install that cannot swap itself is told it is behind, with its own command', async () => {
    const host: FakeHost = {
      probes: [],
      files: {
        [BUN_PACKAGE]: { version: 'goodvibes 1.18.1' },
        [`${BUN_BIN}/goodvibes`]: { link: BUN_PACKAGE, version: 'goodvibes 1.18.1' },
      },
    };
    const result = await runReachabilityCheck({
      execPath: BUN_PACKAGE,
      pathValue: `${BUN_BIN}:/usr/bin`,
      homeDir: HOME,
      runningVersion: '1.18.1',
      commandName: 'goodvibes',
      resolveLatest: async () => 'v1.25.0',
      ...hostIo(host),
    });

    const text = reachabilityNoticeLines(result.notices).join('\n');
    expect(text).toContain('This build is v1.18.1. The current release is v1.25.0');
    expect(text).toContain('genuinely absent from this build');
    expect(text).toContain('bun add -g @pellux/goodvibes-tui');
  });

  test('an unknown latest version says nothing rather than guessing', () => {
    const scan = scanCommandShadows({
      commands: ['goodvibes'],
      installDir: INSTALL_DIR,
      pathEntries: [INSTALL_DIR],
      homeDir: HOME,
      isExecutableFile: (path) => path === `${INSTALL_DIR}/goodvibes`,
      realPath: (path) => path,
    });
    expect(buildReachabilityNotices({
      scan,
      runningVersion: '1.18.1',
      latestVersion: undefined,
      updateCommand: 'curl -fsSL https://goodvibes.sh/install.sh | sh',
    })).toEqual([]);
  });

  test('a build ahead of the published release is not called behind', () => {
    const scan = scanCommandShadows({
      commands: ['goodvibes'],
      installDir: INSTALL_DIR,
      pathEntries: [INSTALL_DIR],
      homeDir: HOME,
      isExecutableFile: (path) => path === `${INSTALL_DIR}/goodvibes`,
      realPath: (path) => path,
    });
    expect(buildReachabilityNotices({
      scan,
      runningVersion: '1.26.0',
      latestVersion: '1.25.0',
      updateCommand: 'curl -fsSL https://goodvibes.sh/install.sh | sh',
    })).toEqual([]);
  });
});

describe('an installed binary nobody can reach by name', () => {
  test('a binary whose directory is missing from PATH is reported', async () => {
    const host: FakeHost = {
      probes: [],
      files: { [`${INSTALL_DIR}/goodvibes`]: { version: 'goodvibes 1.25.0' } },
    };
    const result = await runReachabilityCheck({
      execPath: `${INSTALL_DIR}/goodvibes`,
      pathValue: '/usr/bin',
      homeDir: HOME,
      runningVersion: '1.25.0',
      commandName: 'goodvibes',
      resolveLatest: async () => '1.25.0',
      ...hostIo(host),
    });

    expect(result.notices.map((notice) => notice.kind)).toContain('not-on-path');
    expect(reachabilityNoticeLines(result.notices).join('\n')).toContain('not on your PATH');
  });
});

describe('resolveSelfDirectory', () => {
  test('prefers the PATH entry that actually resolves to this executable', () => {
    expect(resolveSelfDirectory({
      execPath: BUN_PACKAGE,
      command: 'goodvibes',
      pathEntries: ['/usr/bin', BUN_BIN],
      realPath: (path) => (path === `${BUN_BIN}/goodvibes` ? BUN_PACKAGE : path),
      isExecutableFile: (path) => path === `${BUN_BIN}/goodvibes`,
    })).toBe(BUN_BIN);
  });

  test('falls back to the containing directory for a standalone binary only', () => {
    expect(resolveSelfDirectory({
      execPath: `${INSTALL_DIR}/goodvibes`,
      command: 'goodvibes',
      pathEntries: ['/usr/bin'],
      realPath: (path) => path,
      isExecutableFile: () => false,
    })).toBe(INSTALL_DIR);

    expect(resolveSelfDirectory({
      execPath: BUN_PACKAGE,
      command: 'goodvibes',
      pathEntries: ['/usr/bin'],
      realPath: (path) => path,
      isExecutableFile: () => false,
    })).toBeUndefined();
  });
});
