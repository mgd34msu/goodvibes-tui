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

At startup, GoodVibes can discover local inference servers and register them automatically as OpenAI-compatible providers. Discovery covers:

- Ollama
- LM Studio
- vLLM
- llama.cpp / LocalAI
- Text Generation Inference
- Jan
- GPT4All
- KoboldCpp
- Aphrodite

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

- **Rate limit (429).** Retries the next provider in the pool immediately.
- **Server error (500) or network error.** Retries the next provider after a five-second cooldown.
- **Client error (400).** Does not trigger failover. A 400 means the request itself is at fault, not the provider, so switching providers would not help.
- **All providers cooling down with short cooldowns (120 seconds or less).** The system waits for the shortest cooldown to expire and retries.

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

When a turn fails over to another provider, the transcript shows a notice naming both the source and destination providers alongside the error class. If the catalog contains per-1M-token pricing for both models, the notice also includes the cost delta in the form:

```
[Failover] anthropic -> openai (transient) [cost/1M: input 3.00→10.00, output 15.00→30.00]
```

If pricing data is unavailable for either model, the notice says `[cost data unavailable]` instead of fabricating a number.

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

Many model providers also support configurable reasoning effort levels. Selectable options include `instant`, `low`, `medium`, and `high`.

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

Use the normal daemon base URL and bearer token. Model ids include `goodvibes/current`, `goodvibes/default`, provider-qualified registry keys such as `openai:gpt-5.5`, and unambiguous plain model ids. Chat completions accept standard `messages`, optional `tools`, `max_tokens` or `max_completion_tokens`, and `stream: true` for SSE chunks.

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
- `local` for `tts`, `tts-stream`, and `stt`: free, offline engines (whisper.cpp/faster-whisper for STT, Piper/Kokoro for TTS). Nothing auto-downloads; it reports `unconfigured` until `voice.local.*` keys point at an installed engine and model. See [voice-and-live-tts.md](voice-and-live-tts.md).

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
