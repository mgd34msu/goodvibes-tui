# Performance Audit Plan (#22)

**Project**: goodvibes-tui (Bun-based TypeScript TUI coding agent)  
**Date**: 2026-03-28  
**Status**: Planning  
**Codebase**: ~337 files, ~298 TypeScript, 77 directories

---

## 1. Startup Time

### What Runs at Startup

The `main()` function (src/main.ts:245-1315) is a 1,070-line monolith that orchestrates all initialization sequentially.

| Step | File | Function | Est. Impact |
|------|------|----------|-------------|
| Config load | src/config/manager.ts (320 lines) | ConfigManager constructor, readFileSync calls | Medium |
| API key resolution | src/config/index.ts:132-179 | `resolveApiKeys()` — async, reads env + secrets | Low |
| Secret store | src/config/secrets.ts | Keychain/file reads | Medium |
| System prompt load | src/main.ts:86-90 | `loadSystemPrompt()` | Low |
| Provider registry init | src/providers/registry.ts (3,480 lines) | Provider construction, built-in model defs | High |
| Model limits init | src/providers/model-limits.ts:385-397 | `initModelLimits()` — loads cache, may trigger OpenRouter fetch | High |
| Scanner (local providers) | src/discovery/scanner.ts:738-778 | `scan()` — network probes to 11 ports across subnets | High |
| Persisted providers load | src/discovery/scanner.ts:41-57 | `loadPersistedProviders()` — readFileSync | Low |
| Tool registration | src/tools/index.ts:26-50 | `registerAllTools()` — registers 14 tool modules | Medium |
| MCP client init | src/mcp/client.ts (370 lines) | Server spawning, capability negotiation | High |
| MCP registry | src/mcp/registry.ts (172 lines) | Config file reads | Low |
| Session restore | src/main.ts:164-197 | `loadLastConversation()` — readFileSync + JSON.parse | Medium |
| Recovery file check | src/main.ts:221-243 | `checkRecoveryFile()` — readFileSync | Low |
| Project index load | src/state/project-index.ts:91-109 | `ProjectIndex.load()` — async file read + tree parse | Medium |
| File watcher setup | src/state/file-watcher.ts:78-107 | `FileWatcher.start()` — fs.watch on config files | Low |
| Hook dispatcher init | src/hooks/dispatcher.ts | Hook chain registration | Low |
| Import graph build | src/intelligence/import-graph.ts:148-196 | `ImportGraph.build()` — walks entire project tree | High |
| Tree-sitter init | src/intelligence/tree-sitter/service.ts | WASM module loading | High |
| LSP server spawn | src/intelligence/lsp/service.ts | Binary download check + process spawn | High |
| Splash screen render | src/core/conversation.ts:616-647 | `addSplashScreen()` | Low |

### Potential Bottlenecks

1. **Scanner network probes**: `scan()` probes 11 known ports across local subnets with 200ms timeout per probe, 50 concurrent max. On networks with multiple interfaces this could take 2-4 seconds.
2. **Provider registry**: 3,480 lines — largest file in codebase. Construction likely involves significant static data initialization.
3. **Model limits fetch**: `fetchOpenRouterModels()` hits `openrouter.ai/api/v1/models` with 15-second timeout. Even with cache, initial fetch blocks.
4. **MCP server spawning**: Each configured MCP server requires process spawn + stdio handshake.
5. **Tree-sitter WASM**: Loading WASM modules for 5 language grammars (JS, TS, Python, CSS, JSON) is CPU-intensive.
6. **Import graph**: Full project tree walk reads every source file to extract imports.

### Measurement Approach

```typescript
// Instrument main() with phase timers
const t0 = performance.now();
// ... phase ...
console.error(`[startup] ${phaseName}: ${(performance.now() - t0).toFixed(1)}ms`);
```

- Add `performance.now()` markers around each init phase in main()
- Use `Bun.nanoseconds()` for sub-millisecond precision
- Log to stderr (not stdout, which is the terminal)
- Add `--profile-startup` CLI flag to enable timing output

### Quick Wins

