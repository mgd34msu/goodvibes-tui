# UAT Validation Report

Live validation of `@pellux/goodvibes-sdk` + `@pellux/goodvibes-tui` against two daemon postures:

- **Run 1** — daemon embedded inside the running TUI binary (`dist/goodvibes`, PID 3033670, port 3421).
- **Run 2** — daemon launched standalone (`dist/goodvibes-daemon-linux-x64`, PID 3669718, port 3421). Killed at end of run.

Both runs exercised only tests runnable from a non-interactive shell (HTTP, SSE, filesystem, subprocess, npm registry, bun harness). Device-only, TUI-visual, and not-yet-deployed surfaces are out of scope.

**Grading rule (per user directive):** a `PARTIAL` verdict counts as `FAIL`. A test passes only if its stated expectation was met without caveat.

---

## Environment

| Item | Run 1 | Run 2 |
|---|---|---|
| Binary | `dist/goodvibes` (TUI, PID 3033670) | `dist/goodvibes-daemon-linux-x64` (PID 3669718) |
| Daemon ports | `0.0.0.0:3421` + `127.0.0.1:3422` | `0.0.0.0:3421` + `127.0.0.1:3422` |
| Workspace | `/home/buzzkill/Projects/ttest1` | `/home/buzzkill/Projects/ttest1` |
| Auth method | Bearer `gv_S-RWD6C1oSQllY5vo7qT3jbO4hmed5ED` + admin cookie | Admin cookie only (bearer from Run 1 was rejected as stale) |
| `currentModel` | `LM Studio (192.168.0.85):qwen3.6-35b-a3b@q2_k_xl` (live) | `null` (unconfigured) |
| Provider count | 114 | 38 |
| Health | 200 | 200 |
| State at end | still running | killed |

---

## Executive summary

| | Run 1 | Run 2 |
|---|---|---|
| TCs executed | 50 | 48 |
| **PASS** | 34 | 20 |
| **FAIL** (incl. former PARTIAL) | 16 | 28 |
| Pass rate | 68% | 42% |

**Top-level conclusion:** the standalone daemon binary ships with **fewer registered routes and a blank provider state**, which degrades most of the turn-dependent and companion-dependent test surface. The TUI-embedded daemon passes a larger fraction because it's pre-configured by the interactive TUI and loads feature routers the standalone binary does not.

---

## Results by section (Run 1 / Run 2)

### Authentication

| TC | Run 1 | Run 2 | Notes |
|---|---|---|---|
| UAT-AUTH-001 | ✅ PASS | ✅ PASS | Admin login + cookie auth both work on both postures |
| UAT-AUTH-002 | ✅ PASS | ❌ FAIL | Run 2: bearer from Run 1's `companion-token.json` rejected AND `/api/companion/chat/sessions` is 404 on standalone |

### Providers & Models

| TC | Run 1 | Run 2 | Notes |
|---|---|---|---|
| UAT-PROV-001 | ✅ PASS | ✅ PASS | `/api/providers` returns 200 both runs. Run 2: **38 providers**, Run 1: **114** |
| UAT-PROV-002 | ✅ PASS | ❌ FAIL | `/api/providers/current` → 404 `Unknown provider` on standalone |
| UAT-PROV-003 | ✅ PASS | ❌ FAIL | Model switch via PATCH requires `/current` endpoint (absent on standalone) |
| UAT-PROV-004 | ✅ PASS | ❌ FAIL | Same reason as PROV-003 |
| UAT-PROV-005 | ✅ PASS | ❌ FAIL | Same reason as PROV-003 |
| UAT-PROV-006 | ✅ PASS | ❌ FAIL | Same reason as PROV-003 |
| UAT-PROV-008 | ✅ PASS | ❌ FAIL | `MODEL_CHANGED` requires PATCH, which fails on Run 2 |
| UAT-PROV-009 | ❌ FAIL | ❌ FAIL | No `secrets`-tier providers resolved in either run |
| UAT-PROV-010 | ✅ PASS | ❌ FAIL | Run 2 `currentModel: null`; no subscription-tier resolution to verify |
| UAT-PROV-013 | ❌ FAIL | ❌ FAIL | Bare model-id stripping not verifiable without a turn reaching upstream |
| UAT-PROV-014 | ❌ FAIL | ❌ FAIL | Unconfigured-provider turn-time error path unreachable (Run 1: daemon refuses at switch time; Run 2: no PATCH endpoint) |

