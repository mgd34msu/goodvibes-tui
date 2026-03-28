# Dynamic Model Catalog System

**Status:** COMPLETE  
**Created:** 2026-03-28  
**Last Updated:** 2026-03-28  
**Issue:** Model registry overhaul  

---

## Overview

Replace the static `BUILTIN_MODEL_REGISTRY` (3000+ hardcoded lines in registry.ts) with a TTL-cached dynamic catalog sourced from models.dev and ZeroEval benchmarks. Key-aware SyntheticProvider failover, tier-isolated routing (free/paid/subscription never cross), auto-provider registration from env vars, and an enhanced model picker with filters, grouping, favorites, and benchmark scores.

---

## Data Sources

| Source | Data | TTL | Endpoint |
|--------|------|-----|----------|
| models.dev | 4,102 models, 105 providers, limits, pricing, capabilities, env vars, base URLs | 24h | `https://models.dev/api.json` |
| ZeroEval | Benchmark scores (GPQA, SWE-bench, AIME, etc.) for 275 models | 24h | `https://api.zeroeval.com/leaderboard/models/full?justCanonicals=true` |

---

## Provider Categories

| Category | Criteria | Picker Section |
|----------|----------|----------------|
| **Free** | cost.input === 0 && cost.output === 0, no subscription gate | Free section |
| **Paid** | cost > 0 | Paid section with pricing |
| **Subscription** | GitHub Copilot, GitHub Models, GitLab, v0, Vercel, coding-plan providers | Subscription section with label |
| **Shutdown** | iFlow, iFlowCN | Excluded entirely |

**Tier isolation:** Free backends only failover to free. Paid to paid. Subscription to subscription. No surprise charges, ever.

---

## Canonical Model Structure

The same underlying model appears across providers with different names and tiers:

```
GPT-5.2
├── Free backends: (none)
├── Paid backends:
│   ├── OpenAI (gpt-5.2, $1.25/$10)
│   ├── OpenRouter (openai/gpt-5.2, $1.25/$10)
│   └── AIHubMix (gpt-5.2, $1.25/$10)
└── Subscription backends:
    └── GitHub Copilot (gpt-5.2)

Kimi K2.5
├── Free backends:
│   ├── NVIDIA (kimi-k2.5, 262K ctx)
│   ├── OpenCode Zen (kimi-k2.5-free, 262K ctx)
│   └── Fireworks (kimi-k2p5-turbo, 256K ctx)
├── Paid backends: (none)
└── Subscription backends: (none)
```

Normalization rules:
- Strip `coding-` prefix
- Strip `-free` / `:free` suffix
- Strip provider namespace (`z-ai/`, `openai/`, `meta/`, etc.)
- Use models.dev `family` field (75% coverage) as primary grouping
- Map known aliases (`k2p5` → `kimi-k2.5`)

---

## Execution Stages

### Stage 1: Core Catalog System
**Status:** COMPLETE  
**Files:** `src/providers/model-catalog.ts`, `src/providers/model-benchmarks.ts`  
**Dependencies:** None  

**Tasks:**
- [x] 1.1 — Create `model-catalog.ts` with types: `CatalogProvider`, `CatalogModel`, `CanonicalModel`, `ModelCatalog`
- [x] 1.2 — Implement `fetchCatalog()` — fetch models.dev, parse, normalize
- [x] 1.3 — Implement cache layer — read/write `~/.goodvibes/tui/model-catalog.json`, TTL check, atomic writes
- [x] 1.4 — Implement `normalizeModelId()` — strip prefixes/suffixes/namespaces
- [x] 1.5 — Implement canonical grouping — group models by family/normalized ID, split into free/paid/subscription backends
- [x] 1.6 — Implement `hasKeyForProvider()` — check env vars (from catalog data) + secrets store
- [x] 1.7 — Implement `getAvailableModels(keys)` — filter to providers with configured keys
- [x] 1.8 — Create `model-benchmarks.ts` — fetch ZeroEval, cache, fuzzy match to catalog models
- [x] 1.9 — Implement quality tiers — S (≥0.80), A (≥0.65), B (≥0.50), C (<0.50)
- [x] 1.10 — Cache resilience — never delete cache, use stale if fetch fails, only replace with valid new data
- [x] 1.11 — Unit tests for catalog, normalization, tier splitting, key detection, benchmarks