- **Defer scanner**: Move `scan()` to post-first-render; show "Scanning..." in status bar
- **Defer import graph**: Build lazily on first tool call that needs it, not at startup
- **Defer tree-sitter**: Load WASM grammars on first syntax highlight request
- **Defer LSP**: Start LSP servers on first intelligence query, not at boot
- **Parallelize**: Run scanner, model-limits fetch, MCP init, and config load concurrently with `Promise.all()`
- **Cache model limits aggressively**: Current 24h TTL is fine but ensure no blocking re-fetch at startup

### Deeper Optimizations

- **Lazy provider registry**: Only instantiate provider classes when first used
- **Incremental import graph**: Persist graph to disk, rebuild only changed files
- **Precompiled tree-sitter**: Use native tree-sitter bindings instead of WASM where Bun supports it
- **MCP connection pooling**: Reuse MCP server processes across sessions

---

## 2. Event Loop Blocking

### Files With Synchronous FS Operations

| File | Sync Call Count | Severity |
|------|----------------|----------|
| src/main.ts | 15 | High — startup path |
| src/profiles/manager.ts | 15 | High — called on profile switch |
| src/discovery/scanner.ts | 13 | Medium — persist/load |
| src/agents/orchestrator.ts | 13 | High — agent lifecycle |
| src/agents/wrfc-workmap.ts | 11 | Medium — workmap IO |
| src/bookmarks/manager.ts | 11 | Medium — bookmark CRUD |
| src/panels/agent-logs-panel.ts | 7 | Low — panel rendering |
| src/panels/file-explorer-panel.ts | 6 | Medium — directory listing |
| src/agents/wrfc-controller.ts | 5 | Medium — WRFC state |

### Potential Bottlenecks

1. **`readFileSync` in hot paths**: Profile manager reads config synchronously on every profile switch. If profiles reference large files, this blocks rendering.
2. **`existsSync` chains**: Multiple sequential existence checks (e.g., checking for config in 5+ locations) add up.
3. **`writeFileSync` for state persistence**: Session saves, bookmark updates, and workmap writes block the event loop during user interaction.
4. **`readdirSync` in file explorer panel**: Listing large directories blocks rendering.
5. **Agent orchestrator sync IO**: 13 sync calls during agent lifecycle management can stall the main loop during multi-agent operations.

### Measurement Approach

- Monkey-patch `fs.*Sync` functions to log call duration + caller stack
- Use `--trace-sync-io` if available in Bun, or wrap with timing
- Profile with `bun --inspect` and Chrome DevTools "Main thread" flame chart

### Quick Wins

- Replace `readFileSync` with `Bun.file().text()` (async) in non-constructor paths
- Replace `writeFileSync` with `Bun.write()` (async) for state persistence
- Replace `existsSync` chains with a single `stat()` call or `Bun.file().exists()`
- Use `readdir` (async) in file explorer panel

### Deeper Optimizations

- Audit every `*Sync` call site — categorize as "must be sync" (module-level init) vs "can be async"
- Batch multiple sync reads into a single async operation using `Promise.all()`
- Add an async config loader that pre-warms a cache, then serve from cache synchronously

---

## 3. Memory Usage

### Key Data Structures

| Structure | Location | Growth Pattern |
|-----------|----------|----------------|
| `messages: Message[]` | src/core/conversation.ts:64 | Unbounded — grows with conversation |
| `history: InfiniteBuffer` (Line[]) | src/core/history.ts:7 | Unbounded — rendered lines accumulate |
| `undoStack: Message[][]` | src/core/conversation.ts:83 | O(n) conversation snapshots |
| `branches: Map<string, Message[]>` | src/core/conversation.ts:85 | Per-branch full message copies |
| `blockRegistry: BlockMeta[]` | src/core/conversation.ts:77 | One per collapsible block |
| `collapseState: Map<string, boolean>` | src/core/conversation.ts:75 | One per block |
| `imports: ImportsMap` | src/intelligence/import-graph.ts:116 | O(files) — up to 5,000 entries |
| `dependents: DependentsMap` | src/intelligence/import-graph.ts:119 | O(files * avg_imports) |
| `files: Map<string, number>` | src/state/project-index.ts:52 | O(project_files) |
| `cache: Map<string, HighlightedLine[]>` | src/renderer/syntax-highlighter.ts:443 | Capped at 200 entries |
| `compactionEvents: CompactionEvent[]` | src/core/context-compaction.ts:76 | Unbounded — one per compaction |
| `errorLineRegistry: number[]` | src/core/conversation.ts:79 | O(errors) |

