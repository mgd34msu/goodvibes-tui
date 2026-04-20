# User Acceptance Testing (UAT) Plan — Road to 1.0.0

This plan exercises every surface and feature path across `@pellux/goodvibes-sdk` and `@pellux/goodvibes-tui`. Completion of **all** tests (including the surfaces not yet live) is the gate for 1.0.0 sign-off.

## Surfaces

| Surface | Status | Notes |
|---|---|---|
| TUI (`dist/goodvibes` binary) | ✅ Live | Full interactive terminal UI |
| Daemon (HTTP API) | ✅ Live | Embedded in TUI; exposed on `:3421` |
| Daemon CLI | ❓ Untested | Headless daemon invocation |
| Android Companion App | ✅ Live | Shared-session + companion-chat flows |
| Web UI | 🏗 In development | Browser client against daemon HTTP/SSE |
| Cloudflare Workers deploy | 🔜 Planned | `./web` entry compat already verified via Miniflare + `wrangler dev --local` |
| Slack integration | 🔜 Planned | |
| Discord integration | 🔜 Planned | |

## Legend

- 🟢 **Live** — surface exists now; test must pass for 1.0.0.
- 🟡 **Dev** — surface being built; test must pass before the surface ships.
- 🔜 **Planned** — surface doesn't exist yet; test is the acceptance contract when it ships.
- ⛔ **Deferred** — outside 1.0.0 scope; flag but don't block.

Each test uses:
```
ID | Title
Surface: <where to run>
Precondition: <setup>
Steps: <numbered actions>
Expected: <observable outcome>
Status: [ ] not run / [P] pass / [F] fail (+ notes)
```

---

# Section 1 — Authentication & Session Tokens

## UAT-AUTH-001 | Admin password login issues session cookie
**Surface:** Daemon HTTP 🟢
**Precondition:** TUI running on :3421; admin credentials present in `~/.goodvibes/tui/auth-bootstrap.txt`.
**Steps:**
1. `POST /login` with `{"username":"admin","password":"<password>"}` and `-c cookies.txt`
2. `GET /api/control-plane/auth` with `-b cookies.txt`
**Expected:** Step 1 returns 200 with `{authenticated:true, token:<jwt>}`. Step 2 returns `{authenticated:true, authMode:"session", principalKind:"user", admin:true}`.
**Status:** [ ]

## UAT-AUTH-002 | Operator bearer token authenticates companion
**Surface:** Companion app 🟢 / Daemon HTTP
**Precondition:** Companion token in `~/.goodvibes/tui/companion-token.json`.
**Steps:**
1. `GET /api/companion/chat/sessions/<id>` with `Authorization: Bearer <token>` from companion-token.json
**Expected:** 200 with the session payload. (If token stale: expect 401 + rotate via `/login`.)
**Status:** [ ]

## UAT-AUTH-003 | Auto token refresh on 401
**Surface:** SDK 🟢 (consumer app behavior)
**Precondition:** Consumer app using `createGoodVibesSdk({ autoRefresh: { refresh: fn, refreshLeewayMs: 60000 } })` with a token near expiry.
**Steps:**
1. Wait until token is within leeway window
2. Issue any authenticated API call
**Expected:** AutoRefreshCoordinator pre-flight refreshes the token before the call; single refresh serves concurrent in-flight calls (no thundering herd). Call succeeds without consumer observing the 401.
**Status:** [ ]

## UAT-AUTH-004 | Terminal auth error after double 401
**Surface:** SDK 🟢
**Precondition:** Refresh callback returns invalid token.
**Steps:**
1. Call an API that 401s
2. AutoRefreshCoordinator refreshes
3. Retry 401s again
**Expected:** Throws `GoodVibesSdkError{kind:'auth'}` with three-part message (what / why / how-to-fix), includes original 401 as cause.
**Status:** [ ]

## UAT-AUTH-005 | Platform secure token store — iOS Keychain
**Surface:** SDK 🟢 (iOS companion app context)
**Precondition:** `createIOSKeychainTokenStore` instantiated on iOS device.
**Steps:**
1. Write token via `store.set`
2. Read via `store.get` after app restart
**Expected:** Token retrieved; no plaintext on disk.
**Status:** [ ]

## UAT-AUTH-006 | Platform secure token store — Android Keystore
**Surface:** SDK 🟢 (Android companion app)
**Precondition:** `createAndroidKeystoreTokenStore` via `react-native-keychain`.
**Steps:** Same as iOS but on Android.
**Expected:** Token persists in Keystore across app restart.
**Status:** [ ]

## UAT-AUTH-007 | Platform secure token store — Expo SecureStore
**Surface:** SDK 🟢 (Expo managed workflow)
**Steps:** Same but via Expo SecureStore.
**Expected:** Token persists; missing peer dep produces clean `SDKError{kind:'config'}`.
**Status:** [ ]

## UAT-AUTH-008 | Graceful degradation when Keychain peer dep missing
**Surface:** SDK 🟢
**Precondition:** `react-native-keychain` not installed.
**Steps:** Call `createAndroidKeystoreTokenStore`.
**Expected:** Throws `SDKError{kind:'config'}` with install hint; does NOT crash; does NOT fall through to plaintext.
**Status:** [ ]

---

# Section 2 — Provider & Model Management

## UAT-PROV-001 | List providers
**Surface:** Daemon HTTP 🟢
**Steps:** `GET /api/providers` with auth.
**Expected:** 200 with `{providers: Provider[], currentModel}`. Each provider has `id, label, configured, configuredVia, envVars, models`. `configuredVia` is one of `env | secrets | subscription | anonymous | undefined`.
**Status:** [ ]

## UAT-PROV-002 | Get current model
**Surface:** Daemon HTTP 🟢
**Steps:** `GET /api/providers/current`.
**Expected:** Current `registryKey`, `provider`, `id`, `configured`, `configuredVia`.
**Status:** [ ]

## UAT-PROV-003 | Switch model via PATCH (built-in provider with env key)
**Surface:** Daemon HTTP 🟢
**Precondition:** `OPENAI_API_KEY` set.
**Steps:** `PATCH /api/providers/current` with `{"registryKey":"openai:gpt-5.1"}`.
**Expected:** 200 with new current model + `persisted:true`. Settings.json reflects change.
**Status:** [ ]

## UAT-PROV-004 | Switch model — unknown registryKey
**Surface:** Daemon HTTP 🟢
**Steps:** PATCH with `{"registryKey":"bogus:not-a-model"}`.
**Expected:** 404/400 with `code:"MODEL_NOT_FOUND"`.
**Status:** [ ]

## UAT-PROV-005 | Switch model — unconfigured provider
**Surface:** Daemon HTTP 🟢
**Precondition:** provider has env vars declared but none set.
**Steps:** PATCH with that provider's registryKey.
**Expected:** 409 `PROVIDER_NOT_CONFIGURED` + `missingEnvVars` = actual env var names (NOT placeholder `<API key for X>`).
**Status:** [ ]

## UAT-PROV-006 | Switch model — discovered local provider (LM Studio)
**Surface:** Daemon HTTP 🟢 (regression from 0.21.16)
**Precondition:** LM Studio running on LAN, discovered by scanner.
**Steps:** `GET /api/providers` — locate discovered LM Studio entry; PATCH `/api/providers/current` with its registryKey.
**Expected:** 200 success. Previous bug: returned `PROVIDER_NOT_CONFIGURED` with `<API key for X>` placeholder.
**Status:** [ ]

## UAT-PROV-007 | Switch model — discovered Ollama provider
**Surface:** Daemon HTTP 🟢
**Precondition:** Ollama running on local network or localhost.
**Steps:** PATCH with Ollama discovered registryKey.
**Expected:** 200 success; turn actually hits Ollama and returns a response.
**Status:** [ ]

## UAT-PROV-008 | Reactive model change — SSE event
**Surface:** Daemon SSE 🟢
**Precondition:** Subscribed to `/api/companion/chat/sessions/:id/events` (or `/api/sessions/:id/events` for shared session).
**Steps:** Trigger `PATCH /api/providers/current`.
**Expected:** Single `MODEL_CHANGED` envelope arrives on the SSE stream with `{registryKey, provider, previous}`.
**Status:** [ ]

## UAT-PROV-009 | `configuredVia` secrets-tier resolves correctly
**Surface:** Daemon HTTP 🟢
**Precondition:** Provider key stored ONLY in SecretsManager (no env var).
**Steps:** `GET /api/providers` — find that provider.
**Expected:** `configured:true, configuredVia:"secrets"`. (Regression from 0.21.5.)
**Status:** [ ]

## UAT-PROV-010 | `configuredVia` subscription-tier resolves correctly
**Surface:** Daemon HTTP 🟢
**Precondition:** OAuth subscription configured for e.g. OpenAI.
**Steps:** `GET /api/providers`.
**Expected:** `configuredVia:"subscription"`.
**Status:** [ ]

## UAT-PROV-011 | CLI `--provider` / `--model` flags at daemon startup
**Surface:** CLI 🟢
**Steps:** `./goodvibes --provider=inception --model=inception:mercury-2`. Verify daemon starts with that selection.
**Expected:** `GET /api/providers/current` returns the flagged model regardless of settings.json.
**Status:** [ ]

## UAT-PROV-012 | Model picker shows `configuredVia` badges
**Surface:** TUI 🟢
**Steps:** Open TUI settings modal → Providers.
**Expected:** Each provider shows `[env]` / `[sub]` / `[sec]` / `[anon]` badge aligned right; unconfigured shows no badge.
**Status:** [ ]

