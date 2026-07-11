# Getting Started

## Prerequisites

- For the recommended global install: [Bun](https://bun.sh) v1.3.10 or later
- For npm install: Node.js 20+ and npm, plus `bun` on `PATH`
- For source/dev workflows: Bun v1.3.10 or later
- Optional: [Go](https://go.dev) for Go language-server support
- Optional: `rust-analyzer` for Rust work; GoodVibes can download it automatically on first use

## Install

Install from the npm registry with Bun on Linux, macOS, or WSL:

```sh
bun add -g @pellux/goodvibes-tui
bun pm trust -g @pellux/goodvibes-tui
goodvibes
```

Bun blocks lifecycle scripts for untrusted global packages. Only `@pellux/goodvibes-tui` needs trusting, so its postinstall can place the matching TUI and daemon binaries. No dependency needs trusting: the binaries come from the platform-specific `@pellux/goodvibes-tui-<os>-<arch>` package with registry integrity, and the tree-sitter grammar packages ship their `.wasm` files as plain files (the app never loads the native bindings their `install` scripts would build). Verify the install with:

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

On Windows, use WSL2: inside a WSL2 distribution GoodVibes is an ordinary Linux install and the Linux binaries apply unchanged (`wsl --install`, then run the install command in your WSL2 shell). Native Windows is beta and not yet a supported path — see [windows.md](windows.md).

### Pure-binary installer (`goodvibes.sh/install.sh`)

The one-line installer downloads the checksum-verified TUI, daemon, and agent binaries without a package manager, and doubles as the upgrade path:

```sh
curl -fsSL https://goodvibes.sh/install.sh | sh
```

On a **fresh install** — when no daemon is running and no service unit exists yet — it also registers the daemon as a user service so it comes up immediately and on every login:

- **Linux (systemd):** writes `~/.config/systemd/user/goodvibes-daemon.service` (marked as installer-managed), then `systemctl --user daemon-reload` and `enable --now`, and reports whether it went active.
- **macOS (launchd):** writes `~/Library/LaunchAgents/sh.goodvibes.daemon.plist` (installer-managed) and loads it with `launchctl bootstrap`.
- **Neither available (or opted out):** prints the plain `goodvibes-daemon` command to run it yourself.

It never overwrites an existing unit — an already-running daemon is restarted in place by the upgrade path instead.

**Installer options** (environment variables):

| Variable | Default | Effect |
| --- | --- | --- |
| `GOODVIBES_INSTALL_DIR` | `~/.local/bin` | Target directory for the binaries |
| `GOODVIBES_AGENT` | `1` | Set to `0` to skip installing `goodvibes-agent` |
| `GOODVIBES_RESTART_DAEMON` | `1` | Set to `0` to leave a running daemon/agent untouched |
| `GOODVIBES_VECTOR` | `1` | Set to `0` to skip the sqlite-vec native addon |
| `GOODVIBES_DAEMON_SERVICE` | `1` | Set to `0` to skip first-run daemon service setup |
| `GOODVIBES_UNINSTALL` | `0` | Set to `1` to uninstall (see below) |

**Uninstall:**

```sh
curl -fsSL https://goodvibes.sh/install.sh | GOODVIBES_UNINSTALL=1 sh
```

Uninstall mode takes precedence over everything else (no downloads happen). It stops the running daemon/agent, then removes only what the installer manages — the three binaries in the install dir, the sqlite-vec addon directories, and the service unit/plist **only when it carries the installer-managed marker**. A hand-written unit is never deleted; it is reported with the manual removal command instead. Your `~/.goodvibes` data (settings, sessions, memory) is deliberately preserved, and the summary prints the `rm -rf ~/.goodvibes` command if you want to erase it too.

Or install from source:

```sh
git clone https://github.com/mgd34msu/goodvibes-tui.git
cd goodvibes-tui
bun install
```

## Configure a model provider

The fastest path is an environment variable:

```sh
export OPENAI_API_KEY=...
```

GoodVibes also supports:

- encrypted local secrets via `/secrets`
- provider-backed secret references for Bitwarden, Vaultwarden, Bitwarden Secrets Manager, and 1Password
- file-backed and command-backed secret resolvers

Environment variables take precedence over stored secrets when both are present.

## Run from source

```sh
bun run dev
```

That starts the full TUI runtime from `src/main.ts`.

## Run the headless daemon/API host from source

```sh
GOODVIBES_DAEMON_TOKEN=... GOODVIBES_HTTP_TOKEN=... bun run daemon
```

Use this when you want the daemon/API host without the interactive TUI.

## Build and run the compiled binary

```sh
bun run build
./dist/goodvibes
```

`bun run build` compiles `src/main.ts` into `dist/goodvibes`. The compiled binary runs the TUI and can also host the daemon and HTTP listener in-process when those services are enabled in config.

## Common paths

- global settings: `~/.goodvibes/tui/settings.json`
- project settings: `.goodvibes/tui/settings.json`
- secure secrets: `~/.goodvibes/tui/secrets.enc` or `.goodvibes/tui/secrets.enc`
- compatibility secrets: `~/.goodvibes/goodvibes.secrets.json`
- service registry: `.goodvibes/tui/services.json`
- daemon home: `~/.goodvibes/daemon`
- QEMU sandbox bundle: `~/.goodvibes/tui/sandbox`
- custom providers: `~/.goodvibes/tui/providers/*.json`
- schedules: `.goodvibes/tui/schedules.json`
- REPL history: `.goodvibes/tui/repl-history.json`

## First things to open in the product

- `/model` to open the fullscreen provider/model workspace for main chat, helper, tool LLM, and TTS LLM routing
- `/settings` or `/config` to inspect and edit runtime settings in the fullscreen configuration workspace
- `/knowledge status` to inspect the knowledge runtime
- `/plugin browse` and `/marketplace` to inspect the plugin ecosystem
- `/remote` if you are using remote peers or node-host runners
- `/mcp` to add, edit, remove, reload, and inspect MCP servers while the TUI is running
- `/sandbox review` if you plan to use bounded eval or isolated MCP/repl execution

## Local server discovery

On startup, GoodVibes can auto-discover local inference servers and register them as OpenAI-compatible providers. Built-in discovery covers:

- Ollama
- LM Studio
- vLLM
- llama.cpp / LocalAI
- Text Generation Inference
- Jan
- GPT4All
- KoboldCpp
- Aphrodite

## Related docs

- [Deployment and services](deployment-and-services.md)
- [Providers and routing](providers-and-routing.md)
- [Tools and commands](tools-and-commands.md)
