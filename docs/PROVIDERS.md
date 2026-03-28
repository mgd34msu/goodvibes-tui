# Provider Setup Guide

goodvibes-tui connects to LLM providers via built-in integrations and custom OpenAI-compatible or Anthropic-compatible endpoints.

## API Key Resolution

For every provider, API keys are resolved in the following order:

1. **Environment variable** — standard env vars checked at startup
2. **Encrypted secrets store** — set via `/secrets set <KEY> <value>`; stored at `~/.goodvibes/tui/secrets.enc` using AES-256-GCM
3. **Not found** — provider is registered without a key and will fail at request time with a clear error

## Built-in Providers

### OpenAI

Provider name: `openai`

| Env Var | Notes |
|---------|-------|
| `OPENAI_API_KEY` | Primary |
| `OPENAI_KEY` | Fallback |

**Models:** `gpt-5.4`, `gpt-5.3-chat-latest`, `gpt-5-mini`, `gpt-5-nano`, `gpt-oss-120b`

### Anthropic

Provider name: `anthropic`

| Env Var | Notes |
|---------|-------|
| `ANTHROPIC_API_KEY` | Primary |
| `CLAUDE_API_KEY` | Fallback |

**Models:** `claude-opus-4-6`, `claude-sonnet-4-6`, `claude-haiku-4-5` (and others as they are released)

### Google Gemini

Provider name: `gemini`

| Env Var | Notes |
|---------|-------|
| `GEMINI_API_KEY` | Primary |
| `GOOGLE_API_KEY` | Fallback |
| `GOOGLE_GEMINI_API_KEY` | Fallback |

**Models:** `gemini-3.1-pro-preview`, `gemini-3-flash`, `gemini-3.1-flash-lite-preview`, `gemini-2.5-pro`

Gemini models support a 1M context window and optional reasoning effort levels (`low`, `medium`, `high`).

### InceptionLabs

Provider name: `inceptionlabs`

| Env Var | Notes |
|---------|-------|
| `INCEPTION_API_KEY` | Primary |

**Models:** `mercury-2` (32K context, supports reasoning effort: `instant`, `low`, `medium`, `high`), `mercury-edit` (code-editing specialist, not user-selectable)

Mercury-2 is a diffusion LLM with configurable reasoning depth.

### OpenRouter

Provider name: `openrouter`

| Env Var | Notes |
|---------|-------|
| `OPENROUTER_API_KEY` | Primary |

**Default model:** `openrouter/free` (auto-routes to the best free model). Free-tier models include models from NVIDIA, OpenAI, MiniMax, StepFun, Z.ai, and Arcee AI.

OpenRouter models support reasoning effort via the `openrouter` format.

### Groq

Provider name: `groq`

| Env Var | Notes |
|---------|-------|
| `GROQ_API_KEY` | Primary |

**Models:** `qwen/qwen3-32b`, `openai/gpt-oss-120b`, `openai/gpt-oss-20b`, `moonshotai/kimi-k2-instruct`, `moonshotai/kimi-k2-instruct-0905`, `llama-3.3-70b-versatile`, `llama-3.1-8b-instant`, `meta-llama/llama-4-scout-17b-16e-instruct`, `groq/compound`, `groq/compound-mini`

### HuggingFace

Provider name: `huggingface`

| Env Var | Notes |
|---------|-------|
| `HF_API_KEY` | Primary |
| `HUGGINGFACE_API_KEY` | Fallback |
| `HF_TOKEN` | Fallback |

**Models:** 100+ models including Qwen, DeepSeek, Llama, GLM, MiniMax, Cohere, and others. Uses the HuggingFace Inference Router at `https://router.huggingface.co/v1`.

### NVIDIA NIM

Provider name: `nvidia`

| Env Var | Notes |
|---------|-------|
| `NVIDIA_API_KEY` | Primary |

**Models:** DeepSeek V3.x, R1 variants, Nemotron series, Llama, Qwen, Mistral, and others. Uses `https://integrate.api.nvidia.com/v1`.

### Mistral AI

Provider name: `mistral`

