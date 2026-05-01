# Home Assistant Surface

GoodVibes can expose a Home Assistant companion surface through the daemon. The TUI owns onboarding, settings, and auto-start selection; the SDK daemon owns Home Assistant API calls, callback verification, tool/action metadata, and event delivery.

## Onboarding

Select `Connect GoodVibes to external apps and services`, then select `Home Assistant surface`. The dedicated Home Assistant setup screen includes:

- Auto-start this surface: writes `surfaces.homeassistant.enabled`.
- Home Assistant URL: writes `surfaces.homeassistant.instanceUrl`.
- Home Assistant access token: writes `surfaces.homeassistant.accessToken`; raw values are stored as `goodvibes://` secret refs through the wizard secret policy.
- Home Assistant webhook secret: writes `surfaces.homeassistant.webhookSecret`.
- Default conversation ID: writes `surfaces.homeassistant.defaultConversationId`.
- Remote session idle TTL: writes `surfaces.homeassistant.remoteSessionTtlMs`, defaulting to 20 minutes.
- Device ID and device name: identify the GoodVibes daemon inside Home Assistant metadata.
- Event type: defaults to `goodvibes_message` for daemon-to-Home Assistant events.

If auto-start is set to `No`, the setup values are saved but the surface stays idle until `surfaces.homeassistant.enabled` is turned on from Settings > Surfaces.

## Settings

Home Assistant values are also editable after onboarding:

- `/settings` or `/config surfaces.homeassistant.instanceUrl` opens the fullscreen configuration workspace with the Home Assistant settings available under `Surfaces`.
- Edit `surfaces.homeassistant.instanceUrl` inline from the `Surfaces` category to update the instance URL.
- Edit `surfaces.homeassistant.accessToken` from the same workspace to store raw token input in the GoodVibes user secret store and write a `goodvibes://secrets/goodvibes/...` reference to config.
- Edit `surfaces.homeassistant.webhookSecret` from the same workspace to use the same secret-backed persistence path.

Clearing or resetting a Home Assistant secret-backed config key removes the derived GoodVibes user secret when possible. Existing `goodvibes://secrets/env/...`, `goodvibes://secrets/file/...`, and `goodvibes://secrets/goodvibes/...` references are preserved as references rather than copied.

## Daemon Contract

The inbound callback path is:

```text
/webhook/homeassistant
```

The authenticated Home Assistant conversation routes are:

```text
GET  /api/homeassistant/health
POST /api/homeassistant/conversation
POST /api/homeassistant/conversation/stream
POST /api/homeassistant/conversation/cancel
```

`POST /api/homeassistant/conversation` is the submit-and-wait Assist path for companion clients. `POST /api/homeassistant/conversation/stream` streams the response. `POST /api/homeassistant/conversation/cancel` cancels an active Home Assistant remote conversation. Remote sessions are daemon-owned, isolated from TUI/shared sessions, and close after `surfaces.homeassistant.remoteSessionTtlMs` of inactivity.

Home Assistant conversation responses use the SDK-owned remote-chat contract:

```text
mode: "remote-chat"
assistant.text
assistant.speechText
sessionId
messageId
replyToMessageId
conversationId
routeId
```

Home Assistant clients should not expect `agentId` for Assist chat. Use `sessionId`, `messageId`, `replyToMessageId`, `conversationId`, and `routeId` for correlation.

The SDK advertises Home Assistant account, setup, capabilities, tools, actions, directory, target-resolution metadata, and direct conversation routes through the channel daemon routes. The TUI should not call Home Assistant APIs directly.

Home Assistant ingress is handled as isolated remote-chat work by the SDK daemon. The TUI configures the surface and credentials, but Home Assistant messages should not spawn engineer/reviewer/fixer chains and should not attach to the active TUI/shared session.

## Home Graph

SDK 0.26.0 adds daemon-owned Home Assistant Home Graph state. Home Assistant clients should send snapshots, URLs, notes, artifacts, links, and review actions to the daemon rather than duplicating graph storage, source inventory, wiki/export/import behavior, or fact review queues.

