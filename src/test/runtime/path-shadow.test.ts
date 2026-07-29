/**
 * PATH shadowing policy: the maintained install must be the copy the shell
 * runs. All filesystem and subprocess touches are injected, so nothing here
 * reads a real PATH, a real install, or runs a real binary.
 *
 * The scenario every case is measured against is the one that happened:
 * `~/.bun/bin/goodvibes-agent` (a leftover `bun add -g` link, 1.18.1) at PATH
 * position 2 shadowing `~/.local/bin/goodvibes-agent` (1.21.0) at position 21.
 * The installer kept upgrading the copy the user never reached.
 */
import { describe, expect, test } from 'bun:test';
import {
  describeShadowReport,
  describeShadowScan,
  isWithinDirectory,
  owningPackageName,
  removableShadows,
  scanCommandShadows,
  splitPathEntries,
  versionLineIdentifiesCommand,
  type ShadowScanInput,
} from '../../runtime/path-shadow.ts';

const HOME = '/home/owner';
const INSTALL_DIR = `${HOME}/.local/bin`;

/**
 * Builds a scan input from a map of `path -> { link?, version? }`. Any path in
 * the map exists and is runnable; anything else does not.
 */
function scanWith(options: {
  readonly files: Record<string, { readonly link?: string; readonly version?: string }>;
  readonly pathEntries: readonly string[];
  readonly commands?: readonly string[];
  readonly homeDir?: string;
  readonly withProbe?: boolean;
}): ShadowScanInput {
  const { files } = options;
  return {
    commands: options.commands ?? ['goodvibes', 'goodvibes-daemon', 'goodvibes-agent'],
    installDir: INSTALL_DIR,
    pathEntries: options.pathEntries,
    homeDir: options.homeDir ?? HOME,
    isExecutableFile: (path) => Object.hasOwn(files, path),
    realPath: (path) => files[path]?.link ?? path,
    probeVersion: options.withProbe === false
      ? undefined
      : (path) => files[path]?.version,
  };
}

const BUN_GLOBAL_LINK = `${HOME}/.bun/install/global/node_modules/@pellux/goodvibes-agent/bin/goodvibes-agent`;

describe('splitPathEntries', () => {
  test('keeps search order, drops empties, collapses duplicates to the winning position', () => {
    expect(splitPathEntries('/a:/b::/a:/c/')).toEqual(['/a', '/b', '/c']);
  });

  test('an unset or empty PATH yields nothing', () => {
    expect(splitPathEntries(undefined)).toEqual([]);
    expect(splitPathEntries('')).toEqual([]);
  });
});

describe('owningPackageName', () => {
  test('recognises one of our packages behind a global link', () => {
    expect(owningPackageName(BUN_GLOBAL_LINK)).toBe('@pellux/goodvibes-agent');
  });

  test('a nested install belongs to the innermost package', () => {
    expect(owningPackageName('/x/node_modules/@other/thing/node_modules/@pellux/goodvibes-tui/bin/g'))
      .toBe('@pellux/goodvibes-tui');
  });

  test('another publisher, another scope, and a plain path are all not ours', () => {
    expect(owningPackageName('/x/node_modules/@other/goodvibes-agent/bin/g')).toBeUndefined();
    expect(owningPackageName('/x/node_modules/@pellux/something-else/bin/g')).toBeUndefined();
    expect(owningPackageName('/usr/local/bin/goodvibes-agent')).toBeUndefined();
  });
});

describe('versionLineIdentifiesCommand', () => {
  test('accepts the exact shape our commands print', () => {
    expect(versionLineIdentifiesCommand('goodvibes-agent 1.18.1', 'goodvibes-agent')).toBe('1.18.1');
    expect(versionLineIdentifiesCommand('goodvibes v1.25.0\n', 'goodvibes')).toBe('1.25.0');
  });

  test('rejects another program, a different name, and unparseable output', () => {
    expect(versionLineIdentifiesCommand('GNU coreutils 9.4', 'goodvibes')).toBeUndefined();
    expect(versionLineIdentifiesCommand('goodvibes 1.0.0', 'goodvibes-agent')).toBeUndefined();
    expect(versionLineIdentifiesCommand('usage: goodvibes [options]', 'goodvibes')).toBeUndefined();
    expect(versionLineIdentifiesCommand(undefined, 'goodvibes')).toBeUndefined();
  });
});

