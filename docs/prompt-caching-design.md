# Prompt Caching Design: Gemini + OpenAI-Compat Providers

## Status
Proposed

## Context

Anthropic prompt caching is already implemented in `src/providers/anthropic.ts` via inline `cache_control: { type: 'ephemeral' }` breakpoints on the system prompt and last tool definition. Cache usage metrics flow through `ChatResponse.usage.cacheReadTokens` and `cacheWriteTokens`.

We now need caching for:
1. **Gemini** — Google's explicit context caching API (out-of-band cache creation)
2. **OpenAI-Compat** — defensive measures to maximize automatic cache hits on providers that support it

---

## 1. Gemini Context Caching

### How Google's API Works

Unlike Anthropic's inline approach, Gemini requires a separate API call to create a cached content resource:

1. `POST /v1beta/cachedContents` with `systemInstruction` + `tools` + `model` — returns a resource `name` (e.g., `cachedContents/abc123`) with a TTL
2. Subsequent `generateContent` calls pass `cachedContent: "cachedContents/abc123"` instead of resending the cached content
3. Minimum 32,768 tokens to be eligible for caching
4. Default TTL: 1 hour (configurable)
5. Cached content is immutable — if system prompt or tools change, a new cache must be created

### Design Decisions

#### D1: Cache Lifecycle — Hash-Based Invalidation

The cache key is a SHA-256 hash of `systemPrompt + JSON.stringify(tools) + model`. This hash is stored on the provider instance alongside the cached content `name` and its expiry timestamp.

**Lifecycle:**
```
chat() called
  → compute hash of (systemPrompt, tools, model)
  → if hash matches stored hash AND expiry > now + 60s buffer:
      use existing cachedContent name
  → else:
      create new cachedContent via POST
      store { name, hash, expiry } on instance
      (optionally delete old cache resource)
  → call streamGenerateContent with cachedContent field
```

The 60-second buffer prevents using a cache that expires mid-request.

**Rationale:** Hashing is simple, deterministic, and handles all invalidation cases (system prompt change, tool change, model change). No need for a separate invalidation API.

#### D2: Cache State — Provider Instance Properties

New private properties on `GeminiProvider`:

```typescript
class GeminiProvider implements LLMProvider {
  // ... existing fields ...
  
  /** Active cached content resource name (e.g., "cachedContents/abc123") */
  private cachedContentName: string | null = null;
  /** Hash of the content that was cached (systemPrompt + tools + model) */
  private cachedContentHash: string | null = null;
  /** When the cache expires (epoch ms) */
  private cachedContentExpiry: number = 0;
}
```

**Rationale:** Provider instances are long-lived (one per session). Instance-level state is the simplest approach and naturally scopes the cache to a single API key and session.

#### D3: Cache Creation — Separate Helper Method

Extract cache management into a private method:

```typescript
private async ensureCachedContent(
  systemPrompt: string | undefined,
  tools: ToolDefinition[] | undefined,
  model: string,
): Promise<string | null> {
  // 1. Compute hash
  // 2. Check if current cache is valid
  // 3. If not, create new cache via POST /v1beta/cachedContents
  // 4. Return cachedContent name or null if content too small
}
```

The method returns `null` if the content is below the 32K token minimum, in which case `chat()` falls back to sending content inline (current behavior).

#### D4: Token Estimation for 32K Minimum

Before calling the cache creation API, estimate token count:
- Rough heuristic: `(systemPrompt.length + JSON.stringify(tools).length) / 4`
- If estimated tokens < 28,000 (conservative buffer below 32K), skip caching entirely
- If the API rejects with a "too few tokens" error, catch it, mark this hash as "uncacheable" in a local Set, and fall back to inline

**Rationale:** Avoids wasting an API call on content that won't be cached. The heuristic is intentionally conservative — false negatives (skipping when it would have worked) are preferable to false positives (API errors on every call).

#### D5: Request Body Modification

