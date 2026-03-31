# Context Compaction v2 — Design Plan

## Date: 2026-03-30

## Overview

Replace the current LLM-summarization-based compaction with a hybrid approach: deterministic structure with targeted LLM calls for specific extraction tasks. The overall framework is rule-based (sections, budgets, ordering), but individual sections use small LLM calls to judge relevance and extract summaries.

Compaction triggers while there is still enough context room to perform the LLM-assisted extraction. The goal is a SMALL compacted output — less compaction = more post-compaction working space.

## Token Budget

| Section | Max Tokens | Required | Method |
|---------|-----------|----------|--------|
| Handoff header | ~50 | Always | Rule-based |
| Session memories (pinned) | No cap | If any pinned | Rule-based |
| Current task | ~50 | Always | Rule-based |
| Running agents | ~200 | If any running | Rule-based |
| Recent conversation (filtered) | 3,000 | Always | Rule-based gather + LLM filter |
| Tool results + files modified | 1,500 | Always | LLM-assisted relevance filter |
| Agent activity table | 1,500 | Always | Rule-based |
| Older agent summary | 500 | Only if agents beyond table | LLM-assisted |
| Resolved problems | ~300 | If any resolved | LLM-assisted extraction |
| Plan progress | ~100 | If plan exists | Rule-based |
| Session lineage | ~200 | Always | Rule-based (append-only) |
| **Total ceiling** | **~6,500** | | |

Note: Total ceiling is a MAX. Unused budget stays unused = more post-compaction space.

Unused budget is NOT redistributed — it becomes free post-compaction working space.

Empty sections are OMITTED entirely — no headers, no placeholders. If there are no running agents, no "## Currently Running" header. If there are no resolved problems, no "## Resolved Problems" header. Every token counts.

## Sections

### 0. Handoff Header

First line, always present, non-negotiable:

```
IMPORTANT: This session is not new! Context was compacted, please read the following for proper handoff so you may resume work!
```

### 1. Session Memories (pinned, no cap)

Messages the user has explicitly pinned for the duration of the session. These survive ALL compactions unconditionally.

**Creation methods:**
- `!#` prefix in a message — the message is sent normally (with prefix stripped) AND stored as a session memory
- `/memory add <text>` — adds a memory without sending a message

**Management:**
- `/memory` or `/memory list` — shows all session memories with IDs
- `/memory remove <id>` — removes a specific memory

**Storage:**
- In-memory only — dies with the session
- Each memory gets an incrementing ID: `mem-1`, `mem-2`, etc.
- No token cap — if a user wants to fill their context with memories, that's their choice

**In compacted output:**
```
## Session Memories (pinned)
- [mem-1] Never use static model lists
- [mem-2] Minimum review score is 10/10
- [mem-3] User prefers precision_engine tools over native tools
```

**Rationale:** Some instructions apply for the entire session but may fall outside the recent conversation window after enough messages. Without pinning, they'd be lost on compaction. Examples: project constraints, user preferences, architectural decisions made early in the session.

### 2. Current Task

One line stating what the user is currently trying to accomplish. Extracted from the most recent user instruction or plan title.

### 3. Currently Running Agents

List any agents still in `running` or `pending` status at compaction time. Per agent:
- WRFC chain ID
- Agent ID
- One-line description of what they are doing (EXTREMELY brief)

This is the first actionable item the LLM reads — it knows what to check on when it resumes.

### 4. Recent Conversation

#### 4a. Raw Gather (up to 3,000 tokens)

- Start from the most recent message, work backward
- Include only **user** and **assistant** messages
- Full messages only — no partial messages
- Stop when adding the next message would exceed 3,000 tokens
- If a message would push total to 3,001+, exclude it entirely
- 3,000 is a CEILING, not a target — less is fine

#### 4b. Filter for Substance (LLM-assisted)

Feed the gathered messages to the LLM with a targeted prompt:

> "From these recent messages, remove anything that doesn't advance the work: short acknowledgments, agent count updates, repetitive system nudges, status confirmations. Keep: instructions, planning, decisions, task assignments, requirement changes. Return only the messages worth preserving."

The result will be LESS than 3,000 tokens. That's intentional — the savings become post-compaction working space.

**Important:** ALL user messages are high-priority. Even short ones ("do not strip size indicators") can be critical instructions. The LLM filter should bias toward keeping user messages.