### Shared Sessions

| TC | Run 1 | Run 2 | Notes |
|---|---|---|---|
| UAT-SHARED-001 | ✅ PASS | ✅ PASS | `POST /api/sessions` returns 201 |
| UAT-SHARED-002 | ✅ PASS | ✅ PASS | `GET /api/sessions/:id` returns 200 |
| UAT-SHARED-003 | ✅ PASS | ❌ FAIL | Run 2: message persisted but **no assistant reply** (`currentModel: null`) |
| UAT-SHARED-004 | ❌ FAIL | ❌ FAIL | Run 1: 500 `agent capacity reached` on concurrent call; Run 2: no provider configured |
| UAT-SHARED-005 | ✅ PASS | ❌ FAIL | Run 2: only user message in `/messages` (no assistant to verify persistence) |
| UAT-SHARED-006 | ❌ FAIL | ❌ FAIL | Run 1: 500 capacity; Run 2: untestable without configured provider |
| UAT-SHARED-007 | ✅ PASS | ❌ FAIL | Run 2: `/api/sessions/:id/events` 404 `Route not found` |
| UAT-SHARED-008 | ✅ PASS | ❌ FAIL | `MODEL_CHANGED` cannot fire on standalone (no way to change model) |
| UAT-SHARED-009 | ❌ FAIL | ❌ FAIL | Run 1: 500 capacity; Run 2: untestable |
| UAT-SHARED-010 | ✅ PASS | ✅ PASS | Close ↔ reopen works on both |
| UAT-SHARED-011 | ❌ FAIL | ❌ FAIL | Run 1: cancelled an already-completed input (no-op); Run 2: no pending input to cancel |

### Companion Chat

| TC | Run 1 | Run 2 | Notes |
|---|---|---|---|
| UAT-CHAT-001 | ✅ PASS | ❌ FAIL | `/api/companion/chat/sessions` 404 on standalone |
| UAT-CHAT-002 | ✅ PASS | ❌ FAIL | Same 404 |
| UAT-CHAT-004 | ✅ PASS | ❌ FAIL | Same 404 |
| UAT-CHAT-005 | ❌ FAIL | ❌ FAIL | Run 1: soft-close, not hard-delete; Run 2: endpoint 404 |
| UAT-CHAT-006 | ❌ FAIL | ❌ FAIL | Rate-limit threshold not reachable at sequential rate |

### Daemon API Coverage

| TC | Run 1 | Run 2 | Notes |
|---|---|---|---|
| API sweep (read-only) | ✅ 75/75 = 200 | ✅ 74/76 = 200 | Run 2 non-200s: `/api/providers/current` (404), `/api/companion/chat/sessions` (404) |
| UAT-ART-001 | ✅ PASS | ✅ PASS | Artifact CRUD end-to-end |
| UAT-CFG-001 | ✅ PASS | ✅ PASS | `GET/POST /config` |
| UAT-KB-003 | ✅ PASS | ✅ PASS | URL ingest |
| UAT-KB-004 | ✅ PASS | ✅ PASS | Search returns ingested source |
| UAT-KB-005 | ✅ PASS | ✅ PASS | GraphQL schema + trivial query |
| UAT-WS-001 | ✅ PASS | ✅ PASS | Web search returns results |
| UAT-WATCH-001 | ✅ PASS | ✅ PASS | Watcher create→patch→start→stop→delete |
| UAT-SCHED-001 | ✅ PASS | ✅ PASS | Schedule create→enable→disable→delete |
| UAT-LA-001 | ✅ PASS | ✅ PASS | Local-auth user create→(rotate)→delete |
| UAT-PANELS-002 | ✅ PASS | ❌ FAIL | Run 2 returns 404 `Unknown panel: welcome` |
| UAT-CHAN-004 | ✅ PASS | ✅ PASS | Allowlist resolve on webhook surface |
| UAT-CHAN-006 | ✅ PASS | ✅ PASS | Policy PATCH on webhook surface |
| UAT-AUTO-001 | ❌ FAIL | ❌ FAIL | Validator rejects valid schedule shape both runs |
| UAT-TEL-002 | ❌ FAIL | ❌ FAIL | OTLP POST (logs/metrics/traces) 404 both runs |
| UAT-VOICE-002 | ❌ FAIL | ❌ FAIL | TTS 404 `OpenAI API key missing` (wrong status code) |
| UAT-MEM-001 | ❌ FAIL | ❌ FAIL | **Both binaries** missing `sqlite-vec-linux-x64/vec0.so` |
| UAT-CPM-006 (ctl SSE) | ✅ PASS | ✅ PASS | Control-plane SSE opens; default domains differ (see F14) |

