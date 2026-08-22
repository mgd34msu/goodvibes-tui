import { readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

export interface SweepOptions {
  /** Clock reference (injectable for tests). Defaults to Date.now(). */
  readonly now?: number;
  /** Entries older than this are removed. Defaults to 1 hour. */
  readonly staleMs?: number;
}

/** Default stale threshold: 1 hour. */
export const DEFAULT_STALE_MS = 60 * 60 * 1000;

/**
 * Remove stale entries under the shared `.test-tmp` root.
 *
 * This is the BACKSTOP for a signal-killed process, not the primary cleanup.
 * Two leak vectors reach it:
 *   1. `run-<pid>` runner subtrees, run-tests.ts removes its own in a
 *      `finally`, but a hard-killed runner (timeout/OOM) can leave one behind.
 *   2. `makeProjectTempDir` leftovers (`<prefix>-<random>`, see
 *      src/test/helpers/project-temp.ts), normally removed by the `afterAll`
 *      in src/test/preload/temp-cleanup.ts when the test process finishes, so
 *      only a process that never reached its afterAll (SIGKILL, OOM) leaves one.
 *      Under these worktrees the project lives on /tmp, so each leaked subtree
 *      is a leaked /tmp inode subtree.
 *
 * That primary cleanup used to be a `process.on('exit')` hook, which `bun test`
 * never fires at all, so until it was replaced this sweep was reaping the
 * output of every ordinary green run, an hour late.
 *
 * Age-gated (default 1 h) so it is safe under concurrency: a live sibling
 * runner's `run-<pid>` dir and any in-flight `makeProjectTempDir` dir are at
 * most seconds old and are never touched; only orphans a crash/kill left behind
 * (necessarily older) are removed. Returns the names actually removed.
 */
export function sweepStaleTestTmp(root: string, options: SweepOptions = {}): string[] {
  const now = options.now ?? Date.now();
  const staleMs = options.staleMs ?? DEFAULT_STALE_MS;

  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return []; // root doesn't exist yet, nothing to sweep
  }

  const removed: string[] = [];
  for (const name of entries) {
    const full = join(root, name);
    try {
      const st = statSync(full);
      if (now - st.mtimeMs > staleMs) {
        rmSync(full, { recursive: true, force: true });
        removed.push(name);
      }
    } catch {
      // ignore, another concurrent runner may have already removed it
    }
  }
  return removed;
}