### Potential Bottlenecks

1. **InfiniteBuffer**: Named accurately — `lines: Line[]` grows without bound. Each `Line` is an array of `Cell` objects. A long conversation can accumulate thousands of rendered lines, each with per-character cell data.
2. **Undo stack**: `undoStack: Message[][]` stores full message array snapshots. After N user messages, this holds N copies of increasing message arrays. Memory usage is O(n^2) in conversation length.
3. **Branch copies**: `branches: Map<string, Message[]>` stores complete message array copies per branch. No structural sharing.
4. **Import graph for 5,000 files**: Two Maps with Sets — `Map<string, Set<string>>` for both imports and dependents. At 5,000 files with avg 10 imports each, that is 100,000 string references.
5. **Syntax highlighter cache**: Capped at 200 but `HighlightedLine[]` per entry can be large (each line is `SyntaxToken[]`).

### Measurement Approach

- `process.memoryUsage()` snapshots at key points (startup, after first response, every 10 messages)
- `--expose-gc` + manual `gc()` to measure true retained size
- Heap snapshots via `bun --inspect` at conversation milestones (10, 50, 100 messages)
- Track `InfiniteBuffer.getLineCount()` and `ConversationManager.getMessageCount()` over time

### Quick Wins

- **Cap undo stack**: Limit to last 20 snapshots (configurable)
- **Cap compaction events**: Only keep last 50 events
- **Use copy-on-write for branches**: Store branch diff from main, not full copy
- **Trim InfiniteBuffer**: When line count exceeds 10,000, drop oldest lines (keep last 5,000)

### Deeper Optimizations

- **Structural sharing for undo**: Use immutable data structure or diff-based undo instead of full copies
- **Virtualized history**: Only keep rendered lines for visible viewport + small buffer; re-render on scroll
- **WeakRef for syntax cache**: Allow GC to reclaim highlighted blocks not currently visible
- **Streaming compaction**: Compact conversation before it hits memory limits (auto-compact at 80% context window is already implemented via `shouldAutoCompact`)
- **Import graph lazy loading**: Only build sub-graph for files referenced in current conversation

---

## 4. Streaming Latency

### Streaming Pipeline

```
Provider API → chunk parse → event bus → ConversationManager → renderer → terminal
```

