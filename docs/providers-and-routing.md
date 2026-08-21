# Providers and routing

## Provider model

GoodVibes has a layered provider system:

- native runtime providers
- compatible/gateway providers
- synthetic failover groups
- local discovered providers
- search providers
- voice providers
- media and multimodal providers

All of these flow into the same runtime routing, picker, metadata, and health surfaces.

## Native chat/runtime providers

Current built-in native providers include:

- `openai`
- `anthropic`
- `openai-codex`
- `gemini`
- `amazon-bedrock`
- `amazon-bedrock-mantle`
- `anthropic-vertex`
- `github-copilot`

## Compatible and gateway providers

The runtime also supports a broad compatible/gateway layer. Current built-ins include:

- `inceptionlabs`
- `openrouter`
- `aihubmix`
- `groq`
- `cerebras`
- `mistral`
- `ollama-cloud`
- `huggingface`
- `nvidia`
- `llm7`
- `deepseek`
- `fireworks`
- `microsoft-foundry`
- `minimax`
- `moonshot`
- `qianfan`
- `qwen`
- `sglang`
- `stepfun`
- `together`
- `venice`
- `volcengine`
- `xai`
- `xiaomi`
- `zai`
- `cloudflare-ai-gateway`
- `vercel-ai-gateway`
- `litellm`
- `copilot-proxy`
- `cohere`
- `deepinfra`
- `perplexity` (chat completions; distinct from the search provider of the same name below)
- `sambanova`
- `opencode-zen`
- `zenmux` and `zenmux-anthropic` (two endpoints of the same provider, both keyed off `ZENMUX_API_KEY`)

## Local discovery

Run `/scan` to probe localhost and the LAN for local inference servers and register whatever answers as OpenAI-compatible providers; discovery is not run automatically at startup. The scan checks the well-known ports for:

- Ollama
- LM Studio
- vLLM
- llama.cpp / LocalAI
- Text Generation Inference
- Jan
- GPT4All
- KoboldCpp
- Aphrodite

Ollama, LM Studio, vLLM, llama.cpp, and Text Generation Inference get dedicated adapters with server-specific capability traits (tool calling, streaming, and, for Ollama/LM Studio/llama.cpp, a four-level `instant/low/medium/high` reasoning ladder). Jan, GPT4All, KoboldCpp, and Aphrodite are fingerprinted by port but registered through the generic OpenAI-compatible adapter, with no server-specific reasoning support. Use `/provider add <name> <baseURL>` to register a server manually instead, which probes its `/models` endpoint directly rather than scanning ports.

## Synthetic failover

The `synthetic` provider groups the same model across multiple backends under a single selectable entry.

Key properties:

- rate-limit and transient-error failover across backends
- free / paid / subscription boundary preservation
- model grouping with provider counts in the picker
- benchmark-aware ranking from the catalog

For free-tier synthetic models, the runtime can also cascade to the next-best free model when every backend for the current synthetic model is exhausted.

### Setting up failover

Failover needs more than one backend to fail over to, so set API keys for several free providers. A workable minimum:

```sh
export GROQ_API_KEY="..."
export HF_API_KEY="..."
export NVIDIA_API_KEY="..."
export OLLAMA_CLOUD_API_KEY="..."
export OPENROUTER_API_KEY="..."
export AIHUBMIX_API_KEY="..."
```

Then pick any model from the `synthetic` provider. Keys can equally be stored with `/secrets set <NAME> <value>`; environment variables win when both are set.

### What synthetic models are

Synthetic models are models available from multiple providers, automatically grouped by the system under a single selectable entry. When you pick a synthetic model, the system routes your request to the best available backend. You never need to think about which provider is serving it.

Models with different naming across providers (for example `GPT-4o` vs `gpt 4o`) are automatically merged into one entry. Each synthetic model shows how many providers are available for failover in the model picker.

### Transparent failover rules

Within a single synthetic model, backends are tried in order (best context window first, then best max output tokens as a tiebreaker), skipping any backend without a configured key. A failed backend is marked on a cooldown and the next backend in the list is tried immediately, in the same call, with no wait:

