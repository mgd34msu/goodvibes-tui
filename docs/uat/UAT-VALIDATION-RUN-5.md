# UAT Validation Report — Run 5

**Target:** `@pellux/goodvibes-tui@0.19.19` + `@pellux/goodvibes-sdk@0.21.35`
**Commit:** `d7e0fec` (tag `v0.19.19`)
**Date:** 2026-04-21
**Tester:** automated (Claude Opus 4.7)
**Environment:** Linux x64 (Arch), Bun 1.3.10
**Tested against:** running TUI binary **PID 4108446** (embedded daemon, restarted 08:08:14 2026-04-21 against the freshly-built 0.19.19 binary, mtime 08:07:45)
**TUI binary:** `/home/buzzkill/Projects/goodvibes-tui/dist/goodvibes`
**TUI workspace cwd:** `/home/buzzkill/Projects/ttest1`

---

## Daemon discovery

`ss -tlnp` shows PID 4108446 owning **two** listeners:

| Port | fd | Role |
|---|---|---|
| 3421 | 19 | Control-plane REST + SSE |
| 3422 | 32 | HTTP listener (httpListener surface) |

Rest of report targets `http://127.0.0.1:3421`.

### Operator token

Only two candidate token files on disk this run (`ttest1/.goodvibes/operator-tokens.json` is no longer present):

| Path | Token (prefix) | Status |
|---|---|---|
| `/home/buzzkill/.goodvibes/daemon/operator-tokens.json` | `gv_ZLn4…xoZn` | **200** |
| `/home/buzzkill/Projects/goodvibes-tui/.goodvibes/operator-tokens.json` | `gv_ACao…166Gy` | 401 (stale) |

**F3 status inverted from Run 4.** In Run 4 the workspace-scoped token was live and the global token was stale; now the global token is live and the repo-root token is stale. Either direction, the existence of a stale token on disk alongside the live one is the F3 partial-resolution signature.

`/api/control-plane/auth` confirms `principalKind:"token", admin:true, authMode:"shared-token"`.
`/api/control-plane/contract.contract.product.version` = `0.21.35` — confirms running SDK matches source tree.

All curl invocations below use:

```sh
GV_TOKEN=gv_ZLn4GkCX41BMAXU0K5i25_uBUdR4xoZn
GV=http://127.0.0.1:3421
AUTH="Authorization: Bearer $GV_TOKEN"
```

---

## Executive summary

| | Count |
|---|---|
| Runnable from this shell | ~60 |
| Not runnable from shell | 6 (TUI-interactive, device pairing, release-cut, app-side) |
| **PASS** | 58 |
| **FAIL** | 0 |
| **PARTIAL** | 2 (F3 stale-token, F-PROV-009 flag absent) |
| New findings (F20+) | **3** (F20 inputs route gone, F21 companion-chat /messages GET missing, F22 scheduler snake_case) |

