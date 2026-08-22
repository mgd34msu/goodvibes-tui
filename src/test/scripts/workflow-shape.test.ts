/**
 * Workflow-shape gate (ported from the SDK's approach).
 *
 * CI cannot run without pushing, so this suite is the local proof that the
 * hand-authored workflow YAML is well-formed: the job graphs, needs edges, no
 * continue-on-error on any job, timeout caps, pinned action SHAs, and the
 * by-reference release wiring, including that release.yml consumes the SDK's
 * reusable workflows at a pinned mgd34msu/goodvibes-sdk commit.
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
function stepText(job: Job): string {
  return steps(job)
    .map((s) => String(s.run ?? ""))
    .join("\n");
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

describe("ci.yml: the gate graph", () => {
  const ci = load("ci.yml");

  test("has the expected job set", () => {
    const names = jobs(ci).map(([n]) => n);
    for (const n of ["typecheck", "test", "coverage", "architecture-check", "perf-check", "eval-gate", "build", "package-gate"]) {
      expect(names).toContain(n);
    }
  });

  test("the build job gates on every upstream gate", () => {
    const build = ci.jobs!["build"]!;
    for (const dep of ["typecheck", "test", "coverage", "architecture-check", "perf-check", "eval-gate"]) {
      expect(needsOf(build)).toContain(dep);
    }
  });

  test("the build job runs on pull requests too, not push only", () => {
    // A push-only build job lets a PR that breaks the compile merge green.
    const build = ci.jobs!["build"]!;
    expect(String(build.if ?? "")).not.toContain("github.event_name == 'push'");
  });

  test("the build job compiles through the toolchain and then EXECUTES the binary", () => {
    // A bare `bun build --compile` skips the configured prebuild and never
    // starts the artifact, so a binary that cannot boot still passed CI.
    const text = stepText(ci.jobs!["build"]!);
    expect(text).toContain("build:linux-x64");
    expect(text).toContain("smoke:tui");
    expect(text).toContain("dist/goodvibes-linux-x64");
  });

  test("the sdk-pin gate runs pre-tag, in push CI, not for the first time inside release.yml", () => {
    const text = stepText(ci.jobs!["package-gate"]!);
    expect(text).toContain("publish:check");
    expect(text).toContain("package:install-check");
    expect(text).toContain("verification:ledger");
  });

  test("no step masks a failing command behind `|| echo`", () => {
    // `cmd || echo "..."` reports success no matter what cmd did; it is the
    // step-level shape of continue-on-error.
    for (const [name, job] of jobs(ci)) {
      expect(stepText(job), `${name} must not mask a command's exit code`).not.toMatch(/\|\|\s*echo/);
    }
  });

  test("cancel-in-progress is scoped to pull requests only", () => {
    expect(String(ci.concurrency?.["cancel-in-progress"])).toContain("pull_request");
  });
});

describe("ci.yml: zero-touch auto-release", () => {
  const ci = load("ci.yml");
  const gatingJobs = [
    "typecheck",
    "test",
    "coverage",
    "architecture-check",
    "perf-check",
    "eval-gate",
    "build",
    "package-gate",
  ];

  test("auto-release needs EVERY other ci.yml job (only runs when all are green)", () => {
    const auto = ci.jobs!["auto-release"]!;
    const needs = needsOf(auto);
    for (const job of gatingJobs) {
      expect(needs, `auto-release must need ${job} so it only runs when that gate is green`).toContain(job);
    }
    // And its needs set is exactly the other jobs, no gate omitted, no self-need.
    const otherJobs = jobs(ci)
      .map(([n]) => n)
      .filter((n) => n !== "auto-release");
    expect([...needs].sort()).toEqual([...otherJobs].sort());
  });

  test("auto-release is gated to pushes on main", () => {
    const cond = String(ci.jobs!["auto-release"]!.if);
    expect(cond).toContain("github.ref == 'refs/heads/main'");
    expect(cond).toContain("github.event_name == 'push'");
  });

  test("the composite-action self-test is not part of ci.yml at all", () => {
    // It installs the PREVIOUS published release and tests the action wrapper
    // against it, which says nothing about this commit and cannot pass before
    // the first release exists. Dropping it from auto-release's `needs` is not
    // enough to de-gate it: release.yml's release-verify asserts per-job green
    // over EVERY job of the ci.yml run, so any job living here is
    // release-gating. It lives in its own workflow file instead.
    expect(Object.keys(ci.jobs ?? {})).not.toContain("action-self-test");
    const standalone = load("action-self-test.yml");
    expect(Object.keys(standalone.jobs ?? {})).toContain("action-self-test");
  });

  test("auto-release grants contents:write and actions:write", () => {
    const perms = ci.jobs!["auto-release"]!.permissions ?? {};
    expect(perms.contents).toBe("write");
    expect(perms.actions).toBe("write");
  });

  test("auto-release checks tag existence BEFORE creating the tag", () => {
    const text = stepText(ci.jobs!["auto-release"]!);
    const existenceCheck = text.indexOf("git ls-remote --tags origin");
    const tagCreate = text.indexOf("git tag -a");
    expect(existenceCheck).toBeGreaterThanOrEqual(0);
    expect(tagCreate).toBeGreaterThanOrEqual(0);
    // The idempotent existence check must precede tag creation.
    expect(existenceCheck).toBeLessThan(tagCreate);
  });

  test("auto-release dispatches release.yml with mode=release, not a bare tag push", () => {
    const text = stepText(ci.jobs!["auto-release"]!);
    expect(text).toContain("gh workflow run release.yml");
    expect(text).toContain("mode=release");
    // The dispatch uses the tag ref so github.ref/github.sha point at the tag.
    expect(text).toContain("--ref");
    expect(text).toContain("refs/tags/");
  });
});

describe("release.yml: by-reference release on the reusable workflows", () => {
  const rel = load("release.yml");
  const REUSABLE = "mgd34msu/goodvibes-sdk/.github/workflows";
  // release.yml pins every reusable-workflow call to this sdk commit instead
  // of floating on @main (see "Pin the sdk reusable workflows to a commit
  // SHA"); bumping the pin is a deliberate one-line change in release.yml,
  // mirrored here.
  const SDK_PIN = "d5ebf5272c5092334e10be2a184c44cabc41fe88";

  test("the serialized validate-release re-run is gone", () => {
    expect(Object.keys(rel.jobs ?? {})).not.toContain("validate-release");
  });

  test("release-verify calls the reusable by-reference workflow at the pinned sdk commit", () => {
    const rv = rel.jobs!["release-verify"]!;
    expect(rv.uses).toBe(`${REUSABLE}/reusable-release-verify.yml@${SDK_PIN}`);
    expect(String(rv.if)).toContain("github.event_name == 'push'");
  });

  test("tag/version verification is the FIRST release job and everything chains through it", () => {
    const verify = rel.jobs!["verify-tag-version"]!;
    expect(verify).toBeTruthy();
    expect(needsOf(verify), "verify-tag-version must gate nothing before itself").toEqual([]);
    expect(stepText(verify)).toContain("scripts/verify-release-tag-version.ts");
    // Everything downstream reaches it through release-verify.
    expect(needsOf(rel.jobs!["release-verify"]!)).toContain("verify-tag-version");
    expect(needsOf(rel.jobs!["binaries"]!)).toContain("release-verify");
  });

  test("every reusable call site that accepts a toolchain-spec pins an exact version", () => {
    // An unpinned release-time `bunx @pellux/goodvibes-toolchain` resolves
    // whatever npm calls latest at that moment, so the tool that validates the
    // release could change mid-release.
    const pin = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8")) as {
      devDependencies?: Record<string, string>;
    };
    const pinned = pin.devDependencies?.["@pellux/goodvibes-toolchain"];
    expect(pinned, "package.json must pin @pellux/goodvibes-toolchain exactly").toMatch(/^\d+\.\d+\.\d+$/);
    const spec = `@pellux/goodvibes-toolchain@${pinned}`;
    for (const name of ["release-verify", "binaries", "gh-release"]) {
      const job = rel.jobs![name]! as Job & { with?: Record<string, unknown> };
      expect(String(job.with?.["toolchain-spec"] ?? ""), `${name} must pass a versioned toolchain-spec`).toBe(spec);
    }
    // reusable-npm-publish takes no toolchain-spec input, so its pin rides in
    // the publish command instead.
    const publish = rel.jobs!["publish-npm"]! as Job & { with?: Record<string, unknown> };
    expect(String(publish.with?.["publish-command"] ?? "")).toContain(spec);
  });

  test("the GitHub Packages mirror trails npmjs and carries the same kill switch", () => {
    // Without both, flipping PUBLISH_NPM off (or an npmjs failure) still
    // published the mirror, splitting one version across two registries.
    for (const name of ["publish-github-platform-packages", "publish-github-packages"]) {
      const job = rel.jobs![name]!;
      expect(String(job.if), `${name} must carry the PUBLISH_NPM kill switch`).toContain("vars.PUBLISH_NPM == 'true'");
      expect(needsOf(job), `${name} must trail the npmjs publish`).toContain("publish-npm");
    }
  });

  test("dispatch inputs are never interpolated into a run: block", () => {
    // github.event.inputs.* reaches a shell through env:, quoted, so a ref
    // containing shell syntax is a string that fails to resolve, not a command.
    for (const [name, job] of jobs(rel)) {
      expect(stepText(job), `${name} must route dispatch inputs through env:`).not.toContain("github.event.inputs.ref }}");
      expect(stepText(job), `${name} must route dispatch inputs through env:`).not.toContain("github.event.inputs.mode }}");
    }
  });

  test("caller jobs grant the permissions the called reusable workflows request", () => {
    // GitHub validates this at workflow startup: a called workflow's job may
    // only use permissions the caller job grants; an under-granting caller is
    // rejected with startup_failure and jobs: [] before anything runs (this
    // killed the SDK's v1.11.0 release run). The reusables' requested
    // permissions are their documented contract: release-verify reads run/job
    // conclusions (actions+checks read), gh-release creates the release
    // (contents write), npm-publish mints provenance (id-token write).
    const contract: Record<string, Record<string, string>> = {
      "release-verify": { actions: "read", checks: "read" },
      "gh-release": { contents: "write" },
      "publish-npm": { "id-token": "write" },
    };
    for (const [jobName, required] of Object.entries(contract)) {
      const job = rel.jobs![jobName]! as Job & { permissions?: Record<string, string> };
      for (const [scope, level] of Object.entries(required)) {
        expect(job.permissions?.[scope], `${jobName} must grant ${scope}: ${level}`).toBe(level);
      }
    }
  });

  test("the binary matrix calls the reusable workflow at the pinned sdk commit", () => {
    expect(rel.jobs!["binaries"]!.uses).toBe(`${REUSABLE}/reusable-binary-matrix.yml@${SDK_PIN}`);
  });

  test("every smoke:true matrix leg carries its own binary path matching the config's appArtifact", () => {
    // reusable-binary-matrix contract: targets is {key, runner, smoke, binary}
    // and `binary` is REQUIRED when smoke is true, each leg only builds its
    // own suffixed artifact, so the smoke step hard-fails without it (the
    // config's smoke.binaryDefault serves local CLI runs only).
    const binaries = rel.jobs!["binaries"]! as Job & { with?: Record<string, unknown> };
    const targets = JSON.parse(String(binaries.with?.["targets"] ?? "[]")) as Array<{
      key: string;
      runner: string;
      smoke: boolean;
      binary?: string;
    }>;
    expect(targets.length).toBe(4);
    const config = JSON.parse(readFileSync(resolve(ROOT, "toolchain.config.json"), "utf8")) as {
      build: { outDir: string; targets: Array<{ key: string; appArtifact: string }> };
    };
    const appArtifactByKey = new Map(config.build.targets.map((t) => [t.key, t.appArtifact]));
    let smokeLegs = 0;
    for (const target of targets) {
      expect(appArtifactByKey.has(target.key), `matrix key ${target.key} must exist in toolchain.config.json`).toBe(true);
      if (target.smoke) {
        smokeLegs += 1;
        expect(target.binary, `smoke leg ${target.key} must carry binary`).toBeTruthy();
        expect(target.binary).toBe(`${config.build.outDir}/${appArtifactByKey.get(target.key)}`);
      }
    }
    expect(smokeLegs).toBeGreaterThan(0);
  });

  test("gh-release calls the reusable workflow at the pinned sdk commit and gates on staged assets", () => {
    const gh = rel.jobs!["gh-release"]!;
    expect(gh.uses).toBe(`${REUSABLE}/reusable-gh-release.yml@${SDK_PIN}`);
    expect(needsOf(gh)).toContain("stage-release-assets");
  });

  test("gh-release passes the per-release notes-file override (docs/releases, no v prefix)", () => {
    const gh = rel.jobs!["gh-release"]! as Job & { with?: Record<string, unknown> };
    const notesFile = String(gh.with?.["notes-file"] ?? "");
    expect(notesFile).toStartWith("docs/releases/");
    expect(notesFile).toEndWith(".md");
    // Version comes from the stage job's tag-derived output, which strips the
    // v prefix, docs/releases files are named <version>.md, not v<version>.md.
    expect(notesFile).toContain("needs.stage-release-assets.outputs.version");
    expect(notesFile).not.toContain("docs/releases/v");
    // The producing job must actually expose that output.
    const stage = rel.jobs!["stage-release-assets"]! as Job & { outputs?: Record<string, string> };
    expect(String(stage.outputs?.["version"] ?? "")).toContain("steps.version.outputs.version");
  });

  test("publish-npm calls the reusable npm-publish at the pinned sdk commit and is push-gated", () => {
    const pub = rel.jobs!["publish-npm"]!;
    expect(pub.uses).toBe(`${REUSABLE}/reusable-npm-publish.yml@${SDK_PIN}`);
    expect(String(pub.if)).toContain("github.event_name == 'push'");
  });

  test("dispatch is dry-run unless mode=release", () => {
    // A release-mode dispatch is now a first-class publish path (the zero-touch
    // auto-release job in ci.yml dispatches release.yml with mode=release), so
    // the publish jobs run on a push OR a release-mode dispatch, while
    // install-smoke's non-release-dispatch legs and the binaries job's
    // dry-validation leg stay fenced off to a non-release dispatch so they can
    // never publish.
    const publishJobs = [
      "stage-release-assets",
      "gh-release",
      "publish-platform-packages",
      "publish-npm",
      "publish-github-platform-packages",
      "publish-github-packages",
    ];
    for (const name of publishJobs) {
      const cond = String(rel.jobs![name]!.if);
      expect(cond, `${name}.if must still gate on push`).toContain("github.event_name == 'push'");
      expect(cond, `${name}.if must also allow a release-mode dispatch`).toContain("inputs.mode == 'release'");
    }

    const binariesIf = String(rel.jobs!["binaries"]!.if);
    expect(binariesIf).toContain("github.event_name == 'workflow_dispatch'");
    expect(binariesIf).toContain("inputs.mode != 'release'");
  });

  test("workflow_dispatch exposes a mode input defaulting to dry-run", () => {
    const inputs = (
      rel.on as {
        workflow_dispatch?: { inputs?: Record<string, { default?: string; type?: string; options?: string[] }> };
      }
    ).workflow_dispatch?.inputs ?? {};
    expect(inputs.mode).toBeTruthy();
    expect(inputs.mode?.default).toBe("dry-run");
    expect(inputs.mode?.type).toBe("choice");
    expect(inputs.mode?.options).toEqual(expect.arrayContaining(["dry-run", "release"]));
  });

  test("the tag-push publish path is preserved unchanged (manual redo)", () => {
    // Every release job that gates on a release-mode dispatch must still also
    // gate on a plain push, so pushing a v* tag by hand releases exactly as before.
    for (const name of [
      "release-verify",
      "stage-release-assets",
      "gh-release",
      "publish-platform-packages",
      "publish-npm",
      "publish-github-platform-packages",
      "publish-github-packages",
    ]) {
      expect(String(rel.jobs![name]!.if)).toContain("github.event_name == 'push'");
    }
  });

  test("checkouts that could default to the ref input's \"main\" instead resolve the tag ref in release mode", () => {
    // smoke-macos checks out `github.event.inputs.ref || github.ref`, which
    // would silently resolve to the ref input's "main" default on a
    // release-mode dispatch (inputs.ref is never set by the auto-release
    // job's dispatch call) unless a release-mode branch takes priority.
    for (const name of ["smoke-macos"]) {
      const job = rel.jobs![name]!;
      const checkout = steps(job).find((s) => String(s.uses ?? "").startsWith("actions/checkout@"));
      const ref = String((checkout?.with as { ref?: string } | undefined)?.ref ?? "");
      expect(ref, `${name} checkout ref must special-case a release-mode dispatch`).toContain("inputs.mode == 'release'");
    }
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

describe("windows-beta.yml: a promotion signal that means what its header claims", () => {
  const wb = load("windows-beta.yml");

  test("runs on a schedule as well as on demand, so the signal cannot go stale", () => {
    const on = wb.on as { schedule?: Array<{ cron?: string }>; workflow_dispatch?: unknown };
    expect(on.workflow_dispatch !== undefined).toBe(true);
    expect(Array.isArray(on.schedule) && on.schedule.length > 0).toBe(true);
    expect(String(on.schedule?.[0]?.cron ?? "")).toMatch(/\S/);
  });

  test("validates the ref (typecheck + tests) before it builds anything", () => {
    const verify = wb.jobs!["verify-ref"]!;
    expect(stepText(verify)).toContain("bun run test");
    expect(stepText(verify)).toContain("tsc --noEmit");
    expect(needsOf(wb.jobs!["build-windows-beta"]!)).toContain("verify-ref");
  });

  test("builds through the toolchain and smokes with the shared post-build smoke", () => {
    // The old lane hand-rolled `bun build --compile` (no prebuild, no addon)
    // and a pwsh check that asserted only exit 0 plus a banner prefix.
    const build = stepText(wb.jobs!["build-windows-beta"]!);
    expect(build).toContain("build:windows");
    expect(build).not.toContain("bun build src/main.ts");
    const smoke = stepText(wb.jobs!["smoke-windows-beta"]!);
    expect(smoke).toContain("goodvibes-post-build-smoke");
    expect(smoke).toContain("dist/goodvibes-windows-x64.exe");
  });

  test("the windows target it builds exists in toolchain.config.json", () => {
    const config = JSON.parse(readFileSync(resolve(ROOT, "toolchain.config.json"), "utf8")) as {
      build: { outDir: string; targets: Array<{ key: string; appArtifact: string }> };
    };
    const windows = config.build.targets.find((t) => t.key === "windows-x64");
    expect(windows, "build:windows resolves --target windows-x64 from this config").toBeTruthy();
    expect(`${config.build.outDir}/${windows!.appArtifact}`).toBe("dist/goodvibes-windows-x64.exe");
  });
});

describe("composite setup action: single Bun source", () => {
  test("action metadata never references the vars context", () => {
    // GitHub template-evaluates the ENTIRE action manifest, including input
    // descriptions, and the vars context does not exist in composite actions.
    // A literal vars expression anywhere in this file fails every consuming
    // job at load time (this took down all six bun jobs on the v1.19.2 run).
    const raw = readFileSync(resolve(ROOT, ".github/actions/setup/action.yml"), "utf8");
    expect(raw).not.toMatch(/\$\{\{\s*vars\./);
  });

  test("exposes a bun-version input with a default", () => {
    const action = Bun.YAML.parse(readFileSync(resolve(ROOT, ".github/actions/setup/action.yml"), "utf8")) as {
      inputs?: { "bun-version"?: { default?: string } };
    };
    expect(action.inputs?.["bun-version"]?.default).toBeTruthy();
  });
});