// ---------------------------------------------------------------------------
// Real OS temp dir sweep
// ---------------------------------------------------------------------------
//
// `sweepStaleTestTmp` above only ever runs against this repo's own
// `.test-tmp` root. It was never pointed at `os.tmpdir()` (the real host
// /tmp), so the actual leak class this project produced there, mkdtemp
// dirs from tests and a handful of scripts that were signal-killed before
// their afterEach/afterAll or `finally` cleanup ran, was never reclaimed.
// That accumulated without bound (observed: 1,048,436 of 1,048,576 inodes
// in use on one host).
//
// The 158 test files that used to build scratch dirs straight under
// `os.tmpdir()` have since been migrated onto `makeProjectTempDir` (which
// roots them under `.test-tmp`, covered by the sweep above). This second
// sweep is the backstop for what migration alone doesn't reach:
//   - historical orphans already sitting in the real temp dir from before
//     that migration shipped;
//   - the whole-suite `bun test --coverage src` invocation used by
//     `bun run test:coverage` (scripts/coverage-gate.ts), which spawns a
//     single process directly and does NOT get the per-file TMPDIR
//     redirection that `scripts/run-tests.ts` gives `bun run test`;
//   - direct `bun test <file>` invocations (an IDE "run test" button, a
//     one-off debug session) that bypass scripts/run-tests.ts entirely;
//   - the small number of production/script files (the external-editor
//     round-trip, two modal "golden fixture" builders, the release-notes
//     script, the reference example) that legitimately create real-tmpdir
//     scratch outside of any test process and already clean it up on every
//     normal exit path, but not a signal kill mid-run.
//
// Matched ONLY by the exact literal prefixes this project is known to pass
// to mkdtemp, never a blanket "gv-" or "goodvibes-" wildcard. A wildcard
// would also catch sibling repos in the same family (goodvibes-sdk,
// goodvibes-agent, …) running their own test suites in their own worktrees
// on the same shared host; those are unrelated processes with unrelated
// scratch and must never be touched. Confirmed live: a broad `^(gv-|
// goodvibes-)` sweep during this work picked up 52 directories from a
// concurrent sibling repo's test run (e.g. `gv-channel-owner-gate-*`,
// `goodvibes-bedrock-vertex-copilot-discovery-*`) that do not appear
// anywhere in this repo's source. Exact-prefix matching excludes all of
// those by construction.
export const PROJECT_OS_TMP_PREFIXES: readonly string[] = [
  'cluster-inbox', 'cluster-state', 'exec-scrub-allowlist-test', 'exec-test',
  'git-test', 'goodvibes-audio', 'goodvibes-channel-policy', 'goodvibes-cli-bundle',
  'goodvibes-cli-bundle-import', 'goodvibes-cli-bundle-redaction', 'goodvibes-cli-config', 'goodvibes-cli-config-invalid',
  'goodvibes-cli-control-plane-check', 'goodvibes-cli-endpoint', 'goodvibes-cli-feature-errors', 'goodvibes-cli-listener-readiness',
  'goodvibes-cli-provider-posture', 'goodvibes-cli-secret-redaction', 'goodvibes-cli-service-check', 'goodvibes-cli-surface-local-web',
  'goodvibes-cli-surface-slack', 'goodvibes-cli-surface-web', 'goodvibes-cli-surfaces-check', 'goodvibes-cli-surfaces-feature-gates',
  'goodvibes-client-login-home', 'goodvibes-client-sandbox', 'goodvibes-client-work', 'goodvibes-cloudflare-cmd',
  'goodvibes-cluster-group', 'goodvibes-cluster-holdings', 'goodvibes-composer', 'goodvibes-config-default-absent',
  'goodvibes-config-default-corrupt-global', 'goodvibes-config-default-corrupt-global-proj', 'goodvibes-config-default-corrupt-project', 'goodvibes-config-default-corrupt-project-proj',
  'goodvibes-config-default-global', 'goodvibes-config-default-global-dir', 'goodvibes-config-default-project-dir', 'goodvibes-config-persistence',
  'goodvibes-config-reset', 'goodvibes-device-trigger', 'goodvibes-feature-knob', 'goodvibes-hooks',
  'goodvibes-inbound-home', 'goodvibes-inbound-project', 'goodvibes-meaning-login', 'goodvibes-meaning-sandbox',
  'goodvibes-memory-spine-daemon-home', 'goodvibes-memory-spine-daemon-project', 'goodvibes-plugin', 'goodvibes-plugin-bundles',
  'goodvibes-service-posture', 'goodvibes-spine-daemon-home', 'goodvibes-spine-daemon-project', 'goodvibes-tui-spine-fold',
  'goodvibes-union-daemon-home', 'goodvibes-union-daemon-project', 'goodvibes-watchers', 'goodvibes-wq',
  'goodvibes-wrfc-test', 'gv-anchors', 'gv-archetypes-test', 'gv-artifacts',
  'gv-auth', 'gv-auth-behavior', 'gv-automation-foundation', 'gv-automation-manager',
  'gv-automation-service', 'gv-automation-store', 'gv-blocked-esc', 'gv-bm-test',
  'gv-checkpoint-runtime', 'gv-code-index-services', 'gv-codebase-command', 'gv-config-test',
  'gv-consolidation', 'gv-context-cap', 'gv-context-window-ui', 'gv-custom-providers',
  'gv-daemon-config', 'gv-daemon-config-migration', 'gv-daemon-mailbox-settings', 'gv-delivery-artifacts',
  'gv-delivery-config', 'gv-delivery-extended-config', 'gv-delivery-router', 'gv-delivery-router-slack',
  'gv-diff-nogit', 'gv-diff-runtime-nogit', 'gv-display-honesty', 'gv-distributed-runtime',
  'gv-doctor', 'gv-draft-store', 'gv-drafts', 'gv-drafts-reg',
  'gv-fc-test', 'gv-fetch-auth', 'gv-fleet-resolver', 'gv-fleet-resolver-e2e',
  'gv-fleet-resolver-missing', 'gv-front-door', 'gv-fw-test', 'gv-git-diff',
  'gv-git-diff-clean', 'gv-git-new', 'gv-git-panel', 'gv-git-panel-nonrepo',
  'gv-git-status-poll', 'gv-git-status-poll-nochange', 'gv-git-status-poll-stop', 'gv-git-status-poll-throws',
  'gv-gitignore', 'gv-golden-profile-picker', 'gv-golden-session-picker', 'gv-golden-settings',
  'gv-guard-wiring', 'gv-hook-api', 'gv-hook-workbench', 'gv-hooks-command',
  'gv-hooks-gate', 'gv-http-auth', 'gv-http-transport', 'gv-image-input',
  'gv-knowledge', 'gv-knowledge-command', 'gv-knowledge-graphql', 'gv-knowledge-projection',
  'gv-kv-dispose', 'gv-kv-race', 'gv-kv-test', 'gv-listener-config',
  'gv-liveness-settings', 'gv-local-remote-shell', 'gv-markdown-disclosure', 'gv-marketplace-golden',
  'gv-marketplace-modal', 'gv-masked-bs', 'gv-masked-esc', 'gv-masked-hist',
  'gv-masked-panel', 'gv-masked-submit', 'gv-mcp-command', 'gv-media-artifacts',
  'gv-memory-embeddings', 'gv-memory-handoff', 'gv-modal-search-focus', 'gv-model-limits',
  'gv-model-picker', 'gv-multimodal', 'gv-network-inbound', 'gv-network-outbound',
  'gv-notifier', 'gv-onboarding-apply', 'gv-onboarding-snapshot', 'gv-openai-codex',
  'gv-operator-rpc', 'gv-operator-rpc-home', 'gv-operator-token', 'gv-orchestration-listener',
  'gv-orchestration-listener-a', 'gv-orchestration-listener-b', 'gv-permission-audit', 'gv-pi-dir1',
  'gv-pi-dir2', 'gv-pi-dispose', 'gv-pi-norm', 'gv-pi-test',
  'gv-plan-integration', 'gv-pm-test', 'gv-progress', 'gv-prov',
  'gv-provider-accounts', 'gv-provider-api-command', 'gv-provider-api-image', 'gv-provider-expansion',
  'gv-provider-runtime', 'gv-pw-empty', 'gv-pw-short', 'gv-pw-ws',
  'gv-realtime-transport', 'gv-recall', 'gv-recall-files', 'gv-recall-handoff-import',
  'gv-recall-import', 'gv-reconcile-deadline', 'gv-reconcile-timeout', 'gv-reference-node-host',
  'gv-reference-operator', 'gv-release-notes', 'gv-remote-artifacts', 'gv-remote-cmd',
  'gv-remote-env', 'gv-remote-gate', 'gv-remote-setup-daemon', 'gv-remote-shell',
  'gv-replay-root', 'gv-review-revert', 'gv-rewind-runtime', 'gv-rot-empty',
  'gv-rot-short', 'gv-rot-ws', 'gv-routing', 'gv-routing-test',
  'gv-sandbox-modal', 'gv-sandbox-notice', 'gv-sandbox-provision', 'gv-sandbox-provision-home',
  'gv-sandbox-provision-workspace', 'gv-secrets-test', 'gv-service-commands', 'gv-service-commands-legacy',
  'gv-service-commands-migrate', 'gv-session-intents', 'gv-session-orch', 'gv-settings-plane',
  'gv-settings-sync-front-door', 'gv-skills-golden', 'gv-skills-modal-empty', 'gv-skills-modal-global',
  'gv-skills-modal-project', 'gv-ss-modal', 'gv-standalone', 'gv-subscription-provider',
  'gv-surface-domain', 'gv-teleport-cmd', 'gv-test-runtime', 'gv-tool-breadth',
  'gv-tool-breadth-init', 'gv-tool-registry', 'gv-tui-shared-voice', 'gv-unit-parity',
  'gv-update-rollback', 'gv-work-plan', 'gv-work-plan-command', 'gv-work-plan-edit',
  'gv-workstream-services', 'gv-worktree-test', 'gv-write-test', 'inbox-cursor',
  'inbox-poller', 'inbox-register', 'memory-config', 'memory-registry-config',
  'memory-test-config', 'orch-test', 'overflow-test', 'prompt-loader-test',
  'replay-test', 'spine-delta-adopt-home', 'spine-delta-adopt-wd', 'tui-disposal',
];

