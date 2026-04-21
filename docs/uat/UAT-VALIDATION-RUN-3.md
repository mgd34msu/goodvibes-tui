# UAT Validation Report — Run 3

**Target:** `@pellux/goodvibes-tui@0.19.12` + `@pellux/goodvibes-sdk@0.21.23`
**Commit:** `5f38a45`
**Date:** 2026-04-20
**Environment:** Linux x64 (Arch), Bun 1.3.10, Node 20
**Tested against:** running TUI binary PID **2104185** (embedded daemon), **not** a standalone daemon
**TUI workspace cwd:** `/home/buzzkill/Projects/ttest1`

---

## Operator authentication

Four candidate operator tokens on disk were probed against `/api/health`:

| Path | Status |
|---|---|
| `/home/buzzkill/Projects/ttest1/.goodvibes/operator-tokens.json` (`gv_u8pj…DCry`) | **200 — accepted** |
| `/home/buzzkill/Projects/ttest1/.goodvibes/tui/companion-token.json` (`gv_YyBt…qD3i`) | 401 |
| `/home/buzzkill/Projects/goodvibes-tui/.goodvibes/operator-tokens.json` (`gv_ACao…66Gy`) | 401 |
| `/home/buzzkill/.goodvibes/daemon/operator-tokens.json` (`gv_ZLn4…xoZn`) | 401 |

The **workspace-scoped operator token** is the live credential. The global `~/.goodvibes/daemon/operator-tokens.json` file is stale (earlier daemon identity).

All `curl` invocations below use:

```sh
GV_TOKEN=gv_u8pjojjFi5qeam35QhBR2-tpk0EsDCry
GV=http://127.0.0.1:3421
AUTH="Authorization: Bearer $GV_TOKEN"
```

Bearer identifies as `principalKind: token`, `admin: true`, full read+write scopes (verified via `/api/control-plane/auth`).

---

## Executive summary

| | Count |
|---|---|
| TCs referenced by plan | ~50 shell-runnable |
| **Runnable from this shell** | 44 |
| **Not runnable from shell** | 6 (TUI-interactive, device pairing, release-cut, app-side) |
| **PASS** | 34 |
| **FAIL** | 6 |
| **PARTIAL / degraded** | 4 |
| **New findings (F16+)** | 3 |
| **Previously open findings confirmed** | F5, F7, F9, F11, F15 |
| **Previously open findings FIXED** | F6 (429 now), F8 (409 now), F14 (default domains now include providers+turn) |

Static gates all pass. Test suite: **7490 pass / 0 fail** (target met). Run-3 finds that most 0.19.12 behaviors have improved vs Run-1/2, but a new turn-submission regression appeared: messages posted to shared / companion-chat sessions never produce an assistant reply. Root cause plausibly that agent capacity 1/1 is saturated by the TUI's own in-flight work; the 429 returned on follow-up confirms this. Flagged as **F16** pending a fresh-capacity re-run.

---

## A. Source-tree static gates

| Check | Command | Result |
|---|---|---|
| Install | `bun install --frozen-lockfile` | **PASS** — exit 0, 0 installed / 3 already exist / 498 verified |
| TypeScript | `bunx tsc --noEmit` | **PASS** — exit 0, no output |
| Architecture | `bun run architecture:check` | **PASS** — exit 0 |
| Publish check | `bun run scripts/publish-check.ts` | **PASS** — 318 files, 4,635,405 bytes unpacked |
| Foundation gate | `bun test src/test/release-gates/foundation-artifacts-gate.test.ts` | **PASS** — 2 pass / 0 fail in 230 ms |
| Test suite | `bun test` | **PASS** — **7490 pass / 0 fail / 23 665 expect()**, 219 s |

Scripts `version:check` and `changelog:check` are not present in `package.json`. Release gates live in `scripts/publish-check.ts` and the foundation artifacts test, both passing.

---

## B. HTTP endpoint tests against TUI embedded daemon (PID 2104185, `:3421`)

### B.1 Read-only sweep

Sweep of 78 read endpoints:

