# Getting Started with goodvibes-tui

goodvibes-tui is a terminal-based coding agent, similar to Gemini CLI, Codex, and Claude Code. It connects to a wide range of LLM providers, executes tools on your behalf, and supports a multi-agent workflow from within your terminal.

## Prerequisites

- **Bun** v1.0 or later — [https://bun.sh](https://bun.sh)
- Git
- Linux or macOS (Windows support is experimental via the compiled binary)

Install Bun if you do not already have it:

```sh
curl -fsSL https://bun.sh/install | bash
```

## Installation

```sh
git clone https://github.com/mgd34msu/goodvibes-tui
cd goodvibes-tui
bun install
```

The `postinstall` script runs automatically and creates any required directories under `~/.goodvibes/tui/`.

## First Run

```sh
bun run dev
```

This launches the TUI in development mode (no compilation step required). The default model is `openrouter/free`, which works without an API key for basic usage.

For a production-compiled binary:

```sh
bun run build
./dist/goodvibes
```

## Adding a Provider

goodvibes-tui supports multiple ways to supply API keys.

### Option 1: Environment Variables

Set the appropriate environment variable before launching:

```sh
export OPENAI_API_KEY=sk-...
export ANTHROPIC_API_KEY=sk-ant-...
export GEMINI_API_KEY=AIza...
export OPENROUTER_API_KEY=sk-or-...
export GROQ_API_KEY=gsk_...
export HF_API_KEY=hf_...
export NVIDIA_API_KEY=nvapi-...
export MISTRAL_API_KEY=...
export CEREBRAS_API_KEY=...
export INCEPTION_API_KEY=...
export OLLAMA_CLOUD_API_KEY=...
export AIHUBMIX_API_KEY=...
export LLM7_API_KEY=...
```

Keys are loaded automatically at startup.

### Option 2: Encrypted Secrets Store

From inside the TUI, use `/secrets set` to store a key encrypted on disk:

```
/secrets set OPENAI_API_KEY sk-...
```

Secrets are stored at `~/.goodvibes/tui/secrets.enc` using AES-256-GCM encryption, keyed to your machine hostname and username.

### Option 3: Custom Provider (Local / Self-Hosted)

To add a local Ollama server or any OpenAI-compatible endpoint:

```
/provider add my-ollama http://localhost:11434/v1
```

goodvibes-tui will probe the URL for available models and write a config file to `~/.goodvibes/tui/providers/my-ollama.json`. The provider becomes available immediately via the file watcher.

## Basic Usage

### Starting a Conversation

Type your message at the prompt and press **Enter** to send. The agent will respond and may use tools (file read/write, shell execution, web fetch) to complete the task.

### Selecting a Model

Press **Enter** at an empty prompt to open the model picker, or use:

```
/model
```

To switch to a specific model:

```
/model gemini-2.5-pro
/model gpt-5.4
/model claude-sonnet-4-6
```

### Switching Provider

```
/provider openai
/provider anthropic
/provider gemini
```

### Slash Commands

Type `/` to open the autocomplete overlay, which fuzzy-matches command names as you type. Press **Tab** to accept a suggestion. See [COMMANDS.md](./COMMANDS.md) for the full reference.

### Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `Enter` | Submit message / open model picker (empty input) |
| `Ctrl+C` | Interrupt current generation |
| `Ctrl+L` | Clear the display |
| `?` | Open shortcuts overlay |
| `Esc` | Close modal / cancel |
| `Up`/`Down` | Scroll conversation |
| `Ctrl+Up` | History: previous input |
| `Ctrl+Down` | History: next input |

Run `/shortcuts` or press `?` in the TUI to see all bindings.

### Agent Spawning

The assistant can spawn background subagents for long-running or parallel tasks. You can monitor them from the panel sidebar (`/panels`) or the agent detail modal.

### Saving and Resuming Sessions

```
/save my-session-name    # save current session
/sessions               # list all saved sessions
/load my-session-name   # restore a session
```

Sessions persist automatically between runs when `behavior.saveHistory` is enabled (the default).