## UAT-PROV-013 | Bare model id stripping for compat APIs
**Surface:** SDK 🟢 (regression from 0.21.7)
**Precondition:** Model registered as `inception:mercury-2`.
**Steps:** Submit a turn and capture the outbound API request.
**Expected:** Request body has `model:"mercury-2"`, NOT `"inception:mercury-2"`. Upstream returns 200, not 400.
**Status:** [ ]

## UAT-PROV-014 | Unconfigured provider — clean error at turn time
**Surface:** Companion / Daemon 🟢
**Precondition:** Current model points at unconfigured provider.
**Steps:** Submit a companion chat turn.
**Expected:** Turn yields error: `"Provider 'X' is not configured. Set <ENV_VAR> or configure via the TUI settings."` (NOT a silent 401 from upstream.)
**Status:** [ ]

---

# Section 3 — Shared Session Flows (companion-to-operator)

## UAT-SHARED-001 | Create shared session
**Surface:** Daemon HTTP 🟢
**Steps:** `POST /api/sessions` with session metadata.
**Expected:** 201 with session record; id is stable UUID.
**Status:** [ ]

## UAT-SHARED-002 | Get shared session
**Surface:** Daemon HTTP 🟢
**Steps:** `GET /api/sessions/:id`.
**Expected:** Session record with `participants`, `status`, `messages[]`, etc.
**Status:** [ ]

## UAT-SHARED-003 | Main chat input — kind:'message' triggers real turn
**Surface:** Companion + TUI + Daemon 🟢 (regression from 0.21.13–0.21.15)
**Precondition:** Shared session exists; TUI 0.19.10+ running with SDK 0.21.16+.
**Steps:**
1. From companion app "shared session → main chat" section, send `"Hello"`
2. Observe TUI conversation view + companion app
**Expected:**
- Message appears in both TUI and companion (no double-render)
- A real LLM turn fires (NOT a WRFC engineer-chain acknowledgement like "Update noted" / "WRFC chain has passed all gates")
- Response streams back to both surfaces via SSE `STREAM_DELTA` events
- `TURN_COMPLETED` arrives with the final assistant message
**Status:** [ ]

## UAT-SHARED-004 | Follow-up flow — kind:'followup' spawns agent
**Surface:** Companion + Daemon 🟢
**Precondition:** Active shared session.
**Steps:** From companion "shared session → follow-up" section, send a directive.
**Expected:**
- Spawns a WRFC engineer chain
- TUI shows agent spawn
- Full agent event chain streams back to companion via SSE
**Status:** [ ]

## UAT-SHARED-005 | Persisted messages — GET /messages returns companion sends
**Surface:** Daemon HTTP 🟢 (regression from 0.21.9)
**Steps:** After UAT-SHARED-003, call `GET /api/sessions/:id/messages`.
**Expected:** Companion-sent message appears in the list with correct source tag.
**Status:** [ ]

## UAT-SHARED-006 | Task submission — kind:'task'
**Surface:** Daemon HTTP 🟢
**Steps:** `POST /api/sessions/:id/messages` with `kind:"task"`.
**Expected:** Spawns an agent per the operator/TUI existing behavior; returns 202 with submission record.
**Status:** [ ]

## UAT-SHARED-007 | SSE stream — /api/sessions/:id/events delivers turn events
**Surface:** Daemon SSE 🟢
**Precondition:** Active session; default domains include `providers` + `turn`.
**Steps:** Subscribe to SSE; trigger a turn.
**Expected:** Receives `TURN_STARTED`, multiple `STREAM_DELTA`, `TURN_COMPLETED`. No duplicate events. No missing events.
**Status:** [ ]

## UAT-SHARED-008 | SSE stream — MODEL_CHANGED delivered automatically
**Surface:** Daemon SSE 🟢 (regression from 0.21.3)
**Steps:** While subscribed, switch model via PATCH.
**Expected:** `MODEL_CHANGED` arrives without needing to subscribe to `providers` domain explicitly.
**Status:** [ ]

## UAT-SHARED-009 | Session steer
**Surface:** Daemon HTTP 🟢
**Steps:** `POST /api/sessions/:id/steer` with steering content.
**Expected:** Running agent receives steering mid-turn; response reflects steering.
**Status:** [ ]

## UAT-SHARED-010 | Session close + reopen
**Surface:** Daemon HTTP 🟢
**Steps:** `DELETE /api/sessions/:id` then `POST /api/sessions/:id/reopen`.
**Expected:** Session transitions active → closed → active; message history preserved across close.
**Status:** [ ]

## UAT-SHARED-011 | Cancel in-flight input
**Surface:** Daemon HTTP 🟢
**Steps:** Submit a task; call `POST /api/sessions/:id/inputs/:inputId/cancel`.
**Expected:** Agent receives cancel signal; turn ends with cancelled state.
**Status:** [ ]

---

# Section 4 — Companion Chat Sessions (standalone LLM chat)

## UAT-CHAT-001 | Create companion chat session
**Surface:** Companion + Daemon 🟢
**Steps:** From companion app, tap "New Chat".
**Expected:** `POST /api/companion/chat/sessions` returns 201; session shows in app list.
**Status:** [ ]

## UAT-CHAT-002 | Send message + stream response
**Surface:** Companion 🟢
**Steps:** Type "Explain quantum entanglement in one sentence" → Send.
**Expected:** User message renders immediately; assistant streams delta response; final message persisted.
**Status:** [ ]

## UAT-CHAT-003 | Chat history persisted across app restart
**Surface:** Companion + Daemon persistence 🟢
**Steps:** Send several messages; force-kill app; reopen.
**Expected:** Chat history loads from `~/.goodvibes/companion-chat/sessions/<id>.json`.
**Status:** [ ]

## UAT-CHAT-004 | Chat with specific model override
**Surface:** Companion 🟢
**Steps:** Create chat with `model: "inception:mercury-2", provider: "inception"` in session metadata.
**Expected:** Turns use that specific model, not the daemon's current default.
**Status:** [ ]

## UAT-CHAT-005 | Delete chat session
**Surface:** Companion 🟢
**Steps:** `DELETE /api/companion/chat/sessions/:id`.
**Expected:** Session removed; persisted file deleted; app list refreshes.
**Status:** [ ]

## UAT-CHAT-006 | Chat rate limiter
**Surface:** Daemon 🟢
**Steps:** Submit rapid back-to-back messages exceeding limiter threshold.
**Expected:** Limiter rejects excess with 429; messages within threshold succeed.
**Status:** [ ]

---

# Section 5 — Transport & Middleware

## UAT-MW-001 | `sdk.use(middleware)` composition
**Surface:** SDK (any consumer) 🟢
**Steps:** Register two middleware — one logging, one adding a custom header.
**Expected:** Both fire in registration order; outbound request has header + log line.
**Status:** [ ]

## UAT-MW-002 | Middleware error passthrough
**Surface:** SDK 🟢
**Steps:** Middleware throws mid-request.
**Expected:** Transport outer handler consumes `ctx.error`; returns original error kind to caller, not a wrapper.
**Status:** [ ]

## UAT-MW-003 | Idempotency-Key on non-GET/HEAD
**Surface:** SDK 🟢
**Steps:** Issue a POST via the SDK; capture outgoing headers.
**Expected:** `Idempotency-Key` present with UUID v4; same key preserved across retries of same logical request.
**Status:** [ ]

## UAT-MW-004 | Per-method retry policy precedence
**Surface:** SDK 🟢
**Steps:** Configure `perMethodPolicy: { 'peer.postTurn': { attempts: 1 } }` with a contract that's idempotent.
**Expected:** Per-method wins over contract flag. `peer.postTurn` retries at most once; other idempotent methods use default.
**Status:** [ ]

## UAT-MW-005 | W3C traceparent propagation — HTTP
**Surface:** SDK 🟢
**Precondition:** OpenTelemetry active span.
**Steps:** Make HTTP request.
**Expected:** `traceparent` header on the outgoing request matches the active span.
**Status:** [ ]

## UAT-MW-006 | Traceparent on SSE
**Surface:** SDK 🟢
**Steps:** Open SSE with active span.
**Expected:** `traceparent` in fetch headers for the SSE request.
**Status:** [ ]

## UAT-MW-007 | Traceparent on WebSocket auth frame
**Surface:** SDK 🟢
**Steps:** Open WS with active span.
**Expected:** Auth frame includes `traceparent` field.
**Status:** [ ]

## UAT-MW-008 | Zod runtime validation at transport boundary
**Surface:** SDK 🟢
**Steps:** Consumer opts in to Zod validation; daemon returns malformed response.
**Expected:** `SDKError{kind:'contract'}` with field-level detail pointing at the bad response field.
**Status:** [ ]

---

# Section 6 — Realtime Events

## UAT-RT-001 | SSE reconnect policy
**Surface:** SDK 🟢
**Steps:** Drop network mid-stream; restore after 3s.
**Expected:** SSE client reconnects with backoff; resumes from last event ID; no duplicate deltas.
**Status:** [ ]

## UAT-RT-002 | WebSocket reconnect policy
**Surface:** SDK 🟢
**Steps:** Drop WS; restore.
**Expected:** Reconnect with exponential backoff; auth frame re-sent.
**Status:** [ ]