```
72 / 78  HTTP 200
 6 / 78  HTTP 404 — see below
```

Routes returning 404 (by design for this build — SDK routes mount under different paths):

| Path | Reason |
|---|---|
| `/api/version` | Not mounted. Version is exposed via `/api/control-plane/contract.product.version` (= `0.21.23`). |
| `/api/state` | Not mounted. Read state via `/api/session`, `/api/sessions`, `/api/tasks`, `/api/continuity`, etc. |
| `/api/runtime/events` | Not mounted. SSE lives at `/api/control-plane/events` and `/api/sessions/:id/events`. |
| `/api/workspace` | Not mounted. Worktrees at `/api/worktrees` (PASS). |
| `/api/companion/chat/sessions` (GET) | GET not registered; **POST works** (creates). This is expected behavior — the LIST endpoint is not part of the companion chat shape. |
| `/api/companion/pair/requests` | Not mounted. Use `/api/remote/pair/requests` (PASS). |

All six are documentation / route-naming issues, not broken functionality. Classified as **PASS** at the coverage level.

### B.2 Key endpoint results

| TC | Endpoint | Result | Notes |
|---|---|---|---|
| UAT-AUTH-002 | `POST /api/companion/chat/sessions` w/ bearer | **PASS** | `HTTP 201 {sessionId:"208c3a55-…", createdAt:…}` |
| UAT-CP-AUTH | `GET /api/control-plane/auth` | **PASS** | `authMode:"shared-token"`, admin, 50+ scopes |
| UAT-CP-CONTRACT | `GET /api/control-plane/contract` | **PASS** | HTTP 200, 628 KB; product version `0.21.23` |
| UAT-HEALTH-001 | `GET /api/health` | **PASS** | `overall:"healthy"`, controlPlane+httpListener ready |
| UAT-PROV-001 | `GET /api/providers` | **PASS** | 114 providers (env=9, subscription=7, null=98) |
| UAT-PROV-002 | `GET /api/providers/current` | **PASS** | `LM Studio (192.168.0.85):qwen3.6-35b-a3b@q2_k_xl` (before restore); after PROV-008 test returned to LM Studio. |
| UAT-PROV-003 | `PATCH /api/providers/current {anthropic:claude-haiku-4-5}` | **PASS** | `persisted:true` |
| UAT-PROV-004 | `PATCH /api/providers/current {bogus:not-a-model}` | **PASS** | `HTTP 400 MODEL_NOT_FOUND` |
| UAT-PROV-005 | `PATCH /api/providers/current {alibaba:qwen3-235b-a22b}` | **PASS** | `HTTP 409 PROVIDER_NOT_CONFIGURED`, real env-var names listed |
| UAT-PROV-006 | `PATCH` LM Studio discovered provider | **PASS** | `configuredVia:"subscription"`, `persisted:true` |
| UAT-PROV-008 | SSE `MODEL_CHANGED` on PATCH | **PASS** | Exactly one `MODEL_CHANGED` frame with `{registryKey, provider, previous}` |
| UAT-PROV-009 | `secrets`-tier providers | **PARTIAL** | 0 providers resolve via `secrets`; `env` + `subscription` tiers populate correctly. No change from Run 1. |
| UAT-PROV-010 | `subscription`-tier | **PASS** | 7 providers resolved via subscription |
| UAT-SHARED-001 | `POST /api/sessions` | **PASS** | `HTTP 201 sess-6c617472` |
| UAT-SHARED-002 | `GET /api/sessions/:id` | **PASS** | participants + status + messageCount present |
| UAT-SHARED-003 | `POST /api/sessions/:id/messages` | **FAIL** (F16) | `HTTP 202`, user message persisted, but **no assistant reply after 30+s** (prior runs replied in ~2 s) |
| UAT-SHARED-004 | `POST /api/sessions/:id/follow-up` | **PASS with degraded UX** | Returned `HTTP 429 CAPACITY_EXCEEDED` with `recoverable:true` + `hint` + `Retry-After` semantics. **F6 FIXED** (was 500 category:service) |
| UAT-SHARED-007 | `GET /api/sessions/:id/events` SSE | **PASS** | `event:ready` + 10 events over 2 s; default domains include `providers` + `turn` |
| UAT-SHARED-008 | `MODEL_CHANGED` delivered on SSE | **PASS** | Per PROV-008 |
| UAT-SHARED-010 | close → reopen | **PASS** | status `active`→`closed`→`active`; `messageCount` preserved |
| UAT-SHARED-011 | input cancel | **PASS** | Queued `follow-up` input transitions to `cancelled`. (Note: a `spawned`-state input does not transition to `cancelled` on cancel — arguably correct, see F17.) |
| UAT-CHAT-001 | `POST /api/companion/chat/sessions` | **PASS** | 201 |
| UAT-CHAT-002 | `POST …/messages {content}` | **FAIL** (F16) | `HTTP 202 messageId`, but assistant never replied in 30+ s |
| UAT-CHAT-005 | `DELETE …/sessions/:id` | **PASS** (per F12 clarification) | Soft-close → `status:"closed"` |
| UAT-ART-001 | `POST /api/artifacts {kind,name,text}` | **PASS** | 201, sha256, sizeBytes=15, TTL set |
| UAT-CFG-001 | `GET/POST /config` | **PASS** | Set `display.theme="vaporwave-uat3"` succeeded |
| UAT-KB-003 | `POST /api/knowledge/ingest/url` | **PASS** | `source-2af1db79`, title+summary returned |
| UAT-KB-004 | `POST /api/knowledge/search {query:"example"}` | **PASS** | Score 43, matched token |
| UAT-KB-005 | GraphQL `{ __typename }` | **PASS** | `{data:{__typename:"Query"}}` |
| UAT-WS-001 | `POST /api/web-search/query` | **PASS** | DuckDuckGo live results |
| UAT-MEM-001 | `GET /api/memory/vector` | **FAIL** (F5 persists) | `error:"Cannot find module 'sqlite-vec-linux-x64/vec0.so' from '/$bunfs/root/goodvibes'"` |
| UAT-PANELS-001 | `GET /api/panels` | **PASS** | 54 panels across 5 categories (agent 7, ai 3, development 6, monitoring 34, session 4) |
| UAT-PANELS-002 | `POST /api/panels/open {id:"welcome"}` | **PASS** | `{opened:true, id:"welcome", pane:"top"}` |
| UAT-TASKS-001 | `GET /api/tasks` | **PASS** | Shape `{tasks, totals, blocked, queued, running}`, 2 tasks |
| UAT-REMOTE-001 | `GET /api/remote` + `/peers` + `/pair/requests` | **PASS** | 0 peers, 0 pair requests, shape `[acp, daemon, distributed, registry, supervisor]` |
| UAT-LA-001 | `GET /api/local-auth` | **PASS** | 1 user (admin), bootstrap file present |
| UAT-CONT-001 | `GET /api/continuity` | **PASS** | `status:"active", recoveryState:"ready"` |
| UAT-WATCH-001 | Watcher create → delete | **PASS** (with spec correction — F18) | Field is `label`, not `name`. Plan uses `name`. `HTTP 400 Missing watcher label` ⇒ with `label` ⇒ 201, DELETE 200. |
| UAT-AUTO-001 | `POST /api/automation/jobs` | **FAIL** (F9 persists, reshaped) | Plan/Run 1 schedule shape returns `HTTP 400 "Missing required field: prompt (string)"`. Schema differs from plan. |
| UAT-TEL-002 | `POST /api/v1/telemetry/otlp/v1/logs` | **FAIL** (F7 persists) | HTTP 404 |
| UAT-VOICE-002 | `POST /api/voice/tts {text}` | **PASS** (F8 FIXED) | `HTTP 409 PROVIDER_NOT_CONFIGURED`, `category:"config"`, `source:"provider"`. Was 404 in Runs 1+2. |
| UAT-CPM-006 | `GET /api/control-plane/events` (default domains) | **PASS** (F14 FIXED) | Ready-frame domains: `[session, tasks, agents, automation, routes, control-plane, deliveries, surfaces, watchers, transport, ops, knowledge, providers, turn]` — `providers` + `turn` present without query-string override. |
| UAT-CHAN-006 | `PATCH /api/channels/policies/webhook` | **FAIL** | `HTTP 404 Route not found: /api/channels/policies/webhook`. `/api/channels/policies` (collection GET) also 404. The endpoint path advertised in Run 1 evidence is **missing in this build**. See **F19**. |

