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

## Custom providers

Any OpenAI-compatible API can be added by dropping JSON into:

- `~/.goodvibes/tui/providers/*.json`

Provider JSON is hot-reloaded, so custom provider definitions appear in the model/runtime surfaces without restarting the process.

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

The TUI `/tts` command uses providers that advertise `tts-stream` for live local playback. Configure defaults with `/config-tts provider <id>` and `/config-tts voice <voice-id>`. See [Voice and live TTS](voice-and-live-tts.md) for command usage and playback requirements.

## Media and multimodal providers

Current media and multimodal coverage includes:

- image understanding: OpenAI, Gemini, Anthropic, and local OpenAI-compatible multimodal backends
- generation providers: BytePlus, Runway, Alibaba, Fal, and Comfy
- unified multimodal runtime for image, audio, video, and document analysis

## Related docs

- [Getting started](getting-started.md)
- [Knowledge, artifacts, and multimodal](knowledge-artifacts-and-multimodal.md)
- [Channels, remote runtime, and API](channels-remote-and-api.md)