## UAT-RT-003 | Producer queue bounding
**Surface:** SDK 🟢
**Precondition:** Very slow SSE subscriber.
**Steps:** Producer emits events faster than consumer drains.
**Expected:** Queue bounded (configurable); oldest-dropped policy kicks in; no memory blow-up.
**Status:** [ ]

## UAT-RT-004 | Observer hooks — onEvent / onError / onTransportActivity
**Surface:** SDK 🟢
**Steps:** Register SDKObserver with all three hooks; run a turn.
**Expected:** Observer receives per-event callbacks; errors do not crash SDK; observer thunks are wrapped in `invokeObserver`.
**Status:** [ ]

## UAT-RT-005 | OpenTelemetry observer adapter
**Surface:** SDK 🟢
**Steps:** Register OTel observer; run a turn.
**Expected:** Spans created with correct attributes; errors end span with ERROR status.
**Status:** [ ]

---

# Section 7 — MCP Servers & Tools

## UAT-MCP-001 | Connect to local MCP server
**Surface:** TUI + Daemon 🟢
**Steps:** Configure MCP server in TUI settings; trigger turn that invokes an MCP tool.
**Expected:** Tool call routes to MCP server; result returns in-line; ANSI/dangerous output sanitized.
**Status:** [ ]

## UAT-MCP-002 | MCP trust modes
**Surface:** TUI 🟢
**Steps:** Configure MCP servers with `constrained`, `ask-on-risk`, `allow-all`, `blocked` trust modes.
**Expected:** Behavior matches mode — `ask-on-risk` prompts, `blocked` refuses, etc.
**Status:** [ ]

## UAT-MCP-003 | MCP allowedPaths / allowedHosts enforcement
**Surface:** TUI 🟢
**Steps:** Restrict MCP to allowed paths; attempt tool call outside.
**Expected:** Tool call denied; clear error surfaced.
**Status:** [ ]

## UAT-MCP-004 | Tool result sanitization (ANSI escape)
**Surface:** TUI 🟢 (regression from 0.18.33)
**Steps:** MCP tool returns output containing ANSI cursor escapes, OSC, BEL.
**Expected:** Dangerous sequences stripped; SGR color preserved.
**Status:** [ ]

---

# Section 8 — TUI-specific UX

## UAT-TUI-001 | Startup + session restore
**Surface:** TUI 🟢
**Steps:** Start TUI with prior session persisted.
**Expected:** Last conversation restored; cursor at input; model badge correct.
**Status:** [ ]

## UAT-TUI-002 | Input box submit — real turn fires
**Surface:** TUI 🟢
**Steps:** Type "Hello" + Enter.
**Expected:** Turn fires; response streams in-line; conversation scrolls.
**Status:** [ ]

## UAT-TUI-003 | Model picker modal
**Surface:** TUI 🟢
**Steps:** Open model picker; fuzzy-filter; select.
**Expected:** Selection updates current model; badge reflects new choice; PATCH fires to daemon.
**Status:** [ ]

## UAT-TUI-004 | Panels — all migrated panels render
**Surface:** TUI 🟢
**Steps:** Cycle through all panels (knowledge, marketplace, memory, system-messages, orchestration, skills, file-explorer, agent-logs, wrfc, plan-dashboard, diff, token-budget, context-visualizer, git, schedule, provider-health, agent-inspector, session-browser, etc.).
**Expected:** Each renders without error; scroll works; selection gutter responsive.
**Status:** [ ]

## UAT-TUI-005 | QR code panel — half-height top quiet band
**Surface:** TUI 🟢 (recent visual fix)
**Steps:** Open QR code panel.
**Expected:** Top white border is half-cell height (▄ with white fg on transparent bg), not full cell.
**Status:** [ ]

## UAT-TUI-006 | Voice input (if enabled)
**Surface:** TUI 🟢
**Precondition:** `ui.voiceEnabled: true`.
**Steps:** Trigger voice input.
**Expected:** Captures audio; transcribes; submits.
**Status:** [ ]

## UAT-TUI-007 | Settings modal — all categories
**Surface:** TUI 🟢
**Steps:** Open settings; cycle through display / ui / provider / subscriptions / behavior / storage / permissions / mcp / sandbox / danger / tools / flags / network.
**Expected:** Each category renders; changes persist to `~/.goodvibes/tui/settings.json`.
**Status:** [ ]

## UAT-TUI-008 | Permission prompts
**Surface:** TUI 🟢
**Precondition:** Permission mode = `prompt`; tool with `prompt` permission (e.g. `edit`, `inspect`).
**Steps:** Agent calls that tool.
**Expected:** Modal appears; accept/deny works; outcome surfaces in conversation.
**Status:** [ ]

## UAT-TUI-009 | Session save + resume across restarts
**Surface:** TUI 🟢
**Steps:** Converse; exit; restart.
**Expected:** Full conversation restored; branches/forks preserved.
**Status:** [ ]

## UAT-TUI-010 | Shell integration / exec tool
**Surface:** TUI 🟢
**Steps:** Agent calls `exec` tool (permission: allow).
**Expected:** Command runs in sandboxed shell; output captured; errors surface cleanly.
**Status:** [ ]

## UAT-TUI-011 | Git status header + git panel
**Surface:** TUI 🟢
**Steps:** Open TUI in a git repo.
**Expected:** Header shows branch + ahead/behind; git panel lists modified files; async git refresh doesn't block UI.
**Status:** [ ]

## UAT-TUI-012 | Companion followups appear in TUI conversation
**Surface:** TUI + Companion 🟢 (regression from 0.21.9–0.21.15)
**Steps:** From companion "main chat", send a message; watch TUI.
**Expected:** Message appears in TUI conversation view with proper source tag; turn response streams in-line in TUI too.
**Status:** [ ]

---

# Section 9 — Android Companion App

## UAT-APK-001 | QR pairing flow
**Surface:** Companion APK 🟢
**Steps:** Open app; scan QR code from TUI.
**Expected:** Pairing succeeds; token stored in Keystore; app connects to daemon.
**Status:** [ ]

## UAT-APK-002 | List shared sessions
**Surface:** Companion 🟢
**Steps:** Open shared sessions tab.
**Expected:** All active sessions from daemon shown; status + last activity visible.
**Status:** [ ]

## UAT-APK-003 | Main chat input (covered by UAT-SHARED-003)

## UAT-APK-004 | Follow-up input (covered by UAT-SHARED-004)

## UAT-APK-005 | Companion chat (covered by UAT-CHAT-*)

## UAT-APK-006 | Model picker UI
**Surface:** Companion 🟢
**Steps:** Open model picker in app.
**Expected:** Lists all providers + models from `GET /api/providers`; shows `configured` status; tapping switches via PATCH; picker updates on `MODEL_CHANGED` SSE event.
**Status:** [ ]

## UAT-APK-007 | Offline behavior
**Surface:** Companion 🟢
**Steps:** Turn off network mid-chat.
**Expected:** UI indicates disconnect; cached history visible; pending sends queued or rejected cleanly.
**Status:** [ ]

## UAT-APK-008 | Notification / background session presence
**Surface:** Companion 🟢
**Steps:** Background the app during an active turn.
**Expected:** Turn completes; notification surfaces (if configured); resume shows final message.
**Status:** [ ]

## UAT-APK-009 | APK install from GH release
**Surface:** Distribution 🟢
**Steps:** Download APK from GH release; install via `adb install -r`.
**Expected:** Installs cleanly; opens without crash.
**Status:** [ ]

---

# Section 10 — Web UI (🟡 In development)

## UAT-WEB-001 | Daemon connect from browser
**Surface:** Web 🟡
**Steps:** Open web UI pointed at daemon URL.
**Expected:** Login flow completes; session token stored in memory (or IndexedDB if chosen); API calls succeed.
**Status:** [ ]

## UAT-WEB-002 | CORS + CSP compliance
**Surface:** Web 🟡
**Precondition:** Daemon HTTP layer serves appropriate CORS headers for web origins.
**Steps:** Inspect browser console during normal use.
**Expected:** No CORS violations; no CSP warnings on allowed resources.
**Status:** [ ]

## UAT-WEB-003 | SSE in browser
**Surface:** Web 🟡
**Steps:** Subscribe to session events via browser `EventSource` or custom SSE parser.
**Expected:** Deltas arrive; reconnect on drop; no memory leak on long sessions.
**Status:** [ ]

## UAT-WEB-004 | Companion-parity flows (main-chat, follow-up, model picker)
**Surface:** Web 🟡
**Steps:** Run equivalents of UAT-SHARED-003, UAT-SHARED-004, UAT-APK-006 from browser.
**Expected:** Same behavior as Android companion.
**Status:** [ ]

## UAT-WEB-005 | Browser SDK bundle size
**Surface:** Web 🟡
**Steps:** Build consuming app; measure `./web` entry bundle.
**Expected:** Under bundle-budgets.json limit for the web entry; no node: imports; no Bun.* identifiers.
**Status:** [ ]

---

# Section 11 — Cloudflare Workers (🔜 Planned)

## UAT-CF-001 | SDK loads under `wrangler dev --local`
**Surface:** Cloudflare Workers 🔜
**Precondition:** Test harness at `test/workers-wrangler/` already exercises this; verify the pattern works in a real worker.
**Steps:** Deploy a minimal worker that imports `@pellux/goodvibes-sdk/web` and calls a daemon endpoint via HTTPS.
**Expected:** Worker compiles; runtime has no node: / Bun.* imports; fetch to daemon succeeds.
**Status:** [ ]