**Acceptance:** `initCatalog()` loads models.dev data, groups into canonicals with tier-split backends, matches benchmark scores. Cache survives network failure.

---

### Stage 2: Auto-Provider Registration
**Status:** COMPLETE  
**Files:** `src/providers/auto-register.ts`, `src/config/index.ts`  
**Dependencies:** Stage 1  

**Tasks:**
- [x] 2.1 — Create `auto-register.ts` — scan catalog providers, check env vars, register unknown providers
- [x] 2.2 — Handle multi-endpoint providers (ZenMux: openai + anthropic endpoints) — route based on model's native API format
- [x] 2.3 — Log auto-registrations: "Auto-registered 3 providers: Groq, NVIDIA, OpenCode Zen"
- [x] 2.4 — Wire into startup in `main.ts` after `initCatalog()`
- [x] 2.5 — Unit tests for auto-registration, multi-endpoint routing, env var detection

**Acceptance:** User sets `GROQ_API_KEY` env var, starts TUI, Groq is available as a provider with all its models — zero manual configuration.

---

### Stage 3: Catalog-Driven SyntheticProvider
**Status:** COMPLETE  
**Files:** `src/providers/synthetic.ts`  
**Dependencies:** Stage 1, Stage 2  

**Tasks:**
- [x] 3.1 — Remove `MANUAL_SYNTHETIC_OVERRIDES` static backend lists
- [x] 3.2 — Build backend lists from canonical model data instead
- [x] 3.3 — Tier-isolated failover — free only fails over to free, paid to paid, subscription to subscription
- [x] 3.4 — Key-aware filtering — skip backends without configured keys silently
- [x] 3.5 — Sort backends by context desc → max output desc within each tier
- [x] 3.6 — Clear error when zero backends have keys: "No API keys configured for any provider offering [model]"
- [x] 3.7 — Implement `best-free` synthetic model — resolves to highest SWE-bench free model with keys
- [x] 3.8 — Unit tests for tier isolation, key filtering, best-free resolution, failover ordering

**Acceptance:** Selecting a canonical free model tries free backends in order. Paid never leaks into free. `best-free` dynamically picks the best option.

---

### Stage 4: Replace Static Registry
**Status:** COMPLETE  
**Files:** `src/providers/registry.ts`  
**Dependencies:** Stage 1, Stage 2, Stage 3  

**Tasks:**
- [x] 4.1 — Remove `BUILTIN_MODEL_REGISTRY` (~3000 lines)
- [x] 4.2 — `getModelRegistry()` returns catalog-sourced models
- [x] 4.3 — Merge order: catalog models → custom providers → discovered local servers
- [x] 4.4 — Preserve custom provider loading (`~/.goodvibes/tui/providers/`)
- [x] 4.5 — Preserve local server discovery (scanner.ts)
- [x] 4.6 — Verify all existing features still work: /model command, model picker, provider health panel
- [x] 4.7 — Integration tests for registry with catalog backing

**Acceptance:** `BUILTIN_MODEL_REGISTRY` deleted. All models come from catalog + custom + discovered. No regressions in existing functionality.

---

### Stage 5: Enhanced Model Picker
**Status:** COMPLETE  
**Files:** `src/input/model-picker.ts`, `src/renderer/model-picker-overlay.ts`  
**Dependencies:** Stage 1, Stage 4  