### 5. Tool Results + Files Modified (up to 1,500 tokens, LLM-assisted)

Combined section — tool calls inherently reference files.

Feed recent tool results to the LLM:

> "From these tool call results, select the ones that are still relevant for ongoing work. Include: file paths touched with what was done (created/edited/deleted), any error outputs that haven't been resolved, any build/test results. Max 1,500 tokens. Use relative paths and short descriptions."

Scope: since last compaction (or session start).

### 6. Agent Activity Table (up to 1,500 tokens, rule-based)

One row per **WRFC chain**, not per intermediate step.

Columns:
- Chain ID
- Task summary (brief)
- Score lineage (e.g., "7.2 → 9.1 → 10")
- Final result (PASSED / FAILED / IN_PROGRESS)

Rules:
- Skip intermediate reviews and fix cycles — just the chain's purpose and final outcome
- Most recent chain first, working backward
- Stop when adding the next row would exceed 1,500 tokens
- Built directly from `AgentManager` + `WrfcController` state — no LLM call needed

### 7. Older Agent Summary (0-500 tokens, LLM-assisted)

- Only included if agents exist beyond the table cutoff
- Feed the older agent list to the LLM:

> "Summarize what these agents accomplished in aggregate. Focus on outcomes: what was built, fixed, reviewed. Max 500 tokens."

- If the table covers all agents, skip this section entirely

### 8. Resolved Problems (LLM-assisted)

Feed the conversation window to the LLM:

> "Extract problem → resolution pairs from this conversation. Only include problems that were actually resolved. One line each. Format: problem → resolution."

Highlight the resolution, not the debugging journey.

### 9. Plan Progress (rule-based)

- Which phases/items completed since last compaction (or session start)
- Current phase status
- What's next / what's blocked
- Read directly from `planManager.getActive()` + `planManager.getSummary()`

### 10. Session Lineage (rule-based, append-only)

Structured micro-log that never degrades. Each compaction adds one line. Old lines never change.

```
## Session Lineage
Original task: "Create HTTP server with MCP hosting and API"
Compactions: 3
- #1: Completed Phase 1 (core infrastructure). Key: chose Express over Fastify.
- #2: Completed Phase 2-3 (API + auth). Key: JWT auth, rate limiting added.
- #3: Phase 4 in progress. Key: MCP WebSocket transport working.
```

This replaces the "prior compaction carryover" concept. No summarization of summaries. Facts are preserved exactly. Each entry is one line — the section grows linearly but stays small.

## Output Format

```
IMPORTANT: This session is not new! Context was compacted, please read the following for proper handoff so you may resume work!

## Current Task
Building HTTP server with file serving, MCP hosting, and REST API.

## Session Memories (pinned)
- [mem-1] Never use static model lists
- [mem-2] Minimum review score is 10/10
- [mem-3] User prefers precision_engine tools over native tools

## Currently Running
- wrfc-abc123 | agent-def456 | Implementing REST API routes
- wrfc-ghi789 | agent-jkl012 | Writing unit tests for auth module

## Recent Conversation
[filtered user/assistant messages]

## Tool Results & Files Modified
- src/server.ts — created (Express setup, static file middleware)
- src/api/router.ts — created (RESTful routing with validation)
- src/mcp/transport.ts — edited (added WebSocket upgrade handling)
- Last build: PASS (0 errors)
- Last test: 47/47 passing

## Agent Activity
| Chain | Task | Scores | Result |
|-------|------|--------|--------|
| wrfc-xxx | Fix benchmark parser | 8.2→9.8→10 | PASSED |
| wrfc-yyy | Add fuzzy edit fallback | 6.8→8.4→9.8→10 | PASSED |
| ... | ... | ... | ... |

## Older Work Summary
[aggregate prose if agents exist beyond table, up to 500 tokens]

## Resolved Problems
- Benchmark parser returned 0 entries → fixed field name mismatch with ZeroEval API
- Arrow keys disabled after /command → catch-all continue was swallowing left/right
- Agent spawn blocked main conversation → batch-spawn not detected in turn loop break

## Plan Progress
- Phase 1: Core Infrastructure [COMPLETE]
- Phase 2: API Routes [IN PROGRESS — 2/4 items done]
- Phase 3: Testing [PENDING]

## Session Lineage
Original task: "Create HTTP server with MCP hosting and API"
Compactions: 1
- #1: Completed Phase 1. Key: Express chosen, static file serving working.
```