## UAT-CF-002 | Production deploy — `wrangler deploy`
**Surface:** Cloudflare Workers 🔜
**Precondition:** CF account + deploy token.
**Steps:** Deploy to CF; invoke the worker.
**Expected:** Production workerd runs the bundle; EventSource absent (prod reality) is handled gracefully by SDK.
**Status:** [ ]

## UAT-CF-003 | `./web` entry has no Workers-incompatible APIs
**Surface:** Cloudflare Workers 🔜
**Steps:** Deploy + exercise every SDK path.
**Expected:** No runtime errors about missing globals (EventSource, client-WebSocket, etc.); graceful fallbacks.
**Status:** [ ]

## UAT-CF-004 | CPU / time limits
**Surface:** Cloudflare Workers 🔜
**Steps:** Long-running turn proxied through worker.
**Expected:** Worker streams delta chunks back without hitting CF CPU limit on paid plan; stays within budget on free tier or fails cleanly.
**Status:** [ ]

---

# Section 12 — Slack Integration (🔜 Planned)

## UAT-SLACK-001 | OAuth install flow
**Surface:** Slack 🔜
**Steps:** Install the Slack app; complete OAuth.
**Expected:** Bot token stored; workspace listed in daemon's integrations.
**Status:** [ ]

## UAT-SLACK-002 | DM → daemon chat round-trip
**Surface:** Slack 🔜
**Steps:** DM the bot "Hello".
**Expected:** Daemon receives message; LLM turn fires; response posted back to DM.
**Status:** [ ]

## UAT-SLACK-003 | Channel mention → session creation
**Surface:** Slack 🔜
**Steps:** Mention the bot in a channel with a task.
**Expected:** Creates a shared session tied to the channel; agent runs; progress posted as thread replies.
**Status:** [ ]

## UAT-SLACK-004 | Signed request verification
**Surface:** Slack 🔜
**Steps:** Send a request with invalid signature.
**Expected:** Rejected with 401; no processing.
**Status:** [ ]

## UAT-SLACK-005 | Rate limits — respect Slack's 1msg/s
**Surface:** Slack 🔜
**Steps:** Flood the bot with messages.
**Expected:** Outbound posts throttled; no 429 from Slack; backlog drained in order.
**Status:** [ ]

---

# Section 13 — Discord Integration (🔜 Planned)

## UAT-DISCORD-001 | Bot invite + slash command registration
**Surface:** Discord 🔜
**Steps:** Invite bot to guild; invoke `/chat hello`.
**Expected:** Slash command registered; response lands in channel.
**Status:** [ ]

## UAT-DISCORD-002 | Thread-scoped conversations
**Surface:** Discord 🔜
**Steps:** Start a thread via bot command; converse.
**Expected:** Thread maps to a daemon session; history preserved.
**Status:** [ ]

## UAT-DISCORD-003 | File attachments
**Surface:** Discord 🔜
**Steps:** Attach image / doc in message to bot.
**Expected:** Bot downloads, processes (if multimodal), responds referring to attachment.
**Status:** [ ]

---

# Section 14 — CLI

## UAT-CLI-001 | Daemon-only headless start
**Surface:** CLI ❓
**Steps:** `./goodvibes --daemon-only` (or equivalent; verify actual flag).
**Expected:** Daemon starts without TUI; HTTP listener up on :3421; clean shutdown on SIGTERM.
**Status:** [ ]

## UAT-CLI-002 | `--version` flag
**Surface:** CLI 🟢
**Steps:** `./goodvibes --version`.
**Expected:** Prints SDK + TUI versions; exits 0.
**Status:** [ ]

## UAT-CLI-003 | `--help` flag
**Surface:** CLI 🟢
**Steps:** `./goodvibes --help` and `./goodvibes-daemon --help`.
**Expected:** Usage docs including `--provider`, `--model`.
**Status:** [ ]

## UAT-CLI-004 | Curl-based turn submission (headless workflow)
**Surface:** CLI + HTTP 🟢
**Steps:** Login → create session → submit `kind:"task"` → stream events via SSE → observe turn completion.
**Expected:** Full curl-only workflow produces a usable turn without TUI interaction.
**Status:** [ ]

---

# Section 15 — Persistence & Mirrors

## UAT-PERSIST-001 | Session data survives daemon restart
**Surface:** Daemon 🟢
**Steps:** Create session; submit messages; kill daemon; restart; re-query session.
**Expected:** Session + messages fully restored from `~/.goodvibes/**/sessions/*.jsonl`.
**Status:** [ ]

## UAT-PERSIST-002 | Config changes via PATCH persist
**Surface:** Daemon 🟢
**Steps:** `PATCH /api/providers/current`; kill daemon; restart.
**Expected:** Current model survives restart; `GET /api/providers/current` returns the new value.
**Status:** [ ]

## UAT-PERSIST-003 | Conversation branches — fork / switch / merge
**Surface:** TUI + SDK 🟢
**Steps:** Fork current conversation to branch; submit messages; switch back; merge.
**Expected:** Branch management behaves per spec; no message loss; history cache invalidates correctly.
**Status:** [ ]

## UAT-PERSIST-004 | Auto-compact at threshold
**Surface:** TUI 🟢
**Precondition:** `behavior.autoCompactThreshold: 80`.
**Steps:** Fill conversation to >80% context.
**Expected:** Auto-compact fires; user shown summary; continued conversation respects compacted history.
**Status:** [ ]

---

# Section 16 — Security & Safety

## UAT-SEC-001 | Three-part error format
**Surface:** SDK 🟢
**Steps:** Trigger various errors (auth failure, rate limit, config error, network timeout).
**Expected:** Each `SDKError` has what / why / how-to-fix in the message.
**Status:** [ ]

## UAT-SEC-002 | Raw-throw guard
**Surface:** SDK source 🟢
**Steps:** `bun run` the raw-throw guard gate.
**Expected:** 0 raw `throw new Error(...)` in public source.
**Status:** [ ]

## UAT-SEC-003 | No `any` in public source
**Surface:** SDK + TUI 🟢
**Steps:** `bun run any:check` in SDK.
**Expected:** 0 occurrences.
**Status:** [ ]

## UAT-SEC-004 | ANSI sanitization at untrusted entry points
**Surface:** TUI 🟢
**Steps:** MCP tool returns cursor escapes + OSC + BEL; turn result includes raw bytes.
**Expected:** Dangerous control sequences stripped; SGR colors preserved.
**Status:** [ ]

## UAT-SEC-005 | Permissions matrix enforced
**Surface:** TUI 🟢
**Steps:** Configure each tool permission (allow/deny/prompt); agent attempts each.
**Expected:** Behavior matches config; `deny` tools never execute.
**Status:** [ ]

## UAT-SEC-006 | Sandbox mode NEVER activated by agent
**Surface:** SDK 🟢
**Steps:** Audit logs for sandbox config changes.
**Expected:** Sandbox mode only enabled by explicit user action; no agent / subagent invocation.
**Status:** [ ]

## UAT-SEC-007 | Session token not logged / exfiltrated
**Surface:** SDK + TUI 🟢
**Steps:** Grep logs during auth flow.
**Expected:** Tokens never appear in logs or telemetry.
**Status:** [ ]

## UAT-SEC-008 | minimatch ReDoS mitigation via postinstall
**Surface:** SDK install 🟢
**Steps:** Fresh `npm install @pellux/goodvibes-sdk`; inspect `node_modules/minimatch/package.json`.
**Expected:** Version is 10.2.5 (patched) after postinstall patcher runs.
**Status:** [ ]

## UAT-SEC-009 | SBOM attached to every GH release
**Surface:** Release pipeline 🟢
**Steps:** Check last 3 GH releases.
**Expected:** Each has `sbom.cdx.json` asset.
**Status:** [ ]

## UAT-SEC-010 | npm provenance attestation
**Surface:** Release pipeline 🟢
**Steps:** `npm view @pellux/goodvibes-sdk --json | jq .dist.attestations`.
**Expected:** Provenance attestation URL present for recent versions.
**Status:** [ ]

---

# Section 17 — Release Pipeline & Packaging

## UAT-REL-001 | Tag push triggers release workflow
**Surface:** CI 🟢
**Steps:** Push a tag matching `v*`.
**Expected:** Release workflow fires; npm publishes; GH release created with assets.
**Status:** [ ]

## UAT-REL-002 | Changelog gate blocks releases missing CHANGELOG section
**Surface:** CI 🟢
**Steps:** Attempt to push a tag whose version has no `## [X.Y.Z]` CHANGELOG entry.
**Expected:** CI `changelog-check` job fails; release blocked.
**Status:** [ ]

## UAT-REL-003 | Sync safety — unscoped `sync` command guarded
**Surface:** SDK repo 🟢
**Steps:** Attempt `bun run sync` without `--scope`.
**Expected:** Script refuses / warns; no mass deletion.
**Status:** [ ]

## UAT-REL-004 | Mirror drift guard
**Surface:** CI 🟢
**Steps:** Modify canonical `packages/transport-http/src/` but not its mirror.
**Expected:** `mirror-drift` job fails; blocks merge.
**Status:** [ ]

## UAT-REL-005 | Bundle budgets enforced
**Surface:** CI 🟢
**Steps:** Add 50KB of source to a watched entry.
**Expected:** `bundle-budgets` job fails with specific entry name over budget.
**Status:** [ ]

## UAT-REL-006 | Install-smoke-check against published tarball
**Surface:** CI 🟢
**Steps:** Watch a release run.
**Expected:** `install:smoke` retries on ECONNRESET (as added in 0.21.15); succeeds within 3 attempts.
**Status:** [ ]