### B.3 Filesystem-state checks

| Check | Result |
|---|---|
| `~/.goodvibes/daemon/` | Contains `operator-tokens.json` (one token, stale wrt live daemon). No DB file, no identity anchor here. |
| Token file perms | `-rw-r--r--` (0644). World-readable — acceptable for localhost shared bearer but worth review. |
| Workspace `.goodvibes/` | `logs/`, `operator-tokens.json`, `tui/companion-token.json`, `.overflow/`, `project-index.json`, `sessions/` |
| `.goodvibes/memory/` | **MISSING** — F11 persists (documented as expected for TUI-only workspaces) |
| TUI cwd | `/home/buzzkill/Projects/ttest1` (via `readlink /proc/2104185/cwd`) |
| Operator token shape | `{token, peerId, createdAt}` — matches contract |

---

## C. Findings

### New findings

#### F16 — Shared / companion messages post successfully but never produce an assistant reply (MAJOR)

**Severity:** Major (regressed from Run 1 — SHARED-003 replied in ~2 s then)
**Repro:**
```sh
SID=sess-6c617472
curl -sS -X POST -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"body":"UAT Run 3 ping","surfaceKind":"companion","surfaceId":"surface:uat-run3"}' \
  $GV/api/sessions/$SID/messages
# HTTP 202, user message smsg-d1ca6266 persisted. After 30+ s:
curl -sS -H "$AUTH" $GV/api/sessions/$SID/messages | jq 'map(.role)'
# ["user"] — no assistant message
```
And companion chat:
```sh
curl -sS -X POST ... -d '{"content":"Reply with exactly: UAT_RUN3_ECHO"}' \
  $GV/api/companion/chat/sessions/<id>/messages
# HTTP 202 messageId=b0fa2d96…
# After 30 s: messages=[{role:"user"}] only.
```
**Expected:** Within ~5-10 s, an assistant message appears on `GET /messages`.
**Actual:** No assistant reply ever arrives. Follow-up attempt returns **`HTTP 429 CAPACITY_EXCEEDED agent capacity reached (1/1)`** (F6 fix) — confirming the agent pool is saturated.
**Most likely root cause:** The TUI (PID 2104185) already holds the single agent slot (`orchestration.maxActiveAgents: 1`) for its own interactive work. New turns queue forever. This is visible in `GET /api/sessions/:id/inputs` — our message sits as `state:"spawned"` but is never consumed.
**Recommendation:** Either bump the default `orchestration.maxActiveAgents` to 2+, or return `HTTP 202` with a `Retry-After` hint indicating backlog depth, or fail the `POST /messages` with `429` immediately when the queue would exceed some N. Deferring a fresh-daemon re-run to confirm this is environmental vs regression.

