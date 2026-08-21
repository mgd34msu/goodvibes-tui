# Knowledge, artifacts, and multimodal

## Context layers

GoodVibes uses three distinct context layers. Session memory holds lightweight notes scoped to
the current session only. Durable memory is reviewed and stored in SQLite so it survives across
sessions, and it supports reuse, review, export, and injection into future tasks. A structured
knowledge store sits alongside both, holding sources, nodes, edges, issues, extractions, usage
records, consolidation candidates and reports, schedules, a GraphQL surface, and projections.

These layers work together rather than collapsing everything into transcript history.

## Durable memory

Durable memory records carry review state, a confidence score, and provenance, and they can link
to other records. They support scoped reuse across session, project, and team contexts, and move
through queue, review, and promote workflows on their way to being treated as reviewed.

Representative record classes include decisions, constraints, incidents, patterns, facts, risks,
runbooks, architecture, and ownership.

## Structured knowledge

The knowledge runtime supports ingest from several sources, including single URLs, bookmark
imports, browser-local history and bookmark profiles (only after explicit user consent), URL
lists, existing artifacts, and connector-based sources. Once content is ingested, it can be searched,
assembled into packets, linted, reindexed, and rendered or materialized as projections, and any
of that work can be saved as a schedule. The store also tracks consolidation candidates and
reports, and it answers semantic questions ("ask") with source-backed responses that return
sources, facts, linked objects, gaps, a confidence score, and whether the answer was synthesized.

The system is designed as a reviewed, self-improving knowledge store for future task context.

Regular Knowledge/Wiki and Home Assistant Home Graph are separate runtime instances. Regular knowledge routes use the default Knowledge/Wiki store. Home Graph data is accessed through `/api/homeassistant/home-graph/*` and lives in the Home Graph store. Do not use `includeAllSpaces` as a way to browse Home Graph from the regular Knowledge/Wiki surface; Home Graph has its own browse, map, pages, ask, refinement, and review routes.

## Semantic ask

The SDK owns semantic question answering through:

- `POST /api/knowledge/ask`
- operator method `knowledge.ask`
- local TUI command `/knowledge ask <query> [--space <knowledgeSpaceId>] [--limit <n>] [--mode <concise|standard|detailed>]`

SDK-owned semantic enrichment supports provider-backed LLM extraction with timeout, abort, and concurrency controls. Broad reindex caps LLM attempts and then continues with deterministic extraction, so hosts should wire the SDK semantic service rather than implementing their own timeout or concurrency shim.

TUI rendering should display the answer object returned by the SDK, every field of it:

| Field | Holds |
| --- | --- |
| `answer.text` | The answer text itself |
| `answer.sources` | The source records backing the answer |
| `answer.facts` | The facts the answer draws on |
| `answer.linkedObjects` | Knowledge objects linked from the answer |
| `answer.gaps` | Gaps the system identified while answering |
| `answer.confidence` | The confidence score |
| `answer.synthesized` | Whether the answer was synthesized rather than directly sourced |

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

Connectors are the front door for ingest, covering single URLs, bookmark exports, browser-local
history and bookmark profiles, URL lists, artifacts, and future source-specific connectors as
they are added.

Built-in extractors cover HTML (including Readability-backed article extraction for suitable
pages), plain text, markdown, JSON, CSV and TSV, XML, YAML, PDF text, DOCX, XLSX, and PPTX.

## Embeddings and retrieval

The knowledge/memory runtime uses sqlite-vec with a pluggable embedding registry. Current
embedding providers include local hashed embeddings, OpenAI, OpenAI-compatible and LM Studio
endpoints, Gemini, Mistral, and Ollama. Whichever provider is configured is used for semantic
recall, knowledge packet selection, and review and search support.

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

The knowledge domain exposes a GraphQL schema and execution surface, alongside projection
targets such as overview pages, rollups, backlinks, source-health views, and exportable markdown
or wiki-style materializations.

The canonical store is the structured knowledge database. GraphQL and projections are query and presentation surfaces on top of it.

## Artifacts

Artifacts are first-class runtime objects. The artifact store handles markdown, text, JSON, CSV,
spreadsheets, PDFs, images, audio, video, and generated outputs. Artifacts can be ingested,
stored, retrieved, delivered through channels, and reused by knowledge and multimodal pipelines.

Large file uploads should use daemon upload bodies rather than JSON inline data:

- `POST /api/artifacts` accepts multipart/form-data with field name `file`.
- `POST /api/artifacts` accepts raw binary bodies with `Content-Type` set and the filename supplied with `filename` query params or `X-GoodVibes-Filename`.
- `POST /api/knowledge/ingest/artifact` accepts existing artifact references, daemon-local paths, remote URIs, multipart files, and raw binary uploads.
- Keep JSON `dataBase64` only for small inline control payloads. PDFs, photos, archives, and large documents should use multipart or raw upload bodies.

The host-side artifact storage cap is configured with `storage.artifacts.maxBytes`. The default is 512 MiB.

## Multimodal

The unified multimodal runtime handles image analysis, audio analysis through speech-to-text
(STT) backed paths, video analysis through keyframe and transcript fusion, and document analysis
through the extractors and packet building described above. It also supports packet building on
its own, optional write-back of results into structured knowledge, and provider routing across
the media and voice subsystems.

## Jobs and schedules

Eight knowledge job kinds can be run directly or saved as schedules through the runtime:

| Job | What it does |
| --- | --- |
| `lint` | Run knowledge health checks and refresh the issue queue |
| `reindex` | Re-run compile and structured memory sync across the current store |
| `refresh-stale` | Recrawl stale, failed, or aging remote sources |
| `refresh-bookmarks` | Recrawl bookmark and URL-list sources to refresh summaries and links |
| `rebuild-projections` | Render and materialize the major derived markdown/wiki projections |
| `semantic-self-improvement` | Classify semantic gaps and repair eligible concrete subjects with corroborated source-backed ingest |
| `light-consolidation` | Score recent usage, refresh candidate promotions, and write a deterministic consolidation report |
| `deep-consolidation` | Run the full consolidation loop, including high-confidence memory promotion and deterministic reporting |

## High-signal commands

Six command families front this whole subsystem:

| Command | Does |
| --- | --- |
| `/recall add\|search\|vector\|queue\|review\|explain\|injections\|promote\|capture` | Durable project memory; these are the subcommands most tasks reach for, and `/recall` has more |
| `/knowledge status\|ask\|ingest-url\|import-bookmarks\|import-urls\|list\|search\|get\|queue\|review-issue\|candidates\|reports\|schedules\|lint\|packet\|explain\|reindex\|consolidate` | The structured knowledge store's full command surface |
| `/memory-sync` | Durable memory export/import and bundle exchange |
| `/handoff` | Reviewable memory handoff bundles (export, inspect, import) |
| `/session-memory` | Session-scoped memory capture and review; all subcommands filtered to session scope |
| `/team-memory` | Team/shared memory review and exchange; queue and export filtered to team scope |

## Related docs

- [Providers and routing](providers-and-routing.md)
- [Channels, remote runtime, and API](channels-remote-and-api.md)
- [Tools and commands](tools-and-commands.md)