When a valid cached content name exists, the `chat()` method modifies the request:

```typescript
// Current:
body['systemInstruction'] = systemInstruction;
body['tools'] = [{ functionDeclarations: ... }];

// With caching:
if (cachedContentName) {
  body['cachedContent'] = cachedContentName;
  // Do NOT send systemInstruction or tools — they're in the cache
} else {
  body['systemInstruction'] = systemInstruction;
  body['tools'] = [{ functionDeclarations: ... }];
}
```

**Critical:** When using `cachedContent`, the system instruction and tools MUST be omitted from the request body. Sending them alongside `cachedContent` is an API error.

#### D6: Cache Usage Reporting

Google's response includes `usageMetadata.cachedContentTokenCount` when cache is used. Map this to the existing `ChatResponse.usage` fields:

```typescript
usage: {
  inputTokens: promptTokenCount - cachedContentTokenCount,  // Non-cached input
  outputTokens: candidatesTokenCount,
  cacheReadTokens: cachedContentTokenCount,  // Reuse existing field
  // cacheWriteTokens only set on the turn that creates the cache
}
```

**Rationale:** Reuses the existing `cacheReadTokens`/`cacheWriteTokens` fields from `ChatResponse.usage` (already defined in `interface.ts` for Anthropic). No interface changes needed.

#### D7: Cache Cleanup

Optional: When creating a new cache (because the hash changed), attempt to `DELETE` the old cached content resource. This is fire-and-forget — failure is logged but doesn't block the request.

```typescript
if (this.cachedContentName && this.cachedContentHash !== newHash) {
  // Fire-and-forget cleanup
  fetch(`${GEMINI_API_BASE}/${this.cachedContentName}?key=${this.apiKey}`, {
    method: 'DELETE',
  }).catch(err => logger.debug('Failed to delete old Gemini cache', { err }));
}
```

### Gemini Implementation Summary

**Files to modify:**
- `src/providers/gemini.ts` — Add cache state, `ensureCachedContent()`, modify `chat()` body construction, parse `cachedContentTokenCount` from response

**Files unchanged:**
- `src/providers/interface.ts` — Already has `cacheReadTokens`/`cacheWriteTokens` in `ChatResponse.usage`
- `src/providers/tool-formats.ts` — No changes needed

**Estimated scope:** ~80 lines added to `gemini.ts`

---

## 2. OpenAI-Compat Cache Optimization

### Background

OpenAI-compatible providers have varying cache support:

| Provider | Cache Support | Mechanism |
|----------|--------------|----------|
| OpenAI (native) | Automatic | Identical prompt prefix matching, server-side |
| OpenRouter | Partial | Depends on underlying model provider |
| Groq | None | Custom inference engine |
| Mistral | None | No documented API |
| Cerebras | None | Custom inference engine |
| Ollama Cloud | None | Local/cloud inference |
| NVIDIA | None | NIM inference |
| HuggingFace | None | Inference endpoints |
| LLM7 | None | Free tier aggregator |
| AIHubMix | Partial | Depends on underlying provider |

### Design Decisions

#### D8: Defensive Cache-Friendliness (No Active Caching)

Do NOT implement active caching for OpenAI-compat providers. Instead, ensure we don't accidentally defeat automatic caching on providers that support it.

**Rationale:** Active caching would require per-provider feature detection with no standard API. The cost-benefit is poor — most OpenAI-compat providers don't support it, and those that do (OpenAI, some OpenRouter backends) handle it server-side.

#### D9: Stable Message Ordering

Ensure these properties of the request are deterministic across calls:

1. **System prompt is always the first message** — already the case in `toOpenAIMessages()` (line 56-98 of `tool-formats.ts`)
2. **Tools array order is stable** — tools are passed from the caller; verify no sorting/shuffling occurs in `toOpenAITools()`
3. **No per-request entropy in system prompt** — no timestamps, random IDs, or session-specific data injected into the system prompt by the provider layer