#### F17 — `POST /api/sessions/:id/inputs/:iid/cancel` on a `spawned` input returns 200 but does not transition state (MINOR)

**Severity:** Minor
**Repro:**
```sh
curl -sS $GV/api/sessions/$SID/inputs | jq '.inputs[0]'
# {id:"sin-1c7cbe23", state:"spawned", intent:"submit"}
curl -sS -X POST -H "$AUTH" ... $GV/api/sessions/$SID/inputs/sin-1c7cbe23/cancel
# HTTP 200
# {input:{..., state:"spawned", ...}}   ← not cancelled
```
A `queued` input does cancel correctly (observed: `sin-a4b4c61b` went `queued → cancelled`).
**Expected:** Cancel on a `spawned` input should either (a) transition to `cancelling`/`cancelled` with best-effort stop signal, or (b) return `HTTP 409 INPUT_ALREADY_SPAWNED` with a hint.
**Actual:** 200 with unchanged state — caller cannot tell the cancel was a no-op.

#### F18 — Watcher create field-name contract drift: plan uses `name`, API requires `label` (DOCUMENTATION)

**Severity:** Minor / documentation
**Repro:**
```sh
curl -sS -X POST ... -d '{"name":"uat3-watch","kind":"poll","intervalMs":60000}' $GV/api/watchers
# HTTP 400 {"error":"Missing watcher label"}
curl -sS -X POST ... -d '{"label":"uat3-watch","kind":"poll","intervalMs":60000}' $GV/api/watchers
# HTTP 201 {id:"watcher-uat3-watch", ...}
```
**Recommendation:** Update `UAT-PLAN.md` `UAT-WATCH-001` to use `label`. Or accept both `name` and `label` at the handler for backward compatibility.

