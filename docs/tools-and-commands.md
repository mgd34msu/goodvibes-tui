# Tools and Commands

## Built-in tools

GoodVibes ships a broad built-in tool set. Current tool families include:

- file and code operations: `read`, `write`, `edit`, `find`
- execution and inspection: `exec`, `analyze`, `inspect`
- network and research: `fetch`, `web_search`
- orchestration: `agent`, `workflow`, `task`, `team`, `worklist`
- runtime/control surfaces: `state`, `registry`, `control`, `channel`, `remote`
- external integration surfaces: `mcp`
- structured query/eval surfaces: `repl`, `query`, `packet`

The tool registry is part of the main runtime and is shared across the TUI, agents, automation, and daemon-backed flows.

## High-value tool families

### File and code work

- `read` for token-efficient file reading, outlines, symbols, AST views, and paginated batch reads
- `write` for atomic writes, overwrite modes, and auto-heal pipelines
- `edit` for structural code edits with validation and rollback
- `find` for files, content, symbols, references, and structural search

### Execution and analysis

- `exec` for shell execution, background processes, retries, and process tracking
- `analyze` for impact, dependencies, dead code, upgrade, semantic diff, and security checks
- `inspect` for project/frontend/runtime inspection

### Research and retrieval

- `fetch` for HTTP retrieval and extraction
- `web_search` for provider-backed search and evidence shaping
- `packet` for compact knowledge/context packets
- `query` and `repl` for bounded query/eval work

### Coordination and product control

- `agent` for in-process agent work
- `workflow` for WRFC and related execution flows
- `remote` for distributed runtime control
- `channel` for channel-aware runtime and delivery surfaces
- `control` and `state` for product/runtime introspection

## Slash-command families

Representative slash-command families include:

- `/model`
- `/settings`
- `/config`
- `/recall`
- `/knowledge`
- `/remote`
- `/sandbox`
- `/plugin`
- `/marketplace`
- `/workflow`
- `/schedule`
- `/voice`
- `/tts`
- `/cloudflare`
- `/mcp`
- `/incident`
- `/replay`
- `/eval`

`/model` opens the fullscreen provider/model workspace. The left rail chooses the target route (`Main Chat`, `Helper Model`, `Tool LLM`, or `TTS LLM`), and the main table filters large model catalogs by search, price tier, capability, availability, benchmark sort, and grouping. `/provider` opens the same workspace in provider-first mode so users can choose a provider and then a model for the active target.

`/plan` now inspects or seeds the TUI-owned project-planning state. The primary planning UX is natural conversation in the TUI; daemon and companion surfaces only get passive SDK storage/evaluation routes. Use `/plan panel` to open the Planning panel, `/plan approve` to record explicit execution approval, or `/plan <goal>` to seed the current workspace planning artifact.

## Operator surfaces

Many commands also have matching panels and control rooms. High-signal examples:

- provider accounts and health
- knowledge and memory review
- remote peers and work queues
- channels and deliveries
- MCP trust and reconnect posture
- approvals, policy, security, and diagnostics
- tasks, orchestration, worktrees, and agents
- WRFC chain state and constraint satisfaction
- project planning readiness, decisions, project language, task graph, verification gates, and agent handoff metadata

## Project planning

Project planning is TUI-owned. When a normal chat turn clearly asks for an implementation plan, dependency graph, verification strategy, or agent handoff, the TUI opens the Planning panel, stores state in the SDK `ProjectPlanningService`, evaluates readiness, and asks one focused planning question before execution.

Planning artifacts are stored in a project knowledge space named `project:<projectId>`, where the project id is derived from the workspace path. The SDK supplies passive daemon routes and operator methods, but daemon/non-TUI surfaces do not enter planning loops.

See [Project planning](project-planning.md) for the panel layout, `/plan` behavior, and route/method list.

## Knowledge Ask

