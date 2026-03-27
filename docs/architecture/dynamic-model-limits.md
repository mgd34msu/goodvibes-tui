# Architecture: Dynamic Model Token Limits

## Decision ID: dec_20260327_001
## Category: architecture
## Confidence: high
## Status: Proposed

---

## Summary

Extend the model system with per-model token limits (output, tool result, tool calls, reasoning) populated from OpenRouter's public API as baseline, with provider-specific overrides from local/network providers.

## Current State Analysis

### What exists today

| Component | File | Current Behavior |
|-----------|------|------------------|
| `ModelDefinition` | `src/providers/registry.ts:16-34` | Has `contextWindow: number` but no output/tool token limits |
| `ChatRequest.maxTokens` | `src/providers/interface.ts:42` | Optional, rarely set by caller |
| Anthropic provider | `src/providers/anthropic.ts:72` | Defaults `max_tokens` to `8192` when not provided |
| OpenAI/Gemini providers | `src/providers/openai.ts`, `gemini.ts` | Only pass `max_tokens` if `maxTokens` is truthy — otherwise omitted |
| Orchestrator `runTurn` | `src/core/orchestrator.ts:305-320` | Does NOT pass `maxTokens` to `provider.chat()` |
| Tool result truncation | `src/tools/shared/overflow.ts:7` | Hardcoded `DEFAULT_MAX_CHARS = 50_000` |
| Exec tool truncation | `src/tools/exec/index.ts:20` | Hardcoded `OUTPUT_TRUNCATE_LIMIT = 50_000` |
| Read tool max_tokens | `src/tools/read/index.ts:798` | Per-request `max_tokens` param, not model-aware |
| Scanner context windows | `src/discovery/scanner.ts:306-467` | `fetchModelContextWindows()` fetches context length per server type |
| `DiscoveredServer` | `src/discovery/scanner.ts:12-20` | Has `modelContextWindows?: Record<string, number>` |

### Key gaps
1. No `maxOutputTokens` flows from model definition to chat requests
2. Tool result truncation is hardcoded, not model-aware
3. No external source of truth for model capabilities beyond what's hardcoded in `BUILTIN_MODEL_REGISTRY`
4. Scanner fetches context windows but not output token limits

---

## Design

### 1. Type Extensions

#### `ModelDefinition.tokenLimits` (registry.ts)

```typescript
export interface TokenLimits {
  maxOutputTokens?: number;       // max generation tokens sent as max_tokens to API
  maxToolResultTokens?: number;   // max tokens per tool result before truncation
  maxToolCalls?: number;          // max parallel tool calls per turn
  maxReasoningTokens?: number;    // budget for thinking/reasoning
}

export interface ModelDefinition {
  // ... existing fields ...
  tokenLimits?: TokenLimits;
}
```

**Rationale**: Optional field preserves backward compatibility. All existing `BUILTIN_MODEL_REGISTRY` entries work unchanged — they just get defaults.

#### `DiscoveredServer` extension (scanner.ts)

```typescript
export interface DiscoveredServer {
  // ... existing fields ...
  modelContextWindows?: Record<string, number>;
  modelOutputLimits?: Record<string, number>;  // NEW
}
```

### 2. New Module: `src/providers/model-limits.ts`

Single-responsibility module for fetching, caching, and resolving model token limits.

```
src/providers/model-limits.ts
  ├── fetchOpenRouterModels()      — fetch from OpenRouter API
  ├── loadCachedLimits()           — read ~/.goodvibes/tui/model-limits.json
  ├── saveCachedLimits()           — write cache with TTL metadata
  ├── resolveTokenLimits()         — merge: provider > OpenRouter > defaults
  ├── getTokenLimitsForModel()     — public API: resolve limits for a model ID
  └── refreshModelLimits()         — manual refresh, called by /refresh-models
```

#### OpenRouter API Response Shape

```typescript
// GET https://openrouter.ai/api/v1/models (no auth)
interface OpenRouterModel {
  id: string;                                    // e.g. "anthropic/claude-sonnet-4"
  context_length: number;                        // e.g. 200000
  top_provider: {
    max_completion_tokens: number | null;         // e.g. 8192
  };
  supported_parameters?: string[];               // e.g. ["max_tokens", "temperature"]
  // ... other fields we don't need
}
```

#### Cache Schema: `~/.goodvibes/tui/model-limits.json`

```typescript
interface ModelLimitsCache {
  version: 1;
  fetchedAt: number;              // Unix timestamp ms
  ttlMs: number;                  // 86_400_000 (24 hours)
  models: Record<string, {        // keyed by OpenRouter model ID
    contextLength: number;
    maxOutputTokens: number | null;
    supportedParameters: string[];
  }>;
}
```