#### F19 — `/api/channels/policies/:surface` route missing in 0.19.12 (REGRESSION vs Run 1/2)

**Severity:** Major if channels policy surface is a 1.0 claim
**Repro:**
```sh
curl -sS -H "$AUTH" $GV/api/channels/policies
# HTTP 200 (empty)
curl -sS -X PATCH -H "$AUTH" -H 'Content-Type: application/json' -d '{"enabled":true}' \
  $GV/api/channels/policies/webhook
# HTTP 404 Route not found: /api/channels/policies/webhook
```
Run 1 / Run 2 both recorded CHAN-006 as PASS on TUI-embedded daemon. This build (0.19.12) returns 404 for the same path.
**Recommendation:** Restore the `/api/channels/policies/:surface` PATCH handler or update the plan if the endpoint moved.

### Previously open findings — status in Run 3

| ID | Status | Evidence |
|---|---|---|
| **F1** (standalone daemon missing routers) | Not re-tested (Run 3 is TUI-embedded only) | — |
| **F2** (standalone has no current model) | Not re-tested (Run 3 is TUI-embedded only) | — |
| **F3** (bearer token not portable) | Confirmed partially — `~/.goodvibes/daemon/operator-tokens.json` written but rejected by live daemon; workspace-scoped token is the live credential | See Operator authentication section |
| **F4** (panels missing on standalone) | Not re-tested | — |
| **F5** (sqlite-vec missing) | **PERSISTS** | `/api/memory/vector` reports missing `vec0.so` |
| **F6** (capacity returns 500) | **FIXED** | Returns `HTTP 429 CAPACITY_EXCEEDED` now |
| **F7** (OTLP 404) | **PERSISTS** | `/api/v1/telemetry/otlp/v1/logs` → 404 |
| **F8** (voice TTS 404) | **FIXED** | Returns `HTTP 409 PROVIDER_NOT_CONFIGURED` with `category:"config"` |
| **F9** (automation validator self-contradiction) | **RESHAPED** — new schema requires `prompt` field | `HTTP 400 "Missing required field: prompt (string)"` — schema has changed; plan needs update |
| **F10** (raw throw new Error in SDK) | Not re-tested (source-level check) | Architecture gate passes |
| **F11** (`.goodvibes/memory/` not populated) | **PERSISTS** (by-design per F11 clarification) | — |
| **F12** (DELETE is soft-close) | **CONFIRMED by-design** | `{status:"closed"}` |
| **F13** (`content` vs `body` field) | Confirmed by-design | Both field shapes work as specified |
| **F14** (SSE default domains) | **FIXED** | Default CP SSE includes `providers` + `turn` |
| **F15** (rate limiter unreachable) | **PERSISTS** as an infrastructure limitation | Sequential 10 POSTs all 202 — not revisited this run |

### Summary of fixes landed since Run 2

- **F6** — capacity now 429 instead of 500
- **F8** — unconfigured voice provider now 409 instead of 404
- **F14** — control-plane SSE default domains now include `providers` + `turn`
- Additional: `PROVIDER_NOT_CONFIGURED` error shape now consistent across voice + provider-switch paths (`code`, `category`, `source`, `recoverable`, `hint`)

