# goodvibes-tui

A terminal-native AI coding and operations console with multi-provider LLM support, typed runtime systems, and a Unicode-rich custom renderer.

Version: **0.15.7**

<!-- screenshot -->

---

## What is this

goodvibes-tui is a serious terminal product in the same broad space as Claude Code, Gemini CLI, and Codex, but it is built around a different set of constraints:

- terminal-native rendering, not a React app inside a terminal
- Unicode-rich, cell-accurate UI primitives
- compact, token-efficient transcript behavior
- operator-facing control rooms for non-conversational state
- explicit runtime visibility for permissions, routing, health, remote execution, and orchestration

The interface is rendered directly to the alternate screen buffer with raw ANSI escape sequences. Conversation, panels, modals, overlays, and the footer all sit on the same renderer foundation instead of mixing framework surfaces with terminal escape hacks.

The runtime is organized around typed store domains, typed runtime events, a shared control plane for permissions and orchestration, and product surfaces for reviewing and repairing state. Agents run in-process with isolated histories, scoped tools, and optional worktrees, while operational state such as MCP posture, provider routing, local auth, remote sessions, settings control-plane state, and task execution is routed into dedicated panels instead of dumped into the main transcript.

---

## Features

### Multi-Provider Models And Routing
- Native OpenAI, Anthropic, Gemini, and InceptionLabs support plus a broad OpenAI-compatible provider layer
- Dynamic model catalog with benchmark metadata, provider auto-registration, custom provider JSON, and hot-reload
- Interactive model and provider pickers with family, capability, availability, and tier filtering
- Synthetic-provider failover that preserves free / paid / subscription boundaries instead of silently mixing billing paths
- Provider account control room with route posture, auth freshness, fallback risk, and recovery actions

### Terminal-Native UI System
- Raw ANSI renderer with no Ink, React, or virtual DOM
- Shared Unicode glyph primitives for borders, cursors, meters, markers, and selection states
- Conversation, panels, and modals built on the same low-level renderer instead of ad hoc surface logic
- Width-aware overlays, stable bottom docking above the prompt, half-height message surfaces, and structured footer layers
- Shared panel workspace layout budgeting so scroll regions use the renderer-owned visible-row budget instead of panel-local `height - N` guesses
- Copy/selection logic that strips decorative gutters and visual scaffolding from clipboard output

### Conversation And Transcript Workflow
- Markdown rendering, syntax highlighting, inline diffs, collapsible blocks, bookmarks, block copy, and block save
- Transcript event navigation by family for operational browsing of long sessions
- Search overlays, compact line-number modes (`all`, `code`, `off`), and block-level collapse/expand
- Presentation routing so non-conversational runtime chatter can live in control-room panels instead of the main transcript
- Tracked assistant-message rendering that supports markdown tables, including tolerant handling of slightly malformed LLM-generated separator rows

### Panels, Control Rooms, And Workspaces
- Split-pane panel system with panel picker, layout control, and keyboard-first focus behavior
- Dedicated control rooms for provider accounts, provider health, local auth, settings sync, remote, MCP, marketplace, orchestration, tasks, intelligence, worktrees, approvals, forensics, security, policy, cockpit, system messages, and more
- Summary-first heavy panels with posture, issues, next actions, and detail regions instead of raw inventories first
- Routed system-message workspace for startup discovery and operational noise that does not belong in the main conversation
- Cross-panel actions between Explorer, Preview, and Symbols so file browsing can open previews and jump to symbol locations directly from panel focus
- Live panels stay subscribed while open, so switching tabs no longer freezes agent/tool/thinking updates until the panel is reopened
- Dedicated `Agents` panel provides a view-only live peek into running agent sessions while the background-process strip remains the fast-access surface below the prompt

### Modal And Selection UX
- Modal stack navigation that unwinds correctly back to the slash-command menu and prior nested modals
- Search/list focus ownership in searchable modals, so typing only targets filter input when that row is actually focused
- Toggleable selection-modal behavior with `Space` / `Enter` for primary actions, `Left` / `Right` for booleans, enums, and numeric adjustments, and `Shift+Left` / `Shift+Right` for step-by-10 number changes
- Slash-command menu close behavior that fully clears command mode and prompt state on `Esc`

### Token And Usage Visibility
- Live thinking-strip token output that continues to advance even when visible response streaming is disabled
- Fresh-input versus cached-context accounting in the footer and token surfaces, so per-turn request counts stop double-counting cache-read tokens while the context bar still reflects the full prompt footprint
- Reasoning-heavy OpenAI/OpenAI-compatible streams now advance live token/output indicators even when providers emit reasoning deltas instead of plain text deltas

### Agents, Tasks, And WRFC
- In-process agents with isolated history, scoped tools, optional worktrees, and structured communication lanes
- Archetype registry that supports built-ins and user-defined markdown archetypes
- Task lifecycle tracking across exec, agent, MCP, plugin, integration, daemon, scheduler, and ACP work
- Automated WRFC loops with review/fix/check chains, configurable gates, and explicit evidence in completion reports
- Built-in planning/strategy layer with execution plans, adaptive plan modes, and status/explain/override controls

### Tools And Intelligence
- Built-in native tools: `read`, `write`, `edit`, `find`, `exec`, `fetch`, `analyze`, `inspect`, `agent`, `state`, `workflow`, `registry`, `task`, `team`, `worklist`, `mcp`, `packet`, `query`, `remote`, `repl`, and `control`
- Native file tooling with notebook-aware read/write/edit, AST-aware editing, validation hooks, undo, and compact output shaping
- Sandbox-backed REPL/eval tooling with bounded JavaScript, TypeScript, Python, SQL, and GraphQL runtimes plus persisted REPL history
- Durable knowledge/memory substrate with reviewable records, provenance, links, scoped export/import, and task-time knowledge injection
- Language intelligence with bundled LSP servers, tree-sitter grammars, diagnostics, symbols, references, hover, and outline support
- Intelligence control room with readiness, workflow entry points, and recovery guidance

### Security, Auth, And Operational Controls
- Prompt / allow-all / custom permission modes with layered evaluation and risk analysis
- Policy bundle loading, signing, verification, divergence simulation, and rule-suggestion flows for permission changes
- Secure-secret hierarchy with `preferred_secure` storage policy by default
- Local daemon/listener auth with bootstrap credentials, local user management, password rotation, session revocation, and review surfaces
- Health, policy, security, and setup control surfaces for reviewing and repairing runtime posture

### Ecosystem, MCP, And Remote
- Curated marketplace, plugin trust model, quarantine engine, rollback flows, recommendations, and product-control commands
- MCP lifecycle with trust posture, quarantine, reconnect behavior, repair flows, and tool projection into the main registry
- Remote runner registry, pool-aware dispatch, replay/review artifacts, and operator-facing remote inspection/recovery surfaces
- Second TUI instances now skip already-owned daemon/listener ports cleanly instead of hanging while trying to start duplicate local services

### Runtime Foundations
- Typed runtime store and typed runtime-event system with domain-specific dispatch instead of ad hoc mutation
- Bootstrap composition root with explicit initialization order
- Session continuity, return-context summaries, knowledge capture, compaction, guidance, diagnostics, notifications, retention, idempotency, and integration-helper APIs
- Feature flags, profiles, profile sync bundles, live settings editing, and UI routing controls for system / operational / WRFC messages
- Performance budgets, panel-health contracts, telemetry exporters, and operator playbooks for stuck turns, reconnect failures, permission deadlocks, plugin degradation, and recovery scenarios

### Evaluation, Replay, And Incident Analysis
- Evaluation harness with built-in suites, baselines, scorecards, and regression gates
- Deterministic replay tooling with load / step / seek / diff / export flows
- Forensics collector and registry with incident bundles, replay mismatch evidence, root-cause summaries, and export/capture flows
- State inspector and telemetry substrate with transition logs, time-travel buffers, hotspot sampling, and local ledger exporters

### Integrations, Notifications, And Delivery
- Slack, Discord, GitHub, and generic webhook integration modules
- Delivery queue, dead-letter handling, delivery classification, and notification routing policies
- Local notification/webhook front doors plus portable remote/session handoff bundles
- Optional voice surface and teleport bundle workflows for adjacent operator experiences
- Managed hook workflows, contract inspection, hook simulation, and cron-like scheduled agent tasks

---

## Supported Providers & Models

