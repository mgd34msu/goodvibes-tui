# Getting started

## Prerequisites

- The recommended global install needs [Bun](https://bun.sh) v1.3.10 or later.
- An npm install needs Node.js 20+ and npm, plus `bun` on `PATH`.
- Source and dev workflows need Bun v1.3.10 or later.
- [Go](https://go.dev) is optional, for Go language-server support.
- `rust-analyzer` is optional for Rust work; GoodVibes can download it automatically on first use.

## Install

Install from the npm registry with Bun on Linux, macOS, or WSL:

```sh
bun add -g @pellux/goodvibes-tui
bun pm trust -g @pellux/goodvibes-tui goodvibes-daemon
goodvibes
```

Bun blocks lifecycle scripts for untrusted global packages. `@pellux/goodvibes-tui` needs trusting so its postinstall can place the matching TUI binary, and `goodvibes-daemon` needs trusting so its postinstall can place the daemon binary. `goodvibes-daemon` is a dependency of this package, so one install brings both commands. Nothing else needs trusting. The TUI binary comes from the platform-specific `@pellux/goodvibes-tui-<os>-<arch>` package with registry integrity, and the tree-sitter grammar packages ship their `.wasm` files as plain files (the app never loads the native bindings their `install` scripts would build). Verify the install with:

```sh
bun pm -g untrusted
goodvibes --version
goodvibes-daemon --version
```

`bun pm -g untrusted` should report `Found 0 untrusted dependencies with scripts`.

`npm install -g` is also supported when Bun is already installed and on `PATH`:

```sh
npm install -g @pellux/goodvibes-tui
goodvibes
```

The package downloads the matching prebuilt TUI and daemon binaries for the current Linux or macOS platform during `postinstall`. If `bun` is missing, the preinstall check fails with a clear message instead of installing a broken launcher.

On Windows, use WSL2. Inside a WSL2 distribution GoodVibes is an ordinary Linux install and the Linux binaries apply unchanged (`wsl --install`, then run the install command in your WSL2 shell). Native Windows is beta and not yet a supported path. See [windows.md](windows.md).

### Pure-binary installer (`goodvibes.sh/install.sh`)

The one-line installer downloads the checksum-verified TUI, daemon, and agent
binaries plus the browser operator surface's bundle without a package manager,
and doubles as the upgrade path. It lives in this repository (`scripts/install.sh`),
one copy for the whole suite, and resolves a release tag per repository,
verifying every file against that repository's own `SHA256SUMS.txt`:

```sh
curl -fsSL https://goodvibes.sh/install.sh | sh
```

On a **fresh install**, when no daemon is running and no service unit exists yet, it also registers the daemon as a user service so it comes up immediately and on every login:

- **Linux (systemd):** writes `~/.config/systemd/user/goodvibes.service` (marked as installer-managed), then `systemctl --user daemon-reload` and `enable --now`, and reports whether it went active.
- **macOS (launchd):** writes `~/Library/LaunchAgents/sh.goodvibes.daemon.plist` (installer-managed) and loads it with `launchctl bootstrap`.
- **Neither available (or opted out):** prints the plain `goodvibes-daemon` command to run it yourself.

It never overwrites an existing unit. An already-running daemon is restarted in place by the upgrade path instead.

**Installer options** (environment variables):

| Variable | Default | Effect |
| --- | --- | --- |
| `GOODVIBES_INSTALL_DIR` | `~/.local/bin` | Target directory for the binaries |
| `GOODVIBES_VERSION` | `latest` | Pin the terminal app's release tag |
| `GOODVIBES_DAEMON_VERSION` | `latest` | Pin the daemon's release tag |
| `GOODVIBES_AGENT` | `1` | Set to `0` to skip installing `goodvibes-agent` |
| `GOODVIBES_AGENT_VERSION` | `latest` | Pin the agent's release tag |
| `GOODVIBES_WEBUI` | `1` | Set to `0` to skip the browser operator surface |
| `GOODVIBES_WEBUI_VERSION` | `latest` | Pin the web UI's release tag |
| `GOODVIBES_RESTART_DAEMON` | `1` | Set to `0` to leave a running daemon/agent untouched |
| `GOODVIBES_VECTOR` | `1` | Set to `0` to skip the sqlite-vec native addon |
| `GOODVIBES_DAEMON_SERVICE` | `1` | Set to `0` to skip first-run daemon service setup |
| `GOODVIBES_UNINSTALL` | `0` | Set to `1` to uninstall (see below) |

The browser surface is not a fourth binary and not a fourth service. Its bundle
unpacks to `<install dir>/webui/<version>` and the daemon serves it on its own
listener. Installing it exposes nothing new to your network. The daemon's
shipped binding is loopback and the installer does not change it, so the URL in
the install receipt works on that machine only. Reaching it from another device
is a deliberate separate act, `goodvibes-daemon webui enable --lan`.

**Uninstall:**

```sh
curl -fsSL https://goodvibes.sh/install.sh | GOODVIBES_UNINSTALL=1 sh
```

Uninstall mode takes precedence over everything else (no downloads happen). It stops the running daemon/agent, then removes only what the installer manages, which is the three binaries in the install dir, the sqlite-vec addon directories, the unpacked web UI bundles, and the service unit/plist **only when it carries the installer-managed marker**. A hand-written unit is never deleted; it is reported with the manual removal command instead. Your `~/.goodvibes` data (settings, sessions, memory) is deliberately preserved, and the summary prints the `rm -rf ~/.goodvibes` command if you want to erase it too.

Or install from source:

```sh
git clone https://github.com/mgd34msu/goodvibes-tui.git
cd goodvibes-tui
bun install
```

## Configure a model provider

API keys resolve from environment variables first, then from the GoodVibes
secret store. The local store can hold encrypted values directly or
provider-backed secret references for Bitwarden, Vaultwarden, Bitwarden
Secrets Manager, 1Password, files, and command-backed resolvers.

The fastest path is an environment variable:

```sh
export OPENAI_API_KEY=...
```

| Provider | Primary Env Var | Accepted Aliases | Type |
|----------|----------------|-----------------|------|
| Anthropic | `ANTHROPIC_API_KEY` | `CLAUDE_API_KEY` | Paid |
| OpenAI | `OPENAI_API_KEY` | `OPENAI_KEY` | Paid |
| Google Gemini | `GEMINI_API_KEY` | `GOOGLE_API_KEY`, `GOOGLE_GEMINI_API_KEY` | Paid |
| InceptionLabs | `INCEPTION_API_KEY` | none | Paid |
| Mistral | `MISTRAL_API_KEY` | none | Paid |
| OpenRouter | `OPENROUTER_API_KEY` | none | Free tier available |
| Groq | `GROQ_API_KEY` | none | Free (LPU inference) |
| Cerebras | `CEREBRAS_API_KEY` | none | Free (wafer-scale inference) |
| AIHubMix | `AIHUBMIX_API_KEY` | none | Free tier (rate-limited) |
| HuggingFace | `HF_API_KEY` | `HUGGINGFACE_API_KEY`, `HF_TOKEN` | Free tier (rate-limited) |
| Ollama Cloud | `OLLAMA_CLOUD_API_KEY` | `OLLAMA_API_KEY` | Free |
| NVIDIA NIM | `NVIDIA_API_KEY` | none | 1000 free credits |
| LLM7 | `LLM7_API_KEY` | none | Free |

Additional built-in integrations resolve from the same env/secrets path:

- LLM/gateway providers: `AWS_BEARER_TOKEN_BEDROCK`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `GOOGLE_APPLICATION_CREDENTIALS`, `ANTHROPIC_VERTEX_PROJECT_ID`, `GOOGLE_CLOUD_PROJECT`, `COPILOT_GITHUB_TOKEN`, `GH_TOKEN`, `GITHUB_TOKEN`, `DEEPSEEK_API_KEY`, `FIREWORKS_API_KEY`, `AZURE_OPENAI_API_KEY`, `MINIMAX_API_KEY`, `MOONSHOT_API_KEY`, `QIANFAN_API_KEY`, `QWEN_API_KEY`, `DASHSCOPE_API_KEY`, `MODELSTUDIO_API_KEY`, `SGLANG_API_KEY`, `STEPFUN_API_KEY`, `TOGETHER_API_KEY`, `VENICE_API_KEY`, `VOLCANO_ENGINE_API_KEY`, `XAI_API_KEY`, `XIAOMI_API_KEY`, `ZAI_API_KEY`, `CLOUDFLARE_AI_GATEWAY_API_KEY`, `AI_GATEWAY_API_KEY`, `LITELLM_API_KEY`, `COPILOT_PROXY_API_KEY`
- Search and media: `PERPLEXITY_API_KEY`, `DEEPGRAM_API_KEY`, `ELEVENLABS_API_KEY`, `XI_API_KEY`, `VYDRA_API_KEY`, `BYTEPLUS_API_KEY`, `FAL_KEY`, `FAL_API_KEY`, `COMFY_API_KEY`, `RUNWAYML_API_SECRET`, `RUNWAY_API_KEY`

Alternatively, store keys encrypted using the `/secrets` command:

```sh
/secrets set OPENAI_API_KEY sk-...
```

For self-hosted or external secret managers, link a GoodVibes key to a
provider-backed secret reference:

```sh
/secrets link OPENAI_API_KEY goodvibes://secrets/bitwarden?item=GoodVibes%20OpenAI&field=password&sessionEnv=BW_SESSION
/secrets link SLACK_BOT_TOKEN goodvibes://secrets/vaultwarden?item=GoodVibes%20Slack&field=password&server=https%3A%2F%2Fvault.example.test
/secrets link STRIPE_TOKEN goodvibes://secrets/bws/00000000-0000-0000-0000-000000000000?field=value&accessTokenEnv=BWS_ACCESS_TOKEN
/secrets link OPENAI_API_KEY goodvibes://secrets/1password?vault=Private&item=GoodVibes%20OpenAI&field=API%20Key
```

Use `/secrets providers` for supported provider shapes and `/secrets test <secret-ref>` to validate a ref without printing its value.

Environment variables take precedence over stored secrets when both are present.

## Run from source

```sh
bun run dev
```

That starts the full TUI runtime from `src/main.ts`. It connects to the daemon the same way the
compiled binary does, adopting one already running, or starting an installed-but-stopped daemon
service, and never running the daemon itself. To run the daemon/API host from source instead, clone
and run `goodvibes-daemon` from its own repository.

## Build and run the compiled binary

```sh
bun run build
./dist/goodvibes
```

`bun run build` compiles `src/main.ts` into `dist/goodvibes`. The compiled binary runs the TUI and
can also host the HTTP listener in-process when `danger.httpListener` is enabled in config.

## Launch and resume

Opening the TUI in a workspace starts a fresh session. Previous work is reached
only deliberately. `--continue` reopens the most recently active session for the
working directory, `--resume [id]` reopens a named one, and `--fork [id]`
branches from one. See [CLI session lifecycle flags](tools-and-commands.md#cli-session-lifecycle-flags).
After the splash, a short notice summarizes the resumable state that actually
exists on disk (saved sessions, workspace checkpoints, chain history) and names
the command that reaches each one.

### The startup recovery modal

If a session crashed before saving, its periodic snapshot survives on disk. At
the next launch, right after the first frame is drawn, the TUI asks about it
instead of leaving a sentence for you to act on. Nothing loads unless you choose
Resume.

The ask is two steps:

1. **Recovery snapshot found.** `Resume it` loads the snapshot into the current
   session and retires the recovery point once the load succeeds. `Not now`
   starts fresh. The row detail names the facts actually known about the
   snapshot, namely session id, age, the title when it carries one, and the
   file size when it can be read.
2. **Remove recovery point?** Asked only after you decline. `Keep it` is first
   and preselected, so the snapshot stays on disk and is offered again the next
   time the workspace opens. `Remove it` deletes it, and the conversation it
   holds cannot be recovered afterwards.

Escape is not an answer. Dismissing either modal leaves the snapshot exactly
where it is. Only `Remove it` deletes anything, and a failed load leaves the
file in place to be offered again next launch. A snapshot whose session still
has a live process marker is never offered at all, because another terminal is
refreshing it, so it is that instance's live state rather than an orphaned
crash. Keeping (or dismissing) stays quiet for the rest of the run.

## Common paths

Project runtime data lives under `.goodvibes/` in the working directory, holding sessions, hooks, MCP config, artifacts, and local state.

- global settings: `~/.goodvibes/tui/settings.json`
- project settings: `.goodvibes/tui/settings.json`
- secure secrets: `~/.goodvibes/tui/secrets.enc` or `.goodvibes/tui/secrets.enc`
- compatibility secrets: `~/.goodvibes/goodvibes.secrets.json`
- service registry: `.goodvibes/tui/services.json`
- daemon home: `~/.goodvibes/daemon`
- QEMU sandbox bundle: `~/.goodvibes/tui/sandbox`
- custom providers: `~/.goodvibes/tui/providers/*.json`
- scheduled/automation jobs: `.goodvibes/tui/automation-jobs.json`
- REPL history: `.goodvibes/tui/repl-history.json`
- keybindings: `~/.goodvibes/tui/keybindings.json`
- agent archetypes: `.goodvibes/agents/*.md`
- MCP server config: `.goodvibes/mcp.json`
- hook config: `.goodvibes/hooks.json` (or the file named by `tools.hooksFile`)

## First things to open in the product

These slash commands are the fastest way to get oriented once the TUI is running.

- `/model` to open the fullscreen provider/model workspace for main chat, helper, tool LLM, and TTS LLM routing
- `/settings` or `/config` to inspect and edit runtime settings in the fullscreen configuration workspace
- `/knowledge status` to inspect the knowledge runtime
- `/plugin browse` and `/marketplace` to inspect the plugin ecosystem
- `/remote` if you are using remote peers or node-host runners
- `/mcp` to add, edit, remove, reload, and inspect MCP servers while the TUI is running
- `/sandbox review` if you plan to use bounded eval or isolated MCP/repl execution

## Local server discovery

On startup, GoodVibes can auto-discover local inference servers and register them as OpenAI-compatible providers, probing well-known ports and, where a fixed port is not enough, the server's own response headers. Built-in discovery covers:

- Ollama, on its default port
- LM Studio, on its default OpenAI-compatible server port
- vLLM, identified from its response headers
- llama.cpp, identified from its server header
- LocalAI, an OpenAI-compatible server also identified from its server header
- Text Generation Inference (TGI), Hugging Face's serving stack, identified from its server header
- Jan, on its default port
- GPT4All, on its default port
- KoboldCpp, on its default port
- Aphrodite, on its default port

## Related docs

- [Deployment and services](deployment-and-services.md)
- [Providers and routing](providers-and-routing.md)
- [Tools and commands](tools-and-commands.md)