## UAT-REL-007 | TUI binary install from GH release
**Surface:** Distribution 🟢
**Steps:** Download binary for host OS+arch; `chmod +x`; run.
**Expected:** Runs without missing deps.
**Status:** [ ]

## UAT-REL-008 | SHA256SUMS match binaries
**Surface:** Distribution 🟢
**Steps:** Compute sha256 of each binary; compare to `SHA256SUMS.txt`.
**Expected:** All checksums match.
**Status:** [ ]

---

# Section 18 — Failure Modes & Resilience

## UAT-FAIL-001 | Daemon crash recovery
**Surface:** TUI + Daemon 🟢
**Steps:** Kill daemon process while TUI running.
**Expected:** TUI detects disconnect; displays disconnect state; auto-reconnects when daemon returns.
**Status:** [ ]

## UAT-FAIL-002 | Provider API outage
**Surface:** SDK 🟢
**Steps:** Block outbound requests to provider; submit turn.
**Expected:** Clean error message (not stack trace); retry with backoff until timeout; terminal failure reported once.
**Status:** [ ]

## UAT-FAIL-003 | Rate-limit handling
**Surface:** SDK 🟢
**Steps:** Provider returns 429 with `Retry-After`.
**Expected:** SDK respects `Retry-After`; retries within policy; clean failure after attempts exhausted.
**Status:** [ ]

## UAT-FAIL-004 | Context window exceeded
**Surface:** SDK 🟢
**Steps:** Submit a turn that exceeds the model's context window.
**Expected:** `isContextSizeExceededError` returns true; user sees actionable error message.
**Status:** [ ]

## UAT-FAIL-005 | Malformed server response
**Surface:** SDK 🟢
**Steps:** Proxy daemon through a tool that corrupts response body.
**Expected:** SDK surfaces parse error with structured info; does not crash.
**Status:** [ ]

## UAT-FAIL-006 | WRFC chain max-fix-attempts reached
**Surface:** SDK + TUI 🟢
**Steps:** Force reviewer to always score < threshold.
**Expected:** After max attempts, chain halts; user notified; goodvibes memory updated with failure.
**Status:** [ ]

---

# Section 19 — Observability

## UAT-OBS-001 | Goodvibes logs written
**Surface:** SDK + TUI 🟢
**Steps:** Run any WRFC.
**Expected:** `.goodvibes/logs/activity.md`, `decisions.md`, `errors.md` populated as appropriate.
**Status:** [ ]

## UAT-OBS-002 | Goodvibes memory written
**Surface:** SDK + TUI 🟢
**Steps:** Run a WRFC cycle.
**Expected:** `.goodvibes/memory/decisions.json`, `patterns.json`, `failures.json`, `preferences.json` updated as appropriate.
**Status:** [ ]

## UAT-OBS-003 | Runtime event bus emits expected events for a turn
**Surface:** SDK 🟢
**Steps:** Attach a bus subscriber; run a turn.
**Expected:** Receives `TURN_STARTED`, N×`STREAM_DELTA`, `TURN_COMPLETED` (or error variant).
**Status:** [ ]

---

# Sign-off checklist

- [ ] All 🟢 **Live** tests pass at `@pellux/goodvibes-sdk@<current>` + `@pellux/goodvibes-tui@<current>`
- [ ] All 🟡 **Dev** surface tests pass when that surface ships
- [ ] All 🔜 **Planned** surface tests pass when that surface ships
- [ ] No known critical or major open defects
- [ ] CHANGELOG documents every regression caught by UAT
- [ ] Owner explicit sign-off

Upon full sign-off → bump both `@pellux/goodvibes-sdk` and `@pellux/goodvibes-tui` to `1.0.0` via the standard release workflow.

---

# Section 20 — Daemon API Coverage (added post-route-audit)

The original plan covered auth, providers, sessions, chat, middleware, realtime, MCP, TUI, APK, web, CF, Slack, Discord, CLI, persistence, security, release, failure, observability. The daemon control plane exposes 213 method routes plus feature routers (companion-chat, session-SSE, /login, /config, /task, /schedules). This section covers the API surfaces the original plan did not. Grouped by domain. Each TC states the method, endpoint, an explicit expected shape, and marks admin-only scope where it applies.

## UAT-ACCT-001 | GET /api/accounts — provider/channel posture snapshot
**Surface:** Daemon HTTP 🟢
**Steps:** `GET /api/accounts` with auth.
**Expected:** 200 with provider + channel posture; fields include accounts list (per provider), totals, problems.
**Status:** [ ]

## UAT-APPROV-001 | Approvals list
**Surface:** Daemon HTTP 🟢
**Steps:** `GET /api/approvals`.
**Expected:** 200 with approvals array; each has id, kind, status, requestedAt.
**Status:** [ ]

## UAT-APPROV-002 | Approve / deny / cancel / claim
**Surface:** Daemon HTTP 🟢 (admin)
**Steps:** For each: `POST /api/approvals/{id}/approve|deny|cancel|claim` on a pending approval (create one first via an agent tool that requires approval, or use a synthetic approval).
**Expected:** 200 with updated approval state; prior status → new status transition valid; forbidden transitions return 4xx.
**Status:** [ ]

## UAT-ART-001 | Artifact CRUD
**Surface:** Daemon HTTP 🟢
**Steps:** `POST /api/artifacts` with `{kind,name,content}`; `GET /api/artifacts` to list; `GET /api/artifacts/:id`; `GET /api/artifacts/:id/content`.
**Expected:** Create returns id + metadata. List contains it. Get returns metadata. Content endpoint returns the raw content with correct content-type.
**Status:** [ ]

## UAT-AUTO-001 | Automation snapshot + job CRUD
**Surface:** Daemon HTTP 🟢
**Steps:** `GET /api/automation`; `GET /api/automation/jobs`; `POST /api/automation/jobs` with minimal job spec; `PATCH /api/automation/jobs/:id`; `POST /api/automation/jobs/:id/disable|enable|pause|resume|run`; `DELETE /api/automation/jobs/:id`.
**Expected:** Snapshot contains counts. Job create returns id. Lifecycle transitions succeed. Run queues a run; `GET /api/automation/runs` shows it.
**Status:** [ ]

## UAT-AUTO-002 | Run cancel + retry
**Surface:** Daemon HTTP 🟢
**Steps:** Start a long-running automation run; `POST /api/automation/runs/:id/cancel`; then `POST /api/automation/runs/:id/retry`.
**Expected:** Cancel transitions run to cancelled. Retry creates a new run record.
**Status:** [ ]

## UAT-AUTO-003 | Heartbeat
**Surface:** Daemon HTTP 🟢
**Steps:** `POST /api/automation/heartbeat`; `GET /api/automation/heartbeat`.
**Expected:** POST accepted; GET reflects latest heartbeat timestamp.
**Status:** [ ]

## UAT-CHAN-001 | Channels: list accounts / actions / agent-tools / capabilities / policies / status / tools
**Surface:** Daemon HTTP 🟢
**Steps:** `GET /api/channels/accounts`, `/actions`, `/agent-tools`, `/capabilities`, `/policies`, `/status`, `/tools`, `/policies/audit`.
**Expected:** Each returns 200 with domain-appropriate payload (arrays or maps keyed by surface).
**Status:** [ ]

## UAT-CHAN-002 | Channels surface query
**Surface:** Daemon HTTP 🟢
**Steps:** For each live surface (webhook, etc.), `GET /api/channels/capabilities/:surface`, `/directory/:surface`, `/doctor/:surface`, `/lifecycle/:surface`, `/setup/:surface`, `/repair-actions/:surface`, `/tools/:surface`, `/agent-tools/:surface`, `/actions/:surface`, `/accounts/:surface`.
**Expected:** Each returns 200 with surface-scoped results; disabled surfaces return capabilities metadata without data.
**Status:** [ ]

## UAT-CHAN-003 | Channels action invocation
**Surface:** Daemon HTTP 🟢
**Steps:** `POST /api/channels/actions/:surface/:actionId` with a valid action payload on an enabled surface (webhook is live).
**Expected:** 200/202 with action result; invalid action id returns 404; invalid payload returns 400 with field detail.
**Status:** [ ]

## UAT-CHAN-004 | Channels allowlist edit + resolve
**Surface:** Daemon HTTP 🟢
**Steps:** `POST /api/channels/allowlist/:surface/edit` with an allowlist mutation; `POST /api/channels/allowlist/:surface/resolve`.
**Expected:** Edit persists; resolve returns the effective allowlist for the surface.
**Status:** [ ]

## UAT-CHAN-005 | Channels authorize / lifecycle migrate
**Surface:** Daemon HTTP 🟢
**Steps:** `POST /api/channels/authorize/:surface`; `POST /api/channels/lifecycle/:surface/migrate`.
**Expected:** Authorize transitions surface to authorized state; migrate updates lifecycle version.
**Status:** [ ]

## UAT-CHAN-006 | Channels policies update
**Surface:** Daemon HTTP 🟢
**Steps:** `POST /api/channels/policies/:surface` with a policy patch.
**Expected:** Policy persisted; `GET /api/channels/policies` reflects change.
**Status:** [ ]

## UAT-CHAN-007 | Channel tool invocation
**Surface:** Daemon HTTP 🟢
**Steps:** `POST /api/channels/tools/:surface/:toolId` with tool args.
**Expected:** 200 with tool result; ANSI sanitized; errors structured.
**Status:** [ ]

