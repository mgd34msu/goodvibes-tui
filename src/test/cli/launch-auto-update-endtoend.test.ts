import { afterAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveArtifactNames, CHECKSUM_MANIFEST_NAME } from '@/runtime/release-artifacts.ts';
import { rollbackUpdate, PREVIOUS_FILE_SUFFIX } from '@/input/commands/update-runtime.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

/**
 * Per-test ceiling for this file.
 *
 * A ceiling, not a target. Every test here installs a real binary, runs it as a
 * real process, serves a real release over a real HTTP listener, verifies it and
 * respawns — the wall-clock cost is set by how busy the machine is, not by what
 * the test asserts. 30 s was an idle machine's number: under a realistic
 * concurrent load one of these died at 30003 ms mid-respawn
 * ("this test timed out after 30000ms") while every step was progressing.
 */
const END_TO_END_BUDGET_MS = 180_000;

// End-to-end proof of the launch auto-update loop with REAL processes, REAL
// files, and a REAL local HTTP server standing in for GitHub releases:
//
//   - the "old binary" is an executable (bun-shebang script) at
//     <scratch>/goodvibes, pinned to fixture version 1.0.0 (never the live
//     build VERSION), that invokes the actual selfUpdateAtLaunch machinery
//     (runLaunchAutoUpdate + restartOntoUpdatedBinary) exactly as main() does;
//   - the release payload served for download is ITSELF an executable that
//     prints its own version and argv, so the respawn assertion observes what
//     actually ran, not what was supposed to run;
//   - the only seam used is UpdateFetchLike, and only to rewrite the GitHub
//     host to the local server — the redirect-tag resolution, checksum
//     manifest parsing, sha256 verification, atomic swap, keep-previous, and
//     respawn are all the production code paths operating on real bytes.
//
// A stub systemctl is prepended to each child's PATH so the post-swap daemon
// service probe (read-only `systemctl --user is-active`) can never reach the
// host's real services.

const OLD_VERSION = '1.0.0';
const NEW_VERSION = '1.1.0';
const NEW_TAG = `v${NEW_VERSION}`;
const GITHUB_BASE = 'https://github.com/mgd34msu/goodvibes-tui';
const LAUNCH_MODULE = join(import.meta.dir, '..', '..', 'cli', 'launch-auto-update.ts');

const artifacts = resolveArtifactNames(process.platform, process.arch);

const created: string[] = [];
const servers: Array<{ stop: (force?: boolean) => void }> = [];