**Design decision**: Cache lives at `~/.goodvibes/tui/model-limits.json` (alongside existing `discovered-providers.json`). This is user-level, not project-level, because model limits are global.

#### Model ID Mapping Strategy

OpenRouter uses `provider/model` format (e.g., `anthropic/claude-sonnet-4`). Our registry uses bare model IDs (e.g., `claude-sonnet-4-20250514`). The mapping strategy:

1. **Exact match**: Check if our `ModelDefinition.id` exists as-is in OpenRouter data
2. **Provider-prefixed match**: Check `${ModelDefinition.provider}/${ModelDefinition.id}`
3. **Fuzzy stem match**: Strip version suffixes and date stamps, match on model family
   - `claude-sonnet-4-20250514` → stem `claude-sonnet-4` → matches `anthropic/claude-sonnet-4`
   - `gpt-4.1-mini` → stem `gpt-4.1-mini` → matches `openai/gpt-4.1-mini`
4. **Manual overrides**: A small static map for known mismatches

Implement as `findOpenRouterMatch(modelId: string, provider: string, orModels: Map<string, ...>): OpenRouterModel | null`

### 3. Override Resolution Chain

```
provider-specific (from scan/API) > OpenRouter cache > sensible defaults
```

| Source | Priority | When Available |
|--------|----------|----------------|
| Provider-reported limits | Highest | Scanner finds output limits, or cloud provider reports them |
| OpenRouter cache | Medium | Model exists in OpenRouter's catalog |
| Sensible defaults | Lowest | Always |

**Default values**:
```typescript
const DEFAULT_TOKEN_LIMITS: Required<TokenLimits> = {
  maxOutputTokens: 8192,
  maxToolResultTokens: 50_000,  // chars, matching current DEFAULT_MAX_CHARS
  maxToolCalls: 128,
  maxReasoningTokens: 16384,
};
```

#### Resolution function signature

```typescript
export function resolveTokenLimits(
  modelDef: ModelDefinition,
  providerLimits?: Partial<TokenLimits>,  // from scanner/provider API
  openRouterData?: OpenRouterModelData,    // from cache
): Required<TokenLimits>
```

Merge order:
1. Start with defaults
2. Apply OpenRouter data (contextLength → contextWindow, maxOutputTokens from top_provider)
3. Apply provider-specific overrides
4. Apply any explicit `modelDef.tokenLimits` values (builtin overrides)

### 4. Integration Points

#### 4a. Orchestrator: Pass maxTokens to chat (orchestrator.ts)

In `runTurn()`, after getting the current model (line ~268), resolve token limits and pass to chat:

```typescript
// After: const model = providerRegistry.getCurrentModel();
const limits = getTokenLimitsForModel(model);

// In provider.chat() call (~line 305):
const response = await provider.chat({
  model: model.id,
  maxTokens: limits.maxOutputTokens,  // NEW
  // ... rest unchanged
});
```

**Risk**: Low. `maxTokens` is already an optional field on `ChatRequest`. All providers handle it (Anthropic defaults to 8192, others pass through if truthy).

#### 4b. Tool result truncation: Make model-aware

The `OverflowHandler` and exec tool truncation currently use hardcoded 50K chars. Make them configurable:

**Option A (recommended)**: Pass `maxToolResultTokens` through the tool execution context.

The `executeToolCalls` method in orchestrator.ts (line 585) calls `this.toolRegistry.execute()`. The tool registry would need to accept a context parameter with the current model's limits.

```typescript
// In ToolRegistry.execute() or via a context provider:
const limits = getTokenLimitsForModel(providerRegistry.getCurrentModel());
// Tools access limits.maxToolResultTokens for their overflow handling
```

**Implementation approach**: Add a `getToolResultMaxChars()` function to `model-limits.ts` that reads the current model's limits. Tool implementations call this instead of hardcoded constants.

```typescript
// In src/tools/exec/index.ts, replace:
// const OUTPUT_TRUNCATE_LIMIT = 50_000;
// With:
import { getToolResultMaxChars } from '../providers/model-limits.ts';
// Then in truncate(): use getToolResultMaxChars() instead of OUTPUT_TRUNCATE_LIMIT
```

Same pattern for `overflow.ts` `DEFAULT_MAX_CHARS`.

#### 4c. Scanner extension (scanner.ts)

Extend `fetchModelContextWindows` to also fetch output token limits where available:

- **Ollama**: `/api/show` response includes `model_info` which may contain `max_output_tokens` or similar
- **vLLM**: `/v1/models/{id}` may include `max_completion_tokens`
- **Generic**: `/v1/models/{id}` — check for `max_completion_tokens`, `max_output_tokens` fields

Rename or extend to `fetchModelLimits()` returning both context windows and output limits.

### 5. Startup & Refresh Flow

#### Startup sequence (non-blocking)

