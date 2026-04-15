# Getting Started

## Prerequisites

- For npm install: Node.js 20+ and npm
- For source/dev workflows: [Bun](https://bun.sh) v1.3.10 or later
- Optional: [Go](https://go.dev) for Go language-server support
- Optional: `rust-analyzer` for Rust work; GoodVibes can download it automatically on first use

## Install

Install from npm on Linux, macOS, or WSL:

```sh
npm install -g @pellux/goodvibes-tui
goodvibes
```

The npm package downloads the matching prebuilt release binary during install.

Native Windows is not supported. Use WSL on Windows.

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
- custom providers: `~/.goodvibes/tui/providers/*.json`
- schedules: `.goodvibes/tui/schedules.json`
- REPL history: `.goodvibes/tui/repl-history.json`

## First things to open in the product

- `/model` to choose a provider/model
- `/settings` or `/config` to inspect runtime settings
- `/knowledge status` to inspect the knowledge runtime
- `/plugin browse` and `/marketplace` to inspect the plugin ecosystem
- `/remote` if you are using remote peers or node-host runners
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