## Implementation Architecture

### Two categories of work during compaction

**Rule-based (instant, free):**
- Handoff header
- Current task (from plan title or last user instruction)
- Running agents list (from AgentManager)
- Agent activity table (from AgentManager + WrfcController)
- Plan progress (from planManager)
- Session lineage (append one line to persistent log)

**LLM-assisted (targeted, small calls during compaction):**
- Substance filter (3b) — feed recent messages, ask which advance the work
- Tool result relevance (section 4) — feed recent tool results, ask which are still relevant
- Resolved problems (section 7) — feed conversation window, extract problem→resolution pairs
- Older agent summary (section 6) — feed agent list beyond table, ask for aggregate summary

### Multi-turn Coherence (section 4b filter rule)

When filtering recent messages for substance, always keep user-assistant PAIRS. If an assistant message is kept, the user message that prompted it must also be kept, even if it's short. Conversational coherence matters more than individual message quality. A 3-word user instruction ("do not strip size indicators") can be the most important message in the session.

### Post-compaction Validation

After constructing the compacted context, run a sanity check:
- Is the handoff header present?
- Is the current task stated?
- Are running agents listed (if any exist)?
- Are session memories included (if any exist)?
- Is the total within the token budget ceiling?
- Did any LLM extraction call return empty when it shouldn't have?

If any critical section is missing, log a warning. A bad compaction is worse than no compaction.

### When to trigger

Buffer check: `contextWindow - currentTokens <= 15000` (15k tokens remaining).
Manual trigger via `/compact` command.

15k remaining gives enough space for the ~6.5k compaction output + LLM extraction calls + post-compaction work.

**Small window exception**: If `contextWindow < 12000`, use simplified compaction — keep the last 10 messages and prepend a brief summary note. No LLM call needed; there isn't enough room for extraction calls anyway.

### Data sources

- **Recent conversation**: `ConversationManager.getMessages()` filtered by role
- **Running agents**: `AgentManager.list().filter(a => a.status === 'running' || a.status === 'pending')`
- **Agent activity**: `AgentManager.list()` + `WrfcController` chain state
- **Tool results + files**: Tool call history from conversation messages (role === 'tool')
- **Plan progress**: `planManager.getActive()` + `planManager.getSummary()`
- **Session lineage**: Persistent file or in-memory log, append-only
- **Session memories**: In-memory list, managed by `/memory` command and `!#` prefix
- **Current task**: Plan title if plan exists, otherwise last substantive user message

### Compaction trigger: 15k token buffer

The trigger is `contextWindow - currentTokens <= 15000` (15k remaining), not a percentage.
This gives predictable behavior regardless of window size:
- 1M window: triggers at ~985k tokens used
- 128k window: triggers at ~113k tokens used
- Any window: always leaves 15k for compaction work

Small windows (<12k): fall back to simplified compaction (keep last 10 messages, no LLM call).

### Use a fast/cheap model for extraction calls

The compaction LLM calls (substance filter, tool relevance, problem extraction, older summary) don't need frontier model intelligence. A fast free model handles these fine. Use the synthetic provider's best free model for compaction work rather than the user's selected (potentially expensive) model.

### Token estimation

Use existing `estimateConversationTokens()` (4 chars ≈ 1 token) with 10% safety margin on all budgets. Code-heavy content is closer to 3 chars/token, so the safety margin prevents overruns.

### What changes from v1

1. **Hybrid approach** — v1 sent ALL older messages to LLM for one big summary. v2 uses targeted LLM calls for specific extraction tasks within a deterministic structure.
2. **Structured output** — v1 produced a single prose blob. v2 produces discrete sections with specific purposes.
3. **Agent-aware** — v1 treated all messages equally. v2 understands WRFC chains, agent lifecycle, and running agents.
4. **Running agent awareness** — v1 had no concept of in-flight work. v2 explicitly lists what's running.
5. **Handoff framing** — v1 silently replaced context. v2 explicitly tells the LLM to read the handoff.
6. **Session lineage** — v1 carried forward degrading summaries. v2 maintains an append-only micro-log that never loses fidelity.
7. **Intentionally small** — v1 tried to maximize information in the compacted output. v2 prioritizes post-compaction working space.
