# Knowledge, artifacts, and multimodal

## Context layers

GoodVibes uses three distinct context layers:

- session memory for lightweight current-session notes
- durable reviewed memory in SQLite for reuse, review, export, and task-time injection
- a structured knowledge store with sources, nodes, edges, issues, extractions, usage records, consolidation candidates and reports, schedules, GraphQL, and projections

These layers work together rather than collapsing everything into transcript history.

## Durable memory

Durable memory records support:

- review state
- confidence
- provenance
- links between records
- scoped reuse across session, project, and team contexts
- queue/review/promote workflows

Representative record classes include:

- decisions
- constraints
- incidents
- patterns
- facts
- risks
- runbooks
- architecture
- ownership

## Structured knowledge

The knowledge runtime supports:

- URL ingest
- bookmark import
- browser-local history/bookmark ingest, only after explicit user consent
- URL-list import
- artifact ingest
- connector-based ingest
- search
- packet building
- linting
- reindex
- projection rendering/materialization
- scheduled jobs
- consolidation candidates and reports
- source-backed semantic ask answers with returned sources, facts, linked objects, gaps, confidence, and synthesized state

The system is designed as a reviewed, self-improving knowledge store for future task context.

Regular Knowledge/Wiki and Home Assistant Home Graph are separate runtime instances. Regular knowledge routes use the default Knowledge/Wiki store. Home Graph data is accessed through `/api/homeassistant/home-graph/*` and lives in the Home Graph store. Do not use `includeAllSpaces` as a way to browse Home Graph from the regular Knowledge/Wiki surface; Home Graph has its own browse, map, pages, ask, refinement, and review routes.

## Semantic ask

The SDK owns semantic question answering through:

- `POST /api/knowledge/ask`
- operator method `knowledge.ask`
- local TUI command `/knowledge ask <query> [--space <knowledgeSpaceId>] [--limit <n>] [--mode <concise|standard|detailed>]`

SDK-owned semantic enrichment supports provider-backed LLM extraction with timeout, abort, and concurrency controls. Broad reindex caps LLM attempts and then continues with deterministic extraction, so hosts should wire the SDK semantic service rather than implementing their own timeout or concurrency shim.

TUI rendering should display the answer object returned by the SDK:

- `answer.text`
- `answer.sources`
- `answer.facts`
- `answer.linkedObjects`
- `answer.gaps`
- `answer.confidence`
- `answer.synthesized`

Do not reformat search results into local answer snippets. The SDK response is the answer contract; the TUI only presents it.

## Durable refinement

SDK 0.28.0 adds durable semantic refinement tasks for the base knowledge layer. Refinement records preserve the gap, subject, state, trace, source assessments, blocked reasons, accepted facts, rejected evidence, and follow-up state so clients can explain what the knowledge system attempted instead of only reporting "skipped".

SDK 0.28.1 makes refinement runs budget-aware and non-blocking for user-facing routes. Ask routes should answer from current evidence and return `refinementTaskIds` when repair work is queued or still running. Reindex should queue repair instead of waiting for every repair to finish. Broad `refinement/run` calls cap effective work per run and report truncation or budget exhaustion rather than pinning the daemon. Stale `searching` or `evaluating` tasks older than the SDK recovery window are moved back to a retriable blocked state on the next run.

SDK 0.28.2 fixes the published dist guardrail path for refinement budgets. Runtime dist uses 12 refinement gaps as the default run size and 24 as the maximum effective limit. It also reopens historical `No semantic gap repairer is configured` tasks once the host has wired the SDK web-backed repairer, so old blocked tasks should no longer look like current host composition failures after a run reaches them.

SDK 0.28.3 coalesces overlapping semantic repair runs so repeated or concurrent refinement triggers should be bounded instead of piling up duplicate repair work. Home Graph repair-source metadata now preserves `linkedObjects` through answer rendering.

Daemon routes:

```text
GET  /api/knowledge/refinement/tasks
GET  /api/knowledge/refinement/tasks/{id}
POST /api/knowledge/refinement/run
POST /api/knowledge/refinement/tasks/{id}/cancel
```

The list route accepts filters such as `knowledgeSpaceId` or `spaceId`, `state`, `subjectKind`, `subjectId`, `gapId`, and `limit`. `POST /api/knowledge/refinement/run` is admin-gated and accepts `knowledgeSpaceId` or `spaceId`, optional `gapIds`, optional `sourceIds`, `limit`, and `force`.

Use these SDK routes directly for task inspection and manual repair runs. Do not duplicate the refinement state machine in the TUI.

The TUI daemon runtime wires SDK semantic refinement to the SDK web gap repairer. Gap repair uses the configured GoodVibes web search providers for source discovery and the knowledge ingest service for accepted repair sources. If web search providers are unavailable or disabled, tasks may still become blocked by search/provider readiness, but they should not report `No semantic gap repairer is configured`.

## Issue review

Knowledge issues can be reviewed through the local TUI command and the daemon/operator surfaces:

- `/knowledge review-issue <issueId> <accept|reject|resolve|reopen|edit|forget> [--reviewer <name>] [--value <json-object>]`
- `POST /api/knowledge/issues/{id}/review`
- operator method `knowledge.issue.review`

Review actions update the issue state through the SDK. `accept`, `reject`, `resolve`, and `forget` mark the issue resolved; `reopen` and `edit` return it to open. Optional JSON values can supply reviewed source or node facts for SDK-owned application.

## Connectors and extractors

Connectors provide the front door for ingest ideas such as:

- single URLs
- bookmark exports
- browser-local history and bookmark profiles
- URL lists
- artifacts
- future source-specific connectors

Built-in extractors cover:

- HTML
- Readability-backed article extraction for suitable HTML pages
- text
- markdown
- JSON
- CSV / TSV
- XML
- YAML
- PDF text
- DOCX
- XLSX
- PPTX

## Embeddings and retrieval

The knowledge/memory runtime uses sqlite-vec with a pluggable embedding registry. Current embedding providers include:

- local hashed embeddings
- OpenAI
- OpenAI-compatible / LM Studio
- Gemini
- Mistral
- Ollama

The runtime uses these for:

- semantic recall
- knowledge packet selection
- review and search support

### The sqlite-vec native addon

Semantic search runs on the `sqlite-vec` native extension, which the runtime
loads from `<install-dir>/lib/sqlite-vec-<os>-<arch>/vec0.<suffix>` next to the
running binary. Every install channel ships it:

- **npm / Bun installs** carry it inside the platform-specific
  `@pellux/goodvibes-tui-<os>-<arch>` package and vendor it beside the binaries.
- **The pure-binary installer** (`curl -fsSL https://goodvibes.sh/install.sh | sh`)
  downloads the platform's addon as a checksum-verified release asset
  (`sqlite-vec-<os>-<arch>.<suffix>`, covered by `SHA256SUMS.txt`) and places it
  in `lib/` next to `goodvibes`, `goodvibes-daemon`, and `goodvibes-agent`. One
  copy serves all three. `/update` refreshes it in the same download-verify-swap
  pass as the binaries, so it never goes stale beside a new build. Set
  `GOODVIBES_VECTOR=0` to skip installing it.

**macOS limitation:** on macOS, `bun:sqlite` links Apple's system SQLite, which
ships with extension loading disabled. The addon is still installed for
consistency (and would work if a future runtime lifts the limit), but the
runtime reports the vector index as unavailable and memory search degrades to
literal matching. This is a permanent platform capability limit, not a
packaging defect. `/recall vector status` names the reason plainly. Linux
(including WSL2) has no such restriction.

## GraphQL and projections

The knowledge domain exposes:

- GraphQL schema and execution surfaces
- projection targets
- overview pages
- rollups
- backlinks
- source-health views
- exportable markdown/wiki-style materializations

The canonical store is the structured knowledge database. GraphQL and projections are query and presentation surfaces on top of it.

## Artifacts

Artifacts are first-class runtime objects. The artifact store handles:

- markdown
- text
- JSON
- CSV
- spreadsheets
- PDFs
- images
- audio
- video
- generated outputs

Artifacts can be:

- ingested
- stored
- retrieved
- delivered through channels
- reused by knowledge and multimodal pipelines

Large file uploads should use daemon upload bodies rather than JSON inline data:

- `POST /api/artifacts` accepts multipart/form-data with field name `file`.
- `POST /api/artifacts` accepts raw binary bodies with `Content-Type` set and the filename supplied with `filename` query params or `X-GoodVibes-Filename`.
- `POST /api/knowledge/ingest/artifact` accepts existing artifact references, daemon-local paths, remote URIs, multipart files, and raw binary uploads.
- Keep JSON `dataBase64` only for small inline control payloads. PDFs, photos, archives, and large documents should use multipart or raw upload bodies.

The host-side artifact storage cap is configured with `storage.artifacts.maxBytes`. The default is 512 MiB.

## Multimodal

The unified multimodal runtime handles:

- image analysis
- audio analysis through STT-backed paths
- video analysis through keyframe/transcript fusion
- document analysis through extractors and packet building

It also supports:

- packet building
- optional write-back into structured knowledge
- provider routing across media and voice subsystems

## Jobs and schedules

Knowledge jobs include:

- `lint`
- `reindex`
- `refresh-stale`
- `refresh-bookmarks`
- `rebuild-projections`
- `semantic-self-improvement`
- `light-consolidation`
- `deep-consolidation`

These can be run directly or saved as schedules through the runtime.

## High-signal commands

- `/recall add|search|queue|review|explain|promote|capture`
- `/knowledge status|ask|ingest-url|import-bookmarks|import-urls|search|get|queue|review-issue|candidates|reports|schedules|lint|packet|explain|reindex|consolidate`
- `/memory-sync`
- `/handoff`
- `/session-memory`
- `/team-memory`

## Related docs

- [Providers and routing](providers-and-routing.md)
- [Channels, remote runtime, and API](channels-remote-and-api.md)
- [Tools and commands](tools-and-commands.md)