| Stage | Key Files | Concern |
|-------|-----------|--------|
| Provider streaming | src/providers/*.ts | Per-provider SSE/chunk parsing |
| Synthetic provider | src/providers/synthetic.ts (183 lines) | Failover adds latency |
| Event dispatch | src/core/event-bus.ts (125 lines) | Synchronous listener invocation |
| Streaming block update | src/core/conversation.ts:242-256 | `updateStreamingBlock()` — re-renders on every chunk |
| Markdown rendering | src/renderer/markdown.ts:14-154 | `renderMarkdown()` — full re-parse per update |
| Syntax highlighting | src/renderer/syntax-highlighter.ts:477-491 | `highlight()` — tree-sitter parse per code block |
| Compositor | src/renderer/compositor.ts (256 lines) | Full frame composition per update |
| Terminal output | src/main.ts | ANSI escape sequence generation + write |

### Potential Bottlenecks

1. **updateStreamingBlock() per chunk**: Every SSE chunk triggers `updateStreamingBlock()` which calls `rebuildHistory()` (line 282-305), which re-renders ALL messages, not just the streaming one.
2. **Markdown re-parse**: `renderMarkdown()` (140 lines of logic) runs on the full accumulated text every chunk, not incrementally.
3. **Syntax highlighting during streaming**: If a code block is being streamed, `scheduleParse()` fires tree-sitter for every chunk update.
4. **Event bus synchronous dispatch**: All listeners run synchronously — a slow listener blocks the next chunk.
5. **Compositor full-frame**: Even if only one line changed, the compositor may recompose the entire screen.

### Measurement Approach

- Timestamp each chunk arrival vs. screen update completion
- Measure `updateStreamingBlock()` execution time per call
- Count re-renders per second during active streaming
- Profile `renderMarkdown()` with large accumulated text (5,000+ chars)

### Quick Wins

- **Throttle streaming updates**: Batch chunks and render at 30fps (every 33ms) instead of per-chunk
- **Incremental append**: In `updateStreamingBlock()`, only re-render from `streamingStartLine` instead of full `rebuildHistory()`
- **Defer syntax highlighting**: Don't highlight code blocks until streaming finalizes
- **Debounce compositor**: Skip frames if previous render is still in progress

### Deeper Optimizations

- **Incremental markdown parser**: Parse only the delta between previous and current text
- **Ring buffer for compositor**: Double-buffer the terminal output, only write changed cells
- **Async event bus**: Make event dispatch async with microtask scheduling
- **ANSI diff output**: Only emit escape sequences for cells that changed since last frame

---

## 5. File I/O (Tool Operations)

### Tool File Operations

| Tool | File | Lines | Key Operations |
|------|------|-------|----------------|
| Read | src/tools/read/index.ts | 856 | File read, token counting, line range extraction |
| Write | src/tools/write/index.ts | 415 | Atomic write (tmpfile + rename), snapshot capture |
| Edit | src/tools/edit/index.ts | 1,118 | Find/replace, multi-edit, snapshot before/after |

### Undo/Snapshot System

| Component | File | Lines | Purpose |
|-----------|------|-------|--------|
| FileUndo | src/state/file-undo.ts | 156 | Stores file content before each write/edit |
| PersistentStore | src/state/persistent-store.ts | 49 | Generic JSON file persistence |
| JsonFileStore | src/state/json-file-store.ts | ~50 | JSON file state storage |

### Potential Bottlenecks

1. **Snapshot capture on every write/edit**: `file-undo.ts` reads the entire file content before modification to store as undo state. For large files (10,000+ lines), this doubles the IO per operation.
2. **Atomic writes**: Write tool uses tmpfile + rename pattern. On some filesystems, `rename()` across directories triggers a copy instead of a metadata update.
3. **Edit tool complexity**: At 1,118 lines, the edit tool does find/replace with diff generation. Multi-edit operations (multiple edits to one file) may re-read the file for each edit.
4. **Read tool token estimation**: Token counting on large files involves scanning the entire content.
5. **Synchronous file reads in tools**: Some tool operations may use sync reads for simplicity.

### Measurement Approach

- Time each tool execution end-to-end (already has tool_call metadata?)
- Measure snapshot capture time separately from actual write
- Profile with files of varying sizes: 100, 1,000, 10,000, 50,000 lines
- Track cumulative IO bytes per conversation

### Quick Wins

- **Lazy snapshot**: Only capture undo snapshot if undo is enabled (make it configurable)
- **Cap undo history**: Limit file undo entries per file (e.g., last 10 edits)
- **Stream large reads**: For files >1MB, stream content instead of reading into memory
- **Batch multi-edits**: Apply all edits to a file in a single read-modify-write cycle

### Deeper Optimizations

- **Diff-based undo**: Store diffs instead of full file snapshots (90%+ space savings)
- **Memory-mapped reads**: Use `Bun.mmap()` for large file reads in the read tool
- **Write coalescing**: If multiple writes to same file within 100ms, coalesce into one
- **Async atomic writes**: Use `Bun.write()` which is already async and optimized

---

## 6. Network

### Network Operations

| Operation | File | Trigger | Concern |
|-----------|------|---------|--------|
| Provider API calls | src/providers/*.ts | Every user message | Latency, timeout handling |
| OpenRouter metadata | src/providers/model-limits.ts:125-154 | `fetchOpenRouterModels()` — startup + cache refresh | 15s timeout, large response |
| Scanner probes | src/discovery/scanner.ts:187-202 | `probeHost()` — startup + manual rescan | 200ms timeout x many hosts |
| Context window fetch | src/discovery/scanner.ts:307-468 | `fetchModelContextWindows()` — per discovered server | Multiple sequential fetches |
| Output limit fetch | src/discovery/scanner.ts:479-635 | `fetchModelOutputLimits()` — per discovered server | Multiple sequential fetches |
| Webhook notifications | src/integrations/webhooks.ts | On events | Fire-and-forget |
| Discord/Slack | src/integrations/discord.ts, slack.ts | On events | Fire-and-forget |
| GitHub | src/integrations/github.ts | On events | API rate limits |
| MCP stdio | src/mcp/client.ts (370 lines) | Tool calls | Process IPC overhead |
| ACP connections | src/acp/connection.ts | Agent protocol | WebSocket/HTTP |
| Daemon HTTP | src/daemon/server.ts, http-listener.ts | External API | Local only |

### Potential Bottlenecks

1. **OpenRouter fetch**: Downloads full model catalog (~500KB JSON). Parsed into Map on every cache miss.
2. **Scanner sequential metadata**: After discovering a server, `fetchModelContextWindows()` and `fetchModelOutputLimits()` make sequential HTTP calls per model. With 10 models per server, that is 20+ requests.
3. **MCP stdio latency**: Each MCP tool call requires JSON-RPC over stdio — process scheduling adds 1-5ms per call.
4. **No connection pooling**: Each provider API call may create a new TCP connection (depends on Bun's fetch implementation).
5. **Webhook fire-and-forget**: If webhook endpoint is slow, `fetch()` promise stays alive consuming memory.

### Measurement Approach

- Wrap `fetch()` calls with timing: request start, TTFB, completion
- Log network call frequency per provider per conversation
- Measure OpenRouter response parse time
- Track MCP round-trip latency per tool call

### Quick Wins

- **Parallelize scanner metadata**: Fetch context windows and output limits concurrently per server
- **Stream OpenRouter parse**: Parse JSON incrementally instead of buffering full response
- **Webhook timeout**: Add 5s timeout to webhook notifications
- **Cache DNS**: Bun may already do this, but verify

### Deeper Optimizations

- **HTTP/2 multiplexing**: Use connection reuse for providers that support it
- **Incremental OpenRouter sync**: Use If-Modified-Since or ETag for cache validation
- **MCP batching**: Batch multiple tool calls into single JSON-RPC batch request
- **Scanner results caching**: Skip re-probing servers that responded in last 5 minutes

---

## 7. Renderer

### Architecture

Custom terminal renderer (NOT Ink/React). Direct ANSI escape sequence generation.

| Component | File | Lines | Role |
|-----------|------|-------|------|
| Compositor | src/renderer/compositor.ts | 256 | Frame composition, dirty tracking |
| Buffer | src/renderer/buffer.ts | 35 | Cell grid (width x height) |
| Layout | src/renderer/layout.ts | 31 | Panel layout calculation |
| Markdown | src/renderer/markdown.ts | 666 | Markdown to Cell[] rendering |
| Syntax highlighter | src/renderer/syntax-highlighter.ts | 553 | Tree-sitter based highlighting |
| Code block | src/renderer/code-block.ts | ? | Code block rendering |
| Diff view | src/renderer/diff-view.ts, diff.ts | ? | Diff rendering |
| Semantic diff | src/renderer/semantic-diff.ts | ? | Semantic diff with tree-sitter |
| Tool call | src/renderer/tool-call.ts | ? | Tool call result rendering |
| Thinking | src/renderer/thinking.ts | ? | Thinking block rendering |
| 38 renderer files total | src/renderer/*.ts | ~6,350 lines | Various UI components |

### Panels (Hot Render Path)

| Panel | File | Timer/Interval |
|-------|------|---------|
| Agent inspector | src/panels/agent-inspector-panel.ts | setInterval |
| Agent logs | src/panels/agent-logs-panel.ts | setInterval |
| Git panel | src/panels/git-panel.ts | setInterval |
| Provider health | src/panels/provider-health-panel.ts | setInterval |
| Session browser | src/panels/session-browser-panel.ts | setInterval |
| Token budget | src/panels/token-budget-panel.ts | setInterval |
| Schedule panel | src/panels/schedule-panel.ts | setInterval |

**7 panels use `setInterval` for periodic refresh** — each ticks independently.

### Potential Bottlenecks

1. **Full re-render on streaming**: `rebuildHistory()` re-renders all messages, not just the changed one.
2. **Markdown rendering cost**: `renderMarkdown()` is 140+ lines of logic with inline token parsing, table rendering, and line wrapping. Called on every message.
3. **Syntax highlighting**: Tree-sitter WASM parse is expensive. Cache is capped at 200 entries but cache key includes full code content — no deduplication for minor edits.
4. **Panel timer proliferation**: 7+ independent `setInterval` timers cause unnecessary wakeups even when panels are hidden.
5. **TerminalBuffer.clone()**: Creates deep copy of entire cell grid — called during composition.
6. **No dirty region tracking**: Compositor appears to recompose full frame even for single-line changes.
7. **Semantic diff with tree-sitter**: Parsing both old and new file versions for every diff is expensive.

### Measurement Approach

- Measure render time per frame: `performance.now()` around compositor
- Count renders per second during idle, typing, and streaming
- Profile `renderMarkdown()` with varying content sizes
- Track panel refresh rate vs actual data changes
- Measure `TerminalBuffer.clone()` cost with large terminal sizes (200x50)

### Quick Wins

- **Pause hidden panel timers**: Only tick panels that are currently visible
- **Throttle panel refresh**: 1-2Hz is sufficient for status panels, not every 100ms
- **Skip redundant renders**: If content hash hasn't changed, skip the render
- **Partial re-render**: Track dirty line ranges, only re-render changed lines

### Deeper Optimizations

- **Incremental compositor**: Diff previous and current buffer, only emit changed ANSI sequences
- **Virtualized message rendering**: Only render messages in viewport + 1 screen of buffer
- **Highlight cache key optimization**: Hash code content for cache key instead of using full string
- **Shared panel timer**: Single timer that dispatches to all visible panels
- **GPU-accelerated rendering**: Not applicable for terminal, but sixel/kitty graphics protocol for images

---

## 8. Import Graph

### Architecture

| Component | Location | Purpose |
|-----------|----------|--------|
| ImportGraph class | src/intelligence/import-graph.ts:112-260 | Singleton, builds/queries dependency graph |
| collectSourceFiles | src/intelligence/import-graph.ts:83-106 | Recursive directory walk |
| extractRelativeSpecifiers | src/intelligence/import-graph.ts:43-52 | Regex-based import extraction |
| resolveSpecifier | src/intelligence/import-graph.ts:58-77 | Path resolution with extension probing |
| MAX_FILES | src/intelligence/import-graph.ts:30 | Capped at 5,000 files |
| SUPPORTED_EXTENSIONS | src/intelligence/import-graph.ts:28 | .ts, .tsx, .js, .jsx, .mjs, .cjs |
| SKIP_DIRS | src/intelligence/import-graph.ts:29 | .git, node_modules, dist, etc. |

### Build Process

1. `collectSourceFiles()`: Recursive `readdir` + `stat` to find all source files (up to 5,000)
2. For each file: `readFile()` + regex extraction of import/export specifiers
3. For each relative specifier: `resolveSpecifier()` tries up to 6 extension variants with `existsSync`
4. Build two Maps: `imports` (file -> Set<imported_files>) and `dependents` (file -> Set<importing_files>)

### Potential Bottlenecks

1. **5,000 file reads**: At cap, reads 5,000 files sequentially. Even at 1ms per read, that is 5 seconds.
2. **Extension probing**: `resolveSpecifier()` tries `.ts`, `.tsx`, `.js`, `.jsx`, `/index.ts`, `/index.tsx` — up to 6 `existsSync` calls per specifier. With 10 imports per file and 5,000 files, that is 300,000 `existsSync` calls.
3. **Regex parsing**: `IMPORT_RE` and `REQUIRE_RE` run on every file's full content. Not expensive individually but multiplied by 5,000.
4. **No incremental rebuild**: `build()` clears and rebuilds from scratch. Even `markDirty()` triggers full rebuild.
5. **Singleton with dirty flag**: Any file change marks the entire graph dirty, requiring full rebuild.

### Measurement Approach

- Time `ImportGraph.build()` on projects of varying sizes: 100, 500, 1,000, 5,000 files
- Count `existsSync` calls during build (should be orders of magnitude more than file count)
- Measure memory usage of the two Maps at 5,000 files
- Profile `collectSourceFiles()` directory walk separately from import extraction

### Quick Wins

- **Batch existsSync**: Replace individual `existsSync` calls with a pre-built file existence Set from the directory walk
- **Parallel file reads**: Use `Promise.all()` with concurrency limit (e.g., 50) instead of sequential reads
- **Skip unchanged files**: On rebuild, only re-parse files whose mtime changed
- **Lazy resolution**: Don't resolve specifiers until they are queried

### Deeper Optimizations

- **Persistent graph cache**: Serialize graph to disk with per-file mtimes. On startup, only re-parse changed files.
- **Tree-sitter for imports**: Use tree-sitter AST instead of regex — more accurate and can extract in one pass
- **File existence bitmap**: Pre-scan directory for all files, build a Set, then resolve specifiers via Set lookup (zero syscalls)
- **Incremental update**: On file change, only update that file's imports and its dependents' entries — O(1) instead of O(n)
- **Watch-based invalidation**: Use `FileWatcher` events to incrementally update the graph instead of full rebuild

---

## Priority Matrix

| Area | Impact | Effort | Priority |
|------|--------|--------|----------|
| Startup: defer scanner + import graph | High | Low | P0 |
| Streaming: throttle render updates | High | Low | P0 |
| Renderer: pause hidden panel timers | Medium | Low | P0 |
| Sync FS: convert hot-path readFileSync | High | Medium | P1 |
| Memory: cap undo stack | Medium | Low | P1 |
| Import graph: batch existsSync | High | Medium | P1 |
| Streaming: incremental markdown | High | High | P2 |
| Renderer: dirty region tracking | High | High | P2 |
| Memory: structural sharing for undo | Medium | High | P2 |
| Import graph: persistent cache | High | High | P2 |
| Network: parallel scanner metadata | Medium | Medium | P2 |
| File I/O: diff-based undo snapshots | Medium | High | P3 |
| Renderer: incremental compositor | Medium | High | P3 |
| Network: MCP batching | Low | High | P3 |

---

## Instrumentation Plan

To execute this audit, add a lightweight profiling system:

### Phase 1: Timing Infrastructure

```typescript
// src/utils/perf.ts
const marks: Record<string, number> = {};
export function perfMark(label: string) { marks[label] = Bun.nanoseconds(); }
export function perfMeasure(label: string): number {
  const start = marks[label];
  return start ? (Bun.nanoseconds() - start) / 1_000_000 : -1;
}
export function perfReport(): Record<string, number> {
  // Return all measurements
}
```

### Phase 2: Memory Tracking

```typescript
// Periodic memory snapshots
setInterval(() => {
  const mem = process.memoryUsage();
  // Log to .goodvibes/tui/perf/memory-${Date.now()}.json
}, 30_000);
```

### Phase 3: Render Profiling

```typescript
// Wrap compositor.render()
let frameCount = 0, frameTotalMs = 0;
// Track p50, p95, p99 render times
```

### Phase 4: Network Profiling

```typescript
// Wrap global fetch()
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  const t0 = performance.now();
  const res = await originalFetch(url, opts);
  // Log timing
  return res;
};
```

---

## Execution Order

1. **Instrument** — Add perf.ts utility, wrap main() phases, wrap fetch()
2. **Baseline** — Measure current startup time, streaming FPS, memory at 100 messages
3. **P0 fixes** — Defer startup work, throttle streaming, pause hidden panels
4. **Re-measure** — Compare against baseline
5. **P1 fixes** — Convert sync FS, cap undo, optimize import graph
6. **Re-measure** — Compare against P0 baseline
7. **P2/P3** — Based on measured impact, prioritize deeper optimizations