Models are sourced dynamically from [models.dev](https://models.dev) — the catalog contains 4,000+ models from 105+ providers. Set an API key and the models appear automatically.

### Registered Providers

The following providers are built in. Native providers (OpenAI, Anthropic, Gemini) use dedicated API implementations; all others use the OpenAI-compatible API.

| Provider | Type | Base URL | Notes |
|----------|------|----------|-------|
| `openai` | Native | `api.openai.com/v1` | GPT-4/GPT-5 family |
| `anthropic` | Native | `api.anthropic.com` | Claude family |
| `gemini` | Native | `generativelanguage.googleapis.com` | Gemini family |
| `inceptionlabs` | OpenAI-compat | `api.inceptionlabs.ai/v1` | Mercury diffusion models |
| `openrouter` | OpenAI-compat | `openrouter.ai/api/v1` | 100+ models, free tier |
| `aihubmix` | OpenAI-compat | `aihubmix.com/v1` | Multi-provider hub, free tier |
| `groq` | OpenAI-compat | `api.groq.com/openai/v1` | LPU inference, free tier |
| `cerebras` | OpenAI-compat | `api.cerebras.ai/v1` | Wafer-scale inference, free |
| `mistral` | OpenAI-compat | `api.mistral.ai/v1` | Mistral/Codestral/Devstral family |
| `ollama-cloud` | OpenAI-compat | `ollama.com/v1` | Cloud-hosted Ollama models |
| `huggingface` | OpenAI-compat | `router.huggingface.co/v1` | HF Inference Router, free tier |
| `nvidia` | OpenAI-compat | `integrate.api.nvidia.com/v1` | NVIDIA NIM, 1000 free credits |
| `llm7` | OpenAI-compat | `api.llm7.io/v1` | Free, no API key required |
| `synthetic` | Failover | — | Virtual provider; routes to best available backend |

**Provider aliases**: The catalog ID `inception` is resolved to `inceptionlabs` automatically.

### Local Server Discovery

goodvibes-tui auto-discovers local inference servers on startup. Supported server types:

- **Ollama** (port 11434)
- **LM Studio** (port 1234)
- **vLLM** (detected via `x-vllm-*` response headers)
- **llama.cpp** / **LocalAI** (detected via server header)
- **Text Generation Inference (TGI)**
- **Jan**, **GPT4All**, **KoboldCpp**, **Aphrodite**

Discovered servers are registered automatically as OpenAI-compatible providers with no configuration required.

### Synthetic Failover Provider

The `synthetic` provider groups the same model across multiple backends under a single selectable entry. When one backend hits a rate limit or error, requests automatically failover to the next — no user action needed. Models are cataloged from models.dev (4,000+ models, 100+ providers) with a 24-hour TTL cache.

Many model providers support configurable reasoning effort levels. Selectable options include: `instant`, `low`, `medium`, `high`.

### Custom Providers

Any OpenAI-compatible API can be added by dropping a JSON file in `~/.goodvibes/tui/providers/`:

```json
{
  "name": "openrouter",
  "displayName": "OpenRouter",
  "type": "openai-compat",
  "baseURL": "https://openrouter.ai/api/v1",
  "apiKeyEnv": "OPENROUTER_API_KEY",
  "models": [
    {
      "id": "anthropic/claude-sonnet-4-6",
      "displayName": "Claude Sonnet 4.6 (via OpenRouter)",
      "description": "Anthropic Claude Sonnet 4.6 via OpenRouter",
      "contextWindow": 200000,
      "capabilities": {
        "toolCalling": true,
        "codeEditing": true,
        "reasoning": true,
        "multimodal": true
      }
    }
  ]
}
```

Provider configs are hot-reloaded on file change. Use the `/add-provider` skill for interactive guided setup with smart defaults for popular providers.

---

## Quick Start

### Prerequisites

- [Bun](https://bun.sh) v1.0 or later
- **Optional**: [Go](https://go.dev) for Go LSP support (gopls auto-installs via `go install`)
- **Optional**: For Rust development, `rust-analyzer` is auto-downloaded from GitHub releases (no Rust toolchain required)

### Install

```sh
git clone https://github.com/mgd34msu/goodvibes-tui.git
cd goodvibes-tui
bun install
```

### Configure API Keys

API keys resolve from environment variables first, then from the GoodVibes secret store. The local store can hold encrypted values directly or provider-backed secret references for Bitwarden, Vaultwarden, Bitwarden Secrets Manager, 1Password, files, and command-backed resolvers.

Set environment variables:

| Provider | Primary Env Var | Accepted Aliases | Type |
|----------|----------------|-----------------|------|
| Anthropic | `ANTHROPIC_API_KEY` | `CLAUDE_API_KEY` | Paid |
| OpenAI | `OPENAI_API_KEY` | `OPENAI_KEY` | Paid |
| Google Gemini | `GEMINI_API_KEY` | `GOOGLE_API_KEY`, `GOOGLE_GEMINI_API_KEY` | Paid |
| InceptionLabs | `INCEPTION_API_KEY` | — | Paid |
| Mistral | `MISTRAL_API_KEY` | — | Paid |
| OpenRouter | `OPENROUTER_API_KEY` | — | Free tier available |
| Groq | `GROQ_API_KEY` | — | Free (LPU inference) |
| Cerebras | `CEREBRAS_API_KEY` | — | Free (wafer-scale inference) |
| AIHubMix | `AIHUBMIX_API_KEY` | — | Free tier (rate-limited) |
| HuggingFace | `HF_API_KEY` | `HUGGINGFACE_API_KEY`, `HF_TOKEN` | Free tier (rate-limited) |
| Ollama Cloud | `OLLAMA_CLOUD_API_KEY` | `OLLAMA_API_KEY` | Free |
| NVIDIA NIM | `NVIDIA_API_KEY` | — | 1000 free credits |
| LLM7 | `LLM7_API_KEY` | — | Free |

Alternatively, store keys encrypted using the `/secrets` command. Environment variables take precedence when both are set:

```sh
/secrets set OPENAI_API_KEY sk-...
```

For self-hosted or external secret managers, link a GoodVibes key to a provider-backed SecretRef:

```sh
/secrets link OPENAI_API_KEY bw://GoodVibes%20OpenAI/password?sessionEnv=BW_SESSION
/secrets link SLACK_BOT_TOKEN vaultwarden://GoodVibes%20Slack/password?server=https%3A%2F%2Fvault.example.test
/secrets link STRIPE_TOKEN bws://00000000-0000-0000-0000-000000000000/value?accessTokenEnv=BWS_ACCESS_TOKEN
/secrets link OPENAI_API_KEY op://Private/GoodVibes%20OpenAI/API%20Key
```

Use `/secrets providers` for supported provider shapes and `/secrets test <secret-ref>` to validate a ref without printing its value.

### Synthetic Failover Provider

The `synthetic` provider groups models available from multiple backends. When one provider hits a rate limit, requests automatically failover to the next — no user intervention needed. To enable failover, set API keys for multiple free providers:

```sh
# Recommended minimum for failover
export GROQ_API_KEY="..."
export HF_API_KEY="..."
export NVIDIA_API_KEY="..."
export OLLAMA_CLOUD_API_KEY="..."
export OPENROUTER_API_KEY="..."
export AIHUBMIX_API_KEY="..."
```

Then select any model from the `synthetic` provider (e.g., `gpt-oss-120b`, `kimi-k2.5`, `qwen-3.5-397b`). See [Synthetic Provider & Intelligent Failover](#synthetic-provider--intelligent-failover) for full details on failover behavior.

### Run

```sh
bun run dev
```

### Build a standalone binary

```sh
bun run build
# outputs dist/goodvibes
```

---

## Synthetic Provider & Intelligent Failover

### What are synthetic models?

Synthetic models are models available from multiple providers, automatically grouped by the system under a single selectable entry. When you pick a synthetic model, the system routes your request to the best available backend — you never need to think about which provider is serving it.

- Models with different naming across providers (e.g., `GPT-4o` vs `gpt 4o`) are automatically merged into one entry
- Each synthetic model shows how many providers are available for failover in the model picker

### Transparent failover

Failover happens automatically, with no user action required:

- **Rate limit (429)** — immediately retries the next provider in the pool
- **Server error (500) or network error** — retries the next provider after a 5-second cooldown
- **Client error (400 Bad Request)** — does NOT trigger failover; the error indicates a problem with the request itself, not the provider
- **All providers temporarily exhausted with short cooldowns (≤120s)** — the system automatically waits for the shortest cooldown to expire and retries

Failover is silent by default. The model name in the status bar does not change when switching backends for the same synthetic model.

### Cross-model failover (free models only)

When every provider for a free synthetic model is exhausted and cooldowns are too long to wait:

- The system automatically falls back to the next-best free model, ranked by benchmark score
- The user is notified inline (non-blocking) about the model change
- This cascading continues until a working free model is found
- Free/paid/subscription tiers never mix — cross-model failover only happens within the free tier

#### **IMPORTANT NOTE**: 
This system is not perfect, and there are ways it could result in charges accruing. 

This includes but is not limited to when a provider moves a model from free to paid and you have kept the goodvibes-tui session running for longer than 24 hours (and have not run a model refresh manually in that time period). The system will not know that the model is now a paid model. 

Refreshes happen automatically if a new session is started (or session is resumed) after the 24-hour TTL expires for the model list. For long-running sessions, please ensure that the models are refreshed daily.

### Paid and subscription model exhaustion

Paid and subscription models do **not** auto-failover to a different model. The user made a deliberate, cost-conscious choice.

When a paid or subscription model is exhausted, the system shows a clear message with recovery options:

- Wait for the cooldown to expire and retry
- Switch to a different model with `/model`
- Switch to a free synthetic model

### Model picker grouping

- Synthetic models are split into **Top Models** (S-tier or A-tier by benchmark) and **All Synthetic**
- Each entry shows the number of providers available (e.g., `4 providers`)
- Quality tier badges [S/A/B/C] are displayed next to model names based on composite benchmark score

---

## Configuration

Configuration is stored in `.goodvibes/config.json` in the current working directory. You can view and edit all settings live using `/config` or the `/settings` modal.

### Key Settings

| Key | Default | Description |
|-----|---------|-------------|
| `display.stream` | `true` | Stream responses token by token |
| `display.lineNumbers` | `off` | Line-number mode: `off`, `code`, or `all` |
| `display.collapseThreshold` | `30` | Lines before a block auto-collapses |
| `display.theme` | `vaporwave` | Color theme |
| `display.showThinking` | `false` | Show model thinking traces |
| `display.showTokenSpeed` | `false` | Show tokens/sec in status bar |
| `provider.model` | `openrouter/free` | Active model ID |
| `provider.reasoningEffort` | `medium` | Reasoning depth for supported models |
| `provider.systemPromptFile` | `` | Path to a custom system prompt file |
| `behavior.autoApprove` | `false` | Auto-approve all tool permission prompts |
| `behavior.autoCompactThreshold` | `80` | Context % before auto-compact triggers |
| `behavior.saveHistory` | `true` | Persist conversation history |
| `behavior.returnContextMode` | `off` | Session return-context mode: `off`, `local`, `assisted` |
| `behavior.guidanceMode` | `minimal` | Operational guidance mode: `off`, `minimal`, `guided` |
| `storage.secretPolicy` | `preferred_secure` | Secret storage policy: prefer secure backing store, fall back when allowed |
| `permissions.mode` | `prompt` | Permission mode: `prompt`, `allow-all`, `custom` |
| `ui.systemMessages` | `panel` | Route general system messages to `panel`, `conversation`, or `both` |
| `ui.operationalMessages` | `panel` | Route operational runtime notices to `panel`, `conversation`, or `both` |
| `ui.wrfcMessages` | `both` | Route WRFC/orchestration updates to `panel`, `conversation`, or `both` |
| `danger.agentRecursion` | `false` | Allow agents to spawn subagents |
| `danger.maxGlobalAgents` | `8` | Max simultaneous agents |
| `danger.daemon` | `false` | Enable daemon mode (POST /task) |
| `danger.httpListener` | `false` | Enable HTTP webhook listener |
| `tools.autoHeal` | `false` | Auto-fix syntax errors on write/edit |
| `tools.hooksFile` | `hooks.json` | Hook configuration file name |
| `cache.enabled` | `true` | Enable provider-aware prompt caching |
| `cache.stableTtl` | `1h` | TTL for stable content (system prompt + tools) |
| `cache.monitorHitRate` | `true` | Track and warn on low cache hit rates |
| `helper.enabled` | `false` | Route grunt work to a cheaper helper model |
| `helper.globalProvider` | `` | Helper model provider (e.g., `ollama`) |
| `helper.globalModel` | `` | Helper model ID (e.g., `llama3.2:3b`) |

### Permission Modes

- **`prompt`** (default) — ask before write, edit, exec, fetch, agent, workflow, and MCP calls
- **`allow-all`** — never prompt, allow everything
- **`custom`** — per-tool overrides using `permissions.tools.<name>` keys

Per-tool values: `allow`, `prompt`, `deny`.

---

## Control Rooms, Routing, And Operator Surfaces

GoodVibes is built around the idea that runtime state should be routed to the right place instead of dumped into the transcript.

The current product ships dedicated workspaces for:

- provider accounts and provider health
- local auth and local service posture
- settings sync and managed-settings review
- remote runners, pools, contracts, and artifacts
- sandbox posture, presets, setup, and recovery
- MCP posture, trust, reconnect, and repair
- marketplace, plugins, hooks, orchestration, tasks, intelligence, worktrees, approvals, and system messages

Heavy operational surfaces are summary-first:

- posture
- current issues
- next actions
- then deeper detail

Routing is configurable with:

- `ui.systemMessages`
- `ui.operationalMessages`
- `ui.wrfcMessages`

This is how startup discovery, runtime notices, and orchestration chatter can be sent to a panel, the conversation, or both.

The notification layer is also policy-aware instead of being a raw append-only log:

- quiet-while-typing suppression
- adaptive batching and burst control
- domain verbosity settings
- panel jump and dismiss actions
- routing decisions that favor control rooms for low-signal operational noise

That routing stack lives under `src/runtime/notifications/*` and is one of the reasons the conversation surface can stay compact even when the runtime is busy.

Underneath those surfaces, GoodVibes uses a typed runtime store backed by `zustand/vanilla`, not a React state tree. Conversation, session, permissions, tasks, agents, orchestration, communication, plugins, MCP, ACP/daemon transport, integrations, intelligence, and other domains are updated through typed dispatch paths rather than arbitrary renderer-local state mutation.

---

## Sandbox, Isolation, And QEMU

GoodVibes includes a real sandbox control plane for both evaluation runtimes and MCP isolation.

Isolation controls:

- REPL isolation: `shared-vm` or `per-runtime-vm`
- MCP isolation: `disabled`, `shared-vm`, `hybrid`, `per-server-vm`
- host posture on Windows: `native-basic` or `require-wsl`
- VM backend: `local` or `qemu`

The QEMU path is productized rather than just being a config stub:

- setup bundle generation
- first-run bootstrap scaffolding
- `qemu-img` image creation helpers
- host-side wrapper generation
- guest-test and wrapper-test validation
- session-backed command execution
- guest bundle export / inspect flows
- setup manifest export / apply flows
- `attach` and `launch-per-command` execution modes

Key commands:

- `/setup sandbox`
- `/sandbox review`
- `/sandbox recommend`
- `/sandbox doctor`
- `/sandbox probe`
- `/sandbox qemu setup <dir>`
- `/sandbox qemu bootstrap <dir> [size-gb]`
- `/sandbox qemu create-image <path> [size-gb]`
- `/sandbox qemu inspect-setup <manifest>`
- `/sandbox qemu apply-setup <manifest>`
- `/sandbox session ...`
- `/sandbox guest-bundle export <path>`
- `/sandbox guest-bundle inspect <path>`

Typical first-run path:

```sh
/sandbox qemu bootstrap .goodvibes/tui/sandbox 20
/sandbox doctor
/sandbox guest-test eval-js
```

---

## Remote, Local Services, And Integration Helpers

### Remote runtime

The remote runtime tracks more than just a live connection:

- runner pools
- runner contracts
- remote review artifacts
- recovery posture
- capability inspection
- rerun-local-from-artifact flows

Key commands:

- `/remote`
- `/remote show <runner>`
- `/remote capabilities [runner]`
- `/remote recover [runner]`
- `/remote dispatch ...`
- `/remote dispatch-pool <pool> ...`
- `/remote export <runner>`
- `/remote artifact show <id>`
- `/remote import <path>`

### Local daemon and HTTP listener

Local service surfaces are opt-in:

- `danger.daemon`
- `danger.httpListener`

They are protected by local auth, which now includes:

- bootstrap credentials written to the bootstrap file
- local user management
- password rotation
- session revocation
- review surfaces in both commands and panels

Key commands:

- `/auth local review`
- `/auth local add-user <username> <password> [roles]`
- `/auth local rotate-password <username> <password>`
- `/auth local revoke-session <token>`
- `/auth local clear-bootstrap-file`

### Integration helpers

GoodVibes also exposes integration-helper APIs for future clients and helpers:

- another GoodVibes instance
- a future web frontend
- setup/auth helpers
- operational integrations that need session, approval, account, or health posture

This layer is meant to expose control/state APIs, not a UI protocol.

The adjacent local-product access layer also includes dedicated front doors for:

- provider login/logout flows
- install and update posture review
- trust review bundles
- bridge status/review/export/import paths
- setup deep links and portable install/update/auth review bundles
- deeplink review and bundle packaging for operator surfaces

Key commands:

- `/login`
- `/logout`
- `/install`
- `/update`
- `/trust`
- `/bridge`
- `/profilesync`

The setup surface is also broader than a single readiness screen:

- onboarding and doctor flows
- service, hook, remote, and sandbox review
- support-bundle export
- setup-transfer export / inspect / import
- deep links for cockpit, security, remote, knowledge, incident, hooks, orchestration, and tasks

---

## Policy, Permissions, And Trust

The permission system is more than a prompt toggle. The runtime includes:

- layered policy evaluation for prefix rules, arg-shape rules, path scope, network scope, and mode constraints
- decision logs for audit and review
- policy preflight review before applying bundles
- rule suggestion generation from actual approval decisions
- policy signing and signature verification
- simulation and divergence reporting for candidate policy bundles before promotion
- policy runtime state with bundle lifecycle, promote, rollback, and diff support

The adjacent trust layer covers:

- plugin trust tiers
- quarantine and degraded posture
- marketplace and MCP trust review
- security/policy control-room surfaces instead of silent background policy changes

This work is implemented under:

- [src/runtime/permissions/index.ts](/home/buzzkill/Projects/goodvibes-tui/src/runtime/permissions/index.ts)
- [src/runtime/plugins/manager.ts](/home/buzzkill/Projects/goodvibes-tui/src/runtime/plugins/manager.ts)
- [src/runtime/plugins/quarantine.ts](/home/buzzkill/Projects/goodvibes-tui/src/runtime/plugins/quarantine.ts)
- [src/runtime/ecosystem/recommendations.ts](/home/buzzkill/Projects/goodvibes-tui/src/runtime/ecosystem/recommendations.ts)

The result is that approvals, policy rollout, trust posture, and plugin degradation are all inspectable product behavior, not opaque internals.

---

## Automation, Hooks, And Scheduling

GoodVibes includes a real automation layer instead of only ad hoc slash commands:

- managed hooks with scaffold, chain, enable/disable, inspect, import/export, and simulation flows
- hook-point contracts with execution authority, mutation/injection permissions, timeout policy, and failure policy metadata
- workflow state machines such as `wrfc`, `fix_loop`, `test_then_fix`, and `review_only`
- cron-like scheduled agent tasks with timezone-aware schedules, missed-run tracking, run history, and manual trigger support
- planning commands with active-plan review, mode/explain/override/status controls, and model-authored execution-plan generation

Key commands:

- `/hooks`
- `/workflow`
- `/schedule`
- `/plan`

These surfaces are implemented across:

- [src/input/commands/hooks-runtime.ts](/home/buzzkill/Projects/goodvibes-tui/src/input/commands/hooks-runtime.ts)
- [src/input/commands/schedule-runtime.ts](/home/buzzkill/Projects/goodvibes-tui/src/input/commands/schedule-runtime.ts)
- [src/input/commands/planning-runtime.ts](/home/buzzkill/Projects/goodvibes-tui/src/input/commands/planning-runtime.ts)
- [src/tools/workflow/index.ts](/home/buzzkill/Projects/goodvibes-tui/src/tools/workflow/index.ts)

The point is not “automation because automation.” It is to make recurring operational work, review loops, and reaction policies explicit, inspectable, and schedulable.

---

## Services, Profiles, And Setup Transfer

The services/config side is also productized beyond a flat JSON file:

- named service registry with inspect, auth resolution, connectivity tests, auth review, and doctor output
- first-class SecretRef-backed service credentials through env, GoodVibes local storage, file, exec, 1Password, Bitwarden, Vaultwarden, and Bitwarden Secrets Manager providers
- live profile management plus portable profile sync bundle export/import
- setup transfer bundles that can move config/services/ecosystem posture between environments

Key commands:

- `/services inspect|test|resolve|auth|auth-review|doctor|export|import`
- `/profiles`
- `/profilesync`
- `/setup transfer export|inspect|import`

Service entries can use existing `tokenKey` fields, a SecretRef in the key field, or explicit `tokenRef` / `passwordRef` / `webhookUrlRef` / `signingSecretRef` / `publicKeyRef` fields:

```json
{
  "slack": {
    "name": "slack",
    "authType": "bearer",
    "tokenKey": "SLACK_BOT_TOKEN",
    "tokenRef": {
      "source": "vaultwarden",
      "item": "GoodVibes Slack",
      "field": "password",
      "server": "https://vault.example.test"
    }
  }
}
```

---

## Marketplace, Plugins, And Curated Ecosystem Paths

The ecosystem layer is broader than a basic enable/disable plugin list.

Current capabilities include:

- local plugin discovery across configured search directories
- plugin inspect/review output with trust tier, quarantine posture, capability counts, and signature fingerprint visibility
- curated ecosystem catalogs with publish-local, unpublish, catalog review, install, update, uninstall, and installed-receipt flows
- local-first curated plugin distribution via `.goodvibes/tui/ecosystem/*.json`
- recommendations tied to installed state, denials, and missing capabilities

Key commands:

- `/plugin list|inspect|review|browse|catalog-review|publish-local|install|update|uninstall`
- `/marketplace`

This is implemented by:

- [src/input/commands/integration-runtime.ts](/home/buzzkill/Projects/goodvibes-tui/src/input/commands/integration-runtime.ts)
- [src/runtime/ecosystem/catalog.ts](/home/buzzkill/Projects/goodvibes-tui/src/runtime/ecosystem/catalog.ts)
- [src/runtime/ecosystem/recommendations.ts](/home/buzzkill/Projects/goodvibes-tui/src/runtime/ecosystem/recommendations.ts)

So the product supports both direct local plugins and a curated local-first ecosystem channel with review and receipt tracking.

---

## Tools

goodvibes-tui ships 21 built-in tools. They cover native file and shell operations, bounded eval, coordination/work management, MCP and remote control, planning artifacts, and product-control inspection surfaces.

### REPL / Eval runtimes

GoodVibes also ships a live bounded `repl` tool backed by the sandbox/session layer. The current runtimes are:

- JavaScript
- TypeScript
- Python
- SQL
- GraphQL

The implementation is in:

- [src/tools/repl/index.ts](/home/buzzkill/Projects/goodvibes-tui/src/tools/repl/index.ts)
- [src/tools/repl/schema.ts](/home/buzzkill/Projects/goodvibes-tui/src/tools/repl/schema.ts)
- [src/runtime/sandbox/manager.ts](/home/buzzkill/Projects/goodvibes-tui/src/runtime/sandbox/manager.ts)

These are real runtime profiles, not placeholder names. They are wired through sandbox profiles such as `eval-js`, `eval-ts`, `eval-py`, `eval-sql`, and `eval-graphql`, and REPL history is persisted under `.goodvibes/tui/repl-history.json`.

The important nuance is that the runtimes are intentionally bounded:

- JavaScript and TypeScript evaluate inside the sandbox exec path
- Python runs in an ephemeral virtualenv
- SQL evaluates against an ephemeral in-memory SQLite database
- GraphQL currently provides bounded GraphQL expression analysis/normalization through the REPL path rather than a general remote GraphQL executor

### Durable memory / knowledge

GoodVibes has two distinct memory layers:

- session memory for lightweight pinned notes that only live for the current session
- durable project knowledge stored in SQLite for reuse, review, export, and task-time injection

The durable system is implemented in:

- [src/state/memory-store.ts](/home/buzzkill/Projects/goodvibes-tui/src/state/memory-store.ts)
- [src/state/knowledge-injection.ts](/home/buzzkill/Projects/goodvibes-tui/src/state/knowledge-injection.ts)
- [src/input/commands/memory.ts](/home/buzzkill/Projects/goodvibes-tui/src/input/commands/memory.ts)
- [src/panels/memory-panel.ts](/home/buzzkill/Projects/goodvibes-tui/src/panels/memory-panel.ts)
- [src/panels/knowledge-panel.ts](/home/buzzkill/Projects/goodvibes-tui/src/panels/knowledge-panel.ts)

Durable record classes currently include:

- `decision`
- `constraint`
- `incident`
- `pattern`
- `fact`
- `risk`
- `runbook`
- `architecture`
- `ownership`

Key capabilities:

- scopes: `session`, `project`, `team`
- review states: `fresh`, `reviewed`, `stale`, `contradicted`
- confidence scores
- provenance links back to sessions, turns, tasks, events, and files
- links between memory records
- review queues and promotion flows
- bundle export/import and handoff export/import
- task-time knowledge selection and injection based on task text and write scope
- structured capture from incidents, policy preflight, MCP posture, and plugin posture

There is also a genuine self-improvement loop here:

- failures and incidents can be captured into durable memory
- policy, MCP, and plugin posture can be promoted into durable reviewed knowledge
- operators can review, mark stale, contradict, or promote records
- future tasks can receive automatically selected reviewed knowledge injections
- the runtime can explain exactly which knowledge records it would inject for a task and why

So the system is not just archival storage. It supports iterative operator review and reuse of lessons learned in later work.

Key commands:

- `/recall add ...`
- `/recall search ...`
- `/recall queue`
- `/recall review ...`
- `/recall explain ...`
- `/recall promote ...`
- `/recall capture ...`
- `/recall export ...`
- `/recall import ...`
- `/recall handoff-export ...`
- `/recall handoff-import ...`

This is not just a note store. It is a reviewed knowledge substrate used by the runtime when preparing task context.

There are also dedicated front doors for memory workflows outside `/recall`:

- `/memory-sync` for durable export/import
- `/handoff` for reviewable handoff bundles
- `/session-memory` for session-scoped review/capture
- `/team-memory` for shared/team-oriented exchange

### read

Read files with token-efficient extraction modes. Not just cat-to-context.

- 5 extract modes: `content` (full text), `outline` (signatures only, significant token savings), `symbols` (exported names, even greater savings), `ast` (structural), `lines` (specific ranges)
- Tree-sitter powered outline and symbol extraction with regex fallback
- Token-budget pagination for large batch reads — request N files, get pages that fit within a budget
- Built-in image, PDF, and Jupyter notebook reading
- Per-file caching with optimistic concurrency control (OCC) conflict detection — tracks what you've read and warns if it changed externally

### write

Write files with atomic operations, backup modes, and auto-heal.

- Atomic writes via temp file + rename — no partial writes on crash
- Three overwrite modes: `fail_if_exists`, `overwrite`, `backup` (copies original to `.goodvibes/.backups/`)
- Auto-heal pipeline: if a written file has syntax errors and `tools.autoHeal` is enabled, runs formatter → linter → LLM fix automatically
- Base64 content support for files with special characters
- Batch writes in a single call with per-file mode control

### edit

Structural code editing with AST matching, scope hints, and transactional rollback.

- 5 match modes: `exact`, `fuzzy` (whitespace-insensitive), `regex` (with capture groups), `ast` (tree-sitter structural), `ast_pattern` (ast-grep with metavariables like `$VAR` and `$$$ARGS`)
- Scope hints: `in_function`, `in_class`, `near_line` — disambiguate matches without increasing context
- Occurrence selection: `first`, `last`, `all`, or specific Nth occurrence — with ambiguity guard by default
- Atomic transactions: all edits succeed or all roll back. Also supports `partial` and `none` modes
- Pre/post validation: run `typecheck`, `lint`, `test`, or `build` before and after edits — auto-rollback on failure
- Auto-heal on validation failure (same pipeline as write)

### find

Multi-mode search: files, content, symbols, references, and structural AST patterns.

- 5 search modes in one tool: `files` (glob), `content` (regex grep), `symbols` (exported declarations), `references` (find all references via LSP with grep fallback), `structural` (AST pattern matching via ast-grep)
- Structural search uses ast-grep to find code patterns like `console.log($$$ARGS)` across TypeScript, JavaScript, CSS, and HTML
- Scope expansion: expand content matches to their enclosing `function` or `class` using tree-sitter
- Multiple queries per call executed in parallel
- Progressive output: `count_only` → `files_only` → `locations` → `matches` → `context`

### exec

Shell execution with background processes, retry, progress tracking, and file operations.

- Background execution with process tracking — spawn, poll status, read output, kill
- Retry with exponential backoff on transient failures
- `until` pattern: watch stdout for a regex match, then stop or promote to background
- Pre-command file operations: copy, move, delete files before running commands
- Progress file streaming for long-running commands (auto-enabled above 30s)
- Fail-fast mode: stop sequential execution on first failure, report remaining as skipped

### fetch

HTTP client with extraction modes, service registry auth, and batch operations.

- 11 extraction modes: `raw`, `text`, `json`, `markdown`, `readable` (strips nav/sidebar/footer), `code_blocks`, `links`, `tables`, `metadata` (og-tags), `structured` (CSS selectors), `pdf`
- Named service registry: configure API credentials once in `.goodvibes/tui/services.json`, reference by name in fetch calls
- Inline auth: `bearer`, `basic`, `api-key` per-request
- Batch parallel fetches in a single tool call

### analyze

15-mode code analysis suite — from impact analysis to upgrade compatibility.

- `impact`: trace exported symbols across the project to find what breaks when you change a file
- `dependencies`: build import graph, detect circular dependencies, list external packages
- `dead_code`: find exported symbols with zero references outside their own file
- `security`: scan for hardcoded secrets, world-writable files, and missing .env keys
- `breaking`: compare git refs and detect removed/changed export signatures
- `semantic_diff`: LLM-powered diff summary with risk assessment (low/medium/high)
- `upgrade`: check npm registry for outdated packages and flag breaking version bumps
- Also: `coverage` (lcov/istanbul parse), `bundle` (stats.json), `surface` (public API), `preview` (dry-run edit), `diff` (git ref diff), `permissions` (dangerous pattern scan), `env_audit` (.env key comparison), `test_find` (locate test files for source files)

### inspect

21-mode project and frontend inspection tool.

- `project`: detect project type, package manager, test framework, entry points, monorepo status
- `api` + `api_spec` + `api_validate` + `api_sync`: discover API routes across Next.js (App + Pages Router), Express, Fastify, and Hono → generate OpenAPI 3.0 specs → validate specs against code → detect frontend/backend drift by scanning fetch() calls
- `database`: parse Prisma schemas into structured model/field/relation data
- `components`: extract React component tree with props, hooks, and child components
- `scaffold`: generate module skeleton (types, implementation, tests, barrel export) with dry-run
- Frontend analysis: `layout` (CSS/Tailwind layout hierarchy), `accessibility` (a11y issue detection), `component_state` (useState/useReducer/useContext tracing), `render_triggers` (what causes re-renders), `hooks` (dependency array auditing with missing-dep detection), `overflow`/`sizing`/`stacking` (CSS issue detection), `responsive` (Tailwind breakpoint analysis), `events` (handler analysis), `tailwind` (class conflict detection), `client_boundary` (Next.js directive analysis), `error_boundary` (coverage analysis)

### agent

In-process subagent system with 15 management modes.

- Spawn agents from named archetypes (`engineer`, `reviewer`, `tester`, `researcher`, `general`) or custom archetypes from `.goodvibes/agents/*.md`
- Full lifecycle management: `spawn`, `status`, `cancel`, `list`, `get` (detailed view with recent messages), `wait` (block until completion with timeout)
- Inter-agent messaging via `message` mode
- Token budget estimation via `budget` mode
- Execution plan introspection via `plan` mode
- Git worktree isolation: each agent can work in its own branch, merged back on completion
- Batch spawning via `batch-spawn` mode
- WRFC chain introspection via `wrfc-chains` and `wrfc-history` modes
- Cohort tracking via `cohort-status` and `cohort-report` modes

### state

Session state, persistent memory, telemetry, hooks, and output modes — all in one tool.

- KV state: session-scoped key-value store with atomic persistence
- Durable memory posture: inspect the reviewed knowledge substrate and related runtime state, while the full durable-memory workflow lives under `/recall` and the knowledge panels
- Hook management: list, enable, disable, add, and remove hooks at runtime
- Output mode switching: switch between `default`, `vibecoding`, and `justvibes` verbosity presets
- Analytics: record tool calls, query by filter, export as JSON/CSV, dashboard view — backed by WASM SQLite
- Context and budget reporting for token usage awareness

### workflow

Workflow state machines, automation triggers, and scheduled tasks.

- Named workflow definitions: `wrfc` (work-review-fix cycle), `fix_loop`, `test_then_fix`, `review_only`
- State machine with validated transitions — prevents invalid state changes
- Automation triggers: fire shell commands when specific hook events occur, with optional JS conditions
- Cron scheduler: full 5-field cron expressions with IANA timezone support, missed-run detection, per-task run history, and enable/disable control. Persists to `.goodvibes/tui/schedules.json`
- Full lifecycle: start, transition, cancel, list active instances

### task / team / worklist

Structured execution and coordination tools beyond a single conversation turn.

- `task`: create, inspect, block, cancel, depend, and hand off tasks across sessions
- `team`: define teams, members, lanes, and role assignments
- `worklist`: manage durable worklists with ownership and priority

### packet / query

Durable planning and operator-communication artifacts.

- `packet`: create, revise, publish, and list implementation packets / execution packets
- `query`: track operator queries, answers, escalation targets, and closure state

### mcp / remote / control

Additional product-control tools that expose runtime breadth directly.

- `mcp`: inspect MCP servers, tools, schema freshness, security posture, auth posture, and quarantine controls
- `remote`: inspect and manage remote runner pools, contracts, artifacts, and review flows
- `control`: inspect packaged command families, panel/control-room families, built-in subscription providers, and sandbox presets

### registry

Discover and introspect skills, agents, and tools.

- Fuzzy search across skills (`.goodvibes/skills/*.md`), agents (`.goodvibes/agents/*.md`), and built-in tools
- Task-based recommendations: describe what you want to do, get ranked suggestions
- Dependency chain resolution for skills
- Full content retrieval for any registry item

---

## Evaluation, Replay, Diagnostics, And Incidents

GoodVibes includes a substantial post-execution and operator-repair stack:

- `/eval` runs built-in evaluation suites, compares baselines, and applies regression gates
- `/replay` loads and steps deterministic replay runs
- `/incident` opens, exports, and captures forensics bundles
- `Health` and diagnostics surfaces expose repair actions, transport issues, task failure state, and replay hooks
- the state inspector subsystem tracks transitions, time-travel snapshots, and selector hotspots
- telemetry exporters can write to local ledgers, console sinks, or OTLP bridges
- retention and pruning policy keeps checkpoint/snapshot growth bounded
- idempotency keys prevent duplicate tool execution across replay, reconnect, and retry scenarios
- operational playbooks describe symptoms, checks, and resolution steps for runtime failure classes

This is backed by:

- [src/runtime/eval/index.ts](/home/buzzkill/Projects/goodvibes-tui/src/runtime/eval/index.ts)
- [src/runtime/forensics/index.ts](/home/buzzkill/Projects/goodvibes-tui/src/runtime/forensics/index.ts)
- [src/runtime/diagnostics/index.ts](/home/buzzkill/Projects/goodvibes-tui/src/runtime/diagnostics/index.ts)
- [src/runtime/ui/state-inspector/index.ts](/home/buzzkill/Projects/goodvibes-tui/src/runtime/ui/state-inspector/index.ts)
- [src/runtime/telemetry/index.ts](/home/buzzkill/Projects/goodvibes-tui/src/runtime/telemetry/index.ts)

So the product is not just “chat plus tools.” It also includes validation, replay, incident, telemetry, and repair infrastructure.

The adjacent reliability subsystems include:

- [src/runtime/notifications/index.ts](/home/buzzkill/Projects/goodvibes-tui/src/runtime/notifications/index.ts)
- [src/runtime/perf/index.ts](/home/buzzkill/Projects/goodvibes-tui/src/runtime/perf/index.ts)
- [src/runtime/retention/index.ts](/home/buzzkill/Projects/goodvibes-tui/src/runtime/retention/index.ts)
- [src/runtime/idempotency/index.ts](/home/buzzkill/Projects/goodvibes-tui/src/runtime/idempotency/index.ts)
- [src/runtime/ops/index.ts](/home/buzzkill/Projects/goodvibes-tui/src/runtime/ops/index.ts)

Those pieces cover conversation-noise routing, panel-health/performance budgets, snapshot pruning, duplicate-execution protection, and machine-readable recovery playbooks used by the diagnostics surface.

---

## Slash Commands

| Command | Aliases | Description |
|---------|---------|-------------|
| `/model [id]` | `/m` | Select or display the current LLM model |
| `/provider [name]` | `/p` | Switch provider, or `add <name> <baseURL> [apiKey]` / `remove <name>` |
| `/effort [level]` | `/e` | Show or set reasoning effort level |
| `/config [key] [value]` | `/cfg` | Show, set, or reset config values. Subcommands: `profile`, `diff`, `reset` |
| `/debug` | — | Toggle debug mode |
| `/lines [all\|code\|off]` | — | Cycle or set line-number mode |
| `/expand [type]` | — | Expand blocks by type (all/thinking/tool/code) |
| `/collapse [type]` | — | Collapse blocks by type |
| `/bookmarks` | `/bm` | List bookmarked blocks |
| `/settings` | `/cfg-ui` | Open the config/settings browser modal |
| `/clear` | `/cls` | Clear the conversation display (keeps LLM context) |
| `/reset` | — | Full reset: clear display and conversation context |
| `/compact` | — | Compact conversation context using hybrid structured compaction (v2) |
| `/export [format] [path]` | — | Export conversation (markdown by default) |
| `/share [format] [path]` | `/shr` | Export session as shareable html, json, or md (supports `--redact`) |
| `/title [text]` | — | Show or set the conversation title |
| `/save [name]` | — | Save current session |
| `/load <name>` | — | Load a saved session |
| `/sessions` | — | List saved sessions |
| `/session [action]` | `/sess` | Full session management: list, rename, resume, fork, save, info, export, search, delete |
| `/undo [file]` | `/u` | Remove last turn, or `/undo file` to revert last file write/edit |
| `/redo [file]` | — | Restore last undone turn, or `/redo file` to re-apply last reverted file |
| `/retry [text]` | `/r` | Re-send the last user message |
| `/template` | `/tmpl` | Manage prompt templates: save, use, list, edit, delete |
| `/tools` | `/t` | List available tools |
| `/permissions` | `/perms` | Show or set permission mode and per-tool settings |
| `/secrets` | — | Manage encrypted and provider-backed API key secrets (set/link/get/test/list/delete) |
| `/services` | `/svc` | Manage API service configurations |
| `/accounts [action]` | — | Review provider-account routes, auth posture, and repair actions |
| `/auth [action]` | — | Review auth posture and manage local service auth users/sessions |
| `/memory [action]` | — | Session memory management: `list`, `add <text>`, `remove <id>` |
| `/recall [action]` | `/rc` | Durable knowledge and memory substrate: capture, review, explain, export, import, and handoff |
| `/context` | `/ctx` | Inspect context window usage (token breakdown per message) |
| `/next-error` | `/ne` | Jump to the next error message in the conversation |
| `/prev-error` | `/pe` | Jump to the previous error message in the conversation |
| `/profiles` | `/profile` | Browse and load config profiles |
| `/pin [id]` | — | Pin a model as favorite |
| `/unpin [id]` | — | Remove a model from favorites |
| `/git [action]` | `/g` | Git commands: status, log, diff. Opens git panel if no action given |
| `/scan` | — | Scan for local LLM servers |
| `/plan [task]` | — | Manage execution plans: create, list, or `show <id>` |
| `/panel [action]` | `/panels` | Panel management: open, close, list, toggle, move, focus, split, width, height |
| `/plugin [action]` | — | Manage plugins (enable/disable/reload/list) |
| `/marketplace [action]` | — | Browse curated plugin, skill, hook-pack, and policy-pack surfaces |
| `/branch [name]` | `/br` | List conversation branches or switch to one |
| `/fork [name]` | `/branch-save` | Save a named snapshot of the current conversation |
| `/merge <name>` | — | Append messages from a branch after the fork point |
| `/agents` | — | List active and completed agents |
| `/wrfc` | — | Show WRFC chain status |
| `/health [action]` | — | Unified runtime health review and repair entry point |
| `/guidance [action]` | — | Contextual operational guidance without cluttering the conversation |
| `/remote [action]` | — | Remote runner, pool, contract, and artifact control room |
| `/sandbox [action]` | — | Isolation presets, doctor/probe, sessions, and QEMU setup flows |
| `/setup [action]` | — | First-run readiness, services, sandbox, transfer bundles, and deep links |
| `/worktree [action]` | — | Inspect orchestrator-owned worktrees and recovery posture |
| `/eval [action]` | — | Evaluation harness: suites, baselines, and regression gates |
| `/replay [action]` | `/rep` | Deterministic replay load / step / seek / diff / export |
| `/incident [action]` | — | Incident bundle review, export, and durable-memory capture |
| `/teleport [action]` | — | Portable remote-session handoff bundles |
| `/commands` | `/cmds` | Browse all commands in a scrollable list |
| `/shortcuts` | `/keys`, `/keybinds` | Show keyboard shortcuts reference |
| `/keybindings` | `/kb` | List current keyboard bindings and their config file path |
| `/danger [key] [value]` | — | Danger zone settings (agent recursion, daemon, HTTP listener) |
| `/schedule [action]` | `/sched` | Manage scheduled agent tasks (cron): add, list, remove, enable, disable, run |
| `/image <path>` | `/img` | Attach an image file to the next message |
| `/refresh-models` | — | Refresh model catalog, benchmarks, and token limits |
| `/notify [action]` | `/ntf` | Manage webhook notifications (ntfy.sh): add, remove, list, clear, test |
| `/diff [target]` | `/d` | Show unified diff: session, head, working, staged, or a git ref |
| `/mcp [tools]` | — | List connected MCP servers and their tools |
| `/help [command]` | `/h`, `/?` | Show available commands and keyboard shortcuts |
| `/quit` | `/q`, `/:q` | Exit the application |

> **Tip:** Use the `/add-provider` skill for interactive guided provider setup with smart defaults for popular providers.
>
> Additional front doors exist for narrower product surfaces, including `approval`, `knowledge`, `memory-review`, `memory-sync`, `session-memory`, `team-memory`, `remote-setup`, `remote-env`, `runner-pool`, `bootstrap`, `tunnel`, `voice`, `hooks`, `security`, `policy`, `orchestration`, `communication`, `ops`, `cockpit`, `trust`, `welcome`, `login`, `logout`, `bridge`, `install`, `update`, and related setup/review helpers.

---

## Keyboard Shortcuts

All shortcuts are customizable via `~/.goodvibes/tui/keybindings.json`. Use `/keybindings` to view current bindings.

### Input & Editing

| Key | Action |
|-----|--------|
| `Enter` | Send message |
| `Shift+Enter` | Insert newline |
| `Tab` | Toggle block collapse / path completion |
| `Ctrl+U` | Clear the prompt line |
| `Ctrl+W` | Delete word backward |
| `Ctrl+K` | Kill to end of line |
| `Ctrl+Z` | Undo prompt edit |
| `Ctrl+Shift+Z` | Redo prompt edit |
| `Ctrl+V` | Paste (image or text) |
| `@` | Open file picker (insert file path) |
| `?` | Open help/command picker (empty prompt) |

### Navigation

| Key | Action |
|-----|--------|
| `Arrow Up / Down` | Scroll conversation / recall input history |
| `PageUp / PageDown` | Scroll by page |
| `Ctrl+R` | Reverse input history search |
| `Ctrl+E` | Move to end of line / next error |
| `Ctrl+A` | Move to start of line / apply nearest diff |
| `Mouse wheel` | Scroll |
| `Click drag` | Select text |
| `Middle click` | Paste |
| `Escape` | Exit current mode (search, command, modal) |

### Blocks & Content

| Key | Action |
|-----|--------|
| `Ctrl+Y` | Copy nearest block to clipboard |
| `Ctrl+S` | Save nearest block to file |
| `Ctrl+B` | Bookmark nearest block |
| `Ctrl+F` | Open conversation search overlay |
| `Ctrl+L` | Clear screen |
| `Ctrl+Shift+C` | Copy selection |

### Panels

| Key | Action |
|-----|--------|
| `Ctrl+P` | Toggle panel sidebar |
| `Ctrl+}` | Next panel tab |
| `Ctrl+~` | Previous panel tab |
| `,` / `.` | Cycle panel tabs (when panel focused) |

### System

| Key | Action |
|-----|--------|
| `Ctrl+C` | Clear input / cancel generation / exit (double-press to quit) |

---

## Agent System

Agents are in-process subagents with isolated conversation history, a scoped tool registry, and optional git worktree. They run asynchronously and report back through the agent message bus.

### Built-In Archetypes

| Archetype | Tools | Description |
|-----------|-------|-------------|
| `engineer` | read, write, edit, find, exec, analyze | Full-stack implementation agent |
| `reviewer` | read, find, analyze | Code review and quality assessment |
| `tester` | read, write, find, exec | Test writing and execution |
| `researcher` | read, find, analyze, inspect | Codebase exploration and analysis |
| `general` | read, write, edit, find, exec | General purpose agent |

### Custom Archetypes

Drop a Markdown file into `.goodvibes/agents/` with YAML frontmatter:

```markdown
---
name: documenter
description: API documentation writer
tools: [read, find, write]
model: claude-haiku-4-5
---

You are a technical documentation specialist. Focus on clarity and completeness.
```

The markdown body becomes the agent's system prompt.

### Spawning an Agent

Use the `agent` tool from within a conversation:

```
spawn an engineer agent to refactor src/utils.ts
```

Or use the tool directly with the `agent` tool's spawn mode, specifying an archetype and task.

### Git Worktree Isolation

When an agent is spawned, it can be given its own git worktree. On completion, changes are merged back. On cancellation or error, the worktree is cleaned up.

---

## Hook System

Hooks fire on lifecycle events throughout a session. They are configured in `.goodvibes/hooks.json` (or a custom file set in `tools.hooksFile`).

### Event Path Format

```
Phase:Category:Specific
```

- **Phases**: `Pre`, `Post`, `Fail`, `Change`, `Lifecycle`
- **Categories**: `tool`, `file`, `git`, `agent`, `compact`, `llm`, `mcp`, `config`, `budget`, `session`, `workflow`
- Wildcards are supported: `Pre:tool:*` matches all pre-tool events

### Hook Types

| Type | Description |
|------|-------------|
| `command` | Run a shell command. Event data passed via stdin as JSON. |
| `prompt` | Send a prompt to an LLM. `$ARGUMENTS` is replaced with the event JSON. |
| `agent` | Spawn a subagent to handle the event. |
| `http` | POST the event payload to a URL. |
| `ts` | Execute a TypeScript module that exports a default handler function. |

### Example hooks.json

```json
{
  "hooks": {
    "Post:tool:write": [
      {
        "type": "command",
        "command": "echo 'File written: $FILE' >> .goodvibes/write-log.txt",
        "async": true,
        "description": "Log all file writes"
      }
    ],
    "Pre:tool:exec": [
      {
        "type": "prompt",
        "prompt": "Review this command for safety: $ARGUMENTS",
        "model": "claude-haiku-4-5",
        "description": "Safety check before exec"
      }
    ]
  }
}
```

### Hook Chains

Chains trigger an action only after a sequence of events occurs, with optional time windows and conditions:

```json
{
  "chains": [
    {
      "name": "notify-after-agent-completes",
      "steps": [
        { "match": "Lifecycle:agent:spawned" },
        { "match": "Lifecycle:agent:completed", "within": "5m" }
      ],
      "action": {
        "type": "command",
        "command": "notify-send 'Agent finished'"
      }
    }
  ]
}
```

Hook properties: `match`, `type`, `command`/`prompt`/`url`/`path`, `async`, `once`, `timeout`, `enabled`, `name`.

---

## MCP Integration

Connect to any MCP-compatible server by adding it to `.goodvibes/mcp.json`:

```json
{
  "servers": [
    {
      "name": "filesystem",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]
    },
    {
      "name": "github",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": {
        "GITHUB_PERSONAL_ACCESS_TOKEN": "ghp_..."
      }
    }
  ]
}
```

MCP tools appear in the tool registry as `mcp:<server-name>:<tool-name>`. Tool schemas are loaded progressively — names and descriptions at startup, full parameter schemas on first use. Connections are auto-restarted on crash.

MCP tool calls respect the `permissions.tools.mcp` setting (default: `prompt`).

Current MCP product loops also include:

- trust posture and quarantine review
- auth-review and reconnect flows
- sandbox-backed execution when isolation is configured
- routing into dedicated MCP and Health workspaces instead of transcript spam

Useful commands:

- `/mcp`
- `/mcp review`
- `/mcp auth-review`
- `/mcp repair`

---

## Plugin System

Extend goodvibes-tui with custom plugins. Place plugin folders in `~/.goodvibes/tui/plugins/`:

Each plugin has a `manifest.json` and an entry file (default: `index.ts`):

```json
{
  "name": "my-plugin",
  "version": "1.0.0",
  "description": "My custom plugin"
}
```

Plugins receive a sandboxed API with:
- `registerCommand()` — add custom slash commands
- `registerProvider()` — add OpenAI-compatible LLM providers
- `registerTool()` — add custom tools available to the LLM
- `onEvent()` — subscribe to typed runtime events
- `getConfig()` — read plugin-specific settings

Manage via `/plugin enable|disable|reload|list`.

---

## Architecture

```
src/
├── main.ts              — Entry point: terminal setup, event loop, alt-screen lifecycle
├── core/
│   └── orchestrator.ts  — Main conversation loop, tool dispatch, streaming
├── providers/
│   ├── registry.ts      — ProviderRegistry, model selection, custom model merging
│   ├── synthetic.ts     — SyntheticProvider: cross-provider failover with tier isolation
│   ├── model-catalog.ts — Dynamic catalog from models.dev (4000+ models)
│   ├── model-benchmarks.ts — ZeroEval benchmark integration
│   ├── auto-register.ts — Env-var-based provider auto-registration
│   ├── favorites.ts     — Model pinning and usage tracking
│   ├── model-limits.ts  — OpenRouter-sourced token limits cache
│   ├── anthropic-compat.ts — Anthropic Messages API adapter (for proxies)
│   ├── tool-formats.ts  — OpenAI/Anthropic/Gemini wire format converters
│   ├── custom-loader.ts — Hot-reloadable custom provider loader
│   ├── cache-capability.ts — Provider cache capability registry (13+ providers)
│   ├── cache-strategy.ts — Cache strategy generation + hit rate tracker
│   ├── cache-planner.ts — LLM-assisted cache breakpoint planning
│   ├── anthropic.ts     — Anthropic SDK adapter (multi-breakpoint caching)
│   ├── openai.ts        — OpenAI SDK adapter
│   ├── openai-compat.ts — OpenAI-compatible endpoint adapter (session affinity)
│   └── gemini.ts        — Google Gemini adapter
├── tools/               — 12 built-in tools (read/write/edit/find/exec/fetch/analyze/inspect/agent/state/workflow/registry)
├── agents/
│   ├── orchestrator.ts  — In-process agent runner with turn loop
│   ├── wrfc-controller.ts — Automated WRFC chain state machine
│   ├── wrfc-types.ts    — WRFC chain, gate, and event types
│   ├── completion-report.ts — Structured agent output report types + parser
│   ├── archetypes.ts    — Archetype loader from .goodvibes/agents/*.md
│   ├── message-bus.ts   — Inter-agent messaging with TTL
│   ├── session.ts       — Agent session isolation
│   └── worktree.ts      — Git worktree lifecycle management
├── hooks/
│   ├── types.ts         — HookPhase, HookCategory, HookDefinition, HookChain
│   ├── dispatcher.ts    — Event firing and hook matching
│   ├── chain-engine.ts  — Multi-step chain evaluation
│   └── runners/         — command, prompt, agent, http, ts runners
├── mcp/
│   ├── client.ts        — JSON-RPC 2.0 stdio client
│   ├── config.ts        — .goodvibes/mcp.json reader
│   └── registry.ts      — McpRegistry: connect, isolate, list tools, call tools
├── renderer/            — Cell-based TUI: glyph primitives, layout helpers, overlays, modals
├── input/
│   ├── commands.ts      — Slash-command registrations
│   └── handler.ts       — Raw stdin input processing and focus routing
├── config/
│   ├── schema.ts        — GoodVibesConfig type, ConfigKey, defaults
│   ├── helper-model.ts  — Helper model router + singleton (HelperModel, HelperRouter)
│   ├── index.ts         — Config loader and live-edit manager
│   ├── secret-refs.ts   — env, file, exec, 1Password, Bitwarden, Vaultwarden, and BWS secret references
│   └── secrets.ts       — hierarchy-aware secure/plaintext secret storage
├── state/               — KV store, project index, file cache, mode manager, telemetry
├── permissions/         — Permission manager with per-tool enforcement
├── security/            — Spawn tokens and local user auth
├── daemon/              — Local daemon server and HTTP listener
├── git/                 — GitService wrapping simple-git
├── acp/                 — Agent Client Protocol (subagent child processes)
├── discovery/           — Local LLM scanner + MCP server auto-discovery
├── runtime/
│   ├── store/           — Zustand vanilla store with 19 domain slices, selectors, and dispatch paths
│   ├── events/          — 17 typed event domains and RuntimeEventBus
│   ├── emitters/        — Typed event emission wrappers
│   ├── health/          — RuntimeHealthAggregator, CascadeEngine, partial degradation model
│   ├── feature-flags/   — 8 feature flags with enable/disable/kill lifecycle and audit log
│   ├── tools/           — 6-phase phased tool executor with AbortController and per-phase timeouts
│   ├── permissions/     — LayeredPolicyEvaluator, normalization, rules, and decision reasons
│   ├── tasks/           — Unified task management, adapters, retry, and lifecycle state
│   ├── notifications/   — NotificationRouter, policy stack, formatters, and batching
│   ├── contracts/       — Schema versioning, MigrationRegistry, and validators
│   ├── telemetry/       — Lightweight tracing, exporters, and instrumentation
│   ├── diagnostics/     — Diagnostics providers and inspector panels
│   ├── forensics/       — Failure classification and forensic bundles
│   ├── eval/            — Evaluation harness and scorecard logic
│   ├── remote/          — Supervisor, recovery, contracts, artifacts, and session control
│   ├── sandbox/         — backend planning, session registry, QEMU provisioning, guest bundles
│   ├── provider-accounts/ — account posture, route selection, auth freshness, usage windows
│   ├── auth/            — shared OAuth core and auth inspection
│   ├── settings/        — settings control plane, sync, managed staging, rollback
│   ├── compaction/      — compaction strategies and resume repair pipeline
│   └── bootstrap.ts     — Composition root: typed initialization with dependency ordering
├── panels/              — panel workspaces, control rooms, and panel-management UI
├── integrations/        — Discord, Slack, GitHub webhook integrations
├── export/              — Markdown, JSON, HTML session export with redaction
├── plugins/             — Plugin system (manifest, loader, sandboxed API)
├── profiles/            — Named config profile save/load
├── sessions/            — JSONL session persistence and search
├── scheduler/           — Cron-based recurring task scheduler
├── bookmarks/           — Block bookmark manager
└── intelligence/        — Tree-sitter + LSP language intelligence
    ├── tree-sitter/     — WASM-based parsing and symbol extraction
    └── lsp/             — Language server protocol clients
```

### Key Design Decisions

- **Bun runtime** — native TypeScript execution, fast startup, built-in test runner
- **Raw ANSI renderer** — no framework dependency in the rendering path, direct control over every byte sent to the terminal
- **In-process agents** — agents share the same process and memory, avoiding IPC overhead while maintaining isolation through scoped registries and namespaced state
- **Tree-sitter for code intelligence** — 17 language grammars (TypeScript, TSX, JavaScript, Python, Rust, Go, Java, C, C++, Ruby, Bash, JSON, YAML, TOML, CSS, HTML, Markdown) for structural analysis, outline extraction, and AST-level edits — with 6 (TypeScript, TSX, JavaScript, Python, JSON, CSS) embedded as WASM for instant startup
- **Bundled language servers** — TypeScript, Python, Bash, CSS, HTML, and JSON language servers ship as npm dependencies and work out of the box. Rust (`rust-analyzer`) and Go (`gopls`) are downloaded automatically on first use with SHA256 integrity verification. No manual LSP setup required.
- **SQL.js for analytics** — WASM SQLite for in-process tool call telemetry without a database server
- **Zustand vanilla store** — no React dependency; the runtime store is a plain Zustand store with 19 domain slices and typed selectors, usable from any context (agents, tools, renderer, hooks)
- **Agent Client Protocol** — subagents communicate via @agentclientprotocol/sdk over stdio ndJsonStream
- **Plugin system** — manifest.json + sandboxed API surface with lifecycle hooks (init/activate/deactivate)
- **Crash recovery** — periodic JSONL snapshots with recovery prompt on next startup

---

## Development

### Run in dev mode

```sh
bun run dev
```

### Run tests

```sh
bun test
```

6,600+ tests across contract, security, release gate, runtime, renderer, panel, integration, and UX anti-regression suites. Performance budget gate runs as part of CI — the build fails if any of the 5 perf budgets (store update latency, event dispatch latency, tool execution overhead, compaction duration, startup time) are exceeded.

### Build standalone binary

```sh
bun run build
# outputs dist/goodvibes
```

### Project structure conventions

- Tool implementations live in `src/tools/<name>/index.ts`
- Tool parameter schemas live in `src/tools/<name>/schema.ts`
- Tests mirror the source tree under `src/test/`
- Runtime data (sessions, conversations, hooks, memory) lives in `.goodvibes/` in the working directory
- TUI-specific settings, secrets, auth state, worktree state, and caches live under `.goodvibes/tui/`
- Agent archetypes go in `.goodvibes/agents/*.md`
- MCP server config goes in `.goodvibes/mcp.json`
- Hook config goes in `.goodvibes/hooks.json` (or the file set in `tools.hooksFile`)

---

## License

MIT