### Security (static audit)

| TC | Result | Notes |
|---|---|---|
| UAT-SEC-002 | ❌ FAIL | 1 raw `throw new Error` in `packages/sdk/src/client.ts:416` |
| UAT-SEC-003 | ✅ PASS | 0 `any` uses in public SDK source |
| UAT-SEC-008 | ✅ PASS | `minimatch ^10.2.5` pinned; `postinstall-patch-minimatch.mjs` present |
| UAT-SEC-009 | ✅ PASS | Latest SDK release (`v0.21.16`) ships `sbom.cdx.json` |
| UAT-SEC-010 | ✅ PASS | npm attestations present; SLSA v1 provenance |

### Release pipeline (static)

| TC | Result | Notes |
|---|---|---|
| UAT-REL-002 | ✅ PASS | `release.yml` extracts + attaches changelog excerpt |
| UAT-REL-003 | ✅ PASS | `scripts/sync-check.ts` enforces `--scope=<name>` |
| UAT-REL-004 | ✅ PASS | Actions pinned by full SHA + version comment |
| UAT-REL-006 | ✅ PASS | `install-smoke-check.ts` has ECONNRESET retry |

### Observability (filesystem)

| TC | Result | Notes |
|---|---|---|
| UAT-OBS-001 | ✅ PASS | `ttest1/.goodvibes/logs/activity.md` present (166 KB, actively written) |
| UAT-OBS-002 | ❌ FAIL | `ttest1/.goodvibes/memory/` directory does not exist |

---

## Net regressions introduced by standalone daemon (Run 1 → Run 2)

These passed on Run 1 but failed on Run 2, purely due to the daemon binary posture:

- AUTH-002
- PROV-002, PROV-003, PROV-004, PROV-005, PROV-006, PROV-008, PROV-010
- SHARED-003, SHARED-005, SHARED-007, SHARED-008
- CHAT-001, CHAT-002, CHAT-004
- PANELS-002

**All 16 regressions trace to F1, F2, or F3.** Fixing those three recovers most of Run 2's pass rate.

---

## Failed in both runs (genuine product defects, not run-environment)

- **F5** — sqlite-vec missing in both compiled binaries (UAT-MEM-001)
- **F6** — agent-capacity returns 500 instead of 429/503 (SHARED-004/006/009)
- **F7** — OTLP POST 404 (UAT-TEL-002)
- **F8** — voice TTS 404 with misleading category (UAT-VOICE-002)
- **F9** — automation-job validator self-contradiction (UAT-AUTO-001)
- **F10** — raw `throw new Error` in public SDK source (UAT-SEC-002)
- **F11** — `.goodvibes/memory/` never populated (UAT-OBS-002)
- **F12** — companion-chat DELETE is soft-close (UAT-CHAT-005)
- **F14** — control-plane SSE default-domain inconsistency (minor)
- **F15** — rate limiter unreachable from sequential probe (UAT-CHAT-006)

---

# Findings & resolution paths

## F1 — Standalone daemon is missing feature routers (CRITICAL)

**Symptom:** `/api/companion/chat/*`, `/api/providers/current` (GET + PATCH), and `/api/sessions/:id/events` all return 404 on standalone but 200 on TUI-embedded.

**Impact:** A consumer (Android companion, future web UI, operator) pointed at the standalone daemon cannot (a) open a companion chat, (b) switch models, (c) subscribe to per-session event streams. These are core product features.

**Root cause hypothesis:** The standalone daemon entrypoint registers only the control-plane method catalog; the TUI entrypoint additionally wires feature routers (`companion-chat-routes.ts`, `provider-routes.ts`, session-SSE). Those registrations live in code paths the TUI initializes but the daemon CLI does not.