- **Rate limit (429) or an out-of-credit/billing error.** The failed backend is put on cooldown (the provider's own retry-after when it sends one, otherwise 60 seconds by default) and the next backend is tried right away.
- **Other 4xx errors from the provider (401, 403, 404, and similar).** Treated as provider-specific rather than the caller's fault: the backend gets a 60-second cooldown and the next backend is tried.
- **Server error (500) or network error.** Treated as transient: the backend gets a short five-second cooldown and the next backend is tried immediately, without waiting out that cooldown first.
- **Client error (400).** Does not trigger failover. A 400 means the request itself is malformed, not the provider, so switching providers would not help.
- **All backends cooling down, shortest remaining cooldown 120 seconds or less.** The turn waits out that cooldown and makes one retry attempt on the backend that just came off it. Longer cooldowns are not waited out; the error surfaces immediately instead.

Failover is silent by default: the model name in the status bar does not change when the runtime switches backends for the same synthetic model.

### Cross-model failover (free tier only)

When every backend for a free synthetic model is exhausted and cooldowns are too long to wait out, the system falls back to the next-best free model ranked by benchmark score, notifies inline without blocking the turn, and cascades until it finds a working free model. Free, paid, and subscription tiers never mix. This cascade only happens within the free tier.

> **Cost-accrual caveat:** this system is not perfect, and charges can accrue in ways it cannot always catch. This happens notably when a provider moves a model from free to paid while a session has been running longer than 24 hours without a model refresh, since the system has no way to know the model is now paid. Refreshes happen automatically when a session is started or resumed after the 24-hour catalog TTL expires; for long-running sessions, refresh the model list daily.

### Paid and subscription exhaustion

Paid and subscription models do not auto-switch to a different model, because the user made a deliberate, cost-conscious choice. When a paid or subscription model is exhausted, the system shows recovery options instead:

- wait for the cooldown to expire and retry
- switch model with `/model`
- switch to a free synthetic model

### Model picker grouping

Synthetic models are split into **Top Models** (S-tier or A-tier by benchmark) and **All Synthetic**. Each entry shows how many providers are available for failover, and quality tier badges (S/A/B/C) are shown next to model names based on composite benchmark score.

### Failover notices and cost delta

Besides the backend rotation inside a single synthetic model described above, the TUI has a second, broader failover path. When any turn ends in `TURN_ERROR` and an optimizer-driven fallback chain has a viable next provider that has not already been tried this turn, the TUI switches to it and resubmits the turn, whether or not the original model was synthetic. A synthetic model is itself a fallback ladder over real backends, so this broader path never fails over *into* a synthetic model after a real one failed, only between real providers.

When this happens, the transcript shows a notice naming both the source and destination providers alongside the full user-facing error description (the same message-and-action text a plain `[Error]` line would show). If the catalog contains per-1M-token pricing for both models, the notice also includes the cost delta in the form:

```
[Failover] anthropic -> openai (Network error: could not reach the provider. Check your connection and retry, or switch models with /model.) [cost/1M: input $3.00→$10.00, output $15.00→$30.00]
```

If pricing data is unavailable for either model, the notice says `[cost data unavailable]` instead of fabricating a number. When the fallback chain is exhausted (every candidate already tried this turn, or none exist), the transcript shows `[Failover] Chain exhausted: no alternative provider available.` followed by the original error, and the model selection reverts to what the user had configured for the next turn.

### Chain visibility in the model picker

When a synthetic model is selected in the model picker, the detail area below the list shows the first rung of its fallback ladder (`0. provider/model`) instead of showing a dead-end "synthetic" label. When the chain has more than one entry, the first rung is shown with a `(+N more)` suffix disclosing the remaining fallbacks. Non-synthetic models continue to show context window and capability flags.

### CLI: inspect synthetic chains

Use `goodvibes models chain` to list all synthetic model fallback ladders from the command line. It is the same data available in the TUI picker:

```sh
goodvibes models chain               # all synthetic models
goodvibes models chain balanced      # filter by model id substring
goodvibes models chain --json        # JSON output for scripting
```

Each entry shows the model id, tier, configured/total backend count, and a position-numbered list of `provider/model` rungs.

Many model providers also support configurable reasoning effort, but the levels a given model actually offers are resolved per model rather than fixed. The runtime checks the live catalog entry for that exact model first, then a declaration attached to it (a plugin, a custom-model file, or a local server's traits), then a curated per-family table, and only falls back to a labelled best guess when nothing else matches.

Depending on the model, offered levels are drawn from `none`, `instant`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`; some models instead take a thinking-token budget, or only expose reasoning as an on/off toggle, or have no configurable reasoning at all. `/effort` shows exactly which of these the current model accepts.

## Per-role routing

`/model` opens a picker with five routing targets, each writing its own config keys, so a provider/model choice for one role never overwrites another:

| Target | Label | Config keys | Notes |
| --- | --- | --- | --- |
| `main` | Main Chat | `provider.provider` + `provider.model` | Default provider and model for normal chat turns. |
| `helper` | Helper Model | `helper.globalProvider` + `helper.globalModel` (+ `helper.enabled`) | Optional route for supporting work; empty values inherit Main Chat. |
| `tool` | Tool LLM | `tools.llmProvider` + `tools.llmModel` (+ `tools.llmEnabled`) | Optional route for tool-specific reasoning; selecting a model enables it. |
| `tts` | TTS LLM | `tts.llmProvider` + `tts.llmModel` | Optional override for `/tts` response generation; empty values use the current chat model. |
| `embeddings` | Embeddings | `provider.embeddingProvider` | Not an LLM route: an embedding provider id only, no model concept, used for memory search and the code index. |

The embeddings target has no model to pick, only a provider, so it opens a dedicated embedding-provider list instead of the model list the other four targets share.

## Custom providers

Any OpenAI-compatible API can be added by dropping JSON into:

- `~/.goodvibes/tui/providers/*.json`

For example:

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

Provider JSON is hot-reloaded, so custom provider definitions appear in the model/runtime surfaces without restarting the process. Use the `/add-provider` skill for interactive guided setup with smart defaults for popular providers.

## Daemon OpenAI-Compatible API

The daemon hosts an OpenAI-compatible surface for local clients that can speak the OpenAI REST shape but need GoodVibes provider routing:

```text
GET  /v1/models
POST /v1/chat/completions
```

Use the normal daemon base URL and bearer token. Model ids include the special id `goodvibes/current` (routes to whatever model the TUI session is currently serving), provider-qualified registry keys such as `openai:gpt-5.5`, and unambiguous plain model ids. Chat completions accept standard `messages`, optional `tools`, `max_tokens` or `max_completion_tokens`, and `stream: true` for SSE chunks.

The surface is enabled by default and gated by `controlPlane.openaiCompatible.enabled`; the path prefix is configurable via `controlPlane.openaiCompatible.pathPrefix` (default `/v1`).

This surface is a compatibility adapter over the current GoodVibes provider registry. It does not replace native TUI routing, model pickers, or provider health surfaces.

## Search providers

Built-in search surfaces include:

- `duckduckgo`
- `searxng`
- `brave`
- `exa`
- `firecrawl`
- `tavily`
- `perplexity`

The search runtime exposes normalized results, evidence shaping, verbosity controls, optional source fetches, and provider selection behind a single `web_search` surface.

## Voice providers

Current voice providers include:

- `openai` for `tts`, `stt`, and `realtime`
- `elevenlabs` for `tts`, `tts-stream`, `stt`, and `realtime`
- `deepgram` for `stt`
- `google` for `stt`
- `microsoft`
- `vydra`
- `local` for `tts`, `tts-stream`, and `stt`: free, offline engines (whisper.cpp/faster-whisper for STT, Piper/Kokoro for TTS). Pointing `voice.local.*` at engine and model paths you installed yourself never downloads anything; it reports `unconfigured` until all three keys for a direction (engine, binary, model path) are set. Running `/voice setup` instead performs a managed one-act install that fetches the Piper TTS engine and a default voice automatically, and the whisper STT engine and model where a bundle is hosted for your platform. See [voice-and-live-tts.md](voice-and-live-tts.md).

The TUI `/tts` command uses providers that advertise `tts-stream` for live local playback. Configure defaults through `/config tts`: `tts.provider` chooses the streaming provider, `tts.voice` chooses a provider voice, and `tts.llmProvider` / `tts.llmModel` optionally override the response model. `/tts` uses the active chat model by default when the TTS LLM override is empty. See [Voice and live TTS](voice-and-live-tts.md) for command usage and playback requirements.

## Media and multimodal providers

Current media and multimodal coverage includes:

- image understanding: OpenAI, Gemini, Anthropic, and local OpenAI-compatible multimodal backends
- generation providers: BytePlus, Runway, Alibaba, Fal, and Comfy
- unified multimodal runtime for image, audio, video, and document analysis

## Related docs

- [Getting started](getting-started.md)
- [Knowledge, artifacts, and multimodal](knowledge-artifacts-and-multimodal.md)
- [Channels, remote runtime, and API](channels-remote-and-api.md)
