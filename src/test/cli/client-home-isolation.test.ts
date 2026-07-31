/**
 * client-home-isolation.test.ts
 *
 * A redirected client process must not be able to reach the un-redirected
 * store.
 *
 * `GOODVIBES_HOME` was read by `src/daemon/cli.ts` and by nothing else. The
 * client entry point called `homedir()` unconditionally, so a harness that
 * redirected the tree and then ran a client command got a process that wrote
 * daemon-scoped credentials into the REAL `~/.goodvibes/daemon/secrets.enc`.
 * That happened: two throwaway keys landed in the owner's live store and had to
 * be removed by hand.
 *
 * The behavioural cases run in a CHILD process with both `HOME` and
 * `GOODVIBES_HOME` pointed at temporary directories, so the "real" home in
 * these tests is itself a sandbox and nothing here can touch the machine's
 * actual store — including when the assertion being made is that a write did
 * NOT escape.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import {
  resolveGoodVibesDaemonHome,
  resolveGoodVibesHome,
  resolveGoodVibesHomeOwnership,
  resolveGoodVibesTreeDirectory,
} from '../../config/goodvibes-home.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

const projectRoot = resolve(join(import.meta.dir, '..', '..', '..'));

/**
 * Stores one daemon-scoped credential exactly the way the client composition
 * does: the tree root comes from the entry point's resolver, the daemon home
 * from the same module, and both are handed to the client's own SecretsManager.
 * Prints the store path it wrote so the parent can assert where it landed.
 */
const CHILD_SCRIPT = `
import { ConfigManager } from '@pellux/goodvibes-sdk/platform/config';
import { SecretsManager } from '${projectRoot}/src/config/secrets.ts';
import { resolveGoodVibesDaemonHome, resolveGoodVibesHome } from '${projectRoot}/src/config/goodvibes-home.ts';

const homeDirectory = resolveGoodVibesHome();
const daemonHomeDirectory = resolveGoodVibesDaemonHome(homeDirectory);
const workingDir = process.env.CHILD_WORKING_DIR;
const configManager = new ConfigManager({ workingDir, homeDir: homeDirectory, surfaceRoot: 'tui' });
const secrets = new SecretsManager({
  projectRoot: workingDir,
  globalHome: homeDirectory,
  daemonHome: daemonHomeDirectory,
  configManager,
});
await secrets.set(process.env.CHILD_SECRET_KEY, 'a-throwaway-value', { scope: 'daemon' });
console.log(JSON.stringify({ homeDirectory, daemonHomeDirectory }));
`;

interface ChildResult {
  readonly homeDirectory: string;
  readonly daemonHomeDirectory: string;
}