**Tasks:**
- [x] 5.1 — Add pricing tier filter: Free / Paid / Subscription / All
- [x] 5.2 — Add family grouping: GPT, Claude, Gemini, Llama, Qwen, GLM, MiniMax, DeepSeek, etc.
- [x] 5.3 — Add capability filters: Reasoning, Tool Use, Structured Output, Multimodal, Open Weights
- [x] 5.4 — Add "available only" toggle (default on) — only models with configured keys
- [x] 5.5 — Add benchmark sort: SWE-bench, GPQA, composite score
- [x] 5.6 — Display quality tier badge (S/A/B/C) next to model name
- [x] 5.7 — Display free indicator, provider count, pricing
- [x] 5.8 — Display pinned/favorite indicator (star) at top of list
- [x] 5.9 — Group-by cycling: provider → family → pricing tier → quality tier
- [x] 5.10 — Unit tests for all filters, grouping, sorting

**Acceptance:** Picker shows models grouped and filtered by tier/family/capability with benchmark badges. Favorites pinned at top.

---

### Stage 6: Favorites & Usage Tracking
**Status:** COMPLETE  
**Files:** `src/providers/favorites.ts`, `src/input/commands.ts`  
**Dependencies:** Stage 1  

**Tasks:**
- [x] 6.1 — Create `favorites.ts` — load/save `~/.goodvibes/tui/favorites.json`
- [x] 6.2 — Implement `pinModel(id)`, `unpinModel(id)`, `getPinned()`
- [x] 6.3 — Implement `recordUsage(id)` — called after each chat, tracks model + timestamp + count
- [x] 6.4 — Implement `getRecentModels(n)` — last N distinct models used
- [x] 6.5 — Add `/pin <model>` and `/unpin <model>` commands
- [x] 6.6 — Wire `recordUsage()` into orchestrator after each chat call
- [x] 6.7 — Unit tests for pin/unpin, usage recording, persistence

**Acceptance:** User can pin models, usage is tracked, favorites persist across sessions.

---

### Stage 7: Cost Tracker Integration
**Status:** COMPLETE  
**Files:** `src/panels/cost-tracker-panel.ts`  
**Dependencies:** Stage 1  

**Tasks:**
- [x] 7.1 — Replace `DEFAULT_PRICING = {0,0}` with catalog lookup
- [x] 7.2 — `getCostForModel(modelId)` reads pricing from catalog
- [x] 7.3 — Handle free models (show $0.00 explicitly, not "unknown")
- [x] 7.4 — Handle models not in catalog (fall back to $0, log warning)
- [x] 7.5 — Unit tests for cost lookup, free models, missing models

**Acceptance:** Cost panel shows accurate per-model pricing from catalog data for every model used.

---

### Stage 8: Context Validation
**Status:** COMPLETE  
**Files:** `src/core/orchestrator.ts`  
**Dependencies:** Stage 1  

**Tasks:**
- [x] 8.1 — Before each `provider.chat()` call, estimate request token count
- [x] 8.2 — Compare against `catalogModel.context` from catalog
- [x] 8.3 — If request exceeds context and auto-compact is enabled: trigger compact first
- [x] 8.4 — If still exceeds after compact: clear error with model context and request size
- [x] 8.5 — Suggest larger-context alternatives from catalog
- [x] 8.6 — Unit tests for validation, compact trigger, error messaging

**Acceptance:** Request that exceeds context triggers auto-compact or clear error with alternatives, instead of opaque provider rejection.

---

### Stage 9: Change Notifications
**Status:** COMPLETE  
**Files:** `src/providers/model-catalog.ts` (additions), `src/core/orchestrator.ts`  
**Dependencies:** Stage 1, Stage 6  

**Tasks:**
- [x] 9.1 — On catalog refresh, diff old vs new catalog
- [x] 9.2 — Identify: new models, removed models, changed models (context/pricing/capabilities)
- [x] 9.3 — Filter notifications to: models user has used (from favorites.history), pinned models, top-10 by benchmark
- [x] 9.4 — Format notifications: "Model update: Kimi K2.5 context increased 262K → 512K"
- [x] 9.5 — Surface in TUI (system message or panel notification)
- [x] 9.6 — Unit tests for diff logic, filtering, formatting

