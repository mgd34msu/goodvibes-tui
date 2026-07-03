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

Home Graph is the Home Assistant-specific knowledge layer for devices, entities, areas, integrations, manuals, generated pages, facts, issues, and refinement tasks. Home Assistant clients should send snapshots, URLs, notes, artifacts, links, and review actions to the daemon rather than duplicating graph storage, source inventory, wiki/export/import behavior, or fact review queues.

Home Graph uses Home Assistant-specific routes and storage. Regular `/api/knowledge/*` and `/knowledge` surfaces are for the default Knowledge/Wiki instance and must not show Home Graph records by default.

Runtime stores are intentionally separate:

```text
regular Knowledge/Wiki: knowledge-wiki.sqlite
Home Assistant Home Graph: knowledge-home-graph.sqlite
legacy shared store: knowledge.sqlite is not read by either runtime store
```

Use `/api/homeassistant/home-graph/*` for Home Graph data. Use `/api/knowledge/*` for regular Knowledge/Wiki data. Do not use `includeAllSpaces` as a substitute for Home Graph browse/ask/map routes.

The Home Graph namespace is isolated per Home Assistant installation:

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
POST /api/homeassistant/home-graph/reset
POST /api/homeassistant/home-graph/refinement/run
POST /api/homeassistant/home-graph/refinement/tasks/{id}/cancel
```

Read routes accept `installationId` or `knowledgeSpaceId`. List and browse routes also accept `limit`; issue listing also accepts `status`, `severity`, and `code`. `GET /api/homeassistant/home-graph/status` includes Home Graph readiness and refinement counts so clients can show whether the graph is ready, needs source work, has active repair tasks, or has review-needed tasks.

### Client Rendering Rules

TUI and companion clients should render the SDK-returned fields directly:

- Ask responses: `answer.text`, `answer.synthesized`, `answer.sources`, `answer.facts`, `answer.gaps`, `answer.linkedObjects`, `answer.refinementTaskIds`, and `answer.refinement`.
- Map responses: SDK-provided nodes, edges, facets, filters, source/target ids, and source/target titles.
- Pages responses: generated page metadata and markdown returned by the SDK.
- Refinement task responses: task ids, status, reason, `nextRepairAttemptAt`, traces, linked source/object metadata, and budget/coalescing fields.

Do not locally infer Home Assistant facet names, object identity, source quality, fact quality, or refinement state. Build controls from returned facets and task records, then pass selected filters back to the SDK.

Home Graph answers are designed to be responsive. If evidence is weak, Ask should return the current best answer plus gaps/refinement task ids instead of blocking indefinitely. Repair and enrichment continue through durable refinement tasks.

### Refinement And Reindex

The TUI daemon composes the SDK Home Graph service with the SDK web-backed semantic gap repairer. Refinement tasks can search for candidate repair sources, ingest accepted sources, promote subject-linked facts, refresh generated pages, and continue the SDK refinement state machine.

Operational expectations:

- Reindex reparses stored sources and regenerates graph/page projections without requiring upload again.
- Ask-created gaps can queue bounded repair work and return refinement task ids.
- Concurrent repair/reindex work should coalesce rather than stacking duplicate repair loops.
- Broad refinement runs should report budget/truncation fields instead of pinning the daemon.
- A task blocked with `No semantic gap repairer is configured` indicates a stale daemon or host composition bug, not a Home Assistant client issue.

### Artifact Ingest

Home Graph artifact ingest accepts the same large-upload bodies as the generic artifact and knowledge routes:

- Use `multipart/form-data` with field name `file` for browser, panel, and integration file pickers.
- Use a raw binary request body for the most direct large-file path; set `Content-Type` and pass the filename as `filename` or `X-GoodVibes-Filename`.
- Additional text fields can include `installationId`, `knowledgeSpaceId`, `title`, `tags`, `target`, and `metadata`.
- Browser-facing Home Assistant bridges must proxy multipart/raw bodies to `/api/homeassistant/home-graph/ingest/artifact` without exposing the daemon token and without converting file bytes into JSON.

PDF/manual extraction, source scoring, fact promotion, boilerplate filtering, generated-page refresh, and source-backed answer synthesis are SDK-owned. Clients should reindex existing uploads after extractor or semantic-repair upgrades rather than reuploading unless the source content itself changed.

## Secrets

Prefer GoodVibes secret references or environment-backed secrets for Home Assistant credentials:

```text
goodvibes://secrets/goodvibes/GOODVIBES_SURFACES_HOMEASSISTANT_ACCESS_TOKEN
goodvibes://secrets/goodvibes/GOODVIBES_SURFACES_HOMEASSISTANT_WEBHOOK_SECRET
```

The SDK also recognizes environment fallbacks such as `HOMEASSISTANT_ACCESS_TOKEN`, `HOME_ASSISTANT_ACCESS_TOKEN`, `HA_ACCESS_TOKEN`, `HOMEASSISTANT_URL`, `HOME_ASSISTANT_URL`, `HA_URL`, `HOMEASSISTANT_WEBHOOK_SECRET`, `HOME_ASSISTANT_WEBHOOK_SECRET`, and `HA_GOODVIBES_WEBHOOK_SECRET`.