| Env Var | Notes |
|---------|-------|
| `MISTRAL_API_KEY` | Primary |

**Models:** `mistral-large-latest`, `mistral-medium-latest`, `mistral-small-latest`, `codestral-latest`, `devstral-latest`, `devstral-medium-latest`, `devstral-small-latest`, `magistral-medium-latest`, `magistral-small-latest`, `ministral-14b-latest`, `ministral-8b-latest`, `ministral-3b-latest`, `pixtral-large-latest`, `open-mistral-nemo`

### Cerebras

Provider name: `cerebras`

| Env Var | Notes |
|---------|-------|
| `CEREBRAS_API_KEY` | Primary |

**Models:** `llama3.1-8b`, `qwen-3-235b-a22b-instruct-2507`

### Ollama Cloud

Provider name: `ollama-cloud`

| Env Var | Notes |
|---------|-------|
| `OLLAMA_CLOUD_API_KEY` | Primary |
| `OLLAMA_API_KEY` | Fallback |

Free hosted inference at `https://ollama.com/v1`. Models include DeepSeek, Qwen, Kimi, Mistral, Gemma, GLM, GPT-OSS, MiniMax, Nemotron, and others.

### AIHubMix

Provider name: `aihubmix`

| Env Var | Notes |
|---------|-------|
| `AIHUBMIX_API_KEY` | Primary |

Free-tier proxy for GPT, Gemini, GLM, MiniMax, Kimi, Step, and MiMo models.

### LLM7

Provider name: `llm7`

| Env Var | Notes |
|---------|-------|
| `LLM7_API_KEY` | Primary |

Five free models via llm7.io.

---

## SyntheticProvider and Failover

The **SyntheticProvider** wraps a set of real backend providers and automatically fails over between them when a rate limit (HTTP 429) or quota exhaustion (HTTP 402) is encountered.

### Built-in Synthetic Models

| Synthetic Model ID | Display Name | Backends |
|--------------------|--------------|----------|
| `gpt-oss-120b` | GPT-OSS 120B (Failover) | Groq, HuggingFace, NVIDIA, Ollama Cloud, OpenAI, OpenRouter |
| `minimax-m2.5` | MiniMax M2.5 (Failover) | HuggingFace, NVIDIA, Ollama Cloud, OpenRouter, AIHubMix |
| `kimi-k2.5` | Kimi K2.5 (Failover) | HuggingFace, NVIDIA, Ollama Cloud |
| `qwen-3.5-397b` | Qwen 3.5 397B (Failover) | HuggingFace, NVIDIA, Ollama Cloud |
| `glm-5` | GLM-5 (Failover) | HuggingFace, NVIDIA, Ollama Cloud, AIHubMix |
| `nemotron-3-super-120b` | Nemotron 3 Super 120B (Failover) | NVIDIA, Ollama Cloud, OpenRouter |

### Failover Behavior

1. A request is sent to the first available backend
2. On HTTP 429 or 402, the backend is placed in a 60-second cooldown
3. The request is immediately retried on the next backend
4. If all backends are in cooldown, an error is returned
5. Cooldowns are per-model and per-backend, stored in memory for the session

Additional synthetic models are auto-generated at startup: any model available across three or more providers automatically gets a synthetic failover entry.

---

## Dynamic Model Catalog