**Acceptance:** User sees relevant model changes on refresh. No noise about models they've never used.

---

### Stage 10: Cleanup & Final Integration
**Status:** COMPLETE  
**Files:** Various  
**Dependencies:** All previous stages  

**Tasks:**
- [x] 10.1 — Remove `model-limits.ts` OpenRouter fetch if fully superseded by catalog (or keep as supplement for max_completion_tokens)
- [x] 10.2 — Update documentation: PROVIDERS.md, CONFIGURATION.md, COMMANDS.md
- [x] 10.3 — Update ROADMAP.md with new item
- [x] 10.4 — Full integration test: startup with no cache, startup with stale cache, startup with no network
- [x] 10.5 — Verify no API keys in source code
- [x] 10.6 — Version bump

**Acceptance:** Clean codebase, no dead code, docs updated, all tests pass.

---

## Execution Strategy

**Parallel tracks:**
- Stages 1 → 2 → 3 → 4 are sequential (each depends on prior)
- Stage 5 can start after Stage 1 + 4
- Stage 6 can start after Stage 1 (independent)
- Stage 7 can start after Stage 1 (independent)
- Stage 8 can start after Stage 1 (independent)
- Stage 9 depends on Stage 1 + 6
- Stage 10 is final

**Suggested agent allocation:**

| Batch | Agents | Stages |
|-------|--------|--------|
| 1 | 2 engineers | Stage 1 (catalog + benchmarks) |
| 2 | 3 engineers | Stage 2 (auto-register) + Stage 6 (favorites) + Stage 7 (cost) |
| 3 | 2 engineers | Stage 3 (synthetic) + Stage 8 (context validation) |
| 4 | 1 engineer | Stage 4 (replace registry) |
| 5 | 2 engineers | Stage 5 (picker) + Stage 9 (notifications) |
| 6 | 1 engineer | Stage 10 (cleanup) |

**Review process:** Every stage reviewed at 10/10 before committing. No exceptions.

---

## Cache Files

| File | Content |
|------|---------|
| `~/.goodvibes/tui/model-catalog.json` | models.dev data + fetch timestamp |
| `~/.goodvibes/tui/benchmarks.json` | ZeroEval scores + fetch timestamp |
| `~/.goodvibes/tui/favorites.json` | Pinned models + usage history |

---

## What Gets Removed

- `BUILTIN_MODEL_REGISTRY` in registry.ts (~3000 lines)
- `MANUAL_SYNTHETIC_OVERRIDES` in synthetic.ts
- Static free model lists
- Hardcoded model context lengths
- `DEFAULT_PRICING = {0,0}` fallback

## What Stays

- Custom provider loading (`~/.goodvibes/tui/providers/`)
- Local server discovery (scanner.ts)
- Provider-specific implementations (anthropic.ts, gemini.ts, openai.ts)
- Prompt caching logic (provider-specific)
- model-limits.ts (may supplement catalog with max_completion_tokens)

---

## Multi-Endpoint Providers

Some providers have multiple API endpoints sharing one key:
- ZenMux: `https://zenmux.ai/api/v1` (OpenAI) + `https://zenmux.ai/api/anthropic/v1` (Anthropic)
- AIHubMix: `https://aihubmix.com/v1` (legacy) + `https://aihubmix.com/api/v1/models` (new catalog API)

Each `CatalogModel` backend stores the specific endpoint URL. Routing is transparent.

---

## Key Design Principles

1. **No surprise charges** — tier-isolated failover, free never crosses to paid
2. **No stale data** — TTL-based refresh, but never delete working cache
3. **No configuration required** — set an env var, get a provider
4. **No hardcoded models** — everything from the catalog
5. **No leaked keys** — env vars and .env files only, gitignored
