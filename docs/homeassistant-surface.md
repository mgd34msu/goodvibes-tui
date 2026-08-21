# Home Assistant surface

GoodVibes can expose a Home Assistant companion surface through the daemon. The TUI owns onboarding, settings, and auto-start selection; the SDK daemon owns Home Assistant API calls, callback verification, tool/action metadata, and event delivery.

## Onboarding

Select `Connect GoodVibes to external apps and services`, then select `Home Assistant surface`. Each field on the dedicated setup screen writes one config key:

| Field | Writes | Notes |
| --- | --- | --- |
| Auto-start this surface | `surfaces.homeassistant.enabled` | |
| Home Assistant URL | `surfaces.homeassistant.instanceUrl` | |
| Home Assistant access token | `surfaces.homeassistant.accessToken` | Raw values are stored as `goodvibes://` secret refs through the wizard secret policy |
| Home Assistant webhook secret | `surfaces.homeassistant.webhookSecret` | |
| Default conversation ID | `surfaces.homeassistant.defaultConversationId` | |
| Remote session idle TTL | `surfaces.homeassistant.remoteSessionTtlMs` | Defaults to 20 minutes |
| Device ID and device name | `surfaces.homeassistant.deviceId` / `deviceName` | Identify the GoodVibes daemon inside Home Assistant metadata |
| Event type | `surfaces.homeassistant.eventType` | Defaults to `goodvibes_message` for daemon-to-Home Assistant events |

If auto-start is set to `No`, the setup values are saved but the surface stays idle until `surfaces.homeassistant.enabled` is turned on from Settings > Surfaces.

## Settings

Home Assistant values are also editable after onboarding:

- `/settings` or `/config surfaces.homeassistant.instanceUrl` opens the fullscreen configuration workspace with the Home Assistant settings available under `Surfaces`.
- Edit `surfaces.homeassistant.instanceUrl` inline from the `Surfaces` category to update the instance URL.
- Edit `surfaces.homeassistant.accessToken` from the same workspace to store raw token input in the GoodVibes user secret store and write a `goodvibes://secrets/goodvibes/...` reference to config.
- Edit `surfaces.homeassistant.webhookSecret` from the same workspace to use the same secret-backed persistence path.

Clearing or resetting a Home Assistant secret-backed config key removes the derived GoodVibes user secret when possible. Existing `goodvibes://secrets/env/...`, `goodvibes://secrets/file/...`, and `goodvibes://secrets/goodvibes/...` references are preserved as references rather than copied.

## Daemon contract

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

| Field | Holds |
| --- | --- |
| `mode` | Always `"remote-chat"` |
| `assistant.text` | The assistant's display text |
| `assistant.speechText` | The speech-oriented rendering of the same reply |
| `sessionId`, `messageId`, `replyToMessageId`, `conversationId`, `routeId` | Correlation identifiers |

Home Assistant clients should not expect `agentId` for Assist chat; the correlation identifiers above are the way to tie responses together.

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

Read routes (all under `/api/homeassistant/home-graph`):

| Route | Serves |
| --- | --- |
| `GET .../status` | Graph readiness and refinement counts |
| `GET .../issues` | The issue list |
| `GET .../sources` | The source inventory |
| `GET .../browse` | Graph browsing |
| `GET .../map` | The graph map (nodes, edges, facets) |
| `GET .../pages` | Generated pages |
| `GET .../refinement/tasks` and `GET .../refinement/tasks/{id}` | Refinement task list and detail |
| `POST .../export` | Graph export |
| `POST .../ask` | Source-backed semantic answers |

Admin routes (same prefix):

| Route | Does |
| --- | --- |
| `POST .../sync` | Sync a Home Assistant snapshot into the graph |
| `POST .../ingest/url`, `.../ingest/note`, `.../ingest/artifact` | Ingest a URL, a note, or an artifact |
| `POST .../link` and `POST .../unlink` | Link or unlink graph objects |
| `POST .../device-passport` | Generate a device passport page |
| `POST .../room-page` | Generate a room page |
| `POST .../packet` | Build a context packet from the graph |
| `POST .../facts/review` | Review queued facts |
| `POST .../import` | Import a graph export |
| `POST .../reindex` | Reparse stored sources and regenerate projections |
| `POST .../reset` | Reset the graph store |
| `POST .../refinement/run` and `POST .../refinement/tasks/{id}/cancel` | Run or cancel refinement work |

Read routes accept `installationId` or `knowledgeSpaceId`. List and browse routes also accept `limit`; issue listing also accepts `status`, `severity`, and `code`. `GET /api/homeassistant/home-graph/status` includes Home Graph readiness and refinement counts so clients can show whether the graph is ready, needs source work, has active repair tasks, or has review-needed tasks.

### Client rendering rules

TUI and companion clients should render the SDK-returned fields directly:

- Ask responses: `answer.text`, `answer.synthesized`, `answer.sources`, `answer.facts`, `answer.gaps`, `answer.linkedObjects`, `answer.refinementTaskIds`, and `answer.refinement`.
- Map responses: SDK-provided nodes, edges, facets, filters, source/target ids, and source/target titles.
- Pages responses: generated page metadata and markdown returned by the SDK.
- Refinement task responses: task ids, status, reason, `nextRepairAttemptAt`, traces, linked source/object metadata, and budget/coalescing fields.

Do not locally infer Home Assistant facet names, object identity, source quality, fact quality, or refinement state. Build controls from returned facets and task records, then pass selected filters back to the SDK.

Home Graph answers are designed to be responsive. If evidence is weak, Ask should return the current best answer plus gaps/refinement task ids instead of blocking indefinitely. Repair and enrichment continue through durable refinement tasks.

### Refinement and reindex

The TUI daemon composes the SDK Home Graph service with the SDK web-backed semantic gap repairer. Refinement tasks can search for candidate repair sources, ingest accepted sources, promote subject-linked facts, refresh generated pages, and continue the SDK refinement state machine.

Operational expectations:

- Reindex reparses stored sources and regenerates graph/page projections without requiring upload again.
- Ask-created gaps can queue bounded repair work and return refinement task ids.
- Concurrent repair/reindex work should coalesce rather than stacking duplicate repair loops.
- Broad refinement runs should report budget/truncation fields instead of pinning the daemon.
- A task blocked with `No semantic gap repairer is configured` indicates a stale daemon or host composition bug, not a Home Assistant client issue.

### Artifact ingest

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
