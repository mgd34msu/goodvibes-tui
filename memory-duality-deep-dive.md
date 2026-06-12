# Deep Dive: Memory & Knowledge Systems

**Generated**: 2026-06-11 ~21:20 | Scores: coherence 7, UX clarity 3, retrieval wiring 5, tests 7

## Verdict: ~70% deliberate layering (SDK), ~30% TUI accretion. Layer-explicitly + consolidate front-doors.

FIVE surfaces (prompt assumed four): (1) SDK knowledge GRAPH (/knowledge — ingest/RAG); (2) durable MEMORY registry (= the real "project memory": /recall, cls includes risk/runbook/architecture, scopes session/project/team) — note /project-memory does NOT exist, the surface is /recall; (3) HIDDEN FIFTH: SessionMemoryStore — ephemeral mem-N scratch notes via /session memory, a DIFFERENT store colliding in name; (4) /session-memory front-door — thin alias over /recall; (5) /team-memory front-door — same.

The SDK design is sound: MemoryApi is a sub-namespace of KnowledgeApi with an injection bridge (selectKnowledgeForTask + buildKnowledgeInjectionPrompt). The mess is all TUI surface.

## Findings
1. SCOPE-FILTER NO-OP BUG: /session-memory queue and /team-memory queue both call recall queue with NO scope arg — the advertised distinction is fiction (memory-product-runtime.ts:67,93) | S
2. Two panels (knowledge + memory) render the SAME memoryRegistry with overlapping descriptions; the panel named Knowledge shows MEMORY records while the actual graph has no builtin panel — naming inversion | M
3. Injection is operator-only: selectKnowledgeForTask NEVER invoked at agent spawn (src/agents grep = 0) — curated memory has zero automatic effect | M/L
4. "Project Memory Substrate" reachable only as /recall — discoverability | S
5. SessionMemoryStore name collision with /recall --scope session | S (rename to notes/scratch)

## Consolidation proposal (mostly deletion + rename, no SDK change)
Two stores, three lifecycles: Knowledge = what you ingested; Memory = what you decided; Notes = this session's scratch. /recall becomes the single memory surface with explicit --scope; demote front-doors to honest aliases (fix or delete); merge panels into one filtered MemoryPanel; repoint 'knowledge' panel id to the graph; document the boundary in one guide. Best-in-class additions: auto-inject scoped memory at agent spawn; graph→memory promotion path; memory consolidation/dedup detection.