## UAT-CONT-001 | Continuity snapshot
**Surface:** Daemon HTTP 🟢
**Steps:** `GET /api/continuity`.
**Expected:** 200 with continuity state (session tokens, pending reconnects, etc.).
**Status:** [ ]

## UAT-CPM-001 | Control-plane clients list
**Surface:** Daemon HTTP 🟢
**Steps:** `GET /api/control-plane/clients`.
**Expected:** Array of currently-connected clients (SSE + WS); entries have id, principal, connectedAt, transport.
**Status:** [ ]

## UAT-CPM-002 | Control-plane contract
**Surface:** Daemon HTTP 🟢
**Steps:** `GET /api/control-plane/contract`.
**Expected:** Operator-facing contract JSON (methods + events catalog).
**Status:** [ ]

## UAT-CPM-003 | Methods registry
**Surface:** Daemon HTTP 🟢
**Steps:** `GET /api/control-plane/methods` and `GET /api/control-plane/methods/:methodId`.
**Expected:** List returns 200 with `.methods[]`. Per-method get returns the same shape for one method; unknown id returns 404.
**Status:** [ ]

## UAT-CPM-004 | Events catalog
**Surface:** Daemon HTTP 🟢
**Steps:** `GET /api/control-plane/events/catalog`.
**Expected:** 200 with event catalog keyed by domain; each event has id, domain, schema reference.
**Status:** [ ]

## UAT-CPM-005 | Control-plane snapshot + web + messages
**Surface:** Daemon HTTP 🟢
**Steps:** `GET /api/control-plane`, `GET /api/control-plane/web`, `GET /api/control-plane/messages`.
**Expected:** Snapshot returns aggregate state. `web` returns operator web-UI bootstrap payload. `messages` returns control-plane message log.
**Status:** [ ]

## UAT-CPM-006 | Control-plane events SSE
**Surface:** Daemon SSE 🟢
**Steps:** `GET /api/control-plane/events` as SSE; optionally `?domains=session,tasks,providers`.
**Expected:** First frame `event: ready` with clientId + subscribed domains; subsequent events stream; connection survives until closed.
**Status:** [ ]

## UAT-CPM-007 | Control-plane WS
**Surface:** Daemon WS 🟢
**Steps:** Open WS to `/api/control-plane/ws` with bearer token or session cookie.
**Expected:** Handshake accepted; auth frame accepted; duplex messaging works; same envelope format as SSE.
**Status:** [ ]

## UAT-DELIV-001 | Deliveries
**Surface:** Daemon HTTP 🟢
**Steps:** `GET /api/deliveries` and `GET /api/deliveries/:id`.
**Expected:** List returns delivery records (outbound channel messages); get returns single record.
**Status:** [ ]

## UAT-HEALTH-001 | Health snapshot shape
**Surface:** Daemon HTTP 🟢
**Steps:** `GET /api/health`.
**Expected:** 200 with `{overall, degradedDomains, providerProblems, mcpProblems, integrationProblems, network:{controlPlane, httpListener, operator, ...}}`.
**Status:** [ ]

## UAT-INT-001 | Intelligence snapshot
**Surface:** Daemon HTTP 🟢
**Steps:** `GET /api/intelligence`.
**Expected:** 200 with intelligence state (tokens, costs, provider load, etc.).
**Status:** [ ]

## UAT-KB-001 | Knowledge status + integration snapshot
**Surface:** Daemon HTTP 🟢
**Steps:** `GET /api/knowledge/status`.
**Expected:** 200 with subsystem readiness + counts.
**Status:** [ ]

## UAT-KB-002 | Sources / connectors / schedules list
**Surface:** Daemon HTTP 🟢
**Steps:** `GET /api/knowledge/sources`, `/connectors`, `/schedules`.
**Expected:** Each 200 with arrays.
**Status:** [ ]

## UAT-KB-003 | Ingest flows
**Surface:** Daemon HTTP 🟢
**Steps:** `POST /api/knowledge/ingest/url` with a valid URL; then `/ingest/urls` (batch); `/ingest/bookmarks`; `/ingest/artifact`; `/ingest/connector`.
**Expected:** Each returns 202 with a job id or synchronous result; `GET /api/knowledge/jobs` shows the job.
**Status:** [ ]

## UAT-KB-004 | Search / packet / reindex / projections
**Surface:** Daemon HTTP 🟢
**Steps:** `POST /api/knowledge/search` with a query; `POST /api/knowledge/packet`; `POST /api/knowledge/reindex`; `POST /api/knowledge/projections/materialize` + `/render`.
**Expected:** Each returns domain-appropriate payload. Reindex returns a job id or status.
**Status:** [ ]

## UAT-KB-005 | GraphQL schema + execute
**Surface:** Daemon HTTP 🟢
**Steps:** `GET /api/knowledge/graphql/schema`; `POST /api/knowledge/graphql` with a trivial query `{ __typename }`.
**Expected:** Schema returns SDL. Query returns 200 with `data.__typename`.
**Status:** [ ]

## UAT-KB-006 | Candidates / nodes / items / extractions / projections / reports / issues / usage / job-runs / lint
**Surface:** Daemon HTTP 🟢
**Steps:** For each: `GET /api/knowledge/candidates`, `/candidates/:id`, `/nodes`, `/items/:id`, `/extractions`, `/extractions/:id`, `/projections`, `/reports`, `/reports/:id`, `/issues`, `/usage`, `/job-runs`; `POST /api/knowledge/candidates/:id/decide`; `POST /api/knowledge/lint`.
**Expected:** Each returns 200 with appropriate payload shape; decide transitions candidate state.
**Status:** [ ]

## UAT-KB-007 | Schedules create / enable / delete
**Surface:** Daemon HTTP 🟢
**Steps:** `POST /api/knowledge/schedules` with schedule config; `POST /api/knowledge/schedules/:id/enabled`; `DELETE /api/knowledge/schedules/:id`.
**Expected:** Schedule created; enable flag toggles; delete removes.
**Status:** [ ]

## UAT-LA-001 | Local auth: status + users
**Surface:** Daemon HTTP 🟢 (admin)
**Steps:** `GET /api/local-auth`; `POST /api/local-auth/users` with new username/password; `POST /api/local-auth/users/:username/password`; `DELETE /api/local-auth/users/:username`.
**Expected:** Status returns users count + bootstrap state. Create user succeeds; password rotate succeeds; delete succeeds (except for last admin).
**Status:** [ ]

## UAT-LA-002 | Local auth: bootstrap file delete + sessions delete
**Surface:** Daemon HTTP 🟢 (admin)
**Steps:** `DELETE /api/local-auth/bootstrap-file`; `DELETE /api/local-auth/sessions/:sessionId`.
**Expected:** Bootstrap file removed (idempotent). Session invalidated; subsequent requests with that cookie return 401.
**Status:** [ ]

## UAT-MEDIA-001 | Media providers + generate / analyze / transform
**Surface:** Daemon HTTP 🟢
**Steps:** `GET /api/media/providers`; `POST /api/media/analyze` with an image ref; `POST /api/media/generate` with a prompt; `POST /api/media/transform` with an image + op.
**Expected:** Providers list returns configured media providers. Analyze / generate / transform return 200 with artifact refs or error if no provider configured.
**Status:** [ ]

## UAT-MEM-001 | Memory doctor + vector + embeddings
**Surface:** Daemon HTTP 🟢
**Steps:** `GET /api/memory/doctor`; `GET /api/memory/vector`; `POST /api/memory/vector/rebuild`; `POST /api/memory/embeddings/default` with `{providerId}`.
**Expected:** Doctor returns health checks. Vector stats return counts. Rebuild returns job id. Set-default persists config.
**Status:** [ ]

## UAT-MM-001 | Multimodal status + providers + analyze / packet / writeback
**Surface:** Daemon HTTP 🟢
**Steps:** `GET /api/multimodal`; `GET /api/multimodal/providers`; `POST /api/multimodal/analyze`; `POST /api/multimodal/packet`; `POST /api/multimodal/writeback`.
**Expected:** Status + providers list. Analyze returns structured multimodal response. Packet assembles artifact bundle. Writeback persists artifact.
**Status:** [ ]

## UAT-PANELS-001 | Panel list covers all 5 categories
**Surface:** Daemon HTTP 🟢 / TUI
**Steps:** `GET /api/panels`.
**Expected:** 200 with `{panels:[54]}` covering categories `agent (7), ai (3), development (6), monitoring (34), session (4)`. Each panel has `{id, name, category, description, open}`.
**Status:** [ ]

## UAT-PANELS-002 | Panel open
**Surface:** Daemon HTTP 🟢 / TUI
**Steps:** `POST /api/panels/open` with `{panelId}` for one panel from each category.
**Expected:** 200; panel state flips to `open:true`; TUI renders it (if open); close works similarly.
**Status:** [ ]

## UAT-REMOTE-001 | Remote snapshot + peers + node-host contract
**Surface:** Daemon HTTP 🟢
**Steps:** `GET /api/remote`; `GET /api/remote/peers`; `GET /api/remote/node-host/contract`.
**Expected:** Snapshot includes peers list + pairing state. Peers list has current companion token owner. Contract returns the node-host op contract.
**Status:** [ ]

