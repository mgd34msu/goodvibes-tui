#!/usr/bin/env bun
/**
 * check-workflows.ts — structural validation gate for the GitHub Actions
 * workflow YAML under .github/workflows/.
 *
 * The repo has no actionlint/yaml-lint gate, so a broken workflow edit would
 * only surface at release time. This check runs in the ordinary gate battery and
 * validates the structure statically (it never executes a publish):
 *   - every workflow file parses as YAML;
 *   - every workflow declares `name`, `on`, and a non-empty `jobs` map;
 *   - every job declares `runs-on` and either `steps` or `uses` (reusable call);
 *   - the release workflow carries the publish jobs we expect, and every job that
 *     publishes to GitHub Packages elevates `permissions.packages: write`.
 *
 * Exit code 0 = green (0 problems), non-zero = the count of structural problems.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const workflowsDir = join(root, '.github', 'workflows');

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

/** Jobs the release workflow must define, and whether they mirror to GitHub Packages. */
const RELEASE_REQUIRED_JOBS: ReadonlyArray<{ job: string; githubPackages: boolean }> = [
  { job: 'publish-npm', githubPackages: false },
  { job: 'publish-platform-packages', githubPackages: false },
  { job: 'publish-github-packages', githubPackages: true },
  { job: 'publish-github-platform-packages', githubPackages: true },
];

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
  // YAML parses the `on:` key as the boolean true, so accept either spelling.
  if (!('on' in doc) && !(true in (doc as Record<string | number, unknown>))) {
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
  }

  if (file === 'release.yml') {
    for (const { job, githubPackages } of RELEASE_REQUIRED_JOBS) {
      const jobDef = (jobs as Json)[job];
      if (!isObject(jobDef)) {
        fail(file, `release workflow is missing the "${job}" job`);
        continue;
      }
      if (githubPackages) {
        const perms = jobDef.permissions;
        const packagesPerm = isObject(perms) ? perms.packages : undefined;
        if (packagesPerm !== 'write') {
          fail(file, `job "${job}" mirrors to GitHub Packages but does not declare permissions.packages: write`);
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

console.log(`check-workflows: OK — ${files.length} workflow file(s) validated, 0 problems.`);