```
App starts
  → Load cached model-limits.json (sync, fast)
  → Apply cached limits to BUILTIN_MODEL_REGISTRY models
  → Check TTL — if stale:
      → Background fetch OpenRouter API
      → On success: update cache, update in-memory limits
      → On failure: log warning, continue with stale/defaults
  → Scanner runs (existing flow)
      → Fetches context windows + output limits from local providers
      → Provider limits override OpenRouter limits for those models
```

**Critical**: OpenRouter fetch MUST be non-blocking. The TUI must start immediately with cached/default values.

#### Manual refresh: `/refresh-models` command

```typescript
// In src/input/commands.ts, add:
{
  name: 'refresh-models',
  description: 'Refresh model token limits from OpenRouter',
  handler: async () => {
    bus.emit('system:info', 'Refreshing model limits from OpenRouter...');
    try {
      const count = await refreshModelLimits();
      bus.emit('system:info', `Updated limits for ${count} models`);
    } catch (err) {
      bus.emit('system:error', `Failed to refresh: ${err.message}`);
    }
  }
}
```

### 6. File Changes Summary

| File | Change Type | Description |
|------|-------------|-------------|
| `src/providers/registry.ts` | Modify | Add `TokenLimits` interface, add `tokenLimits?` to `ModelDefinition` |
| `src/providers/model-limits.ts` | **New** | OpenRouter fetch, cache, resolution logic |
| `src/providers/interface.ts` | No change | `ChatRequest.maxTokens` already exists |
| `src/core/orchestrator.ts` | Modify | Pass resolved `maxOutputTokens` to `provider.chat()` in `runTurn()` |
| `src/tools/shared/overflow.ts` | Modify | Replace hardcoded `DEFAULT_MAX_CHARS` with model-aware getter |
| `src/tools/exec/index.ts` | Modify | Replace hardcoded `OUTPUT_TRUNCATE_LIMIT` with model-aware getter |
| `src/discovery/scanner.ts` | Modify | Extend `DiscoveredServer`, extend `fetchModelContextWindows` to also fetch output limits |
| `src/input/commands.ts` | Modify | Add `/refresh-models` command |
| `src/main.ts` | Modify | Add startup cache load + background refresh |

---

## Execution Plan

### Phase 1: Types & Core Module (no behavioral changes)
- Add `TokenLimits` interface and `tokenLimits?` field to `ModelDefinition`
- Create `src/providers/model-limits.ts` with all logic
- Add cache read/write to `~/.goodvibes/tui/model-limits.json`
- Add `/refresh-models` command
- **Parallel**: All files are independent

### Phase 2: Integration (behavioral changes)
- Wire `maxOutputTokens` into orchestrator's `runTurn()`
- Replace hardcoded truncation limits in overflow.ts and exec/index.ts
- **Sequential**: Depends on Phase 1

### Phase 3: Scanner Extension
- Extend `fetchModelContextWindows` to also fetch output limits
- Extend `DiscoveredServer` with `modelOutputLimits`
- Wire provider limits into resolution chain
- **Sequential**: Depends on Phase 1

### Phase 4: Startup Integration
- Load cache on startup in `main.ts`
- Background refresh if stale
- **Sequential**: Depends on Phase 1

### Phase 5: Testing
- Unit tests for `model-limits.ts` (resolution, caching, OpenRouter parsing)
- Unit tests for model ID mapping
- Integration test for end-to-end flow

### Dependency Graph

```
Phase 1 → [Phase 2, Phase 3, Phase 4]  (all parallel after Phase 1)
[Phase 2, Phase 3, Phase 4] → Phase 5
```

---

## Risks

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| OpenRouter API changes format | Low | Medium | Cache + defaults ensure graceful degradation |
| Model ID mismatch between registries | Medium | Low | Fuzzy matching + manual override map |
| Network fetch blocks startup | Low | High | Non-blocking background fetch, sync cache load |
| Truncation limit change breaks existing behavior | Low | Medium | Default to current 50K chars, only change when model-specific limit is known |
| OpenRouter rate limits | Low | Low | 24hr TTL, single fetch on startup |

## Alternatives Considered

### Alt 1: Hardcode all limits in BUILTIN_MODEL_REGISTRY
- **Pro**: Simple, no network dependency
- **Con**: Stale immediately, doesn't scale to 100+ models, requires code changes for new models
- **Why not**: Defeats the purpose — we want automatic, up-to-date limits

### Alt 2: Fetch from each provider's API directly
- **Pro**: Most accurate per-provider
- **Con**: Requires auth for most APIs, complex multi-provider logic
- **Why not**: OpenRouter aggregates this data for free, no auth needed

### Alt 3: Store cache in project config instead of user config
- **Pro**: Project-portable
- **Con**: Same model limits across all projects, wasteful duplication
- **Why not**: Model limits are user-global, not project-specific