describe('isWithinDirectory', () => {
  test('matches the directory itself and its descendants, not a sibling with a shared prefix', () => {
    expect(isWithinDirectory('/home/owner/.local/bin/x', '/home/owner')).toBe(true);
    expect(isWithinDirectory('/home/owner', '/home/owner')).toBe(true);
    expect(isWithinDirectory('/home/owner2/x', '/home/owner')).toBe(false);
  });
});

describe('a shadowed install is detected', () => {
  const input = scanWith({
    pathEntries: [`${HOME}/bin`, `${HOME}/.bun/bin`, '/usr/bin', INSTALL_DIR],
    files: {
      [`${HOME}/.bun/bin/goodvibes-agent`]: { link: BUN_GLOBAL_LINK, version: 'goodvibes-agent 1.18.1' },
      [`${INSTALL_DIR}/goodvibes-agent`]: { version: 'goodvibes-agent 1.21.0' },
      [`${INSTALL_DIR}/goodvibes`]: { version: 'goodvibes 1.25.0' },
      [`${INSTALL_DIR}/goodvibes-daemon`]: { version: 'goodvibes-daemon 1.25.0' },
    },
  });

  test('the earlier-PATH copy is named as the one that wins', () => {
    const result = scanCommandShadows(input);
    expect(result.hasProblem).toBe(true);
    expect(result.shadowed.map((report) => report.command)).toEqual(['goodvibes-agent']);

    const report = result.shadowed[0]!;
    expect(report.winner?.path).toBe(`${HOME}/.bun/bin/goodvibes-agent`);
    expect(report.winner?.version).toBe('1.18.1');
    expect(report.installed?.path).toBe(`${INSTALL_DIR}/goodvibes-agent`);
    expect(report.installed?.version).toBe('1.21.0');
    expect(report.shadowing).toHaveLength(1);
  });

  test('the commands that are not shadowed are not flagged', () => {
    const result = scanCommandShadows(input);
    const daemon = result.reports.find((report) => report.command === 'goodvibes-daemon')!;
    expect(daemon.shadowing).toEqual([]);
    expect(daemon.winner?.path).toBe(`${INSTALL_DIR}/goodvibes-daemon`);
  });

  test('the report says which path wins, both versions, and the exact fix', () => {
    const lines = describeShadowScan(scanCommandShadows(input)).join('\n');
    expect(lines).toContain(`${HOME}/.bun/bin/goodvibes-agent`);
    expect(lines).toContain('version 1.18.1');
    expect(lines).toContain(`${INSTALL_DIR}/goodvibes-agent`);
    expect(lines).toContain('version 1.21.0');
    expect(lines).toContain('bun remove -g @pellux/goodvibes-agent');
  });
});

describe('a healthy install is not falsely flagged', () => {
  test('one copy, in the install directory, on PATH', () => {
    const result = scanCommandShadows(scanWith({
      pathEntries: [`${HOME}/bin`, INSTALL_DIR, '/usr/bin'],
      files: {
        [`${INSTALL_DIR}/goodvibes`]: { version: 'goodvibes 1.25.0' },
        [`${INSTALL_DIR}/goodvibes-daemon`]: { version: 'goodvibes-daemon 1.25.0' },
        [`${INSTALL_DIR}/goodvibes-agent`]: { version: 'goodvibes-agent 1.21.0' },
      },
    }));
    expect(result.hasProblem).toBe(false);
    expect(result.shadowed).toEqual([]);
    expect(describeShadowScan(result)).toEqual([]);
  });

  test('a second copy LATER on PATH loses, so it is not a shadow', () => {
    const result = scanCommandShadows(scanWith({
      pathEntries: [INSTALL_DIR, `${HOME}/.bun/bin`],
      files: {
        [`${INSTALL_DIR}/goodvibes-agent`]: { version: 'goodvibes-agent 1.21.0' },
        [`${HOME}/.bun/bin/goodvibes-agent`]: { link: BUN_GLOBAL_LINK, version: 'goodvibes-agent 1.18.1' },
      },
      commands: ['goodvibes-agent'],
    }));
    expect(result.hasProblem).toBe(false);
    const report = result.reports[0]!;
    expect(report.copies).toHaveLength(2);
    expect(report.winner?.path).toBe(`${INSTALL_DIR}/goodvibes-agent`);
    expect(report.shadowing).toEqual([]);
  });

  test('the same directory listed twice on PATH is one entry, not a self-shadow', () => {
    const result = scanCommandShadows(scanWith({
      pathEntries: splitPathEntries(`${INSTALL_DIR}:/usr/bin:${INSTALL_DIR}/`),
      files: { [`${INSTALL_DIR}/goodvibes-agent`]: { version: 'goodvibes-agent 1.21.0' } },
      commands: ['goodvibes-agent'],
    }));
    expect(result.hasProblem).toBe(false);
  });

  test('a command this build does not install at all is silent', () => {
    const result = scanCommandShadows(scanWith({
      pathEntries: [INSTALL_DIR],
      files: {},
      commands: ['goodvibes-agent'],
    }));
    expect(result.hasProblem).toBe(false);
    expect(result.reports[0]!.copies).toEqual([]);
    expect(result.reports[0]!.winner).toBeUndefined();
  });
});

