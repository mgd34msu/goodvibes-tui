# goodvibes-tui

[![CI](https://github.com/mgd34msu/goodvibes-tui/actions/workflows/ci.yml/badge.svg)](https://github.com/mgd34msu/goodvibes-tui/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Version](https://img.shields.io/badge/version-2.1.0-blue.svg)](https://github.com/mgd34msu/goodvibes-tui)

GoodVibes is a terminal console for coding and operations work with an AI model. You run `goodvibes` in a project directory and get a full-screen terminal app where you talk to a model that can read and edit your files, run shell commands, search the web, and hand work off to background agents, asking your permission before anything that writes or executes.

It talks to many model providers (OpenAI, Anthropic, Gemini, Bedrock, Copilot, OpenRouter and other OpenAI-compatible gateways, plus local servers like Ollama and LM Studio that `/scan` finds on your machine and LAN), keeps its settings, sessions, and secrets on your own machine, and shows you the token count and running cost of every turn. Background work opens in large modals over the conversation: running agents, changed files and diffs, tokens and cost.

<img src="docs/assets/splash.png" alt="GoodVibes 2.1.0 starting up in a terminal. A thin header reads GoodVibes 2.1.0 on the left and the git branch main with a changes dot and the model gpt-6.1-sol on the right. Centered below is a block-letter GOODVIBES wordmark in a cyan-to-violet gradient between two rules, the tagline, the version v2.1.0 with terminal AI assistant, the active model openai:gpt-6.1-sol with 29 tools, the working directory /tmp/orbit-watch, and a hint line reading Ctrl+P commands / ? help / F2 agents. At the bottom is an empty input box reading Ask anything, or type / for commands and @ for files, and a status line showing the normal permission mode, the directory and branch, a cost of zero dollars, an empty context bar at 0 percent of 1.1M, and ctrl+p menu." width="900">

---

## Install

GoodVibes runs on Linux, macOS, and Windows via WSL2. The one-line installer downloads checksum-verified binaries and needs no package manager:

```sh
curl -fsSL https://goodvibes.sh/install.sh | sh
goodvibes
```

Or install from the npm registry with [Bun](https://bun.sh):

```sh
bun add -g @pellux/goodvibes-tui
bun pm trust -g @pellux/goodvibes-tui @pellux/goodvibes-daemon
goodvibes
```

Bun blocks lifecycle scripts for untrusted global packages, so the second line lets both postinstalls run: `@pellux/goodvibes-tui`'s own, which places the TUI binary, and `@pellux/goodvibes-daemon`'s, which places the daemon binary (both names must be the full scoped names). `@pellux/goodvibes-daemon` is a real dependency of this package, so one install brings both commands. No other dependency needs trusting for the install to work. If you skip that step, the `goodvibes` launcher still self-heals on first run by fetching and checksum-verifying its own binary. `npm install -g @pellux/goodvibes-tui` also works when `bun` is already on `PATH`.

Then point it at a model. An environment variable is the fastest path:

```sh
export OPENAI_API_KEY=...
```

On Windows, run it inside a WSL2 distribution, where it is an ordinary Linux install. Native Windows is beta. See [docs/windows.md](docs/windows.md).

Deeper install notes are in [docs/getting-started.md](docs/getting-started.md): the installer's environment variables, uninstall, daemon service registration, encrypted and vault-backed secrets, and running from source.

---

## A 60-second tour

### The conversation loop

<img src="docs/assets/conversation.png" alt="Two conversation turns. The user asks the model to search for nextPass and list every file that references it; the reply shows one collapsed find nextPass tool row with a green checkmark and the summary 2 matches in 2 files, then the answer listing src/index.ts and src/passes.ts. In the second turn the user asks, without running anything, for three things the tracker still needs, and the model answers with three short bullets about orbital-data refresh, pass-prediction validation, and alerts before upcoming passes. Each user message sits in a shaded block and each reply carries a small header with the model name, tool count, and elapsed time. The status line below the input shows the normal mode, the directory /tmp/orbit-watch, an estimated cost of about 3 cents, and the context bar at 1 percent, 14.4k of 1.1M tokens." width="900">

Tool calls stream inline as the model makes them, then their results fold into a collapsible group so a long working session stays readable. Expand any group to see what actually came back. Assistant messages render markdown, syntax-highlighted code, and inline diffs, and any block can be collapsed, bookmarked, copied, or saved to a file.

The status line under the input keeps a running total: the estimated cost so far and how much of the context window is used. `/usage` breaks that down into fresh input tokens, cache reads, and output tokens. When a model's price is not in the catalog, the cost is reported as unavailable rather than guessed.

### Permissions and workspace trust

<img src="docs/assets/workspace-trust.png" alt="A modal over the dimmed conversation, titled New workspace: choose a trust level, with an esc key on its right. Two options are listed: Trust this workspace, full capability, all tools may run, which is highlighted; and Keep restricted (read-only), explore safely, writes and commands are denied until trusted. The hint row reads up and down to move, Enter to choose. Behind it, the transcript shows the model starting exec mkdir -p build and waiting." width="820">

The first time the model wants to write or run something in a new directory, GoodVibes asks how much it is allowed to do there. Restricted is read-only. The model can look around, but writes and commands are refused until you trust the workspace.

<img src="docs/assets/permission-prompt.png" alt="A Shell Execution Approval modal with an amber top edge over the dimmed conversation. The header reads EXECUTE and the session id. A shaded row shows the command mkdir -p build, followed by a red high risk tag beside Execute shell command. Three choices sit in a row, Allow once highlighted, Allow for session, and Deny, with d details on the right. The hint row reads: arrows to choose, Enter to confirm, y allow once, 1-4 remember, n deny, or type a reason to deny. Behind the modal the transcript line reads Waiting for your approval, exec, mkdir -p build." width="900">

After that, the default permission mode is `prompt`: writes, edits, shell commands, network fetches, agent spawns, and MCP calls each stop and ask. The prompt shows what will run and its assessed risk; `d` expands the details, including the working directory, what it can affect, and the raw arguments. You can allow it once, deny it (optionally typing a reason the model sees), or remember the decision at whichever scope fits: this exact command, this command shape, this tool for the whole project, or just for the rest of the session.

Four other modes are available when prompting is not what you want:

- `accept-edits` auto-approves file writes and edits while exec and the other risky classes still ask
- `plan` allows read-only tools and refuses every mutating or exec call
- `allow-all` approves everything
- `custom` takes per-tool `allow` / `prompt` / `deny` overrides

`Shift+Tab` cycles the four session postures: normal (the `prompt` mode), accept-edits, plan, and auto (the `allow-all` mode). `/plan` toggles plan mode directly.

### Models and providers

<img src="docs/assets/model-picker.png" alt="The Models modal opened with /model. Tabs across the top name the routing targets: Main Chat, selected, then Helper (off), Tool LLM (off), TTS, and Embeddings. Below is a search field and a count reading available only, 2,574 of 3,214. The left column lists models grouped by provider, here abacusai, with each model's context window; the right pane describes the highlighted model, its provider, the current Main Chat model openai:gpt-6.1-sol, its status configured, its context window and capability tags, and the filter shortcuts for price, capability, availability, benchmark sort, and grouping. The footer reads Enter use for Main Chat, tab next target, ctrl+f pin, ctrl+r refresh catalog, and 2550 more." width="900">

Models come from a live catalog, so the picker lists far more than a hardcoded set, filterable by search, price, capability, and availability. Separate roles route independently: your main chat model, a cheaper helper model for grunt work, a tool model, a TTS model, and an embeddings model can each point somewhere different.

The `synthetic` provider groups the same model across every backend that serves it into one entry. Pick it and requests route to whichever backend is healthy, failing over on rate limits and transient errors without changing the model you chose, and without ever crossing the free, paid, and subscription boundaries. Any OpenAI-compatible API can be added as a custom provider by dropping a JSON file in `~/.goodvibes/tui/providers/`. It is hot-reloaded. See [docs/providers-and-routing.md](docs/providers-and-routing.md).

### The Agents control room

<img src="docs/assets/fleet-panel.png" alt="The Agents modal opened with F2, headed 0 running, the session's own cost, and the fleet cost. The filter field holds the word healthy and shows 3 of 8 rows. Under a running heading the list shows three watchers, CI watch poller, Daemon heartbeat, and Runtime heartbeat, each marked healthy with its elapsed time. The detail pane on the right describes the selected CI watch poller: watcher id ci-watch-poller, state idle, elapsed time, model unknown, tokens not applicable, cost unpriced, the headline CI watch poller, healthy, its activity phase, and approvals. The hint row reads Enter open full screen, s steer, ctrl+x stop, n new agent, v archive, a archive one, f follow." width="900">

Work that is not conversation opens in modals instead of scrolling past in the transcript. Agents, reached with `F2`, is the live control room for agents, WRFC chains, workstreams, watchers, scheduled jobs and hosted sessions: what is running, for how long, at what token cost, and what it is waiting on. You can open a running agent to watch its live tail or steer it, back out with `Esc` without stopping it, stop it with `Ctrl+X` (it asks first), pause and resume, and archive finished work. Usage (`/usage`) shows context pressure, tokens and cost; Changes (`/changes`) shows changed files with a tinted diff, a semantic summary, hunk staging and review comments; Notifications (`/notifications`) keeps the history.

### Everything else is a command

<img src="docs/assets/help-overlay.png" alt="The Help: Commands modal opened with the question-mark key, with a Type to filter field and a count of 160 items. Commands are grouped under category headings: provider accounts with /accounts and its review, panel, show, routes, and repair subcommands, highlighted; agents with /agents, which opens Agents and lists or hosts third-party coding agents over ACP; experience with /approval; platform access with /auth and its long list of subcommands; local runtime with /bookmarks; experience with /bootstrap; and branches with /branch. The hint row reads up and down to move, Enter to run, and 153 more." width="820">

Press `?` for a searchable, categorized list of every slash command with its arguments and description. The same list is generated into [docs/commands-reference.md](docs/commands-reference.md).

### Keys worth knowing on day one

| Key | Does |
| --- | --- |
| `Enter` / `Shift+Enter` | Send the message / insert a newline |
| `?` | Help and command picker (on an empty prompt) |
| `@` | File picker: insert a path into the prompt |
| `Tab` | Complete a path, or toggle collapse on the nearest block. With the session chips showing and an empty composer, switch to the next session |
| `Ctrl+F` | Search the conversation |
| `Ctrl+Y` / `Ctrl+S` | Copy / save the nearest block |
| `Ctrl+P` / `Ctrl+K` | Command palette: search and run any command, view or setting |
| `F2` / `Ctrl+O` | Open or close Agents |
| `Shift+Tab` | Cycle the session permission mode. With the session chips showing and an empty composer, switch to the previous session |
| `Esc` | Close the top modal (one level), clear the composer, leave an agent or process view (never stops it), or interrupt main's turn |
| `Ctrl+X` | Inside an agent or process view: stop it (press twice to confirm) |
| `Ctrl+C` | Clear input, cancel a running turn. Press twice to quit |

Most bindings are customizable in `~/.goodvibes/tui/keybindings.json`, and `/keybindings` shows what is currently bound. Five keys are fixed and stay out of that file: `F2` (Agents), `Shift+Tab` (permission-mode cycle), `Esc` (leave the current mode), `?` (help), and `@` (file picker). The full reference is in [docs/tools-and-commands.md](docs/tools-and-commands.md).

---

## What's in the box

Each row links to the page that documents it. The product's own `?` overlay and `/help` are always the current authority.

| Area | What you get | Docs |
| --- | --- | --- |
| Models and routing | Native, OpenAI-compatible, and gateway providers; local inference-server discovery; synthetic failover groups; per-role model targets; custom provider JSON | [providers-and-routing.md](docs/providers-and-routing.md) |
| Tools | File read/write/edit/find, shell exec, fetch, web search, code analysis and inspection, agents, workflows, bounded REPL/query runtimes | [tools-and-commands.md](docs/tools-and-commands.md) |
| Slash commands | The full generated command reference, by category | [commands-reference.md](docs/commands-reference.md) |
| Keyboard | The complete binding reference, and how to rebind | [tools-and-commands.md](docs/tools-and-commands.md) |
| Agents and workflows | Built-in and custom archetypes, spawning, git worktree isolation, automation and scheduled jobs | [tools-and-commands.md](docs/tools-and-commands.md) |
| Extending it | Hooks and hook chains, the plugin manifest and API, MCP servers, the curated marketplace | [tools-and-commands.md](docs/tools-and-commands.md) |
| Diagnostics | Evaluation suites, deterministic replay, incident bundles, the state inspector, telemetry | [tools-and-commands.md](docs/tools-and-commands.md) |
| CLI flags | Session lifecycle (`--continue`, `--resume`, `--fork`), non-interactive mode, output formats, host selection | [cli-flags.md](docs/cli-flags.md) |
| Knowledge and memory | Session and durable memory, a structured knowledge store with connectors and extractors, embeddings and retrieval, artifacts, multimodal analysis | [knowledge-artifacts-and-multimodal.md](docs/knowledge-artifacts-and-multimodal.md) |
| Session durability | Post-turn snapshots plus an fsync-per-record transcript journal replayed at every resume | [session-durability.md](docs/session-durability.md) |
| Planning | Conversational planning loop, project-scoped knowledge spaces, readiness evaluation, the Planning modal | [project-planning.md](docs/project-planning.md) |
| Sharing and export | `/share` to HTML, JSON, or Markdown with redaction, upload, and clipboard options | [share-command.md](docs/share-command.md) |
| Daemon and services | Connecting to the standalone GoodVibes daemon, browser operator surface, background service and autostart, inbound TLS, outbound trust | [deployment-and-services.md](docs/deployment-and-services.md) |
| Remote access | A worked home-server setup: always-on daemon, browser access, TUI over SSH, reachability and TLS | [remote-access.md](docs/remote-access.md) |
| Channels and API | Slack, Discord, Telegram, Matrix, webhook and other surfaces; the shared reply pipeline; remote peers and node hosts; the control-plane HTTP and streaming API | [channels-remote-and-api.md](docs/channels-remote-and-api.md) |
| Voice | Live `/tts` playback, TTS and STT providers, streaming voice API | [voice-and-live-tts.md](docs/voice-and-live-tts.md) |
| Sandboxing | Bounded eval and isolated MCP execution, with a QEMU-backed VM path | [qemu-sandbox.md](docs/qemu-sandbox.md) |
| Integrations | Home Assistant surface, Cloudflare Workers/Queues batch, GitHub Action | [homeassistant-surface.md](docs/homeassistant-surface.md) · [cloudflare-batch.md](docs/cloudflare-batch.md) · [github-action.md](docs/github-action.md) |
| Contributing surfaces | The checked-in operator/peer contracts and knowledge schemas | [foundation-artifacts](docs/foundation-artifacts/README.md) |

Full index: [docs/README.md](docs/README.md).

---

## Configuration

Settings are layered. Later layers win:

1. built-in defaults
2. global settings: `~/.goodvibes/tui/settings.json`
3. project overrides: `.goodvibes/tui/settings.json`
4. CLI and runtime overrides

Edit them live with `/settings` or the fullscreen `/config` workspace rather than by hand. A few of the most-reached-for keys:

| Key | Default | What it does |
| --- | --- | --- |
| `permissions.mode` | `prompt` | `prompt`, `accept-edits`, `plan`, `allow-all`, or `custom` (per-tool overrides) |
| `provider.model` | `openrouter:openrouter/free` | Active model for main chat |
| `provider.reasoningEffort` | `medium` | Reasoning depth on models that support it |
| `display.theme` | `vaporwave` | Color theme |
| `display.stream` | `true` | Stream responses token by token |
| `display.lineNumbers` | `off` | Line numbers: `off`, `code`, or `all` |
| `display.showThinking` | `false` | Show model thinking traces |
| `behavior.autoCompactThreshold` | `80` | Context percentage before auto-compact runs |
| `helper.enabled` | `false` | Route grunt work to a cheaper helper model |
| `daemon.enabled` | `true` | Adopt a local session daemon on loopback; off makes no adoption attempt |

The wider key table, the permission modes, and the hand-edited TUI namespaces (checkpoint root guard, scriptable statusline, session behavior, launch-time self-update) are in [docs/configuration.md](docs/configuration.md).

### Where things are stored

Everything lives in plain files, split between the per-user `~/.goodvibes/tui/` tree and the project's own `.goodvibes/` directory:

| Path | What lives there |
| --- | --- |
| `~/.goodvibes/tui/settings.json` | Global settings |
| `.goodvibes/tui/settings.json` | Project settings overriding the global layer |
| `~/.goodvibes/tui/secrets.enc` or `.goodvibes/tui/secrets.enc` | Encrypted secrets, global or per project |
| `~/.goodvibes/tui/providers/*.json` | Custom provider definitions, hot-reloaded |
| `~/.goodvibes/tui/keybindings.json` | Keybinding overrides |
| `.goodvibes/tui/services.json` | The service registry |
| `.goodvibes/tui/automation-*.json` | Scheduled jobs and the rest of the automation store |
| `.goodvibes/agents/*.md` | Agent archetypes |
| `.goodvibes/mcp.json` | MCP server definitions |
| `.goodvibes/hooks.json` | Hooks and hook chains |
| `.goodvibes/` (rest) | Sessions, artifacts, and other project runtime state in the working directory |

---

## A note on cost

Free-tier synthetic models can cascade to the next-best free model when every backend for the current one is exhausted, and free, paid, and subscription tiers are never mixed. This system is not perfect, and there are ways it could result in charges accruing.

This includes but is not limited to when a provider moves a model from free to paid and you have kept the session running for longer than 24 hours without refreshing the model list. The system will not know that the model is now a paid model.

Refreshes happen automatically when a new session is started or resumed after the 24-hour catalog TTL expires. For long-running sessions, please ensure that the models are refreshed daily.

Paid and subscription models never auto-switch to a different model. That choice stays yours. When one is exhausted, GoodVibes says so and offers to wait out the cooldown, change model, or move to a free synthetic model. Full failover behavior: [docs/providers-and-routing.md](docs/providers-and-routing.md).

---

## Development

```sh
git clone https://github.com/mgd34msu/goodvibes-tui.git
cd goodvibes-tui
bun install
bun run dev
```

| Command | Does |
| --- | --- |
| `bun run dev` | Run the TUI from source |
| `bun run test:changed` | Run the test files your change affects (since `origin/main`) |
| `bun run test` | Run the whole suite through the parallel per-file runner (CI runs it on every push) |
| `bun run build` | Compile `src/main.ts` into `dist/goodvibes` |

The compiled binary is the TUI entrypoint. With `daemon.enabled` on (the default) it adopts a running standalone GoodVibes daemon over loopback, and when a daemon is installed as a service but stopped, it starts that service once and waits for it to come online. It never embeds or constructs a daemon of its own. The control plane, HTTP listener (`danger.httpListener`), and web surface are all hosted by the daemon; the TUI configures them and reports their bindings.

Tests live under `src/test/`, mirroring the source tree; byte-exact golden renderer frames are part of that suite. End-to-end tests under `src/test/e2e/` drive the compiled binary in a real terminal against a scripted model. CI also checks import cycles and layer boundaries (`scripts/check-architecture.ts`), and the release gates hold the performance budgets (`scripts/perf-baseline.json`). [Testing and validation](docs/testing-and-validation.md) says what runs where.

Some decisions worth knowing before you read the source:

- **Bun runtime.** Native TypeScript execution, fast startup, built-in test runner.
- **Raw ANSI renderer.** It writes the UI straight to the alternate screen buffer, giving direct control over every byte sent to the terminal. Conversation, modals, overlays, and the footer all share that one renderer.
- **In-process agents.** Agents run in the same process rather than over IPC, staying isolated through scoped tool registries and namespaced state.
- **Typed runtime store.** A plain `zustand/vanilla` store with typed selectors and dispatch paths, reachable from agents, tools, renderer, hooks, channels, and daemon surfaces alike.
- **Tree-sitter and bundled language servers.** Grammars for structural analysis, outlines, and AST-level edits, several embedded as WASM for instant startup. TypeScript, Python, Bash, CSS, HTML, and JSON language servers ship as dependencies, while `rust-analyzer` and `gopls` are fetched on first use with checksum verification.
- **Backend-first external surface.** The daemon product exposes typed HTTP and gateway methods, so other clients do not reimplement runtime logic.
- **Crash recovery.** Periodic snapshots plus an fsync-per-record append-only transcript journal, replayed at every resume seam.
- **Render coalescing and a per-message line cache.** Same-tick render requests collapse into one composite frame, and transcript growth re-renders only the appended message instead of rebuilding the whole conversation.

The TUI consumes the published `@pellux/goodvibes-sdk` platform layer for shared contracts, daemon routes, and transports, and keeps the terminal UI, host wiring, and product composition here. The dependency is pinned in `package.json`. Reference consumers of those surfaces live under [`examples/`](examples/reference-operator-client/README.md).

Source layout, in brief (the layer rules and the operator API bridge are in [docs/architecture.md](docs/architecture.md)):

```text
src/
├── main.ts, core/          terminal entrypoint, orchestrator, conversation and transcript state
├── renderer/               raw ANSI compositor, overlays, modals, fullscreen workspaces
├── views/                  modal surfaces, the fleet read model and acts behind Agents, view wiring
├── input/                  slash commands, keybindings, composer, pickers, settings modals
├── runtime/                bootstrap wiring, typed store, service composition, session recovery
├── shell/                  shell-level modal openers, blocking input, retry affordances
├── config/                 settings layering, surface roots, secrets, credential availability
├── permissions/            approval cards, hunk selection, sandbox exec gate
├── cli/                    flag parsing, management verbs, doctor, launch-time self-update
├── tools/, mcp/            TUI-local tool guards, MCP runtime reload
├── audio/, export/         voice capture, wake word, playback and speech routing; gist upload
├── verification/, widget/  live verifier, the terminal widget module
├── utils/, scripts/        formatting and clipboard helpers, message processing script
└── test/                   the suite, mirroring the tree above
```

---

## Stability

From 1.0.0 the project follows semver: incompatible changes to CLI flags, config keys, slash commands, key bindings, daemon routes, and on-disk layouts land only in major releases, and deprecations are noted in [CHANGELOG.md](CHANGELOG.md) first. Documentation always describes the **current** behavior, not historical behavior.

## License

MIT