## UAT-REMOTE-002 | Peer token lifecycle
**Surface:** Daemon HTTP 🟢 (admin)
**Steps:** `POST /api/remote/peers/:peerId/token/rotate`; then re-auth with new token; `POST /api/remote/peers/:peerId/token/revoke`.
**Expected:** Rotate issues new token; old 401s within leeway. Revoke invalidates peer completely.
**Status:** [ ]

## UAT-REMOTE-003 | Peer disconnect + invoke
**Surface:** Daemon HTTP 🟢
**Steps:** `POST /api/remote/peers/:peerId/disconnect`; `POST /api/remote/peers/:peerId/invoke` with a method + args.
**Expected:** Disconnect drops peer session. Invoke routes a method call to the peer and returns its response.
**Status:** [ ]

## UAT-REMOTE-004 | Pair requests list / approve / reject
**Surface:** Daemon HTTP 🟢 (admin)
**Steps:** Initiate a pair request from a companion; `GET /api/remote/pair/requests`; `POST /api/remote/pair/requests/:id/approve`; repeat with reject for a second request.
**Expected:** List shows pending request(s). Approve issues token; reject drops the request with reason.
**Status:** [ ]

## UAT-REMOTE-005 | Work pull / complete / cancel (node-host protocol)
**Surface:** Daemon HTTP 🟢 (peer token)
**Steps:** Simulate a peer pulling work: `POST /api/remote/work/pull`; complete: `POST /api/remote/work/:workId/complete`; cancel: `POST /api/remote/work/:workId/cancel`.
**Expected:** Pull returns a work item or 204 if none. Complete records result. Cancel aborts.
**Status:** [ ]

## UAT-ROUTES-001 | Routes snapshot + bindings CRUD
**Surface:** Daemon HTTP 🟢
**Steps:** `GET /api/routes`; `GET /api/routes/bindings`; `POST /api/routes/bindings` create; `PATCH /api/routes/bindings/:id`; `DELETE /api/routes/bindings/:id`.
**Expected:** Each operation succeeds with expected state transitions.
**Status:** [ ]

## UAT-SERVICE-001 | Service lifecycle
**Surface:** Daemon HTTP 🟢 (admin, host service)
**Steps:** `GET /api/service/status`; `POST /api/service/start|stop|restart|install|uninstall` (run in a non-destructive order in a disposable env).
**Expected:** Status transitions reflect lifecycle. On systems without service-install capability: clean 4xx with hint.
**Status:** [ ]

## UAT-SESS-INT-001 | Sessions integration snapshot
**Surface:** Daemon HTTP 🟢
**Steps:** `GET /api/session`.
**Expected:** 200 with integration-level session snapshot (counts per kind, active surface id, etc.).
**Status:** [ ]

## UAT-SESS-INPUTS-001 | Session inputs list
**Surface:** Daemon HTTP 🟢
**Steps:** `GET /api/sessions/:id/inputs`.
**Expected:** 200 with inputs array (user-submitted messages + task submissions); each has id, kind, status.
**Status:** [ ]

## UAT-TASKS-001 | Tasks CRUD + retry + cancel
**Surface:** Daemon HTTP 🟢
**Steps:** `POST /task` create; `GET /api/tasks`; `GET /api/tasks/:id`; `POST /api/tasks/:id/cancel`; `POST /api/tasks/:id/retry`; `GET /task/:agentId`.
**Expected:** Create returns id + status; list + get work; cancel + retry move state; status-by-agent returns current task for agent.
**Status:** [ ]

## UAT-TEL-001 | Telemetry snapshot + metrics + traces + errors + events + stream
**Surface:** Daemon HTTP 🟢
**Steps:** `GET /api/v1/telemetry`, `/metrics`, `/traces`, `/errors`, `/events`, `/stream` (SSE).
**Expected:** Each returns domain-appropriate payload. Stream opens SSE with live telemetry frames.
**Status:** [ ]

## UAT-TEL-002 | OTLP endpoints
**Surface:** Daemon HTTP 🟢
**Steps:** `GET /api/v1/telemetry/otlp/v1/logs|metrics|traces`.
**Expected:** Each returns 200 (or an OTLP-compatible shape) if OTLP is enabled; else clean 404/501.
**Status:** [ ]

## UAT-VOICE-001 | Voice providers + voices + status
**Surface:** Daemon HTTP 🟢
**Steps:** `GET /api/voice`, `/voice/providers`, `/voice/voices`.
**Expected:** Status has subsystem readiness. Providers list configured voice providers. Voices list available TTS voices per provider.
**Status:** [ ]

## UAT-VOICE-002 | STT / TTS / realtime session
**Surface:** Daemon HTTP 🟢
**Steps:** `POST /api/voice/stt` with a short audio clip (or empty body if clip not available, to probe input validation); `POST /api/voice/tts` with a text string; `POST /api/voice/realtime/session` to open a realtime handle.
**Expected:** STT returns transcript (or clean validation error). TTS returns audio artifact ref. Realtime session returns a session id + endpoint.
**Status:** [ ]

## UAT-WATCH-001 | Watchers CRUD + start / stop / run
**Surface:** Daemon HTTP 🟢
**Steps:** `GET /api/watchers`; `POST /api/watchers` with a spec (body: `{"label":"<name>","kind":"poll","intervalMs":60000}` — **field is `label`, not `name`**); `PATCH /api/watchers/:id`; `POST /api/watchers/:id/start|stop|run`; `DELETE /api/watchers/:id`.
**Expected:** Lifecycle works. Run fires the watcher once and returns outcome. POST returns `{id, kind, label, state, ...}` — watcher id is derived from the `label` value.
**Status:** [ ]
**Note (F18):** The watcher creation body requires `label` (not `name`). Posting `{"name":...}` will be accepted but the `name` field is ignored; the response will include `label` not `name`.

## UAT-WS-001 | Web search query
**Surface:** Daemon HTTP 🟢
**Steps:** `GET /api/web-search/providers`; `POST /api/web-search/query` with `{query:"hello"}`.
**Expected:** Providers list. Query returns 200 with results or clean provider-unavailable error.
**Status:** [ ]

## UAT-WT-001 | Worktrees snapshot
**Surface:** Daemon HTTP 🟢
**Steps:** `GET /api/worktrees`.
**Expected:** 200 with worktree list (git worktrees the daemon tracks).
**Status:** [ ]

## UAT-SCHED-001 | Schedules list + CRUD + lifecycle
**Surface:** Daemon HTTP 🟢
**Steps:** `GET /schedules`; `POST /schedules` create; `POST /schedules/:id/enable|disable|run`; `DELETE /schedules/:id`.
**Expected:** Each action moves state as expected. Run triggers an immediate execution.
**Status:** [ ]

## UAT-CFG-001 | Config get + set
**Surface:** Daemon HTTP 🟢 (admin for set)
**Steps:** `GET /config`; `POST /config` with `{key:"display.theme",value:"vaporwave"}` (or any benign leaf).
**Expected:** Get returns full config. Set returns 200 and the set leaf is observed in the next get.
**Status:** [ ]

## UAT-STATUS-001 | Alias endpoints
**Surface:** Daemon HTTP 🟢
**Steps:** `GET /status` (control.status alias).
**Expected:** 200 with a concise status payload aligned with /api/health overall.
**Status:** [ ]

---

# Section 21 — Feature & Behavior Coverage

Product-level tests beyond raw endpoint presence. These assert that the system behaves as intended when the feature is exercised end-to-end.

## UAT-BEH-001 | TUI input box → real turn → streaming response
**Surface:** TUI 🟢
**Steps:** From the TUI prompt, type "say hi" and press Enter.
**Expected:** User message appears immediately; assistant response streams as deltas (not a single blob); `TURN_COMPLETED` fires; conversation history persists the exchange.
**Status:** [ ]

## UAT-BEH-002 | Slash commands registry
**Surface:** TUI 🟢
**Steps:** Type `/` in the input box.
**Expected:** Slash-command menu opens; includes built-ins (e.g. `/help`, `/model`, `/panels`, `/session`) and any registered custom commands; filtering by typing narrows the list; Enter invokes the command.
**Status:** [ ]

## UAT-BEH-003 | Panel lifecycle in TUI
**Surface:** TUI 🟢
**Steps:** Open a monitoring panel (e.g. `/panels providers`), observe live data, close it.
**Expected:** Panel opens; receives domain events; closes cleanly with no zombie subscription in `/api/control-plane/clients`.
**Status:** [ ]

## UAT-BEH-004 | Conversation branching
**Surface:** TUI 🟢 / Daemon
**Steps:** Edit a prior user message mid-conversation to fork a branch.
**Expected:** Prior messages preserved; new branch active; branch switcher exposes both; each branch has its own message list.
**Status:** [ ]

## UAT-BEH-005 | Auto-compaction at threshold
**Surface:** TUI 🟢
**Steps:** Fill a conversation to the configured compaction threshold (e.g. 80%).
**Expected:** Auto-compact fires once; older turns summarized; current turn continues without loss of recent context; user notified of compaction.
**Status:** [ ]

## UAT-BEH-006 | MCP tool execution end-to-end
**Surface:** Daemon + TUI 🟢
**Steps:** Enable an MCP server; provoke the agent to call one of its tools.
**Expected:** Tool invocation routed to MCP server; result returned; output ANSI-sanitized; trust-mode enforcement visible (prompt or auto).
**Status:** [ ]

## UAT-BEH-007 | Agent spawning via WRFC
**Surface:** Daemon + TUI 🟢
**Steps:** Submit a task whose resolution requires multiple agent phases.
**Expected:** Orchestrator spawns work agent; runtime emits `spawn` directive; review/fix cycle runs until score >= threshold; commit directive fires; activity + memory written to `.goodvibes/`.
**Status:** [ ]