describe('removal offers only recognised copies of our own program', () => {
  test('a link into one of our packages is offered, with the right package manager', () => {
    const bun = scanCommandShadows(scanWith({
      pathEntries: [`${HOME}/.bun/bin`, INSTALL_DIR],
      files: {
        [`${HOME}/.bun/bin/goodvibes-agent`]: { link: BUN_GLOBAL_LINK, version: 'goodvibes-agent 1.18.1' },
        [`${INSTALL_DIR}/goodvibes-agent`]: { version: 'goodvibes-agent 1.21.0' },
      },
      commands: ['goodvibes-agent'],
    }));
    expect(removableShadows(bun).map((copy) => copy.removal?.command))
      .toEqual(['bun remove -g @pellux/goodvibes-agent']);

    const npm = scanCommandShadows(scanWith({
      pathEntries: [`${HOME}/.npm-global/bin`, INSTALL_DIR],
      files: {
        [`${HOME}/.npm-global/bin/goodvibes-agent`]: {
          link: `${HOME}/.npm-global/lib/node_modules/@pellux/goodvibes-agent/bin/goodvibes-agent`,
          version: 'goodvibes-agent 1.18.1',
        },
        [`${INSTALL_DIR}/goodvibes-agent`]: { version: 'goodvibes-agent 1.21.0' },
      },
      commands: ['goodvibes-agent'],
    }));
    expect(removableShadows(npm).map((copy) => copy.removal?.command))
      .toEqual(['npm rm -g @pellux/goodvibes-agent']);
  });

  test('a standalone file that answers --version as us is offered for deletion', () => {
    const result = scanCommandShadows(scanWith({
      pathEntries: [`${HOME}/bin`, INSTALL_DIR],
      files: {
        [`${HOME}/bin/goodvibes-agent`]: { version: 'goodvibes-agent 1.14.0' },
        [`${INSTALL_DIR}/goodvibes-agent`]: { version: 'goodvibes-agent 1.21.0' },
      },
      commands: ['goodvibes-agent'],
    }));
    const removable = removableShadows(result);
    expect(removable).toHaveLength(1);
    expect(removable[0]!.ownership).toBe('our-binary');
    expect(removable[0]!.removal).toEqual({ kind: 'file', command: `rm ${HOME}/bin/goodvibes-agent` });
  });

  test('an unrelated program with the same name is reported and never offered', () => {
    const result = scanCommandShadows(scanWith({
      pathEntries: [`${HOME}/bin`, INSTALL_DIR],
      files: {
        [`${HOME}/bin/goodvibes`]: { version: 'someone-elses-tool 3.2.1' },
        [`${INSTALL_DIR}/goodvibes`]: { version: 'goodvibes 1.25.0' },
      },
      commands: ['goodvibes'],
    }));
    expect(result.hasProblem).toBe(true);
    expect(removableShadows(result)).toEqual([]);
    expect(result.shadowed[0]!.shadowing[0]!.ownership).toBe('unknown');
    expect(describeShadowScan(result).join('\n')).toContain('will not be touched');
  });

  test('nothing outside the home directory is ever offered, however well we recognise it', () => {
    const result = scanCommandShadows(scanWith({
      pathEntries: ['/usr/local/bin', INSTALL_DIR],
      files: {
        '/usr/local/bin/goodvibes-agent': {
          link: '/usr/local/lib/node_modules/@pellux/goodvibes-agent/bin/goodvibes-agent',
          version: 'goodvibes-agent 1.18.1',
        },
        [`${INSTALL_DIR}/goodvibes-agent`]: { version: 'goodvibes-agent 1.21.0' },
      },
      commands: ['goodvibes-agent'],
    }));
    expect(result.hasProblem).toBe(true);
    expect(result.shadowed[0]!.shadowing[0]!.ownership).toBe('unknown');
    expect(removableShadows(result)).toEqual([]);
  });

  test('a link whose target escapes the home directory is not offered', () => {
    const result = scanCommandShadows(scanWith({
      pathEntries: [`${HOME}/bin`, INSTALL_DIR],
      files: {
        [`${HOME}/bin/goodvibes-agent`]: {
          link: '/opt/vendor/node_modules/@pellux/goodvibes-agent/bin/goodvibes-agent',
          version: 'goodvibes-agent 1.18.1',
        },
        [`${INSTALL_DIR}/goodvibes-agent`]: { version: 'goodvibes-agent 1.21.0' },
      },
      commands: ['goodvibes-agent'],
    }));
    expect(removableShadows(result)).toEqual([]);
  });

  test('without a version probe an unidentifiable copy stays unknown rather than assumed ours', () => {
    const result = scanCommandShadows(scanWith({
      pathEntries: [`${HOME}/bin`, INSTALL_DIR],
      files: {
        [`${HOME}/bin/goodvibes-agent`]: {},
        [`${INSTALL_DIR}/goodvibes-agent`]: {},
      },
      commands: ['goodvibes-agent'],
      withProbe: false,
    }));
    expect(result.hasProblem).toBe(true);
    expect(removableShadows(result)).toEqual([]);
  });

  test('one leftover package providing several commands is offered once', () => {
    const result = scanCommandShadows(scanWith({
      pathEntries: [`${HOME}/.bun/bin`, INSTALL_DIR],
      files: {
        [`${HOME}/.bun/bin/goodvibes`]: {
          link: `${HOME}/.bun/install/global/node_modules/@pellux/goodvibes-tui/bin/goodvibes`,
          version: 'goodvibes 1.10.0',
        },
        [`${HOME}/.bun/bin/goodvibes-daemon`]: {
          link: `${HOME}/.bun/install/global/node_modules/@pellux/goodvibes-tui/bin/goodvibes-daemon`,
          version: 'goodvibes-daemon 1.10.0',
        },
        [`${INSTALL_DIR}/goodvibes`]: { version: 'goodvibes 1.25.0' },
        [`${INSTALL_DIR}/goodvibes-daemon`]: { version: 'goodvibes-daemon 1.25.0' },
      },
      commands: ['goodvibes', 'goodvibes-daemon'],
    }));
    expect(result.shadowed).toHaveLength(2);
    expect(removableShadows(result).map((copy) => copy.path)).toEqual([
      `${HOME}/.bun/bin/goodvibes`,
      `${HOME}/.bun/bin/goodvibes-daemon`,
    ]);
  });
});