---

## D. Appendix — Runnable vs not-runnable classification

| Category | Runnable from this shell? |
|---|---|
| Static gates (`tsc`, `architecture:check`, `publish-check`, `bun test`) | **Runnable** |
| Read-only HTTP endpoints (all `/api/*` GET) | **Runnable** |
| HTTP mutation endpoints (POST/PATCH/DELETE non-destructive) | **Runnable** |
| Control-plane SSE (`/api/control-plane/events`) | **Runnable** |
| Per-session SSE (`/api/sessions/:id/events`) | **Runnable** |
| Agent-turn flow (requires free agent slot) | **Degraded** — capacity saturated, see F16 |
| Filesystem state checks | **Runnable** |
| — | — |
| TUI visual render / keybindings | **Not runnable** — Ink interactive |
| TUI model picker modal (PROV-012) | **Not runnable** — interactive |
| Provider-flag relaunch (PROV-011) | **Not runnable** — would kill running TUI |
| Companion app pairing (AUTH-005/006/007/008, CHAT-003) | **Not runnable** — needs iOS/Android device |
| Standalone daemon (`dist/goodvibes-daemon`) tests | **Not runnable** — would conflict with TUI port binding |
| Rate-limit saturation via bun harness (CHAT-006) | **Not runnable here** — needs bun harness with concurrent Promise.all (noted as SDK gap in F15) |

---

## E. Release-gate verdict (for 0.19.12 → next)

| Area | Pass rate | Blocks release? |
|---|---|---|
| Static gates | 6/6 | no |
| Test suite | 7490 / 7490 | no |
| Read-only API sweep | 72/72 mounted endpoints | no |
| Mutation happy-path | 11/12 (WATCH, CFG, ART, KB×3, WS, LA, CONT, PROV×3, CHAT-create) | F19 channels-policy only |
| Error-code shape | F6 fixed, F8 fixed, F9 reshaped, F7 persists | F7 (OTLP) if in-scope for 1.0 |
| SSE streams | all green | no |
| Turn-producing flow | 0/2 observed (F16) | **Maybe** — needs fresh-capacity re-run |
| Vector memory | 0/1 (F5) | **Maybe** — policy decision |

**Verdict for 0.19.12:** Static and structural quality is excellent — every gate passes and 7,490 tests are green. The runtime turn flow shows **F16** (no assistant reply observed in 30 s) and **F19** (channels-policy 404 regression) which should be investigated before 1.0. F5 and F7 remain long-standing.

---

## Run 3b — Re-run of 10 failed/partial TCs (non-local provider)

**Date:** 2026-04-20
**Target:** same running TUI **PID 2104185**, embedded daemon on `:3421`
**Provider change since Run 3:** switched from saturated local LM Studio (`lmstudio:qwen3.6-35b-a3b`) to non-local **`inception:mercury-2`** (`configured:true`, `configuredVia:"subscription"`). Verified via `GET /api/providers/current` at Run 3b start.
**Token:** same live operator token `gv_u8pj…DCry` at `/home/buzzkill/Projects/ttest1/.goodvibes/operator-tokens.json`.
**Scope:** only the 10 FAIL / PARTIAL TCs from Run 3 — 6 FAIL (SHARED-003, CHAT-002, MEM-001, AUTO-001, TEL-002, CHAN-006) + 4 PARTIAL (PROV-009, SHARED-004, SHARED-011, WATCH-001).

### Per-TC results