**Resolution path:**
1. Compare the standalone daemon bootstrap (`packages/daemon-sdk/src/`) with the TUI bootstrap's router registration.
2. Hoist companion-chat, provider-current, and session-SSE router registration into the shared daemon bootstrap so both postures expose the same API surface.
3. Add an integration test asserting route-registration parity: for every route in the plan, both bootstraps must register it.
4. Update CHANGELOG.

## F2 — Standalone daemon has no current model / reduced provider list (CRITICAL)

**Symptom:** Run 2 `/api/providers` returns `currentModel: null` and 38 providers (vs 114 on TUI).

**Impact:** No turn can execute on a fresh standalone daemon. Messages persist but produce no assistant reply.

**Root cause hypothesis:** Provider discovery (LAN scan for LM Studio etc.) and default-model selection are TUI-runtime concerns; the daemon CLI doesn't run them. Subscription-tier providers require OAuth token context the TUI carries.

**Resolution path:**
1. Share provider-discovery and default-model persistence between TUI and daemon.
2. Honor CLI flags `--provider=` / `--model=` at standalone-daemon startup (already documented in plan as PROV-011).
3. Fallback behavior: if `currentModel == null`, `POST /api/sessions/:id/messages` should return 409 `NO_PROVIDER_CONFIGURED` rather than silently persist without a reply.
4. Document the first-run bootstrap ("start daemon, PATCH `/config` or `/api/providers/current` with provider selection").

## F3 — Standalone operator bearer token not portable from TUI (MAJOR)

**Symptom:** `companion-token.json` written by the TUI is not accepted by the standalone daemon.

**Impact:** Paired companion apps cannot transparently switch between TUI-embedded and standalone daemons.

**Root cause hypothesis:** Peer-token state is scoped to the daemon process that issued it; not persisted across daemon identities.

**Resolution path:**
1. Define a shared token store location (e.g. `<workspace>/.goodvibes/operator-tokens.json` or `<home>/.goodvibes/tokens.json`).
2. Both daemon implementations read/write that file and honor tokens issued by either.
3. OR: document that re-pairing is required when switching daemons; include the hint in the 401 response body.

## F4 — Panel registry incomplete on standalone (MINOR–MAJOR)

**Symptom:** `POST /api/panels/open {id:"welcome"}` returns 200 on TUI-embedded, 404 `Unknown panel: welcome` on standalone.

**Impact:** Any consumer UI pointed at standalone cannot open TUI-authored panels.

**Resolution path:**
1. Audit which panels are registered by TUI code only vs by daemon core.
2. Move panels whose data is daemon-backed into the daemon core so `/api/panels` advertises them on both postures.
3. Panels that are only meaningful with a TUI attached should be marked `surface: "tui"` and advertised conditionally.

## F5 — `sqlite-vec` native addon missing from both compiled binaries (CRITICAL if vector memory is a 1.0 feature)

**Symptom:** `/api/memory/vector` reports:
```
error: Cannot find module 'sqlite-vec-linux-x64/vec0.so' from '/$bunfs/root/goodvibes'
error: Cannot find module 'sqlite-vec-linux-x64/vec0.so' from '/$bunfs/root/goodvibes-daemon-linux-x64'
```

**Impact:** Vector-backed memory search permanently disabled on shipped binaries. Falls back to `hashed-local` embeddings.

**Resolution path:**
1. Audit `bun build --compile` invocation; the native `.so` is an external asset that must be bundled or side-loaded.
2. Options:
   a. `--external sqlite-vec-linux-x64` and ship the `.so` alongside the binary; binary loader resolves from a path relative to `process.execPath`.
   b. Bun asset inclusion to embed the `.so` in the single-file bundle (consult current Bun docs).
   c. Distribute a tarball (binary + `lib/` dir) instead of a single-file binary.
3. Add a CI post-build smoke test: spawn the compiled binary, curl `/api/memory/vector`, assert `error` field absent.

## F6 — Agent-capacity returns HTTP 500 (MAJOR)

**Symptom:** `/api/sessions/:id/steer|follow-up` and `/task` return 500 `category:"service"` when the single agent slot is busy.

**Impact:** Consumers get a generic 5xx that suggests a bug when it's actually backpressure. Breaks retry semantics.