afterAll(() => {
  for (const server of servers) {
    try {
      server.stop(true);
    } catch {
      /* ignore */
    }
  }
  for (const dir of created) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

function scratch(prefix: string): string {
  const dir = makeProjectTempDir(prefix);
  created.push(dir);
  return dir;
}

function sha256Hex(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

/** The executable installed as the OLD version: runs the real launch-update flow, then reports what it is. */
function oldBinarySource(): string {
  return [
    '#!/usr/bin/env bun',
    `import { runLaunchAutoUpdate, restartOntoUpdatedBinary } from ${JSON.stringify(LAUNCH_MODULE)};`,
    `const CURRENT_VERSION = ${JSON.stringify(OLD_VERSION)};`,
    "const base = process.env['GV_TEST_RELEASES_BASE'] ?? '';",
    '// The one seam: point the hardcoded GitHub release URLs at the local server.',
    `const fetchImpl = (url, init) => fetch(url.replace(${JSON.stringify(GITHUB_BASE)}, base), init);`,
    "const applyTimeoutMs = process.env['GV_TEST_APPLY_TIMEOUT_MS'];",
    "const settings = process.env['GV_TEST_DISABLE'] === '1'",
    '  ? { autoUpdateAtLaunch: false }',
    '  : { launchCheckTimeoutMs: 5000, ...(applyTimeoutMs ? { applyTimeoutMs: Number(applyTimeoutMs) } : {}) };',
    'const outcome = await runLaunchAutoUpdate({',
    '  fetchImpl,',
    '  execPath: process.argv[1],',
    '  platform: process.platform,',
    '  arch: process.arch,',
    '  currentVersion: CURRENT_VERSION,',
    '  settings,',
    '  env: process.env,',
    '  print: (line) => console.log(line),',
    '  configManager: { get: () => undefined },',
    '});',
    "if (outcome.action === 'restart') {",
    '  process.exit(restartOntoUpdatedBinary({',
    '    execPath: process.argv[1],',
    '    argv: process.argv.slice(2),',
    '    env: process.env,',
    '    fromVersion: CURRENT_VERSION,',
    '  }));',
    '}',
    'console.log(`RUNNING v${CURRENT_VERSION} argv=${JSON.stringify(process.argv.slice(2))} outcome=${outcome.action}:${outcome.reason}`);',
    '',
  ].join('\n');
}

/** The executable served as the NEW release artifact: proves the respawn ran IT, with the original argv. */
function newBinarySource(): string {
  return [
    '#!/usr/bin/env bun',
    `import { runLaunchAutoUpdate } from ${JSON.stringify(LAUNCH_MODULE)};`,
    `const CURRENT_VERSION = ${JSON.stringify(NEW_VERSION)};`,
    '// The restarted process must not check again (env marker short-circuit);',
    '// any fetch from here is a bug the test asserts against.',
    "const fetchImpl = () => { console.log('UNEXPECTED-FETCH'); throw new Error('unexpected fetch'); };",
    'const outcome = await runLaunchAutoUpdate({',
    '  fetchImpl,',
    '  execPath: process.argv[1],',
    '  platform: process.platform,',
    '  arch: process.arch,',
    '  currentVersion: CURRENT_VERSION,',
    '  settings: {},',
    '  env: process.env,',
    '  print: (line) => console.log(line),',
    '  configManager: { get: () => undefined },',
    '});',
    'console.log(`RUNNING v${CURRENT_VERSION} argv=${JSON.stringify(process.argv.slice(2))} outcome=${outcome.action}:${outcome.reason}`);',
    '',
  ].join('\n');
}

/** Stub systemctl (is-active -> exit 3) so the child's post-swap service probe never reaches the host. */
function stubSystemctlBin(root: string): string {
  const bin = join(root, 'stubbin');
  mkdirSync(bin, { recursive: true });
  const stub = '#!/bin/sh\nexit 3\n';
  const path = join(bin, 'systemctl');
  writeFileSync(path, stub);
  chmodSync(path, 0o755);
  return bin;
}

interface Install {
  readonly dir: string;
  readonly appPath: string;
  readonly daemonPath: string;
  readonly oldAppBytes: Buffer;
  readonly oldDaemonBytes: Buffer;
}

function installOldVersion(prefix: string): Install {
  const dir = scratch(prefix);
  const appPath = join(dir, 'goodvibes');
  const daemonPath = join(dir, 'goodvibes-daemon');
  writeFileSync(appPath, oldBinarySource());
  chmodSync(appPath, 0o755);
  writeFileSync(daemonPath, 'old-daemon-bytes\n');
  chmodSync(daemonPath, 0o755);
  return {
    dir,
    appPath,
    daemonPath,
    oldAppBytes: readFileSync(appPath),
    oldDaemonBytes: readFileSync(daemonPath),
  };
}

/** A real local HTTP server speaking the exact GitHub releases shapes the updater consumes. */
function serveRelease(options: { appBytes: string; corruptAppChecksum?: boolean; stallAppDownload?: boolean }): string {
  if (!artifacts) throw new Error('unsupported test platform');
  const appHash = options.corruptAppChecksum ? sha256Hex('not-the-real-bytes') : sha256Hex(options.appBytes);
  // Deliberately app-only, exactly like a real release of this repository: the
  // daemon has its own repository and its own manifest. A daemon asset served
  // here would let a regression that fetched one pass unnoticed.
  const manifest = [`${appHash}  ${artifacts.app}`, ''].join('\n');
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === '/releases/latest') {
        return new Response(null, {
          status: 302,
          headers: { Location: `${GITHUB_BASE}/releases/tag/${NEW_TAG}` },
        });
      }
      if (path === `/releases/download/${NEW_TAG}/${CHECKSUM_MANIFEST_NAME}`) {
        return new Response(manifest);
      }
      if (path === `/releases/download/${NEW_TAG}/${artifacts.app}`) {
        if (options.stallAppDownload) {
          // Never answers: the launch budget has to CANCEL this request, not
          // wait it out and leave it running.
          return new Promise<Response>(() => {});
        }
        return new Response(options.appBytes);
      }
      return new Response('not found', { status: 404 });
    },
  });
  servers.push(server);
  return `http://127.0.0.1:${server.port}`;
}

