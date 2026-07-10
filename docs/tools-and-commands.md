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
- `/share`
- `/workflow`
- `/schedule`
- `/voice`
- `/tts`
- `/cloudflare`
- `/mcp`
- `/incident`
- `/replay`
- `/eval`
- `/session`
- `/work-plan`
- `/search`
- `/imagine`
- `/codebase`
- `/workstream`
- `/checkpoint`
- `/flags`

`/flags` lists every feature flag grouped by state: enabled, disabled (built but dark), and killed. Each entry shows the flag's name, description, and whether it is runtime-toggleable or startup-only. Toggle a runtime-toggleable flag with `/flags on <id>` or `/flags off <id>` (applied live and persisted); a startup-only flag is saved and applies on next launch. `/flags doctor` lists just the dark subsystems — built flags that are currently disabled — each with the command to switch it on. Interactive toggling also lives in `/settings`.

`/search <query> [--limit <n>]` runs a provider-backed web search directly (bypassing the agent-tool JSON wrapper) and renders ranked results, an instant answer, and the source label into the transcript; it degrades honestly using the web-search service's own status note. `/imagine <prompt>` is the first production caller of the media-provider registry's image generation — on success it persists the artifact (inline bytes stored directly; a remote-URL-only result is stored as a small JSON pointer record rather than eagerly fetched), and prints the registry's own per-provider status (naming the exact env var) when no image-capable provider is configured. (`/image` is a different, pre-existing command — it attaches a local image file to the next message for multimodal analysis.)

`/session` is the single front-door for all session work. Two domains:
- Lifecycle: `list`, `rename`, `resume`, `fork`, `save`, `info`, `export <id|.> [format]`, `search <query>`, `delete <id>`, `events [kind]`, `groups [kind]`, `hotspots`
- Orchestration (cross-session task DAG with cycle detection): `link-task <taskId> [--session <sid>] [--depends-on <sid:taskId>] [--label <label>]`, `handoff <taskId> --to <sid>`, `graph [--session <sid>] [--format text|json]`, `cancel <taskId> [--scope task|subtree|session]`

Alias: `/sess`. Run `/session` with no arguments to see current session info.

`/model` opens the fullscreen provider/model workspace. The left rail chooses the target route (`Main Chat`, `Helper Model`, `Tool LLM`, or `TTS LLM`), and the main table filters large model catalogs by search, price tier, capability, availability, benchmark sort, and grouping. `/provider` opens the same workspace in provider-first mode so users can choose a provider and then a model for the active target.

`/plan` now inspects or seeds the TUI-owned project-planning state. The primary planning UX is natural conversation in the TUI; daemon and companion surfaces only get passive SDK storage/evaluation routes. Use `/plan panel` to open the Planning panel, `/plan approve` to record explicit execution approval, or `/plan <goal>` to seed the current workspace planning artifact.

`/paste` (`/clip`) explicitly reads the system clipboard and inserts supported text or image data into the prompt. Use this when terminal paste does not deliver image clipboard contents to the TUI; the command uses the clipboard helper path instead of relying on the terminal paste stream.

`/mcp` opens the fullscreen MCP workspace. `/mcp add <name> <command> [args...] [--scope project|global]` writes a project server to `.goodvibes/mcp.json` or a global server to `~/.config/mcp/mcp.json`, then reloads the live MCP runtime without restarting. Use `/mcp remove <server> [--scope project|global]`, `/mcp reload`, `/mcp config`, and `/mcp tools [server]` for the same operations from the command line.

## Navigation and keyboard chords

- **F2** opens **and focuses the Fleet panel** (the live unified process tree). It previously opened a standalone process monitor; that modal was retired in an earlier release and Fleet subsumes it.
- **Ctrl+O** also opens and focuses **Fleet** (the retired Ops Control panel now aliases to it).
- **Ctrl+PageUp** / **Ctrl+PageDown** move to the previous / next panel tab. (Ctrl+] remains a second binding for next; the old Ctrl+[ binding was removed because it collided with Escape.)
- **Ctrl+C twice** quits — a single Ctrl+C on an empty composer only arms a ~1s "press again to exit" confirm; the footer advertises this as `Ctrl+C x2 quit`.
- **Alt+1..9** jump directly to the first nine panel tabs (shown as `⌥N` on the tab bar).