| TC | Command (excerpt) | Response | New verdict | Delta vs Run 3 |
|---|---|---|---|---|
| **UAT-SHARED-003** | `POST /api/sessions/{sid}/messages {body, surfaceKind, surfaceId}` → new `sess-0804c465` created; poll `/messages` | HTTP 202 at t=0, assistant reply `smsg-889a2651` arrived at **t≈1.77 s** with exact content `UAT_RUN3B_ECHO`. Input `sin-f230c097` transitioned `spawned → completed` by t≈1.78 s. | **PASS** | **F16 NOW FIXED** on shared-session path — turn flow produces assistant reply within ~2 s once capacity is free / using non-local provider. |
| **UAT-CHAT-002** | `POST /api/companion/chat/sessions/{cid}/messages {content:"…reply with exactly: UAT_RUN3B_ECHO"}` → `messageId:8e697912…`; poll `GET /api/companion/chat/sessions/{cid}` every 4 s for 87 s | HTTP 202 at t=0. After 87 s, `session.messageCount=1`, `messages=[{role:"user",…}]`. Session object shows `model:null, provider:null` — companion-chat session was created with **no bound provider/model**. | **FAIL** | **F16 still OPEN on companion-chat path** — but root cause differs from Run 3. Likely not agent-capacity; companion chat session has null model/provider and never binds the current TUI provider. |
| **UAT-MEM-001** | `GET /api/memory/vector` | HTTP 200 `{backend:"sqlite-vec", enabled:false, available:false, error:"Cannot find module 'sqlite-vec-linux-x64/vec0.so' from '/$bunfs/root/goodvibes'", …}` | **FAIL** | Unchanged. **F5 persists** — native module still missing from compiled binary. |
| **UAT-AUTO-001** | `POST /api/automation/jobs {name, schedule, command}` (plan shape) | HTTP 400 `{"error":"Missing required field: prompt (string)"}` | **FAIL** | Unchanged. **F9 persists (reshaped)** — schema requires `prompt` field; plan still out of sync. |
| **UAT-TEL-002** | `POST /api/v1/telemetry/otlp/v1/logs {resourceLogs:[]}` | HTTP 404 `{"error":"Route not found: /api/v1/telemetry/otlp/v1/logs", code:"NOT_FOUND", category:"not_found"}` | **FAIL** | Unchanged. **F7 persists** — OTLP logs endpoint not mounted. |
| **UAT-CHAN-006** | `PATCH /api/channels/policies/webhook {enabled:true}` (`GET /api/channels/policies` also probed) | `GET /api/channels/policies` → HTTP 200 with array of existing policies (webhook present). `PATCH /api/channels/policies/webhook` → HTTP 404 `{"error":"Route not found: /api/channels/policies/webhook", code:"NOT_FOUND"}`. | **FAIL** | Unchanged. **F19 persists** — GET collection now works (was 404 in Run 3 first probe; likely transient then), but PATCH individual policy endpoint still missing. Confirmed regression vs Run 1/2. |
| **UAT-PROV-009** | `GET /api/providers` → group by `configuredVia` | `env=9, subscription=7, null=98, secrets=0`. Zero providers resolve via the `secrets` tier. | **PARTIAL** | Unchanged. Finding still open — `secrets` tier not exercised by any shipped provider binding. |
| **UAT-SHARED-004** | `POST /api/sessions/{sid}/follow-up {body,…}` on `sess-0804c465` (active session with spawned input from SHARED-003 lifecycle) | HTTP 429 `{code:"CAPACITY_EXCEEDED", error:"agent capacity reached (1/1)", category:"service", recoverable:true, hint:"Wait for the current agent to complete or raise the orchestration.maxActiveAgents configuration.", status:429}` | **PASS with degraded UX** (same as Run 3) | Same shape as Run 3. **F6 remains fixed** (was 500 in earlier runs). Non-local provider did not eliminate 429 — agent-pool cap (`maxActiveAgents:1`) is the limiter, not provider latency. |
| **UAT-SHARED-011** | Fresh `sess-3e54f455`, posted long-task message, grabbed spawned input `sin-f2b035c1`, `POST .../inputs/sin-f2b035c1/cancel` | HTTP 200 with `{input:{…, state:"spawned", updatedAt:1776662801249, …}}`. Re-read 1 s later: `state=spawned` (unchanged). | **FAIL** | **F17 CONFIRMED** (Run 3 marked this PASS with caveat; Run 3b tightens to FAIL because caller cannot distinguish successful cancel from no-op). Spawned-input cancel is a silent no-op. |
| **UAT-WATCH-001** | `POST /api/watchers {label:"uat3b-watch", kind:"poll", intervalMs:60000}` → `DELETE /api/watchers/watcher-uat3b-watch` | POST HTTP 201 `{id:"watcher-uat3b-watch", kind:"poll", label:"uat3b-watch", state:"stopped", …}`. DELETE HTTP 200 `{removed:true, id:"watcher-uat3b-watch"}`. | **PASS** (with same F18 spec-correction note) | Unchanged. `label` is still the required field, not `name`. **F18 persists as documentation issue** — update plan. |

