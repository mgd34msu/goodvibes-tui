# /scan — Local LLM Discovery

## Overview

Automatic discovery of local and LAN-hosted LLM servers. Probes known ports on localhost and the local subnet, identifies running servers, pulls their model lists, and registers them as providers in the goodvibes-tui provider registry.

Runs automatically on startup (background, non-blocking) and manually via `/scan` slash command.

---

## Behavior

### Startup
- Fire-and-forget background scan on app launch
- Does not block the main render loop or user input
- Discovered providers are registered as they're found (incremental)
- System message logged for each discovered server: `[Scan] Found Ollama at 192.168.1.50:11434 (3 models)`

### /scan Command
- Triggers a full re-scan (localhost + subnet)
- Shows a modal with results: server name, host:port, model count, status
- Re-registers providers (overwrites stale entries from prior scan)
- Can be run anytime — e.g., after spinning up a new local server

---

## Discovery Strategy

### Ports

| Port | Known Server(s) |
|------|------------------|
| 1234 | LM Studio |
| 1337 | Jan |
| 2242 | Aphrodite |
| 4891 | GPT4All |
| 5000 | text-gen-webui, TabbyAPI |
| 5001 | koboldcpp |
| 7860 | text-gen-webui (alt) |
| 8000 | vLLM |
| 8001 | llama.cpp (alt) |
| 8080 | llama.cpp, LocalAI, TGI |
| 11434 | Ollama |

11 unique ports.

### Probe Order (per host:port)

1. `GET /v1/models` — OpenAI-compatible endpoint. Works for LM Studio, llama.cpp, vLLM, LocalAI, TGI, Aphrodite, Jan, GPT4All, text-gen-webui, koboldcpp, TabbyAPI, and modern Ollama.
2. If port 11434 and `/v1/models` fails: `GET /api/tags` — Ollama native API fallback for older versions.

### Probe Parameters
- Timeout: 200ms per probe (fast fail for closed ports)
- Concurrency: 50 parallel probes
- Subnet detection: read local IP from `os.networkInterfaces()`, derive /24 subnet
- Scan order: localhost first (ports only, ~100ms), then subnet (255 hosts × 11 ports, ~10-15s)

### Server Identification

Identify the server software from response characteristics:

| Signal | Server |
|--------|--------|
| Port 11434 + `/api/tags` responds | Ollama |
| Port 1234 + response has `lmstudio` in headers or model IDs | LM Studio |
| Response header `x-vllm-*` or model ID format | vLLM |
| Port 8080 + response has `llama` in server header | llama.cpp |
| Port 8080 + response has `localai` in server header | LocalAI |
| Response header contains `text-generation-inference` | TGI |
| Fallback | `local-{host}:{port}` |

### Provider Registration

- Each discovered server → `OpenAICompatProvider` instance
- Provider name: identified server name + host suffix if not localhost (e.g., `ollama`, `lm-studio-192.168.1.50`)
- Models: pulled from `/v1/models` response `data[].id`
- If a provider with the same name already exists (from custom JSON or prior scan), overwrite it
- Models registered in `BUILTIN_MODEL_REGISTRY` are NOT overwritten — custom/built-in take precedence

---

## Architecture

### New Files

| File | Purpose |
|------|---------|
| `src/discovery/scanner.ts` | Core scanner: subnet detection, port probing, server identification |
| `src/discovery/index.ts` | Barrel export |
| `src/renderer/scan-modal.ts` | Modal renderer for `/scan` results |

### Modified Files

| File | Change |
|------|---------|
| `src/main.ts` | Fire background scan on startup; wire `/scan` modal |
| `src/input/commands.ts` | Register `/scan` slash command |
| `src/input/handler.ts` | Add scan modal input handling (if needed, may reuse selection modal) |
| `src/providers/registry.ts` | Add `registerDiscovered()` method or reuse existing `register()` |

---

## Execution Plan

### Phase 1: Core Scanner (1 agent)
**Blocker: None**