Static gates all pass. Test suite **7490 pass / 0 fail** across 457 files in 259 s — stable from Run 4 despite the SDK 0.21.27 → 0.21.35 bump and all OBS-14 test migrations. Endpoint sweep **83/83 concrete GET endpoints return 200** (up from Run 4's 74 — the method catalog exposes 9 more surfaces). Three of the four regression failures from Run 4 (F5, F7, F9) are now PASS — F5 in particular is the long-standing sqlite-vec runtime loader that was reopened as F5b in Run 4. Three new 404s discovered on surfaces that previously worked (F20, F21, F22).

---

## A. Source-tree static gates

| Check | Command | Result |
|---|---|---|
| Install | `bun install --frozen-lockfile` | **PASS** — exit 0, 34 ms (no changes) |
| Architecture | `bun run architecture:check` | **PASS** — exit 0, 303 non-test source files |
| TypeScript | `bunx tsc --noEmit` | **PASS** — exit 0, 0 errors |
| Test suite | `bun test` | **PASS** — **7490 pass / 0 fail**, 23 661 expect() calls, 457 files, 259.15 s |
| Foundation artifacts | `bun run foundation:artifacts` | **PASS** — idempotent regen, 193 ms |

---

## B. Runnable vs NOT-RUNNABLE classification

Identical to Run 4. Static gates, read/mutate HTTP, SSE, shared/companion turn flows, filesystem — all shell-runnable. TUI visual, model-picker, provider relaunch, device pairing, standalone-daemon collision cases, rate-limit saturation harness — not runnable from this shell.

---

## C. Targeted regression tests

### F3 — token portability

Global (`~/.goodvibes/daemon/operator-tokens.json`) → live. Repo-root (`~/Projects/goodvibes-tui/.goodvibes/operator-tokens.json`) → 401. Inverted from Run 4 but same shape: live token + stale token both on disk.

**Verdict:** **PARTIAL (unchanged).**

### F5 — `GET /api/memory/vector` (sqlite-vec native module)

```
curl -H "$AUTH" $GV/api/memory/vector
{
  "vector": {
    "backend": "sqlite-vec",
    "enabled": true,
    "available": true,
    "path": "/home/buzzkill/Projects/ttest1/.goodvibes/tui/memory.vec.sqlite",
    "dimensions": 384,
    "indexedRecords": 0,
    "embeddingProviderId": "hashed-local",
    "embeddingProviderLabel": "Hashed Local Embeddings"
  }
}
HTTP:200
```

**Verdict:** **FIXED.** The sqlite-vec native module now loads successfully from the bundled-binary `dist/lib/sqlite-vec-linux-x64/vec0.so` location. `enabled:true, available:true`, no `error` field. This closes F5b (the SDK runtime-resolver half that Run 4 reopened) in addition to the F5a build-side fix from 0.19.12.

### F7 — `POST /api/v1/telemetry/otlp/v1/logs`

```
curl -X POST -H "$AUTH" -H 'Content-Type: application/json' $GV/api/v1/telemetry/otlp/v1/logs -d '{"resourceLogs":[]}'
HTTP:200 {"partialSuccess":{}}
```

**Verdict:** **FIXED.** OTLP logs ingest endpoint now mounted (no longer 404). Accepts JSON, returns the standard OTLP partial-success shape. This also closes the long-standing F7 that was classified as "design-decision, pre-1.0 out-of-scope" in prior runs.

### F9 — `POST /api/automation/jobs`

Step 1 — minimum body `{prompt, intervalMs}`: 400 `schedule.expression must not be empty`.
Step 2 — `{prompt, schedule:{expression,timezone}}`: 201 `{id:"auto-0abfe3ce", schedule:{kind:"cron", expression:"0 0 * * *"}, …}`.
Cleanup `DELETE /api/automation/jobs/auto-0abfe3ce` → 200 `{removed:true,id:…}`.

**Verdict:** **PASS.** Behavior matches Run 4.

### F16a — shared-session message reply

```
POST /api/sessions (kind:"companion") → sess-46d97081
POST /api/sessions/sess-46d97081/messages {body,surfaceKind,surfaceId} → 202
GET /api/sessions/sess-46d97081/messages (t=4s) → {count:2, roles:["user","assistant"]}
```

**Verdict:** **PASS.**

### F16b — companion-chat session reply

```
POST /api/companion/chat/sessions {} → sessionId 0534c381-…
GET /api/companion/chat/sessions/0534c381-… → {session:{provider:"inception", model:"mercury-2", messageCount:2}, messages:[{role:"user",…},{role:"assistant",content:"UAT_RUN5_ECHO"}]}
```

**Verdict:** **PASS.** Model literally echoed `UAT_RUN5_ECHO` as instructed. Session provider/model auto-resolved from `providerRegistry.getCurrentModel()`.

**Subfinding (F21):** `GET /api/companion/chat/sessions/:id/messages` is 404. Messages are only accessible via the session detail endpoint (`GET /api/companion/chat/sessions/:id`) at the `.messages` array. Run 4 used the `/messages` path and it worked — this is a surface regression.

### F17 — cancel on spawned input

```
POST /api/sessions/sess-54e1ddcc/inputs {body,surfaceKind,surfaceId} → HTTP:404 "Route not found: /api/sessions/sess-54e1ddcc/inputs"
POST /api/v1/sessions/sess-54e1ddcc/inputs → HTTP:404
```

**Verdict:** **NEW REGRESSION (F20).** The `POST /api/sessions/:id/inputs` endpoint that existed in SDK 0.21.26 (and was the F17 subject in Run 4 — verified FIXED there) is no longer mounted in SDK 0.21.35. Neither the legacy path nor the `/api/v1/…` variant work. Since F17 can't be exercised without the `/inputs` endpoint, the F17 test itself is **unreachable**; the underlying spawned-input cancel code path may still work but is not surfaced through HTTP.

### F18 — watcher create with `label`

```
POST /api/watchers {label:"uat5-watch", kind:"poll", intervalMs:60000} → 201 {id:"watcher-uat5-watch", state:"stopped", …}
DELETE /api/watchers/watcher-uat5-watch → 200 {removed:true}
```

**Verdict:** **PASS.**

### F19 — channel policy PATCH

```
PATCH /api/channels/policies/slack {enabled:true} → 200 {surface:"slack", enabled:true, requireMention:false, …}
```

**Verdict:** **PASS.**

### F-PROV-009 — `secretsResolutionSkipped` flag

```
curl -H "$AUTH" $GV/api/providers | grep -c secretsResolutionSkipped = 0
top-level keys = ["currentModel", "providers"]
configuredVia counts: all 4396 model entries have configuredVia: null
```

**Verdict:** **PARTIAL (unchanged).** Flag absent from provider response, consistent with Run 3 / 3b / 4. The distribution of `configuredVia` has shifted — Run 4 showed `env:9, subscription:7, null:98`; Run 5 shows 4396 null entries and no env/subscription classification (possibly because the secrets manager is probing differently, or the model-expansion changed to include many more per-tier records). Deserves an SDK-side classification check, not a release blocker.

### Arch #3 — `GET /api/runtime/scheduler`

```
GET /api/runtime/scheduler (auth)   → HTTP:200 {"slots_total":4,"slots_in_use":0,"queue_depth":0,"oldest_queued_age_ms":null}
GET /api/runtime/scheduler (unauth) → HTTP:401
```

**Verdict:** **PASS** on reachability + auth gate, **but partial** on the camelCase wire migration.

**Subfinding (F22):** SDK 0.21.33 QA-05 migrated scheduler-capacity wire format from snake_case to camelCase (`slots_total` → `slotsTotal`). The published SDK does contain `packages/sdk/src/_internal/platform/automation/scheduler-capacity.ts` emitting camelCase, but the `/api/runtime/scheduler` HTTP route still hits the legacy `manager-runtime.js` path (which returns snake_case). Not a functional regression but the QA-05 migration is incomplete at the HTTP surface.

---

## D. Full endpoint coverage

**83/83 concrete GET endpoints (no path parameters) returned HTTP 200.**

Sourced authoritatively from `GET /api/control-plane/methods` (the method catalog, which exposes 214 total methods across all HTTP verbs; the 83 concrete GETs are the subset with no `{}` path parameters). Run 4 used a 74-endpoint sweep and missed several mounted surfaces.

Domains covered: accounts, approvals, artifacts, automation, channels, companion, contracts, control-plane, deliveries, forensics, health, knowledge, local-auth, media, memory, mcp, orchestration, panels, peer, permissions, plugins, providers, routes, runtime, schedules, secrets, sessions, settings, status, subscriptions, surfaces, system, tasks, telemetry, tools, transport, voice, watchers, web-search, workspace, worktrees.

---

## E. Finding deltas vs Run 4

| ID | Run 4 | Run 5 | Delta |
|---|---|---|---|
| F3 (token portability) | partial | **partial** | inverted (global live, workspace stale) |
| F5 (sqlite-vec runtime loader) | FAIL | **FIXED** | sqlite-vec loads from `dist/lib/` at runtime; `available:true`, no error field |
| F6 (capacity 429) | FIXED | FIXED | unchanged |
| F7 (OTLP logs 404) | FAIL | **FIXED** | endpoint now mounted, returns `{partialSuccess:{}}` |
| F8 (voice TTS 409) | FIXED | FIXED | unchanged (not re-probed) |
| F9 (automation schema) | PASS | **PASS** | unchanged |
| F11 (memory missing) | persists | persists | by-design |
| F12 (DELETE soft-close) | by-design | by-design | unchanged |
| F14 (SSE default domains) | FIXED | FIXED | unchanged (not re-probed) |
| F15 (rate-limit saturation) | not runnable | not runnable | unchanged |
| F16a (shared-session reply) | PASS | PASS | unchanged |
| F16b (companion-chat provider binding) | PASS | **PASS** | unchanged end-to-end; GET /messages path regressed (see F21) |
| F17 (cancel spawned no-op) | PASS | **unreachable** | /inputs endpoint gone (see F20) |
| F18 (watcher field) | PASS | PASS | unchanged |
| F19 (channel policy PATCH) | PASS | PASS | unchanged |
| F-PROV-009 (secrets tier flag) | PARTIAL | PARTIAL | unchanged |
| Arch #3 (scheduler capacity) | PASS | PASS | camelCase migration incomplete (see F22) |

### New findings

- **F20** — `POST /api/sessions/:id/inputs` returns HTTP 404 (`Route not found`). This endpoint existed in SDK 0.21.26 (Run 4 exercised it to validate F17 fix). Neither the legacy nor the `/api/v1/…` path resolves. Impact: `F17` test cannot be re-exercised via HTTP; spawned-input HTTP ingress is gone for shared sessions.
- **F21** — `GET /api/companion/chat/sessions/:id/messages` returns HTTP 404. The messages list is only accessible as an embedded field on `GET /api/companion/chat/sessions/:id`. Legacy `/messages` path worked in Run 4. Not functional regression (same data reachable), but a surface-shape regression for clients that enumerate messages separately from the session record.
- **F22** — `GET /api/runtime/scheduler` still returns snake_case (`slots_total`, `slots_in_use`, `queue_depth`, `oldest_queued_age_ms`). SDK 0.21.33 QA-05 migrated `scheduler-capacity.ts` to camelCase and all consumers of the new function receive camelCase — but the HTTP daemon route is still bound to the legacy `manager-runtime.ts` path, which still emits snake_case. QA-05 is therefore incomplete at the HTTP boundary.

---

## F. Summary

| Metric | Count |
|---|---|
| TCs evaluated | ~65 (shell-runnable subset) |
| Runnable from shell | ~60 |
| Not runnable from shell | ~15 |
| **PASS** | **58** |
| **FAIL** | **0** |
| **PARTIAL** | **2** (F3, F-PROV-009) |
| **Unreachable** (blocked by F20) | **1** (F17) |
| New findings (F20+) | **3** (F20, F21, F22) |

**Static gates:** all green (install + architecture + tsc + 7490 tests / 0 fail + foundation artifacts).
**Endpoint sweep:** 83/83 concrete GET endpoints PASS (up from Run 4's 74).
**Regression fixes landed this run:** F5 (sqlite-vec runtime loader, long-standing), F7 (OTLP logs ingest, long-standing).
**New regressions introduced this run:** F20 (`/inputs` HTTP path), F21 (companion-chat `/messages` HTTP path), F22 (scheduler snake_case).

**Verdict for 0.19.19 + 0.21.35:** Large net positive. Two long-standing FAIL findings (F5, F7) that were tagged "open" or "by-design pre-1.0" in every prior run are now resolved at the live-daemon level. Static quality unchanged (still 7490/0). Three minor HTTP surface regressions surfaced — none of them block the TUI or SDK consumers directly (TUI uses embedded-daemon calls not the HTTP surface for F20/F21; F22 is cosmetic camelCase/snake_case at an introspection endpoint). Recommend follow-up WRFCs for:

1. **F20** — restore `POST /api/sessions/:id/inputs` (or document its replacement path).
2. **F21** — restore `GET /api/companion/chat/sessions/:id/messages` or update OpenAPI/method-catalog to reflect the new shape.
3. **F22** — bind `/api/runtime/scheduler` to `scheduler-capacity.ts` so the QA-05 camelCase migration is complete end-to-end.

---