After reviewing the code: `toOpenAITools()` maps tools in input order (deterministic). `toOpenAIMessages()` prepends the system prompt as the first message. No entropy is injected at the provider level.

**Current status: Already cache-friendly.** No code changes needed in `openai-compat.ts`.

#### D10: Cache Usage Passthrough (Future)

If a provider returns `prompt_tokens_details.cached_tokens` in the usage response (OpenAI's format), parse and map it to `cacheReadTokens`. This is a low-priority enhancement.

```typescript
// Future: in the usage parsing block
if (raw.usage?.prompt_tokens_details?.cached_tokens) {
  cacheReadTokens = raw.usage.prompt_tokens_details.cached_tokens;
}
```

**Scope:** ~5 lines in `openai-compat.ts`. Can be done alongside Gemini or deferred.

### OpenAI-Compat Summary

**Files to modify (optional, low priority):**
- `src/providers/openai-compat.ts` — Parse `cached_tokens` from usage response if present

**No breaking changes. No interface changes.**

---

## 3. Execution Plan

### Phase 1: Gemini Context Caching (Primary)

```
Dependency graph:
  [D1, D2, D3, D4] → D5 → D6 → D7
  All within gemini.ts
```

**Tasks:**
1. Add cache state properties to `GeminiProvider` (D2)
2. Add `ensureCachedContent()` private method with hash computation, cache creation API call, and 32K token check (D1, D3, D4)
3. Modify `chat()` to call `ensureCachedContent()` and conditionally set `cachedContent` vs inline content (D5)
4. Parse `cachedContentTokenCount` from `usageMetadata` in the SSE stream handler (D6)
5. Add fire-and-forget cache cleanup on hash change (D7)

**Verification:**
- TypeScript compilation passes
- Manual test: first call creates cache (verify via log), second call reuses it
- Manual test: changing system prompt triggers new cache creation
- Manual test: content below 32K threshold falls back to inline

### Phase 2: OpenAI-Compat Cache Passthrough (Optional)

**Tasks:**
1. Add `cached_tokens` parsing to usage block in `openai-compat.ts` (D10)
2. Map to `cacheReadTokens` in `ChatResponse.usage`

**Verification:**
- TypeScript compilation passes
- No behavior change for providers that don't return `cached_tokens`

### Phase 3: Observability

**Tasks:**
1. Add debug logging for cache hit/miss/create/delete in Gemini provider
2. Surface cache metrics in TUI status (if applicable — check how Anthropic cache metrics are displayed)

---

## 4. Risks

| Risk | Probability | Impact | Mitigation |
|------|------------|--------|------------|
| Gemini cache API changes in v1beta | Medium | Medium | Pin to known working version, handle gracefully |
| Cache creation adds latency to first request | High (by design) | Low | Only first request per session; subsequent requests are faster |
| 32K minimum means most sessions won't cache | Medium | Low | Graceful fallback to inline (current behavior) |
| Race condition: concurrent `chat()` calls creating duplicate caches | Low | Low | Provider `chat()` is called sequentially by the agent loop |
| API key quota for cache storage | Low | Medium | Document that cached content counts toward quota |

---

## 5. Alternatives Considered

### Alt 1: Cache in a Shared Service Layer
Store cache state in a shared cache manager used by all providers.
- **Rejected:** Over-engineered for two providers with completely different cache mechanisms. Anthropic is inline (no state), Gemini is external (stateful). A shared abstraction would be leaky.

### Alt 2: Implement OpenAI Prompt Caching API
Use OpenAI's explicit caching hints (if/when available).
- **Deferred:** OpenAI's automatic caching already works without hints. When they ship an explicit API, we can add it.

### Alt 3: Cache Gemini Content via Local Storage
Store the cached content name in a local file to survive process restarts.
- **Rejected:** Cached content has a 1-hour default TTL. Process restarts are rare within that window, and the cost of a single cache recreation is negligible.