## UAT-BEH-008 | Provider failover
**Surface:** SDK + Daemon 🟢
**Steps:** Configure a primary provider; simulate primary 5xx; configure a fallback.
**Expected:** Failover selects fallback after retry budget exhausted; turn completes on fallback; event surface logs the switch.
**Status:** [ ]

## UAT-BEH-009 | Cancel mid-turn
**Surface:** TUI + Daemon 🟢
**Steps:** Start a long turn, press Esc (or use `/cancel`).
**Expected:** Cancel cascade halts streaming; partial response preserved; session state is `cancelled` not `errored`; subsequent input accepted.
**Status:** [ ]

## UAT-BEH-010 | Settings modal persistence
**Surface:** TUI 🟢
**Steps:** Open settings, change a value (e.g. `display.theme`), close; restart TUI.
**Expected:** Value persisted via `/config` or settings store; survives restart; reflected in `GET /config`.
**Status:** [ ]

## UAT-BEH-011 | QR pairing round-trip
**Surface:** TUI + companion 🟢
**Steps:** Open QR panel; companion scans; approve pair request.
**Expected:** QR renders correctly (scan-readable); pair request appears in `/api/remote/pair/requests`; approve issues companion token; companion can subsequently authenticate.
**Status:** [ ]

## UAT-BEH-012 | Operator approvals flow
**Surface:** Operator UI / Daemon 🟢
**Steps:** Trigger an agent action that requires approval; observe approval; approve; run continues.
**Expected:** Approval appears in `/api/approvals`; agent blocks until decision; approval resolves state; run continues or terminates correctly.
**Status:** [ ]

## UAT-BEH-013 | Artifact create → reference in agent output
**Surface:** Daemon + TUI 🟢
**Steps:** Agent produces a large output; check it's persisted as an artifact and referenced by id.
**Expected:** Artifact created via `/api/artifacts`; id appears in message; content retrievable via `/api/artifacts/:id/content`.
**Status:** [ ]

## UAT-BEH-014 | Token usage accounting
**Surface:** Daemon 🟢
**Steps:** Run a known-length turn; fetch `/api/providers/:id/usage` before and after.
**Expected:** Usage counters incremented by the expected input + output token counts (within 5% tolerance for tokenizer drift).
**Status:** [ ]

## UAT-BEH-015 | Memory write + retrieve
**Surface:** SDK / Daemon 🟢
**Steps:** Save a memory via the memory API (through agent tool or direct API); retrieve via search.
**Expected:** Memory persisted in `.goodvibes/memory/*.json`; vector index updated; search returns it with reasonable score.
**Status:** [ ]

## UAT-BEH-016 | Knowledge ingest + search round-trip
**Surface:** Daemon 🟢
**Steps:** `POST /api/knowledge/ingest/url`; wait for job completion; `POST /api/knowledge/search` for a phrase from the ingested content.
**Expected:** Ingest produces extractions + items; search returns the ingested doc.
**Status:** [ ]

## UAT-BEH-017 | Automation job end-to-end
**Surface:** Daemon 🟢
**Steps:** Create a trivial automation job; enable; run; observe run in `/api/automation/runs`; inspect result.
**Expected:** Job executes; run recorded; result visible; re-run behaves idempotently.
**Status:** [ ]

## UAT-BEH-018 | Watcher trigger
**Surface:** Daemon 🟢
**Steps:** Create a watcher on a condition; trigger the condition; observe fired execution.
**Expected:** Watcher detects condition; executes configured action; run recorded.
**Status:** [ ]

## UAT-BEH-019 | Schedule trigger
**Surface:** Daemon 🟢
**Steps:** Create a schedule with near-future cron; wait; confirm firing.
**Expected:** Schedule fires at the expected time; disable prevents future fires.
**Status:** [ ]

## UAT-BEH-020 | Channel round-trip (webhook surface)
**Surface:** Daemon 🟢
**Steps:** POST to the configured inbound webhook; observe ingress handling; check delivery records; trigger outbound egress.
**Expected:** Inbound creates a session input or delivery record; outbound produces a delivery.
**Status:** [ ]

## UAT-BEH-021 | Session SSE survives network blip
**Surface:** Daemon + consumer 🟢
**Steps:** Open `/api/sessions/:id/events`; kill network briefly; restore.
**Expected:** Consumer reconnects with `Last-Event-ID`; no duplicate events; no dropped events within resume window.
**Status:** [ ]

## UAT-BEH-022 | Streaming delta ordering
**Surface:** Daemon + TUI 🟢
**Steps:** Run a long multi-paragraph response.
**Expected:** Deltas arrive in order; no interleaving corruption; final combined text matches `TURN_COMPLETED` payload.
**Status:** [ ]

## UAT-BEH-023 | Tool-use inside a turn
**Surface:** Daemon + TUI 🟢
**Steps:** Provoke a turn that uses a tool (e.g. asks agent to read a file).
**Expected:** Tool call event + tool result event stream before final assistant message; TUI renders tool preview panel if enabled.
**Status:** [ ]

## UAT-BEH-024 | Intelligence costs/tokens panel populates
**Surface:** TUI 🟢
**Steps:** Run several turns; open `cost` panel.
**Expected:** Panel shows running totals of tokens + cost; matches `/api/providers/:id/usage`.
**Status:** [ ]

## UAT-BEH-025 | Git panel reflects repo state
**Surface:** TUI 🟢
**Steps:** Make a local change in the workspace; open git panel.
**Expected:** Panel reflects status (modified/untracked) live; refreshes when the file tree changes.
**Status:** [ ]

## UAT-BEH-026 | Symbols panel lists project symbols
**Surface:** TUI 🟢
**Steps:** Open `symbols` panel; navigate to a symbol.
**Expected:** Panel populated; selecting a symbol jumps to source.
**Status:** [ ]

## UAT-BEH-027 | Accounts panel reflects provider config tiers
**Surface:** TUI 🟢
**Steps:** Open `accounts` panel.
**Expected:** Each provider shown with `configuredVia` tier (env / secrets / subscription / anonymous).
**Status:** [ ]

## UAT-BEH-028 | Hooks panel shows registered hooks
**Surface:** TUI 🟢
**Steps:** Open `hooks` panel.
**Expected:** Panel lists registered lifecycle hooks with enabled state; toggling persists to settings.
**Status:** [ ]

## UAT-BEH-029 | Plugins panel shows installed plugins
**Surface:** TUI 🟢
**Steps:** Open `plugins` panel.
**Expected:** Panel lists plugins; version, status, source; enable/disable toggles work.
**Status:** [ ]

## UAT-BEH-030 | WRFC panel shows chain state
**Surface:** TUI 🟢
**Steps:** Run a task that starts a WRFC chain; open `wrfc` panel.
**Expected:** Panel shows current phase (work/review/fix/commit), score, attempts count; live-updates.
**Status:** [ ]

## UAT-BEH-031 | Forensics panel records recent agent failures
**Surface:** TUI 🟢
**Steps:** Force an agent failure; open `forensics` panel.
**Expected:** Failure appears with root cause, timestamp, agent id; entries correlate to `/api/v1/telemetry/errors`.
**Status:** [ ]

## UAT-BEH-032 | Marketplace panel shows available plugins/skills
**Surface:** TUI 🟢
**Steps:** Open `marketplace` panel.
**Expected:** Panel lists available plugins from configured marketplace source.
**Status:** [ ]

## UAT-BEH-033 | Sandbox panel reflects current mode
**Surface:** TUI 🟢
**Steps:** Open `sandbox` panel.
**Expected:** Panel shows current sandbox mode (off/on); toggle requires explicit user confirmation; reflects `/config` `.sandbox` value.
**Status:** [ ]

## UAT-BEH-034 | Session switcher lists all sessions
**Surface:** TUI 🟢
**Steps:** Open `sessions` panel.
**Expected:** Shows sessions from `/api/sessions` with kind/status; selecting one activates it.
**Status:** [ ]

## UAT-BEH-035 | Docs panel serves doc packets
**Surface:** TUI 🟢
**Steps:** Open `docs` panel.
**Expected:** Renders in-app docs (getting-started, commands, panels).
**Status:** [ ]

## UAT-BEH-036 | Welcome panel appears on first run
**Surface:** TUI 🟢
**Steps:** Launch TUI with a fresh workspace.
**Expected:** Welcome panel opens with pairing QR, quick links, and first-run hints; dismiss persists across sessions.
**Status:** [ ]

## UAT-BEH-037 | Incident panel captures critical errors
**Surface:** TUI 🟢
**Steps:** Provoke a critical runtime error.
**Expected:** Incident created; visible in panel; escalation path documented.
**Status:** [ ]

## UAT-BEH-038 | Settings-sync panel status
**Surface:** TUI 🟢
**Steps:** Open `settings-sync` panel.
**Expected:** Shows sync status between profiles / hosts if configured; else shows "disabled".
**Status:** [ ]

## UAT-BEH-039 | Subscription panel shows entitlement
**Surface:** TUI 🟢
**Steps:** Open `subscription` panel.
**Expected:** Displays current subscription tier and feature entitlements.
**Status:** [ ]

## UAT-BEH-040 | Skills panel lists registered skills
**Surface:** TUI 🟢
**Steps:** Open `skills` panel.
**Expected:** Lists goodvibes skills with tier and status.
**Status:** [ ]