function runClientSecretWrite(env: Record<string, string>, workingDir: string): ChildResult {
  const result = Bun.spawnSync(['bun', '--eval', CHILD_SCRIPT], {
    cwd: projectRoot,
    env: {
      ...process.env,
      CHILD_WORKING_DIR: workingDir,
      CHILD_SECRET_KEY: 'CLIENT_HOME_ISOLATION_TEST_KEY',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stdout = result.stdout.toString();
  const stderr = result.stderr.toString();
  if (result.exitCode !== 0) {
    throw new Error(`child client write failed (${String(result.exitCode)}):\n${stderr}`);
  }
  const line = stdout.trim().split('\n').filter((entry) => entry.startsWith('{')).pop();
  if (!line) throw new Error(`child client write printed no result:\n${stdout}\n${stderr}`);
  return JSON.parse(line) as ChildResult;
}

describe('a client process cannot write outside a redirected home', () => {
  let loginHome = '';
  let sandbox = '';
  let workingDir = '';

  beforeEach(() => {
    loginHome = makeProjectTempDir('goodvibes-client-login-home');
    sandbox = makeProjectTempDir('goodvibes-client-sandbox');
    workingDir = makeProjectTempDir('goodvibes-client-work');
    mkdirSync(join(loginHome, '.goodvibes'), { recursive: true });
  });

  afterEach(() => {
    for (const directory of [loginHome, sandbox, workingDir]) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('with GOODVIBES_HOME set, the daemon-tier store lands inside it and the login home stays empty', () => {
    const result = runClientSecretWrite({ HOME: loginHome, GOODVIBES_HOME: sandbox }, workingDir);

    expect(result.homeDirectory).toBe(sandbox);
    expect(result.daemonHomeDirectory).toBe(join(sandbox, '.goodvibes', 'daemon'));

    const sandboxStore = join(sandbox, '.goodvibes', 'daemon', 'secrets.enc');
    const loginStore = join(loginHome, '.goodvibes', 'daemon', 'secrets.enc');

    // The credential is in the sandbox...
    expect(existsSync(sandboxStore)).toBe(true);
    // ...and nothing was created in the home the process would have used had
    // the redirect been ignored. This is the assertion the old code failed:
    // before the fix, `loginStore` is where the write went.
    expect(existsSync(loginStore)).toBe(false);
    expect(existsSync(join(loginHome, '.goodvibes', 'daemon'))).toBe(false);
  });

  test('with no redirect, the same write lands under the login home', () => {
    // The other half of the proof: the redirect is what moved the store, not
    // some unrelated failure that wrote nothing anywhere.
    const result = runClientSecretWrite({ HOME: loginHome, GOODVIBES_HOME: '' }, workingDir);

    expect(result.homeDirectory).toBe(loginHome);
    expect(existsSync(join(loginHome, '.goodvibes', 'daemon', 'secrets.enc'))).toBe(true);
    expect(existsSync(join(sandbox, '.goodvibes', 'daemon', 'secrets.enc'))).toBe(false);
  });

  test('GOODVIBES_DAEMON_HOME alone moves the client daemon tier too', () => {
    const daemonHome = join(sandbox, 'daemon-identity');
    const result = runClientSecretWrite({ HOME: loginHome, GOODVIBES_DAEMON_HOME: daemonHome }, workingDir);

    expect(result.homeDirectory).toBe(loginHome);
    expect(result.daemonHomeDirectory).toBe(daemonHome);
    expect(existsSync(join(daemonHome, 'secrets.enc'))).toBe(true);
    expect(existsSync(join(loginHome, '.goodvibes', 'daemon', 'secrets.enc'))).toBe(false);
  });
});

describe('the home resolver both entry points share', () => {
  test('an unset, blank, or whitespace value means the login home, never the filesystem root', () => {
    expect(resolveGoodVibesHome({ HOME: '/tmp/login-home-fixture' })).toBe('/tmp/login-home-fixture');
    expect(resolveGoodVibesHome({ HOME: '/tmp/login-home-fixture', GOODVIBES_HOME: '' })).toBe('/tmp/login-home-fixture');
    expect(resolveGoodVibesHome({ HOME: '/tmp/login-home-fixture', GOODVIBES_HOME: '   ' })).toBe('/tmp/login-home-fixture');
  });

  test('a relative override resolves against the working directory rather than being used as-is', () => {
    const resolved = resolveGoodVibesHome({ HOME: '/tmp/login-home-fixture', GOODVIBES_HOME: 'sandbox-home' });
    expect(resolved).toBe(join(process.cwd(), 'sandbox-home'));
  });

  test('the daemon home falls under an overridden tree root unless named separately', () => {
    const under = resolveGoodVibesHomeOwnership({ HOME: '/tmp/login', GOODVIBES_HOME: '/tmp/tree' });
    expect(under.daemonHomeDirectory).toBe('/tmp/tree/.goodvibes/daemon');

    const named = resolveGoodVibesHomeOwnership({
      HOME: '/tmp/login',
      GOODVIBES_HOME: '/tmp/tree',
      GOODVIBES_DAEMON_HOME: '/tmp/identity',
    });
    expect(named.homeDirectory).toBe('/tmp/tree');
    expect(named.daemonHomeDirectory).toBe('/tmp/identity');
    // Naming the daemon's identity directory must not move the tree with it.
    expect(resolveGoodVibesDaemonHome('/tmp/tree', { GOODVIBES_DAEMON_HOME: '/tmp/identity' })).toBe('/tmp/identity');
  });
});

describe('GOODVIBES_HOME has exactly one meaning', () => {
  let loginHome = '';
  let sandbox = '';

  beforeEach(() => {
    loginHome = makeProjectTempDir('goodvibes-meaning-login');
    sandbox = makeProjectTempDir('goodvibes-meaning-sandbox');
  });

  afterEach(() => {
    for (const directory of [loginHome, sandbox]) rmSync(directory, { recursive: true, force: true });
  });

  test('it names the tree root, and the .goodvibes directory is derived from it', () => {
    expect(resolveGoodVibesTreeDirectory({ HOME: '/tmp/login', GOODVIBES_HOME: '/tmp/tree' }))
      .toBe(join('/tmp/tree', '.goodvibes'));
  });

  test('with the variable unset the derived tree is ~/.goodvibes, byte-for-byte what the scripts defaulted to', () => {
    // The migration-safety claim, asserted rather than asserted-in-prose: the
    // two reporting scripts used to default to `join(homedir(), '.goodvibes')`
    // and now derive from the resolver. An owner who never sets the variable
    // sees no change at all.
    expect(resolveGoodVibesTreeDirectory({ HOME: '/tmp/login' })).toBe(join('/tmp/login', '.goodvibes'));
  });

  test('the audit script inspects the same tree a redirected client writes into', () => {
    // The disagreement, closed end-to-end. The client child in the tests above
    // writes its daemon-tier store to <sandbox>/.goodvibes/daemon/secrets.enc.
    // This runs the real audit script against the same redirect and checks it
    // is looking at that same tree — not at <sandbox>, which is what it did
    // when it read the variable as the .goodvibes directory itself.
    const treeDirectory = join(sandbox, '.goodvibes');
    mkdirSync(join(treeDirectory, 'tui'), { recursive: true });

    const result = Bun.spawnSync(['bun', join(projectRoot, 'scripts', 'audit-goodvibes-home.ts'), '--json'], {
      cwd: projectRoot,
      env: { ...process.env, HOME: loginHome, GOODVIBES_HOME: sandbox },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    expect(result.exitCode, result.stderr.toString()).toBe(0);

    const report = JSON.parse(result.stdout.toString()) as { homeDir: string };
    expect(report.homeDir).toBe(treeDirectory);
    // Stated as the relationship that matters, not just the literal: the tree
    // the audit reports must be the parent of the store the client writes.
    expect(join(report.homeDir, 'daemon', 'secrets.enc'))
      .toBe(join(sandbox, '.goodvibes', 'daemon', 'secrets.enc'));
  });

  test('nothing outside the resolver reads the variable', () => {
    // The behavioural twin of check-architecture's one-goodvibes-home-meaning
    // rule, so a second meaning cannot be reintroduced in either gate alone.
    // Reads only — src/cli/service-posture.ts WRITES it into the systemd unit's
    // Environment= block, which is how the daemon receives the one meaning.
    const readPattern = /\benv(?:ironment)?\s*(?:\[\s*['"]GOODVIBES_HOME['"]\s*\]|\.GOODVIBES_HOME\b)/;
    const sources: string[] = [];
    const collect = (directory: string): void => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) collect(path);
        else if (path.endsWith('.ts')) sources.push(path);
      }
    };
    collect(join(projectRoot, 'src'));
    collect(join(projectRoot, 'scripts'));

    const readers = sources
      .filter((path) => !path.includes(`${sep}test${sep}`) && !path.endsWith('.test.ts'))
      .filter((path) => readPattern.test(readFileSync(path, 'utf8')))
      .map((path) => relative(projectRoot, path))
      .sort();

    expect(readers).toEqual([join('src', 'config', 'goodvibes-home.ts')]);
  });
});

describe('the client entry point resolves no home of its own', () => {
  test('src/main.ts asks the shared resolver instead of calling homedir()', () => {
    // The behavioural tests above prove the composition; this one pins the call
    // site, because the defect was one line reverting to homedir() while every
    // layer beneath it stayed correct.
    const source = readFileSync(join(projectRoot, 'src', 'main.ts'), 'utf8');
    expect(source).toContain('homeDirectory: resolveGoodVibesHome()');
    expect(source).not.toMatch(/homeDirectory:\s*homedir\(\)/);
  });

  test('nothing in this repository starts a daemon of its own any more', () => {
    // The pair this used to pin was src/main.ts and src/daemon/cli.ts: two
    // entry points in one tree, which had to resolve the home the same way or
    // an app and the daemon it embedded would read different trees. There is
    // one entry point now — the daemon is a separate program with a separate
    // repository — so the divergence this guarded against cannot happen here.
    // What is pinned instead is that the second entry point is really gone.
    expect(existsSync(join(projectRoot, 'src', 'daemon'))).toBe(false);
    const pkg = JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf8')) as { bin?: Record<string, string> };
    expect(Object.keys(pkg.bin ?? {})).toEqual(['goodvibes']);
  });
});