The default knowledge space is isolated per Home Assistant installation:

```text
homeassistant:<installationId>
```

Read routes:

```text
GET  /api/homeassistant/home-graph/status
GET  /api/homeassistant/home-graph/issues
GET  /api/homeassistant/home-graph/sources
GET  /api/homeassistant/home-graph/browse
GET  /api/homeassistant/home-graph/map
GET  /api/homeassistant/home-graph/pages
GET  /api/homeassistant/home-graph/refinement/tasks
GET  /api/homeassistant/home-graph/refinement/tasks/{id}
POST /api/homeassistant/home-graph/export
POST /api/homeassistant/home-graph/ask
```

Admin routes:

```text
POST /api/homeassistant/home-graph/sync
POST /api/homeassistant/home-graph/ingest/url
POST /api/homeassistant/home-graph/ingest/note
POST /api/homeassistant/home-graph/ingest/artifact
POST /api/homeassistant/home-graph/link
POST /api/homeassistant/home-graph/unlink
POST /api/homeassistant/home-graph/device-passport
POST /api/homeassistant/home-graph/room-page
POST /api/homeassistant/home-graph/packet
POST /api/homeassistant/home-graph/facts/review
POST /api/homeassistant/home-graph/import
POST /api/homeassistant/home-graph/reindex
POST /api/homeassistant/home-graph/refinement/run
POST /api/homeassistant/home-graph/refinement/tasks/{id}/cancel
```

Read routes accept `installationId` or `knowledgeSpaceId`. List and browse routes also accept `limit`; issue listing also accepts `status`, `severity`, and `code`. `GET /api/homeassistant/home-graph/status` includes Home Graph readiness and refinement counts so clients can show whether the graph is ready, needs source work, has active repair tasks, or has review-needed tasks.

Home Graph artifact ingest accepts the same large-upload bodies as the generic artifact and knowledge routes:

- Use `multipart/form-data` with field name `file` for browser, panel, and integration file pickers.
- Use a raw binary request body for the most direct large-file path; set `Content-Type` and pass the filename as `filename` or `X-GoodVibes-Filename`.
- Additional text fields can include `installationId`, `knowledgeSpaceId`, `title`, `tags`, `target`, and `metadata`.
- Browser-facing Home Assistant bridges must proxy multipart/raw bodies to `/api/homeassistant/home-graph/ingest/artifact` without exposing the daemon token and without converting file bytes into JSON.

SDK 0.26.7 adds capped searchable extraction text for manuals and documents and uses bounded lightweight Home Graph search for ask responses. Manuals or documents ingested before SDK 0.26.7 should be reingested or reindexed if deep manual details need to be searchable.

SDK 0.26.8 makes Home Graph review decisions durable across refreshes, preserves resolved state for generated issues, applies stricter Home Assistant quality rules, and discovers Home Assistant integration documentation as pending source candidates.

SDK 0.27.2 makes knowledge map filtering and facets SDK-owned. TUI or companion map screens should build filter controls from the `facets` returned by `/api/knowledge/map` or `/api/homeassistant/home-graph/map`, then pass selected values back as map filters. Do not hardcode Home Assistant facet names beyond displaying the SDK-provided `facets.homeAssistant` groups. Home Graph map accepts JSON `POST` and trailing slash requests, and Home Graph ask treats binary/raw-PDF-like extraction text as repair-needed rather than usable answer material.

SDK 0.27.3 improves Home Graph PDF repair and generated-page maintenance. Reindex reparses existing PDF sources with the shared extractor, rejects binary PDF garbage, handles compressed streams, auto-links manuals to matching Home Assistant objects by identity/model, regenerates source-backed pages, and exposes generated pages through `GET /api/homeassistant/home-graph/pages`. Run `POST /api/homeassistant/home-graph/reindex` after updating before retesting older uploaded PDF manuals.

SDK 0.27.4 adds the shared semantic knowledge/wiki layer. Home Graph ask can now return `answer.facts`, `answer.gaps`, and `answer.synthesized` alongside `answer.text`, `answer.sources`, and `answer.linkedObjects`. Home Graph reindex runs semantic enrichment and generated pages include semantic facts. Render those returned answer fields directly rather than building local snippets from `results`.