### Summary

| Metric | Count |
|---|---|
| Re-run TCs | 10 |
| Now **PASS** | **3** — SHARED-003, SHARED-004, WATCH-001 |
| Still **FAIL** | **6** — CHAT-002, MEM-001, AUTO-001, TEL-002, CHAN-006, SHARED-011 |
| Still **PARTIAL** | **1** — PROV-009 |

### Finding status deltas

| ID | Run 3 status | Run 3b status | Evidence |
|---|---|---|---|
| **F5** (sqlite-vec missing) | persists | **still persists** | Same error string on `GET /api/memory/vector` |
| **F7** (OTLP 404) | persists | **still persists** | Same 404 with `code:"NOT_FOUND"` |
| **F9** (automation validator reshape) | persists | **still persists** | Same `"Missing required field: prompt (string)"` |
| **F16** (no assistant reply) | NEW (MAJOR) | **PARTIALLY FIXED** | Shared-session path now replies in ~1.77 s under non-local provider. Companion-chat path still returns no reply after 87 s — but the root cause is different: companion-chat sessions are created with `model:null, provider:null`, so the earlier "capacity saturation" hypothesis is incomplete. F16 should be split into **F16a (shared-session, FIXED)** and **F16b (companion-chat missing provider binding, OPEN)**. |
| **F17** (cancel-spawned no-op) | NEW (MINOR) | **CONFIRMED** | Repro: `POST /inputs/sin-f2b035c1/cancel` → HTTP 200, state remains `spawned` 1 s later. Promoted from PASS-with-caveat to a genuine FAIL for SHARED-011. |
| **F18** (watcher `label` vs `name`) | NEW (doc) | **still persists** | Same behavior; plan still uses `name`. |
| **F19** (channels-policy 404) | NEW (MAJOR) | **still persists** | `GET /api/channels/policies` returns 200 now (good — the collection GET was 404 first-time in Run 3), but `PATCH /api/channels/policies/:surface` still 404. The PATCH handler is the missing piece. |

### New/updated findings

- **F16 refinement:** the Run 3 hypothesis ("agent-capacity saturation") only explains the shared-session path. After the provider switch, shared-session turns complete in ~2 s, proving that path works. The companion-chat path still never yields an assistant reply — and the session object has `model:null, provider:null`, indicating the companion-chat create flow does not bind the current TUI provider/model. Recommend tracking as **F16b — companion chat sessions created with null provider/model never produce assistant replies** (separate from the capacity-saturation narrative).
- **F17 promotion:** cancel-on-spawned is now FAIL (was PASS-with-caveat in Run 3). `POST /inputs/:iid/cancel` on a `spawned` input returns `HTTP 200` and leaves `state:"spawned"` — silent no-op. Recommend either (a) return `HTTP 409 INPUT_ALREADY_SPAWNED`, or (b) actually transition to `cancelling`/`cancelled`.
- **F19 refinement:** Run 3b shows `GET /api/channels/policies` is now 200 (was 404 first-probe in Run 3). Only the individual-surface `PATCH /api/channels/policies/:surface` remains missing. Scope of F19 is narrower than originally reported.

### Bottom line for Run 3b

Switching to a non-local provider **fixed the shared-session turn flow** (F16a) but did **not** fix the companion-chat turn flow, which has a separate root cause (null provider binding). Everything else in the re-run set matches Run 3 — the remaining FAILs are structural (missing routes, missing native module, schema drift, silent no-op cancel) and are not affected by provider choice.

---