## Operator surfaces

> **W6.1 note.** Most operator read/navigate surfaces are now reached as
> **config-modal surfaces** via `ctx.openModal` (or their panel-id modal
> redirect), not standalone panels: providers/health, services, subscription,
> remote, sandbox, settings-sync (WO-A) and marketplace, plugins, skills, hooks,
> policy, security, knowledge, memory, docs→keybindings, qr-code→pairing,
> work-plan, project-planning→planning (WO-B). The runtime-ops consoles
> (cockpit, orchestration, tasks, worktrees, approvals, communication, …)
> redirect to the **Fleet** panel. The command front-doors below are unchanged.

Many commands also have matching panels and control rooms. High-signal examples:

- provider accounts and health (`/health` pillars include `setup`, `services`, `sandbox`, `accounts`, `auth`, `settings`, `remote`, `continuity`, `worktrees`, `maintenance`, and `term` for terminal-capability posture)
- knowledge and memory review
- remote peers and work queues
- channels and deliveries
- MCP trust and reconnect posture
- approvals, policy, security, and diagnostics
- tasks, orchestration, worktrees, and agents
- WRFC chain state and constraint satisfaction
- project planning readiness, decisions, project language, task graph, verification gates, and agent handoff metadata
- persistent work-plan task tracking for ongoing local implementation work

## Project planning

Project planning is TUI-owned. When a normal chat turn clearly asks for an implementation plan, dependency graph, verification strategy, or agent handoff, the TUI opens the Planning panel, stores state in the SDK `ProjectPlanningService`, evaluates readiness, and asks one focused planning question before execution.

Planning artifacts are stored in a project knowledge space named `project:<projectId>`, where the project id is derived from the workspace path. The SDK supplies passive daemon routes and operator methods, but daemon/non-TUI surfaces do not enter planning loops.

See [Project planning](project-planning.md) for the panel layout, `/plan` behavior, and route/method list.

`/work-plan` is the separate persistent checklist surface. Use it when the work already has concrete tasks and you want durable status tracking rather than another planning interview.

## Context maintenance

GoodVibes automatically compacts the conversation context when token usage reaches the configured threshold. The default threshold is 80% (`behavior.autoCompactThreshold`). You can adjust this in Settings → Behavior; the valid range is 10–100.

When auto-compaction fires, a before/after notice appears in the transcript. The current context fill level is shown in the shell footer when usage exceeds 50%.

Use `/compact` to compact manually at any time.

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

Each chain row and the selected-chain summary also show elapsed time (active chains, since `createdAt`) or total duration (terminal chains, `createdAt` to `completedAt`). Press `a` on a selected chain to jump straight to its owner agent in the Inspector panel. When an expanded chain's detail exceeds the panel's per-chain line cap, the truncated tail is replaced with a `+N more` indicator instead of being silently dropped.

The panel's empty state points at the actual chain producer, `/teamwork create-mode <mode> <title>` (modes with `reviewMode: wrfc` — see `/teamwork modes`), rather than a `/wrfc run` command that does not exist.

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

For QEMU guest bootstrapping details, including the generated image script and guest runtime package list, see [QEMU sandbox bootstrapping](qemu-sandbox.md).

## CLI session lifecycle flags

Three flags control which session is active when the TUI opens:

- `--continue` — resumes the most recently active session for the current working directory (reads the last-session pointer file; does nothing when no pointer exists).
- `--resume [id]`, `-r [id]` — resumes a specific session by id. When the id is omitted, resolves via the same last-session pointer as `--continue`.
- `--fork [id]` — forks a session into a new branch. Bare `--fork` forks the session already active when the TUI starts; `--fork <id>` resumes the named session first, then forks it.

Only one of `--continue`, `--resume`, and `--fork` may be used in a single invocation. Combining them is an error.

When a session is resumed, the TUI prints `Resumed session: <id>` with message count and model to the transcript. When a session is forked, it prints `Session forked:` with the new id, fork name, source title, and message count.

See [CLI flags reference](cli-flags.md) for full syntax, inline-value forms, and examples.

## Related docs

- [Getting started](getting-started.md)
- [CLI flags reference](cli-flags.md)
- [/share — session export](share-command.md)
- [Deployment and services](deployment-and-services.md)
- [Channels, remote runtime, and API](channels-remote-and-api.md)