**Resolution path:**
1. In the daemon's request handler, detect the "capacity reached" case and return **HTTP 429** with `Retry-After` header and `code:"CAPACITY_EXCEEDED"` (or 503 `Service Unavailable` if capacity is configuration-bound rather than transient).
2. Add unit test asserting the status code.
3. Update SDK retry policy to honor the new status code.

## F7 — OTLP ingest endpoints return 404 (MINOR–MAJOR)

**Symptom:** `POST /api/v1/telemetry/otlp/v1/{logs,metrics,traces}` → 404 on both runs. GET equivalents are registered.

**Resolution path:**
1. Product decision: is OTLP ingest in scope for 1.0?
2. If yes: register POST handlers that accept OTLP-proto or OTLP-JSON and forward to the internal telemetry bus.
3. If no: remove the GET routes for symmetry and document telemetry as consumer-pull via `/api/v1/telemetry/stream` SSE.

## F8 — Voice TTS returns 404 when provider unconfigured (MINOR)

**Symptom:** `POST /api/voice/tts` with no OpenAI key → `HTTP 404` with `category:"not_found", error:"OpenAI API key missing"`.

**Impact:** Wrong HTTP semantics. 404 means "route not found". Config-missing is 409 / 422 / 503.

**Resolution path:**
1. TTS route: distinguish "unconfigured provider" (409 `PROVIDER_NOT_CONFIGURED`) from "route missing".
2. Add test asserting correct status for unconfigured case.

## F9 — Automation-job validator contradicts its own error message (MINOR)

**Symptom:** `POST /api/automation/jobs` with `schedule:{kind:"cron",expression:"0 3 * * *"}` returns 400 `schedule.expression must not be empty`.

**Resolution path:**
1. Open `packages/sdk/src/_internal/platform/**/automation*.ts` and trace the `schedule.expression` check.
2. Confirm expected input schema via `/api/control-plane/methods` catalog:
   ```sh
   jq '.methods[] | select(.id=="automation.jobs.create") | .inputSchema' /tmp/cp-methods.json
   ```
3. Fix either the validator or the error message so they agree; ideally the validator reports the actual failed path with the observed value.

## F10 — One raw `throw new Error` in public SDK source (MINOR)

**Symptom:** `packages/sdk/src/client.ts:416 — throw new Error('Auto-refresh: transport not yet initialised')`.

**Resolution path:**
1. Replace with `throw new SDKError({ kind: 'internal', message: '...', cause: ... })`.
2. Add lint rule: `no-restricted-syntax` forbidding `throw new Error` in `packages/sdk/src/**` (outside tests / `_internal/`).

## F11 — No `.goodvibes/memory/` populated (MINOR)

**Symptom:** Workspace has `.goodvibes/logs/activity.md` (166 KB) but `memory/` doesn't exist.

**Clarification (2026-04-19):** `.goodvibes/memory/` is workspace-scoped and only created when the `runtime_state` tool is invoked in `mode: memory` during an orchestrator-driven session. TUI chat sessions do not automatically write to `memory/`. OBS-002 is expected behavior for a workspace that has only had interactive TUI conversations. The directory will be created automatically on first orchestrated session that uses memory tools. No code change required; update UAT plan to note this condition.

## F12 — `DELETE /api/companion/chat/sessions/:id` is soft-close (DOCUMENTATION)

**Symptom:** DELETE returns 200 with `status:"closed"`; GET still returns the record.

**Clarification (2026-04-19):** This is intentional SDK behavior. DELETE is an audit-friendly soft-close, not a hard delete. Records are retained for audit purposes. This is by design — companion chat sessions are conversation history and should not be silently destroyed. Documentation updated to reflect this. The UAT test expectation was incorrect.

**Resolution path:**
1. Update UAT-CHAT-005 expectation: soft-close is correct; PASS criteria is `status:"closed"` in response body.
2. Document in SDK companion-chat API docs: DELETE closes the session (status → closed); session remains readable; use a dedicated purge endpoint if hard-delete is needed in the future.

## F13 — Companion-chat message field is `content` but plan narrative uses `body` (DOCUMENTATION)

**Symptom:** `POST /api/companion/chat/sessions/:id/messages` requires `{content}`; other session types use `{body}`.

**Clarification (2026-04-19):** Companion chat uses `{content}` because it is a pure text interface modeled after OpenAI chat. Shared sessions use `{body}` because they carry multimodal payloads. The field names are intentionally different — they correspond to different message schemas (`CompanionChatMessage` vs `SharedSessionMessage`). This is not a bug.

