/**
 * Workflow-shape gate (ported from the SDK's approach).
 *
 * CI cannot run without pushing, so this suite is the local proof that the
 * hand-authored workflow YAML is well-formed: the job graphs, needs edges, no
 * continue-on-error on any job, timeout caps, pinned action SHAs, and the
 * by-reference release wiring — including that release.yml consumes the SDK's
 * reusable workflows at mgd34msu/goodvibes-sdk@main.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const WF_DIR = resolve(ROOT, ".github/workflows");

type Job = Record<string, unknown> & {
  needs?: string | string[];
  "runs-on"?: string;
  "timeout-minutes"?: number;
  uses?: string;
  if?: unknown;
  steps?: Array<Record<string, unknown>>;
  permissions?: Record<string, string>;
};
type Workflow = { on?: unknown; jobs?: Record<string, Job>; concurrency?: Record<string, unknown> };

function load(name: string): Workflow {
  return Bun.YAML.parse(readFileSync(resolve(WF_DIR, name), "utf8")) as Workflow;
}
function jobs(wf: Workflow): [string, Job][] {
  return Object.entries(wf.jobs ?? {});
}
function needsOf(job: Job): string[] {
  return Array.isArray(job.needs) ? job.needs : job.needs ? [job.needs] : [];
}
function steps(job: Job): Array<Record<string, unknown>> {
  return job.steps ?? [];
}

describe("all workflows: baseline hygiene", () => {
  const files = readdirSync(WF_DIR).filter((f) => f.endsWith(".yml"));

  test("no job or step uses continue-on-error: true (per-job-green is the only green)", () => {
    for (const f of files) {
      const wf = load(f);
      for (const [, job] of jobs(wf)) {
        expect(job["continue-on-error"]).not.toBe(true);
        for (const step of steps(job)) expect(step["continue-on-error"]).not.toBe(true);
      }
    }
  });

  test("every executing job declares a timeout (reusable-workflow callers are exempt)", () => {
    for (const f of files) {
      const wf = load(f);
      for (const [name, job] of jobs(wf)) {
        if (job.uses) continue;
        expect(job["timeout-minutes"], `${f}:${name} needs timeout-minutes`).toBeGreaterThan(0);
      }
    }
  });

  test("all uses: references are SHA-pinned, a local path, or a reusable @main/@vN ref", () => {
    for (const f of files) {
      const wf = load(f);
      for (const [, job] of jobs(wf)) {
        const refs: string[] = [];
        if (typeof job.uses === "string") refs.push(job.uses);
        for (const step of steps(job)) if (typeof step.uses === "string") refs.push(step.uses);
        for (const ref of refs) {
          const ok = ref.startsWith("./") || /@[0-9a-f]{40}$/.test(ref) || /@(main|v\d)/.test(ref);
          expect(ok, `unpinned action ref: ${ref} in ${f}`).toBe(true);
        }
      }
    }
  });
});

describe("ci.yml: the eight-job gate graph", () => {
  const ci = load("ci.yml");

  test("has the expected job set", () => {
    const names = jobs(ci).map(([n]) => n);
    for (const n of ["typecheck", "test", "coverage", "architecture-check", "perf-check", "eval-gate", "build", "action-self-test"]) {
      expect(names).toContain(n);
    }
  });

  test("the build job gates on every upstream gate", () => {
    const build = ci.jobs!["build"]!;
    for (const dep of ["typecheck", "test", "coverage", "architecture-check", "perf-check", "eval-gate"]) {
      expect(needsOf(build)).toContain(dep);
    }
  });

  test("cancel-in-progress is scoped to pull requests only", () => {
    expect(String(ci.concurrency?.["cancel-in-progress"])).toContain("pull_request");
  });
});

describe("release.yml: by-reference release on the reusable workflows", () => {
  const rel = load("release.yml");
  const REUSABLE = "mgd34msu/goodvibes-sdk/.github/workflows";

  test("the serialized validate-release re-run is gone", () => {
    expect(Object.keys(rel.jobs ?? {})).not.toContain("validate-release");
  });

  test("release-verify calls the reusable by-reference workflow at @main", () => {
    const rv = rel.jobs!["release-verify"]!;
    expect(rv.uses).toBe(`${REUSABLE}/reusable-release-verify.yml@main`);
    expect(String(rv.if)).toContain("github.event_name == 'push'");
  });

  test("the binary matrix calls the reusable workflow at @main", () => {
    expect(rel.jobs!["binaries"]!.uses).toBe(`${REUSABLE}/reusable-binary-matrix.yml@main`);
  });

  test("gh-release calls the reusable workflow at @main and gates on staged assets", () => {
    const gh = rel.jobs!["gh-release"]!;
    expect(gh.uses).toBe(`${REUSABLE}/reusable-gh-release.yml@main`);
    expect(needsOf(gh)).toContain("stage-release-assets");
  });

  test("gh-release passes the per-release notes-file override (docs/releases, no v prefix)", () => {
    const gh = rel.jobs!["gh-release"]! as Job & { with?: Record<string, unknown> };
    const notesFile = String(gh.with?.["notes-file"] ?? "");
    expect(notesFile).toStartWith("docs/releases/");
    expect(notesFile).toEndWith(".md");
    // Version comes from the stage job's tag-derived output, which strips the
    // v prefix — docs/releases files are named <version>.md, not v<version>.md.
    expect(notesFile).toContain("needs.stage-release-assets.outputs.version");
    expect(notesFile).not.toContain("docs/releases/v");
    // The producing job must actually expose that output.
    const stage = rel.jobs!["stage-release-assets"]! as Job & { outputs?: Record<string, string> };
    expect(String(stage.outputs?.["version"] ?? "")).toContain("steps.version.outputs.version");
  });

  test("publish-npm calls the reusable npm-publish at @main and is push-gated", () => {
    const pub = rel.jobs!["publish-npm"]!;
    expect(pub.uses).toBe(`${REUSABLE}/reusable-npm-publish.yml@main`);
    expect(String(pub.if)).toContain("github.event_name == 'push'");
  });

  test("platform packages publish BEFORE the main package, and both AFTER the GH release", () => {
    expect(needsOf(rel.jobs!["publish-platform-packages"]!)).toContain("gh-release");
    const npm = needsOf(rel.jobs!["publish-npm"]!);
    expect(npm).toContain("gh-release");
    expect(npm).toContain("publish-platform-packages");
  });

  test("artifact-glob and assets-glob inputs are newline-separated multi-line blocks", () => {
    // The reusable workflows expand these globs one-per-line; a space-separated
    // single-line value silently becomes one glob that matches nothing (an
    // adjacent repo shipped exactly that and its shape suite passed over it).
    const globInputs: Array<{ job: string; input: string }> = [
      { job: "binaries", input: "artifact-glob" },
      { job: "gh-release", input: "assets-glob" },
    ];
    for (const { job, input } of globInputs) {
      const def = rel.jobs![job]! as Job & { with?: Record<string, unknown> };
      const value = String(def.with?.[input] ?? "");
      expect(value, `${job}.with.${input} must be set`).not.toBe("");
      const globs = value.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
      expect(globs.length, `${job}.with.${input} must list multiple globs, one per line`).toBeGreaterThan(1);
      for (const glob of globs) {
        expect(glob, `${job}.with.${input} line "${glob}" must not be space-separated`).not.toMatch(/\s/);
      }
    }
  });

  test("the GitHub Packages mirror jobs elevate packages: write", () => {
    for (const name of ["publish-github-packages", "publish-github-platform-packages"]) {
      expect(rel.jobs![name]!.permissions?.["packages"]).toBe("write");
    }
  });

  test("concurrency never cancels an in-progress release", () => {
    expect(rel.concurrency?.["cancel-in-progress"]).toBe(false);
  });
});

describe("composite setup action: single Bun source", () => {
  test("exposes a bun-version input with a default", () => {
    const action = Bun.YAML.parse(readFileSync(resolve(ROOT, ".github/actions/setup/action.yml"), "utf8")) as {
      inputs?: { "bun-version"?: { default?: string } };
    };
    expect(action.inputs?.["bun-version"]?.default).toBeTruthy();
  });
});
