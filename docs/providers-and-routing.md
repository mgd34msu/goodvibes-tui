# Providers and Routing

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

### Failover notices and cost delta

When a turn fails over to another provider, the transcript shows a notice naming both the source and destination providers alongside the error class. If the catalog contains per-1M-token pricing for both models, the notice also includes the cost delta in the form:

```
[Failover] anthropic -> openai (transient) [cost/1M: input 3.00→10.00, output 15.00→30.00]
```

If pricing data is unavailable for either model, the notice says `[cost data unavailable]` instead of fabricating a number.

### Chain visibility in the model picker

When a synthetic model is selected in the model picker, the detail area below the list shows the first rung of its fallback ladder (`0. provider/model`) instead of showing a dead-end "synthetic" label. When the chain has more than one entry, the first rung is shown with a `(+N more)` suffix disclosing the remaining fallbacks. Non-synthetic models continue to show context window and capability flags.

### CLI: inspect synthetic chains

Use `goodvibes models chain` to list all synthetic model fallback ladders from the command line — the same data available in the TUI picker:

```sh
goodvibes models chain               # all synthetic models
goodvibes models chain balanced      # filter by model id substring
goodvibes models chain --json        # JSON output for scripting
```

Each entry shows the model id, tier, configured/total backend count, and a position-numbered list of `provider/model` rungs.

## Custom providers

Any OpenAI-compatible API can be added by dropping JSON into:

- `~/.goodvibes/tui/providers/*.json`

Provider JSON is hot-reloaded, so custom provider definitions appear in the model/runtime surfaces without restarting the process.

## Daemon OpenAI-Compatible API

SDK 0.28.0 exposes a daemon-hosted OpenAI-compatible surface for local clients that can speak the OpenAI REST shape but need GoodVibes provider routing:

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