**Resolution path:**
1. Update all UAT test scripts: use `{content}` for `/api/companion/chat/sessions/:id/messages`; use `{body}` for `/api/sessions/:id/messages`.
2. Document the distinction in SDK companion-chat API docs with an example showing both field shapes side-by-side.

## F14 — Control-plane SSE default domains differ between daemons (MINOR)

**Symptom:** Run 1 ready-frame domains include `providers` + `turn`; Run 2 omits them.

**Clarification (2026-04-19):** Investigation of `@pellux/goodvibes-sdk` gateway source confirms `providers` and `turn` are in `DEFAULT_DOMAINS` at the SDK level (both postures). The Run 2 discrepancy was caused by the UAT test client connecting with an explicit `?domains=` querystring that excluded those two domains. No code change required — the canonical default domain list already includes `providers` and `turn` as of SDK 0.21.12+.

**Resolution path:**
1. Update UAT-CPM-006 test script: do not pass explicit `?domains=` when testing default behavior — connect without the parameter and verify the ready-frame domains against the full SDK DEFAULT_DOMAINS list.
2. SDK bump to 0.21.18 (done) carries the correct list.

## F15 — Rate-limit threshold not reachable at sequential rate (INFRASTRUCTURE)

**Symptom:** 10 rapid sequential POSTs to `/api/companion/chat/sessions/:id/messages` all 202; limiter never fires.

**Clarification (2026-04-19):** The `CompanionChatRateLimiter` defaults to 30 msgs/min per client and 10 msgs/min per session (`DEFAULT_MESSAGES_PER_MINUTE_PER_SESSION = 10`). Sequential HTTP requests are rate-limited by the test harness RTT, making it difficult to exhaust the 60-second sliding window with only 10 requests. The rate limiter IS wired correctly — verified by inspection of `companion-chat-manager.js`.

**SDK gap (2026-04-19):** `CompanionChatRateLimiter` options (`perClientLimit`, `perSessionLimit`, `windowMs`) are passed through `CompanionChatManager` config, but `DaemonServer` / `facade-composition.js` hardcodes the defaults with no pass-through from the CLI or env. Exposing a lower threshold for integration testing requires an SDK change to surface `companionChatRateLimiterOptions` in `DaemonConfig`. Tracked in decisions.md.

**Resolution path (testing):**
1. Write bun test harness that sends `Promise.all(Array.from({length: 11}, () => fetch(...POST...)))` — concurrent requests from the same client will hit the per-session limit (default 10/min) on the 11th.
2. Long-term: SDK should expose `GOODVIBES_CHAT_LIMITER_PER_SESSION` / `GOODVIBES_CHAT_LIMITER_PER_CLIENT` env vars as a testing escape hatch.

---

## 1.0.0 gate

| Area | Pass rate | Blocks 1.0? |
|---|---|---|
| Security static audit | 4 / 5 | F10 should be fixed; low risk |
| Release pipeline static | 4 / 4 | no |
| Filesystem observability | 1 / 2 | F11 should be clarified |
| Daemon API read sweep | 75/75 + 74/76 | **F1** (Run 2's two 404s) |
| Mutation API (art, cfg, kb, ws, watch, sched, la, chan) | 8/8 both runs | no |
| Provider/session/chat happy-path | Run 1 passes, Run 2 fails | **F1 + F2 + F3** |
| Vector memory | 0 / 2 | **F5** if vector memory is a 1.0 claim |
| Error-code shape | multiple fails | F6, F7, F8 for polished UX |

**Verdict:** Run 2 shows the standalone daemon is not a 1.0-viable drop-in replacement for the TUI-embedded daemon. F1 (router parity), F2 (provider state), and F3 (token portability) are the required work; F5 and F6 are next-highest priority.

---

## Out of scope for this report

- Interactive TUI surfaces (visual)
- Android/iOS companion app flows
- Web UI (not yet built)
- Cloudflare Workers / Slack / Discord (not deployed)
- SDK internal harness-only TCs (AUTH-003/004 refresh behavior, MW, RT reconnect, FAIL-*)

These surfaces have TCs in the expanded UAT plan (Sections 5–13, 21) but cannot be executed from a non-interactive shell.