describe('an install directory missing from PATH is just as unreachable', () => {
  test('it is reported in plain words', () => {
    const result = scanCommandShadows(scanWith({
      pathEntries: ['/usr/bin'],
      files: { [`${INSTALL_DIR}/goodvibes-agent`]: { version: 'goodvibes-agent 1.21.0' } },
      commands: ['goodvibes-agent'],
    }));
    expect(result.hasProblem).toBe(true);
    expect(result.shadowed[0]!.installDirNotOnPath).toBe(true);
    expect(describeShadowReport(result.shadowed[0]!).join('\n')).toContain('not on your PATH');
  });
});

describe('injected I/O that throws never crashes the scan', () => {
  test('a failing realPath, existence check, and version probe degrade to unknown', () => {
    const result = scanCommandShadows({
      commands: ['goodvibes-agent'],
      installDir: INSTALL_DIR,
      pathEntries: [`${HOME}/bin`, INSTALL_DIR],
      homeDir: HOME,
      isExecutableFile: (path) => {
        if (path === '/nonexistent') throw new Error('boom');
        return path === `${HOME}/bin/goodvibes-agent` || path === `${INSTALL_DIR}/goodvibes-agent`;
      },
      realPath: () => {
        throw new Error('dangling link');
      },
      probeVersion: () => {
        throw new Error('not executable');
      },
    });
    expect(result.hasProblem).toBe(true);
    expect(result.shadowed[0]!.shadowing[0]!.ownership).toBe('unknown');
    expect(removableShadows(result)).toEqual([]);
  });
});