// Async spawn, deliberately: the release server (Bun.serve) runs on THIS
// process's event loop, so a blocking spawnSync here would deadlock the child
// against a server that can never answer while the loop is held.
async function runInstalledBinary(
  install: Install,
  args: string[],
  env: Record<string, string>,
): Promise<{ stdout: string; exitCode: number }> {
  const proc = Bun.spawn([install.appPath, ...args], {
    env: {
      ...process.env,
      PATH: `${stubSystemctlBin(install.dir)}:${process.env['PATH'] ?? ''}`,
      ...env,
    },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [out, err, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout: out + err, exitCode };
}

describe.if(artifacts !== null)('launch auto-update — end to end with real processes and a real release server', () => {
  test('a stale binary launches, updates through the real verify path, and the respawn runs the NEW binary with the original argv', async () => {
    const install = installOldVersion('gv-e2e-update');
    const newAppBytes = newBinarySource();
    const base = serveRelease({ appBytes: newAppBytes });

    const run = await runInstalledBinary(install, ['--session', 'alpha', '--flag'], { GV_TEST_RELEASES_BASE: base });

    // The parent (old) process reported the update honestly before restarting.
    expect(run.stdout).toContain(`Update available: ${NEW_TAG} (running v${OLD_VERSION}). Downloading and verifying...`);
    expect(run.stdout).toContain(`Updated to ${NEW_TAG}.`);
    expect(run.stdout).toContain(`auto-update: ${NEW_TAG} installed — restarting onto the new version`);

    // The respawned process IS the downloaded payload: it prints the receipt
    // naming both versions, the NEW version banner, and the ORIGINAL argv.
    expect(run.stdout).toContain(`auto-update: updated from v${OLD_VERSION} to v${NEW_VERSION} at launch`);
    expect(run.stdout).toContain(`RUNNING v${NEW_VERSION} argv=["--session","alpha","--flag"] outcome=continue:just-updated`);
    expect(run.stdout).not.toContain('UNEXPECTED-FETCH');
    expect(run.exitCode).toBe(0);

    // The swap happened on disk: the live app binary holds the served payload...
    expect(readFileSync(install.appPath, 'utf-8')).toBe(newAppBytes);
    // ...and the outgoing version is kept byte-identical at .previous.
    expect(readFileSync(`${install.appPath}${PREVIOUS_FILE_SUFFIX}`).equals(install.oldAppBytes)).toBe(true);
    // The daemon binary beside it is a different product on a different release
    // line and updates itself. This app's release publishes no daemon asset, so
    // it is neither fetched nor replaced — and nothing is parked for it either,
    // which is what makes the rollback below leave it alone too.
    expect(readFileSync(install.daemonPath).equals(install.oldDaemonBytes)).toBe(true);
    expect(() => readFileSync(`${install.daemonPath}${PREVIOUS_FILE_SUFFIX}`)).toThrow();

    // ── rollback, for real, from the swapped state ──────────────────────────
    // rollbackUpdate is exactly what `/update rollback` invokes; only print is
    // captured — the renames are the real filesystem operations.
    const printed: string[] = [];
    rollbackUpdate({
      execPath: install.appPath,
      platform: process.platform,
      arch: process.arch,
      print: (line) => printed.push(line),
      configManager: { get: () => undefined },
      runCommand: () => ({ status: 3, stdout: '' }),
    });
    expect(printed.join('\n')).toContain('Rolled back to the previously installed version.');
    expect(readFileSync(install.appPath).equals(install.oldAppBytes)).toBe(true);
    expect(readFileSync(install.daemonPath).equals(install.oldDaemonBytes)).toBe(true);
    expect(printed.join('\n')).toContain('The daemon was not rolled back');
    // The exchange keeps the rolled-back-from version for one command forward.
    expect(readFileSync(`${install.appPath}${PREVIOUS_FILE_SUFFIX}`, 'utf-8')).toBe(newAppBytes);

    // The restored binary RUNS (auto-update disabled for this launch so the
    // still-serving release does not immediately re-update it — which also
    // proves the off switch in a real process).
    const restored = await runInstalledBinary(install, ['--after-rollback'], {
      GV_TEST_RELEASES_BASE: base,
      GV_TEST_DISABLE: '1',
    });
    expect(restored.exitCode).toBe(0);
    expect(restored.stdout).toContain(`RUNNING v${OLD_VERSION} argv=["--after-rollback"] outcome=continue:disabled`);
  }, END_TO_END_BUDGET_MS);

  test('a corrupted checksum swaps NOTHING: the failure is stated and the current version starts', async () => {
    const install = installOldVersion('gv-e2e-corrupt');
    const base = serveRelease({ appBytes: newBinarySource(), corruptAppChecksum: true });

    const run = await runInstalledBinary(install, ['--work'], { GV_TEST_RELEASES_BASE: base });

    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain('auto-update failed: checksum mismatch for');
    expect(run.stdout).toContain(`starting the current version v${OLD_VERSION}`);
    expect(run.stdout).toContain(`RUNNING v${OLD_VERSION} argv=["--work"] outcome=continue:update-failed`);
    // No swap, no partial state: live bytes untouched, nothing parked.
    expect(readFileSync(install.appPath).equals(install.oldAppBytes)).toBe(true);
    expect(readFileSync(install.daemonPath).equals(install.oldDaemonBytes)).toBe(true);
    expect(() => readFileSync(`${install.appPath}${PREVIOUS_FILE_SUFFIX}`)).toThrow();
    expect(() => readFileSync(`${install.daemonPath}${PREVIOUS_FILE_SUFFIX}`)).toThrow();
  }, END_TO_END_BUDGET_MS);

  test('a download that outlives the budget is cancelled for real: the deferral is printed, nothing is swapped, and the process exits clean', async () => {
    const install = installOldVersion('gv-e2e-deferred');
    // The app artifact request is accepted and then never answered, so the
    // install can only end by being cancelled.
    const base = serveRelease({ appBytes: newBinarySource(), stallAppDownload: true });

    const run = await runInstalledBinary(install, ['--slow-download'], {
      GV_TEST_RELEASES_BASE: base,
      GV_TEST_APPLY_TIMEOUT_MS: '1500',
    });

    // The receipt matches what happened: the swap never started, so this
    // really will be retried next launch.
    expect(run.stdout).toContain('update deferred — will retry next launch');
    expect(run.stdout).not.toContain('updated in background');
    expect(run.stdout).toContain(`RUNNING v${OLD_VERSION} argv=["--slow-download"] outcome=continue:update-deferred`);
    // A cancelled download is an expected ending, not a crash: the abandoned
    // request's rejection must not take the process down.
    expect(run.exitCode).toBe(0);
    // Nothing was written: live bytes untouched, nothing parked at .previous.
    expect(readFileSync(install.appPath).equals(install.oldAppBytes)).toBe(true);
    expect(readFileSync(install.daemonPath).equals(install.oldDaemonBytes)).toBe(true);
    expect(() => readFileSync(`${install.appPath}${PREVIOUS_FILE_SUFFIX}`)).toThrow();
  }, END_TO_END_BUDGET_MS);

  test('a dead release server yields exactly one offline line and the current version proceeds untouched', async () => {
    const install = installOldVersion('gv-e2e-offline');
    // A server that once existed and is gone: connection refused, instantly.
    const dead = Bun.serve({ port: 0, fetch: () => new Response('') });
    const deadBase = `http://127.0.0.1:${dead.port}`;
    dead.stop(true);

    const run = await runInstalledBinary(install, ['--offline-work'], { GV_TEST_RELEASES_BASE: deadBase });

    expect(run.exitCode).toBe(0);
    const offlineLines = run.stdout.split('\n').filter((line) => line === "couldn't reach the update server — check skipped");
    expect(offlineLines).toHaveLength(1);
    expect(run.stdout).toContain(`RUNNING v${OLD_VERSION} argv=["--offline-work"] outcome=continue:check-skipped`);
    expect(readFileSync(install.appPath).equals(install.oldAppBytes)).toBe(true);
    expect(() => readFileSync(`${install.appPath}${PREVIOUS_FILE_SUFFIX}`)).toThrow();
  }, END_TO_END_BUDGET_MS);
});
