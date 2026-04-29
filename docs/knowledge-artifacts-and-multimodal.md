# Knowledge, Artifacts, and Multimodal

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

The system is designed as a reviewed, self-improving knowledge substrate for future task context.

## Issue Review

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
- `light-consolidation`
- `deep-consolidation`

These can be run directly or saved as schedules through the runtime.

## High-signal commands

- `/recall add|search|queue|review|explain|promote|capture`
- `/knowledge status|ingest-url|import-bookmarks|import-urls|search|get|queue|review-issue|candidates|reports|schedules|lint|packet|explain|reindex|consolidate`
- `/memory-sync`
- `/handoff`
- `/session-memory`
- `/team-memory`

## Related docs

- [Providers and routing](providers-and-routing.md)
- [Channels, remote runtime, and API](channels-remote-and-api.md)
- [Tools and commands](tools-and-commands.md)