SDK 0.27.5 keeps semantic behavior SDK-owned while bounding provider-backed LLM work. Home Graph ask passes strict candidate filters into semantic answering, deterministic answer fallback filters facts by query intent, and broad reindex only attempts a capped number of provider-backed semantic enrichments before continuing deterministically.

SDK 0.27.6 tightens semantic evidence ranking for Home Graph answers, separates subject terms from generic feature/spec/support terms, prevents generated semantic pages and facts from becoming Home Graph object anchors, allows deterministic records to upgrade to provider-backed LLM enrichment, hides stale deterministic facts, and suppresses manual boilerplate in feature/spec answers.

SDK 0.27.7 further suppresses low-value semantic answer noise. Home Graph answer linked objects exclude semantic extraction artifacts, feature/spec answers filter weak accessory/setup/safety/manual text, generated Home Graph pages apply the same fact-quality filter, and answer synthesis no longer waits behind synchronous semantic enrichment.

SDK 0.27.8 tightens the shared semantic feature/spec filters again. It removes truncated deterministic fragments, filters more remote-control/button-map, accessory/setup, new-feature/spec-change, maintenance, service/repair, and customer-service boilerplate, and applies the low-value filter to answer synthesis fact prompts as well as source text windows.

SDK 0.28.0 adds durable Home Graph refinement tasks and exposes them through `/api/homeassistant/home-graph/refinement/*`. Home Graph map and pages should continue to render SDK-returned facets, filters, generated pages, readiness, refinement task ids, and answer fields directly. Companion clients should not locally infer map filter names or refinement state; build controls from the returned `facets` and task records.

SDK 0.28.1 keeps Home Graph repair asynchronous for interactive flows. Ask should return quickly with the current evidence plus `answer.refinementTaskIds` when repair is queued. Reindex queues repair work instead of blocking on all repair attempts. Broad refinement runs cap effective work per invocation and report truncation or budget exhaustion. Stale `searching` or `evaluating` tasks older than the SDK recovery window are recovered to retriable blocked state on the next run.

SDK 0.28.2 fixes the published dist guardrail path for Home Graph refinement budgets. Runtime dist now defaults to 12 refinement gaps per run and caps the effective limit at 24. It also reopens historical `No semantic gap repairer is configured` tasks when the TUI daemon has the SDK web-backed repairer wired, so those old blocked tasks should be retried as normal repair candidates rather than treated as evidence of a current host wiring failure.

SDK 0.28.3 preserves Home Graph `linkedObjects` from repair-source metadata and coalesces overlapping semantic repair runs. Concurrent or repeated Refine/Reindex/Ask repair work should therefore return bounded skipped/truncated results instead of stacking duplicate repair execution on the daemon.

The TUI daemon composes the SDK Home Graph service with the SDK web-backed semantic gap repairer. Refinement tasks can therefore search for candidate repair sources, ingest accepted sources into knowledge, and continue the SDK refinement state machine. A task blocked with `No semantic gap repairer is configured` indicates a stale daemon or a host composition bug rather than a Home Assistant client issue.

## Secrets

Prefer GoodVibes secret references or environment-backed secrets for Home Assistant credentials:

```text
goodvibes://secrets/goodvibes/GOODVIBES_SURFACES_HOMEASSISTANT_ACCESS_TOKEN
goodvibes://secrets/goodvibes/GOODVIBES_SURFACES_HOMEASSISTANT_WEBHOOK_SECRET
```

The SDK also recognizes environment fallbacks such as `HOMEASSISTANT_ACCESS_TOKEN`, `HOME_ASSISTANT_ACCESS_TOKEN`, `HA_ACCESS_TOKEN`, `HOMEASSISTANT_URL`, `HOME_ASSISTANT_URL`, `HA_URL`, `HOMEASSISTANT_WEBHOOK_SECRET`, `HOME_ASSISTANT_WEBHOOK_SECRET`, and `HA_GOODVIBES_WEBHOOK_SECRET`.
