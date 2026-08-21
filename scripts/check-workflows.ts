#!/usr/bin/env bun
/**
 * check-workflows.ts, structural validation gate for the GitHub Actions
 * workflow YAML under .github/workflows/.
 *
 * The repo has no actionlint/yaml-lint gate, so a broken workflow edit would
 * only surface at release time. This check runs in the ordinary gate battery and
 * validates the structure statically (it never executes a publish):
 *   - every workflow file parses as YAML;
 *   - every workflow declares `name`, `on`, and a non-empty `jobs` map;
 *   - every job declares `runs-on` and either `steps` or `uses` (reusable call);
 *   - no job carries `continue-on-error: true` (banned across the ecosystem: a
 *     run that reports success over a failing job is a false green);
 *   - the release workflow carries the publish jobs we expect, and every job that
 *     publishes to GitHub Packages elevates `permissions.packages: write`;
 *   - the release workflow verifies the tag against package.json before it
 *     publishes anything (the verify-tag-version job), and every GitHub Packages
 *     mirror job trails the npmjs publish and carries the same PUBLISH_NPM kill
 *     switch, so the mirror can never publish a version npmjs did not get.
 *
 * Exit code 0 = green (0 problems), non-zero = the check found problems.
 *
 * The first CLI argument overrides the directory to validate; it exists so the
 * gate's own test can point it at fixture workflows and prove each rule still
 * reports a problem when the workflow is actually broken.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const dirArg = process.argv[2];
const workflowsDir = dirArg ? resolve(dirArg) : join(root, '.github', 'workflows');

type Json = Record<string, unknown>;

const problems: string[] = [];
function fail(file: string, message: string): void {
  problems.push(`${file}: ${message}`);
}

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const files = readdirSync(workflowsDir).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'));
if (files.length === 0) {
  console.error('check-workflows: no workflow files found under .github/workflows');
  process.exit(1);
}

/**
 * Jobs the release workflow must define.
 *   - `githubPackages`: the job mirrors to GitHub Packages, so it needs
 *     `permissions.packages: write` AND must trail the npmjs publish.
 *   - `killSwitch`: the job writes to a registry, so its `if` must carry the
 *     PUBLISH_NPM repo-variable kill switch. A publish job without it publishes
 *     even when releases are switched off.
 */
const RELEASE_REQUIRED_JOBS: ReadonlyArray<{ job: string; githubPackages: boolean; killSwitch: boolean }> = [
  { job: 'verify-tag-version', githubPackages: false, killSwitch: false },
  { job: 'publish-npm', githubPackages: false, killSwitch: true },
  { job: 'publish-platform-packages', githubPackages: false, killSwitch: true },
  { job: 'publish-github-packages', githubPackages: true, killSwitch: true },
  { job: 'publish-github-platform-packages', githubPackages: true, killSwitch: true },
];

/** The kill-switch expression every registry-writing job must carry in its `if`. */
const PUBLISH_KILL_SWITCH = "vars.PUBLISH_NPM == 'true'";

/** The npmjs publish job every GitHub Packages mirror job must trail. */
const NPM_PUBLISH_JOB = 'publish-npm';

function needsOf(job: Json): string[] {
  const needs = job.needs;
  if (typeof needs === 'string') return [needs];
  if (Array.isArray(needs)) return needs.filter((n): n is string => typeof n === 'string');
  return [];
}

for (const file of files) {
  const raw = readFileSync(join(workflowsDir, file), 'utf8');
  let doc: unknown;
  try {
    doc = Bun.YAML.parse(raw);
  } catch (err) {
    fail(file, `does not parse as YAML: ${err instanceof Error ? err.message : String(err)}`);
    continue;
  }
  if (!isObject(doc)) {
    fail(file, 'top-level document is not a mapping');
    continue;
  }
  if (typeof doc.name !== 'string' || doc.name.trim().length === 0) {
    fail(file, 'missing a non-empty `name`');
  }
  // Bun.YAML.parse keeps `on:` as the string key "on", verified, not assumed.
  // Some YAML 1.1 parsers fold it to the boolean true, which lands as the string
  // key "true" on a JS object, so accept that spelling too rather than silently
  // passing a workflow whose trigger block went missing.
  if (!('on' in doc) && !('true' in doc)) {
    fail(file, 'missing an `on` trigger block');
  }
  const jobs = doc.jobs;
  if (!isObject(jobs) || Object.keys(jobs).length === 0) {
    fail(file, 'missing a non-empty `jobs` map');
    continue;
  }

  for (const [jobName, job] of Object.entries(jobs)) {
    if (!isObject(job)) {
      fail(file, `job "${jobName}" is not a mapping`);
      continue;
    }
    const isReusableCall = typeof job.uses === 'string';
    if (!isReusableCall) {
      if (!('runs-on' in job)) fail(file, `job "${jobName}" is missing runs-on`);
      if (!Array.isArray(job.steps) || job.steps.length === 0) {
        fail(file, `job "${jobName}" has no steps`);
      }
    }
    // A step-level continue-on-error is an informational annotation and never
    // reds a check run; only the JOB-level form is banned here, because that is
    // the one that reports a run green over a job that failed.
    if (job['continue-on-error'] === true) {
      fail(file, `job "${jobName}" declares job-level continue-on-error: true (banned: it hides a failing job behind a green run)`);
    }
  }

  if (file === 'release.yml') {
    for (const { job, githubPackages, killSwitch } of RELEASE_REQUIRED_JOBS) {
      const jobDef = (jobs as Json)[job];
      if (!isObject(jobDef)) {
        fail(file, `release workflow is missing the "${job}" job`);
        continue;
      }
      const condition = typeof jobDef.if === 'string' ? jobDef.if : '';
      if (killSwitch && !condition.includes(PUBLISH_KILL_SWITCH)) {
        fail(file, `job "${job}" writes to a registry but its \`if\` does not carry the ${PUBLISH_KILL_SWITCH} kill switch`);
      }
      if (githubPackages) {
        const perms = jobDef.permissions;
        const packagesPerm = isObject(perms) ? perms.packages : undefined;
        if (packagesPerm !== 'write') {
          fail(file, `job "${job}" mirrors to GitHub Packages but does not declare permissions.packages: write`);
        }
        // npmjs is the source of truth. A mirror that can start before (or
        // without) the npmjs publish splits one version across two registries.
        if (!needsOf(jobDef).includes(NPM_PUBLISH_JOB)) {
          fail(file, `job "${job}" mirrors to GitHub Packages but does not list "${NPM_PUBLISH_JOB}" in needs (the mirror must trail the npmjs publish)`);
        }
      }
    }
  }
}

if (problems.length > 0) {
  console.error(`check-workflows: ${problems.length} structural problem(s):`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}

console.log(`check-workflows: OK; ${files.length} workflow file(s) validated, 0 problems.`);
