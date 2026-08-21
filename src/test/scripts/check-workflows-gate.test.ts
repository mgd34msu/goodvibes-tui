/**
 * Gate test for scripts/check-workflows.ts.
 *
 * The rule it exercises most carefully is the `on:` trigger check, because that
 * one shipped in a form that could not fail: it accepted a workflow if `'on' in
 * doc` OR `true in doc`, and a JS `in` with a boolean key looks for the string
 * key "true", which no workflow has. The comment above it asserted that YAML
 * parses `on:` as the boolean true, Bun.YAML.parse does not; it keeps the
 * string key "on". So the second half of the condition was dead, and nothing
 * said so.
 *
 * Every case below is paired: a workflow that should pass, and a workflow that
 * removes exactly one thing and must therefore fail. A gate that cannot be made
 * to fail is not a gate.
 */
import { describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

const REPO_ROOT = resolve(import.meta.dir, '..', '..', '..');
const GATE = join(REPO_ROOT, 'scripts', 'check-workflows.ts');

const VALID_WORKFLOW = [
  'name: Example',
  'on:',
  '  push:',
  '    branches: [main]',
  'jobs:',
  '  build:',
  '    runs-on: ubuntu-latest',
  '    steps:',
  '      - run: echo hi',
  '',
].join('\n');

function runGate(files: Record<string, string>): { exitCode: number; output: string } {
  const dir = makeProjectTempDir('check-workflows-fixture');
  const workflows = join(dir, 'workflows');
  mkdirSync(workflows, { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(join(workflows, name), body, 'utf8');
  }
  const proc = Bun.spawnSync(['bun', GATE, workflows], {
    cwd: REPO_ROOT,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return {
    exitCode: proc.exitCode,
    output: proc.stdout.toString() + proc.stderr.toString(),
  };
}

describe('check-workflows', () => {
  test('accepts a structurally complete workflow', () => {
    const res = runGate({ 'ci.yml': VALID_WORKFLOW });
    expect(res.exitCode).toBe(0);
    expect(res.output).toContain('1 workflow file(s) validated');
  });

  test('rejects a workflow with no trigger block', () => {
    const withoutOn = VALID_WORKFLOW.replace('on:\n  push:\n    branches: [main]\n', '');
    // The fixture really has no top-level `on:` key. ("runs-on:" contains the
    // substring, so this has to be anchored to the start of a line.)
    expect(/^on:/m.test(withoutOn)).toBe(false);
    const res = runGate({ 'ci.yml': withoutOn });
    expect(res.exitCode).toBe(1);
    expect(res.output).toContain('missing an `on` trigger block');
  });

  test('accepts the YAML 1.1 `true:` spelling of the trigger key', () => {
    // The alternation that made the check unfalsifiable was `true in doc`, which
    // tests for a key named "true". A parser that folds `on:` to a boolean lands
    // exactly that key, so the alternation is kept in that form, and this case
    // is what stops it from being dead code nobody notices again.
    const folded = VALID_WORKFLOW.replace('on:\n', "'true':\n");
    const res = runGate({ 'ci.yml': folded });
    expect(res.exitCode).toBe(0);
  });

  test('rejects a workflow with no name', () => {
    const res = runGate({ 'ci.yml': VALID_WORKFLOW.replace('name: Example\n', '') });
    expect(res.exitCode).toBe(1);
    expect(res.output).toContain('missing a non-empty `name`');
  });

  test('rejects a workflow with an empty jobs map', () => {
    const res = runGate({
      'ci.yml': ['name: Example', 'on:', '  push:', 'jobs: {}', ''].join('\n'),
    });
    expect(res.exitCode).toBe(1);
    expect(res.output).toContain('missing a non-empty `jobs` map');
  });

  test('rejects a job with no steps and no reusable-workflow call', () => {
    const res = runGate({
      'ci.yml': [
        'name: Example',
        'on:',
        '  push:',
        'jobs:',
        '  build:',
        '    runs-on: ubuntu-latest',
        '',
      ].join('\n'),
    });
    expect(res.exitCode).toBe(1);
    expect(res.output).toContain('has no steps');
  });

  test('accepts a job that calls a reusable workflow instead of declaring steps', () => {
    const res = runGate({
      'ci.yml': [
        'name: Example',
        'on:',
        '  push:',
        'jobs:',
        '  call:',
        '    uses: ./.github/workflows/other.yml',
        '',
      ].join('\n'),
    });
    expect(res.exitCode).toBe(0);
  });

  test('rejects a file that is not valid YAML', () => {
    const res = runGate({ 'ci.yml': 'name: [unclosed\n' });
    expect(res.exitCode).toBe(1);
    expect(res.output).toContain('does not parse as YAML');
  });

  test('requires packages: write on the release jobs that mirror to GitHub Packages', () => {
    const release = [
      'name: Release',
      'on:',
      '  workflow_dispatch:',
      'jobs:',
      '  publish-npm:',
      '    runs-on: ubuntu-latest',
      '    steps:',
      '      - run: echo npm',
      '  publish-platform-packages:',
      '    runs-on: ubuntu-latest',
      '    steps:',
      '      - run: echo platform',
      '  publish-github-packages:',
      '    runs-on: ubuntu-latest',
      '    steps:',
      '      - run: echo gh',
      '  publish-github-platform-packages:',
      '    runs-on: ubuntu-latest',
      '    permissions:',
      '      packages: write',
      '    steps:',
      '      - run: echo gh-platform',
      '',
    ].join('\n');
    const res = runGate({ 'release.yml': release });
    expect(res.exitCode).toBe(1);
    expect(res.output).toContain('job "publish-github-packages" mirrors to GitHub Packages');
    // The job that DOES declare the permission is not reported, so the rule is
    // reading the permission rather than flagging every job in the list.
    expect(res.output).not.toContain('job "publish-github-platform-packages" mirrors to GitHub Packages but does not declare');
  });

  test('rejects a job-level continue-on-error: true', () => {
    const withMask = [
      'name: Example',
      'on:',
      '  push:',
      'jobs:',
      '  build:',
      '    runs-on: ubuntu-latest',
      '    continue-on-error: true',
      '    steps:',
      '      - run: echo hi',
      '',
    ].join('\n');
    const res = runGate({ 'ci.yml': withMask });
    expect(res.exitCode).toBe(1);
    expect(res.output).toContain('continue-on-error');
  });

  test('accepts a STEP-level continue-on-error (informational, never a false green)', () => {
    const stepLevel = [
      'name: Example',
      'on:',
      '  push:',
      'jobs:',
      '  build:',
      '    runs-on: ubuntu-latest',
      '    steps:',
      '      - run: echo hi',
      '        continue-on-error: true',
      '',
    ].join('\n');
    expect(runGate({ 'ci.yml': stepLevel }).exitCode).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // Release-lane rules. Each pair below builds a release.yml that satisfies
  // every OTHER rule, then removes exactly one thing.
  // ---------------------------------------------------------------------------
  const KILL_SWITCH = "vars.PUBLISH_NPM == 'true'";

  function releaseFixture(overrides: {
    verifyTagVersion?: boolean;
    mirrorKillSwitch?: boolean;
    mirrorNeedsNpm?: boolean;
  } = {}): string {
    const {
      verifyTagVersion = true,
      mirrorKillSwitch = true,
      mirrorNeedsNpm = true,
    } = overrides;
    const lines = ['name: Release', 'on:', '  workflow_dispatch:', 'jobs:'];
    if (verifyTagVersion) {
      lines.push(
        '  verify-tag-version:',
        '    runs-on: ubuntu-latest',
        '    steps:',
        '      - run: bun scripts/verify-release-tag-version.ts',
      );
    }
    for (const job of ['publish-npm', 'publish-platform-packages']) {
      lines.push(
        `  ${job}:`,
        '    runs-on: ubuntu-latest',
        `    if: ${KILL_SWITCH}`,
        '    steps:',
        `      - run: echo ${job}`,
      );
    }
    for (const job of ['publish-github-packages', 'publish-github-platform-packages']) {
      lines.push(`  ${job}:`, '    runs-on: ubuntu-latest');
      if (mirrorNeedsNpm) lines.push('    needs: [publish-npm]');
      if (mirrorKillSwitch) lines.push(`    if: ${KILL_SWITCH}`);
      lines.push('    permissions:', '      packages: write', '    steps:', `      - run: echo ${job}`);
    }
    return `${lines.join('\n')}\n`;
  }

  test('accepts a release workflow that satisfies every release rule', () => {
    const res = runGate({ 'release.yml': releaseFixture() });
    expect(res.exitCode).toBe(0);
  });

  test('rejects a release workflow with no tag/version verification job', () => {
    const res = runGate({ 'release.yml': releaseFixture({ verifyTagVersion: false }) });
    expect(res.exitCode).toBe(1);
    expect(res.output).toContain('missing the "verify-tag-version" job');
  });

  test('rejects a GitHub Packages mirror job without the PUBLISH_NPM kill switch', () => {
    const res = runGate({ 'release.yml': releaseFixture({ mirrorKillSwitch: false }) });
    expect(res.exitCode).toBe(1);
    expect(res.output).toContain('kill switch');
  });

  test('rejects a GitHub Packages mirror job that does not trail the npmjs publish', () => {
    const res = runGate({ 'release.yml': releaseFixture({ mirrorNeedsNpm: false }) });
    expect(res.exitCode).toBe(1);
    expect(res.output).toContain('must trail the npmjs publish');
  });

  test("the repo's own workflows pass", () => {
    const proc = Bun.spawnSync(['bun', GATE], {
      cwd: REPO_ROOT,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const output = proc.stdout.toString() + proc.stderr.toString();
    expect(output).toContain('0 problems');
    expect(proc.exitCode).toBe(0);
  });
});