`/knowledge ask <query>` asks the SDK knowledge/wiki layer for a source-backed semantic answer. Use `--space <knowledgeSpaceId>` to target a specific space such as a Home Assistant graph, `--limit <n>` to bound evidence, and `--mode concise|standard|detailed` to select answer detail.

The TUI displays the SDK-returned answer text, sources, facts, linked objects, gaps, confidence, and synthesized state directly. It does not turn search results into local snippets.

## WRFC constraint visibility

The WRFC panel surfaces constraint state at every level of a running chain:

- Each chain renders a constraint badge (`c:N/M`) colored by aggregate satisfaction status (green = all satisfied, grey = unverified, red = unsatisfied; yellow when some constraints are verified and some are still pending).
- Expanding a chain shows each constraint with a status marker: `[SAT]` (satisfied), `[UNS CRIT]` / `[UNS MAJOR]` / `[UNS MINOR]` (unsatisfied, severity-tagged), or `[UNV]` (unverified). Inherited constraints are marked with a trailing ` *`.
- Fix-attempt process-modal rows append `[Nc]` to indicate the number of constraints the fix is targeting.
- The selected-chain summary line shows satisfied/total/inherited counts.
- Controller-flagged synthetic issues (raised by the workflow controller rather than a reviewer) render above reviewer issues under a `[CRITICAL]` "Controller flags" header.
- The agent-detail modal surfaces the `systemPromptAddendum` field from the agent record when it contains a WRFC engineer addendum, so the full constraint injection is visible without leaving the TUI.
- When constraints are loaded, the system-message router emits a `WORKFLOW_CONSTRAINTS_ENUMERATED` operator-visible message. This is routed through the standard `ui.wrfcMessages` setting (`panel`, `conversation`, or `both`).

The `/wrfc` command opens the chain-status view directly. Constraint counts are also visible in the orchestration panel and in `/wrfc` output without opening the full panel.

## Live TTS commands

`/tts <prompt>` submits a normal chat turn and adds live spoken output for that one turn. Text still renders normally in the transcript. Assistant deltas are chunked at sentence or phrase boundaries and streamed through the configured TTS provider.

`/tts stop` cancels active playback and pending TTS requests without deleting the text response.

`/config tts` opens the TTS category in the fullscreen configuration workspace. It manages the defaults used by spoken-output clients:

- `tts.provider`
- `tts.voice`
- `tts.llmProvider`
- `tts.llmModel`

Use the `tts.provider` row to choose a provider with streaming TTS support, the `tts.voice` row to choose a voice, and the `tts.llmProvider` / `tts.llmModel` rows to choose an optional `/tts` response model override through the fullscreen provider/model workspace. Without that override, `/tts` uses the current chat provider/model. Live local playback requires `mpv` or `ffplay` on `PATH`.

## Cloudflare batch commands

Cloudflare integration is optional and keeps local immediate daemon behavior by default. Select `Use Cloudflare for batch or remote daemon work` in onboarding to configure it visually, or use `/cloudflare` for runtime actions.

High-signal commands:

- `/cloudflare status`
- `/cloudflare requirements`
- `/cloudflare create-token --account <account-id> --bootstrap-env <ENV_NAME>`
- `/cloudflare discover`
- `/cloudflare validate`
- `/cloudflare provision --batch-mode explicit`
- `/cloudflare verify`
- `/cloudflare disable`

The TUI calls SDK daemon routes only. It does not call Cloudflare APIs directly. See [Cloudflare batch and control plane](cloudflare-batch.md) for token setup, supported components, and provisioning behavior.

## Workflow-oriented commands

Some command families are especially important when you are running GoodVibes as an operational console rather than just a chat surface:

- `/workflow` for WRFC and related execution chains
- `/schedule` for cron-like and interval-based automation
- `/hooks` for managed hook inspection and simulation
- `/remote` for dispatching and recovering distributed work
- `/sandbox` for isolation review and QEMU/bootstrap flows

## Related docs

- [Getting started](getting-started.md)
- [Deployment and services](deployment-and-services.md)
- [Channels, remote runtime, and API](channels-remote-and-api.md)