Build `src/discovery/scanner.ts` with:
- `getLocalSubnet()` — reads local IP from `os.networkInterfaces()`, returns list of IPs in /24
- `probeHost(host, port, timeoutMs)` — single HTTP probe, returns `{ host, port, models[], serverName } | null`
- `scanLocalhost()` — probe all 11 ports on 127.0.0.1
- `scanSubnet()` — probe all 11 ports on all /24 hosts (parallelized, 50 concurrent)
- `identifyServer(host, port, response, headers)` — heuristic server identification
- `scan()` — full scan: localhost first, then subnet. Returns `DiscoveredServer[]`

Types:
```typescript
interface DiscoveredServer {
  name: string;           // 'ollama', 'lm-studio', 'local-192.168.1.50:8080'
  host: string;           // '127.0.0.1' or '192.168.1.50'
  port: number;
  baseURL: string;        // 'http://192.168.1.50:11434/v1'
  models: string[];       // ['llama3:latest', 'codellama:7b']
  serverType: string;     // 'ollama' | 'lm-studio' | 'vllm' | 'llamacpp' | 'unknown'
}

interface ScanResult {
  servers: DiscoveredServer[];
  scannedHosts: number;
  scannedPorts: number;
  durationMs: number;
}
```

### Phase 2: Provider Registration (1 agent, can parallel with Phase 3)
**Blocker: Phase 1**

Wire discovered servers into the provider registry:
- For each `DiscoveredServer`, create an `OpenAICompatProvider`
- Register models in the model registry with appropriate capabilities
- Handle re-scan: clear previously discovered providers before re-registering
- Add model definitions with `selectable: true`, reasonable capability defaults

Modify:
- `src/providers/registry.ts` — add `registerDiscoveredProviders(servers: DiscoveredServer[])` method
- `src/discovery/index.ts` — barrel export

### Phase 3: UI + Slash Command (1 agent, can parallel with Phase 2)
**Blocker: Phase 1**

Build the `/scan` command and results display:
- `src/renderer/scan-modal.ts` — modal showing discovered servers with model counts
- `src/input/commands.ts` — register `/scan` command
- Modal shows: server name, host:port, model count, server type
- While scanning: show spinner with "Scanning localhost..." → "Scanning subnet (X/255)..."

### Phase 4: Startup Integration (1 agent)
**Blocker: Phases 2 and 3**

Wire everything into `src/main.ts`:
- Import scanner
- Fire `scan()` in background on startup (non-blocking)
- Register discovered providers as they come in
- Log system messages for discovered servers
- Wire `/scan` command context (modal open, re-scan trigger)

---

## Agent Allocation

| Phase | Agents | Parallel? | Depends On |
|-------|--------|-----------|------------|
| 1 | 1 | — | Nothing |
| 2 | 1 | Yes, with Phase 3 | Phase 1 |
| 3 | 1 | Yes, with Phase 2 | Phase 1 |
| 4 | 1 | — | Phases 2 + 3 |

**Total: 4 agents, 3 sequential rounds**
- Round 1: Phase 1 (scanner core)
- Round 2: Phases 2 + 3 (parallel — registration + UI)
- Round 3: Phase 4 (startup wiring)

---

## Edge Cases

- **No network interfaces**: skip subnet scan, localhost only
- **Multiple NICs**: scan all /24 subnets found
- **Firewall blocks probes**: 200ms timeout handles this gracefully
- **Server responds but isn't an LLM**: `/v1/models` returns unexpected JSON → skip
- **Same server on multiple ports**: deduplicate by host + response content
- **Docker/WSL**: internal IPs may differ — localhost scan covers this
- **Server goes down after discovery**: provider stays registered, requests fail normally with provider error messages
- **Re-scan finds fewer servers**: clear old discovered providers, register fresh set

---

## Out of Scope (v1)

- Periodic auto-scanning
- mDNS/Bonjour discovery
- Custom port configuration (users can add custom providers via JSON for non-standard ports)
- Model capability detection beyond what `/v1/models` reports
- Authentication for discovered servers (assume no auth for local servers)