/**
 * Default stale threshold for the real OS temp dir: 4 hours.
 *
 * Longer than `DEFAULT_STALE_MS` (1 h) deliberately: `.test-tmp` is only
 * ever touched by this project's own test runs, all of which finish in
 * minutes, so 1 h of slack is generous. The real OS temp dir is a shared
 * system directory, a slow CI runner under contention, or a developer who
 * leaves an external-editor session open on `goodvibes-composer-*` for a
 * long writing session, can legitimately hold an entry open far longer
 * than a test takes. 4 h comfortably outlasts any of those while still
 * reclaiming same-day rather than letting orphans accumulate for months
 * the way the pre-fix backlog did.
 */
export const DEFAULT_OS_TMP_STALE_MS = 4 * 60 * 60 * 1000;

/**
 * Remove stale entries under `osTmpRoot` (intended to be `os.tmpdir()`)
 * whose name starts with one of `PROJECT_OS_TMP_PREFIXES` followed by `-`
 * (the exact shape `mkdtemp`/`makeProjectTempDir` produce: `<prefix>-<random>`).
 * Never touches anything else, no wildcard, no blanket sweep of the shared
 * temp directory. Age-gated the same way as `sweepStaleTestTmp`: only
 * entries older than `staleMs` (default `DEFAULT_OS_TMP_STALE_MS`) are
 * removed, so anything currently in use, this project's or a sibling
 * repo's, is left alone. Returns the names actually removed.
 */
export function sweepStaleOsTmpEntries(osTmpRoot: string, options: SweepOptions = {}): string[] {
  const now = options.now ?? Date.now();
  const staleMs = options.staleMs ?? DEFAULT_OS_TMP_STALE_MS;

  let entries: string[];
  try {
    entries = readdirSync(osTmpRoot);
  } catch {
    return [];
  }

  const removed: string[] = [];
  for (const name of entries) {
    if (!PROJECT_OS_TMP_PREFIXES.some((prefix) => name.startsWith(`${prefix}-`))) continue;
    const full = join(osTmpRoot, name);
    try {
      const st = statSync(full);
      if (now - st.mtimeMs > staleMs) {
        rmSync(full, { recursive: true, force: true });
        removed.push(name);
      }
    } catch {
      // ignore, removed concurrently, or a permissions edge case
    }
  }
  return removed;
}