At startup, goodvibes-tui fetches a live model catalog from [models.dev](https://models.dev) and benchmark data from [ZeroEval](https://zeroeval.com). This replaces the static built-in model list with a continuously updated source.

### Data Sources

| Source | Content | TTL | Endpoint |
|--------|---------|-----|----------|
| models.dev | 4,102 models across 105 providers — pricing, context windows, capabilities, env var names, base URLs | 24h | `https://models.dev/api.json` |
| ZeroEval | Benchmark scores (GPQA, SWE-bench, AIME, etc.) for 275 models | 24h | `https://api.zeroeval.com/leaderboard/models/full?justCanonicals=true` |

### Cache Files

| File | Content |
|------|---------|
| `~/.goodvibes/tui/model-catalog.json` | models.dev data + fetch timestamp |
| `~/.goodvibes/tui/benchmarks.json` | ZeroEval scores + fetch timestamp |
| `~/.goodvibes/tui/favorites.json` | Pinned models + usage history |

The cache is never deleted on failure — if a network request fails, the last valid cache is used. Run `/refresh-models` to force an immediate re-fetch.

### Pricing Tiers

| Tier | Criteria | Behavior |
|------|----------|----------|
| **Free** | `cost.input === 0 && cost.output === 0`, no subscription gate | Free section in model picker |
| **Paid** | `cost > 0` | Paid section with pricing shown |
| **Subscription** | GitHub Copilot, GitHub Models, GitLab, v0, Vercel, coding-plan providers | Subscription section with label |
| **Shutdown** | iFlow, iFlowCN | Excluded entirely |

Tier isolation is enforced in failover: free backends only fail over to free, paid to paid, subscription to subscription. No surprise charges.

### Quality Tiers

Benchmark scores from ZeroEval are mapped to quality tiers displayed in the model picker:

| Tier | Score | Badge |
|------|-------|-------|
| S | ≥ 0.80 | S |
| A | ≥ 0.65 | A |
| B | ≥ 0.50 | B |
| C | < 0.50 | C |

---

## Custom Providers

Add any OpenAI-compatible or Anthropic-compatible endpoint as a custom provider.

### Quick Add via Command

```
/provider add <name> <baseURL> [apiKey]
```

goodvibes-tui probes `<baseURL>/models`, discovers available models (with context windows), and writes a JSON config file to `~/.goodvibes/tui/providers/<name>.json`.

### Manual Config File

Create a JSON file at `~/.goodvibes/tui/providers/<name>.json`:

```json
{
  "name": "my-provider",
  "displayName": "My Provider",
  "type": "openai-compat",
  "baseURL": "http://localhost:11434/v1",
  "apiKeyEnv": "MY_PROVIDER_API_KEY",
  "models": [
    {
      "id": "llama3:8b",
      "displayName": "Llama 3 8B",
      "contextWindow": 8192,
      "capabilities": {
        "toolCalling": true,
        "codeEditing": true,
        "reasoning": false,
        "multimodal": false
      }
    }
  ]
}
```

### Config Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | Yes | Unique identifier (letters, digits, hyphens, underscores) |
| `displayName` | string | Yes | Human-readable name |
| `type` | string | Yes | `openai-compat` or `anthropic-compat` |
| `baseURL` | string | Yes | API endpoint base URL |
| `apiKey` | string | No | Explicit API key (prefer `apiKeyEnv` for security) |
| `apiKeyEnv` | string | No | Environment variable name for the API key |
| `defaultHeaders` | object | No | Extra HTTP headers for every request |
| `reasoningFormat` | string | No | `mercury`, `openrouter`, `llamacpp`, or `none` |
| `models` | array | Yes | At least one model definition |

### Model Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | Yes | Model ID sent to the API |
| `displayName` | string | Yes | Name shown in the model picker |
| `description` | string | No | Short description |
| `contextWindow` | number | Yes | Max context in tokens |
| `selectable` | boolean | No | Whether shown in the model picker (default: true) |
| `capabilities.toolCalling` | boolean | Yes | Supports function/tool calling |
| `capabilities.codeEditing` | boolean | Yes | Optimized for code editing |
| `capabilities.reasoning` | boolean | Yes | Supports extended reasoning/thinking |
| `capabilities.multimodal` | boolean | Yes | Accepts images or other media |
| `reasoningEffort` | string[] | No | Supported effort levels, e.g. `["low", "medium", "high"]` |
| `tier` | string | No | `free`, `standard`, or `premium` |

### Hot Reload

The provider directory is watched at runtime. Adding, editing, or removing a `.json` file in `~/.goodvibes/tui/providers/` takes effect within 300ms without restarting goodvibes-tui.

### Removing a Custom Provider

```
/provider remove my-provider
```

Or delete the file directly from `~/.goodvibes/tui/providers/`.
