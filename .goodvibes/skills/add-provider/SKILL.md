---
name: add-provider
description: Adds custom LLM providers and models to goodvibes-tui. Use when user wants to add a provider, add a model, configure Ollama, Together AI, OpenRouter, Groq, LM Studio, Fireworks, vLLM, or any OpenAI-compatible endpoint.
version: 1.0.0
triggers:
  - /add-provider
  - add provider
  - add a provider
  - new provider
  - custom provider
  - add model
  - add a model
author: goodvibes
---

# Add Custom Provider

Interactively collect provider and model details from the user, then write a JSON config to `~/.goodvibes/tui/providers/{name}.json`.

## Workflow

### Step 1: Check for Existing Provider

Before collecting info, check if `~/.goodvibes/tui/providers/` already has JSON files. If the user names a provider that already exists, ask:
- **Add models** to the existing provider, or
- **Overwrite** it entirely

If adding models, read the existing JSON, append new models, and write back.

### Step 2: Collect Provider Details

Ask the user for each field. Apply smart defaults when the provider name matches a known service.

#### Required Fields

| Field | Description | Validation |
|-------|-------------|------------|
| `name` | Internal ID | Lowercase alphanumeric + hyphens only, 1-64 chars |
| `displayName` | Human-readable name | Non-empty string |
| `type` | API compatibility | `openai-compat` (recommended) or `anthropic-compat` (not yet supported — use `openai-compat`) |
| `baseURL` | API endpoint | Must start with `http://` or `https://` |

> **Note:** `anthropic-compat` is accepted in the JSON schema for forward compatibility but is not yet functional at runtime. The loader will skip configs with this type and emit a warning. Use `openai-compat` for now — most Anthropic-compatible proxies (e.g., via LiteLLM) expose an OpenAI-compatible endpoint.

#### Optional Fields

| Field | Description | Default |
|-------|-------------|---------|
| `apiKeyEnv` | Environment variable for API key | None |
| `apiKey` | Explicit API key (not recommended) | None |
| `defaultHeaders` | Custom HTTP headers sent with every API request (e.g., for proxy authentication or routing) | None |

### Smart Defaults

When the user mentions a known provider, pre-fill these values and confirm:

```yaml
ollama:
  displayName: Ollama
  type: openai-compat
  baseURL: http://localhost:11434/v1
  apiKeyEnv: null

together:
  displayName: Together AI
  type: openai-compat
  baseURL: https://api.together.xyz/v1
  apiKeyEnv: TOGETHER_API_KEY

openrouter:
  displayName: OpenRouter
  type: openai-compat
  baseURL: https://openrouter.ai/api/v1
  apiKeyEnv: OPENROUTER_API_KEY

groq:
  displayName: Groq
  type: openai-compat
  baseURL: https://api.groq.com/openai/v1
  apiKeyEnv: GROQ_API_KEY

lm-studio:
  displayName: LM Studio
  type: openai-compat
  baseURL: http://localhost:1234/v1
  apiKeyEnv: null

fireworks:
  displayName: Fireworks AI
  type: openai-compat
  baseURL: https://api.fireworks.ai/inference/v1
  apiKeyEnv: FIREWORKS_API_KEY

vllm:
  displayName: vLLM
  type: openai-compat
  baseURL: http://localhost:8000/v1
  apiKeyEnv: null
```

If the name does not match a known provider, ask for all fields individually.

### Step 3: Collect Model Details

Collect at least one model. For each model:

| Field | Description | Validation |
|-------|-------------|------------|
| `id` | Model identifier sent to the API | Non-empty string |
| `displayName` | Human-readable name | Non-empty string |
| `description` | Short description | Optional, auto-generate if blank |
| `contextWindow` | Max tokens in context | Positive integer |
| `capabilities.toolCalling` | Supports function/tool calling | Boolean, default `true` |
| `capabilities.codeEditing` | Good at code editing tasks | Boolean, default `true` |
| `capabilities.reasoning` | Extended reasoning/chain-of-thought | Boolean, default `false` |
| `capabilities.multimodal` | Supports image input | Boolean, default `false` |
| `reasoningEffort` | Supported reasoning effort levels | Optional, e.g., `["low", "medium", "high"]` |

After each model, ask: "Add another model?" Loop until done.

### Step 4: Preview and Confirm

Show the complete JSON to the user and ask for confirmation before writing.

Example output:

```json
{
  "name": "ollama",
  "displayName": "Ollama",
  "type": "openai-compat",
  "baseURL": "http://localhost:11434/v1",
  "models": [
    {
      "id": "llama3.3-70b",
      "displayName": "Llama 3.3 70B",
      "description": "Meta's Llama 3.3 70B parameter model",
      "contextWindow": 131072,
      "capabilities": {
        "toolCalling": true,
        "codeEditing": true,
        "reasoning": true,
        "multimodal": false
      },
      "reasoningEffort": ["low", "medium", "high"]
    }
  ]
}
```

### Step 5: Write the File

Write to `~/.goodvibes/tui/providers/{name}.json`. Create the directory if it does not exist.

Use `precision_write` with `mode: "fail_if_exists"` for new providers. Use `mode: "overwrite"` when the user chose to overwrite an existing provider or when merging models into an existing file.

If the `apiKeyEnv` field is set, include it in the JSON. If the user provided an explicit `apiKey`, include it but warn that storing keys in plain text is not recommended -- suggest using an environment variable instead.

If `defaultHeaders` were provided, include them.

### Step 6: Confirm

Tell the user:
- The file was written to `~/.goodvibes/tui/providers/{name}.json`
- The provider should be available immediately if goodvibes-tui is currently running (it hot-reloads custom provider configs); if not running, changes take effect on next startup
- If an API key is needed, remind them to set the environment variable

## Validation Rules

Before writing, verify:
1. `name` matches `/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/` and is 1-64 characters (no trailing hyphens)
2. `baseURL` starts with `http://` or `https://`
3. `contextWindow` is a positive integer for every model
4. At least one model is defined
5. Every model has a non-empty `id` and `displayName`

If validation fails, tell the user which field is invalid and ask for correction.

## JSON Schema Reference

The provider JSON maps to the codebase types:

- Provider registration uses `OpenAICompatProvider` for `openai-compat` type. The `anthropic-compat` type is parsed and accepted in the JSON but is **not yet supported at runtime** — the loader skips it with a warning. Recommend `openai-compat` for all custom providers.
- `OpenAICompatOptions`: `{ name, baseURL, apiKey, defaultModel, models }`
- Model entries map to `ModelDefinition`: `{ id, provider, displayName, description, contextWindow, capabilities, reasoningEffort?, selectable }`
  - `reasoningEffort?: string[]` — optional array of supported effort levels, e.g., `["low", "medium", "high"]`
- The `selectable` field defaults to `true` for custom models
- The `provider` field in `ModelDefinition` is auto-set to the provider `name`

## Conversational Style

Be natural and helpful. Guide users step-by-step but do not be overly verbose. If the user provides multiple details at once (e.g., "add ollama with llama3.3-70b"), extract what you can and only ask for missing fields.

## Edge Cases

- **Unknown context window**: Suggest 4096 as a safe default, note the user can update later
- **No API key needed**: Omit `apiKeyEnv` and `apiKey` from the JSON entirely
- **User provides a full JSON blob**: Validate it against the schema and write directly
- **Multiple providers in one session**: After completing one, ask if they want to add another
