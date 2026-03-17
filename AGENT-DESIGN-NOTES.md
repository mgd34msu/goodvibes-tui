# Agent System Design Notes

Captures design discussions and requirements for agent system improvements.
References source files in `src/` — read those for implementation context.

---

## 6. Agent System Prompts + Project Context

### Problem
- `AgentOrchestrator.buildSystemPrompt()` (agents/orchestrator.ts:171-179) generates a minimal 4-line prompt with no project awareness
- `ArchetypeLoader` (agents/archetypes.ts) supports loading `systemPrompt` from `.goodvibes/agents/*.md` files, but `AgentOrchestrator` never reads it
- Agents don't know their working directory, project structure, available files, coding conventions, or how to use their tools effectively
- This directly causes lackluster agent output — they have no context to work with

### Requirements
- System prompt must include:
  - Project context: working directory, project type (from `detectProject()`), package manager, test framework
  - File structure awareness: key entry points, directory layout summary
  - Archetype-specific instructions: loaded from `ArchetypeLoader.loadArchetype(template).systemPrompt`
  - Tool usage instructions: how each tool works, what parameters to use, best practices
  - Coding conventions: if `.goodvibes/GOODVIBES.md` or similar exists, inject relevant sections
  - Task context: the spawning parent's context (what it knows about the task)
- System prompt should be layered: base instructions + archetype overlay + project context + task context
- Must not bloat context window — keep it concise, use progressive disclosure where possible

### Key Files
- `src/agents/orchestrator.ts` — `buildSystemPrompt()` needs rewrite
- `src/agents/archetypes.ts` — `ArchetypeLoader` already supports system prompts, just needs wiring
- `src/tools/inspect/index.ts` — `detectProject()` can provide project info
- `src/utils/prompt-loader.ts` — `loadSystemPrompt()` / `readPromptFile()` for @ includes

---

## 7. Agent Communication Model

### Problem
- `AgentMessageBus` (agents/message-bus.ts) exists with point-to-point and broadcast messaging + TTL
- But nothing wires it into the `AgentOrchestrator` execution loop
- Agents are completely isolated — each gets its own `ConversationManager` with no shared context
- No mechanism for a parent to send instructions to a running child
- No mechanism for siblings to coordinate

### Requirements

#### Parent ↔ Child Communication
- Any parent (main orchestrator or agent) must be able to send messages to any child it spawned
- Children must be able to send results/status back to their parent
- Agent output must bubble up to the main conversation — the user must see what agents did
- Parent should be able to: send follow-up instructions, cancel, request status

#### Sibling ↔ Sibling Communication
- Any child should be able to communicate with any other child spawned by the same parent
- Use case: engineer agent tells reviewer agent "I'm done with file X, review it"
- Use case: two engineer agents coordinate to avoid conflicting file edits

#### Recursive Communication (Danger Zone)
- When `danger.agentRecursion` is enabled and `maxRecursionDepth > 0`:
  - Parent can communicate with child-of-child (grandchild)
  - The full tree is navigable: parent → child → grandchild
  - Each level inherits communication capabilities from its parent
- Security: `SpawnTokenManager` (security/spawn-tokens.ts) already gates recursion via 3-layer checks

#### Implementation Approach
- `AgentMessageBus` already has the primitives: `send()`, `broadcast()`, `subscribe()`, `getMessages()`
- Need to wire into `AgentOrchestrator.runAgent()`: check for incoming messages between turns
- Incoming messages should be injected as system messages or user messages into the agent's conversation
- Decision needed: system messages (non-conversational, context injection) vs user messages (trigger a new LLM turn)
- Suggestion: system messages for status/coordination, user messages for new instructions that need a response

#### Output to Main Conversation
- When an agent completes, its final output (last assistant message or summary) must be:
  1. Stored in `AgentRecord.progress` (currently truncated to 200 chars — needs full capture)
  2. Injected into the parent's conversation as a tool result or system message
  3. Visible in the main TUI conversation history
- The user should see something like: `[Agent engineer-a1b2c3d4 completed] <summary of what it did>`

### Key Files
- `src/agents/message-bus.ts` — existing pub/sub infrastructure
- `src/agents/orchestrator.ts` — `runAgent()` turn loop needs message checking
- `src/agents/session.ts` — `AgentSession` tracks per-agent state
- `src/core/orchestrator.ts` — main orchestrator, handles `subagent:complete` events
- `src/core/event-bus.ts` — `subagent:complete`, `subagent:update` events already defined
- `src/acp/connection.ts` — ACP protocol handler, captures `lastProgressText`

---

## 8. Automated WRFC Chains

### Problem
- `WorkflowManager` (tools/workflow/index.ts) implements WRFC state machine with states: gather → plan → apply → review → revision → complete
- But it's entirely manual — you call the `workflow` tool to start/transition/cancel
- No automatic chain triggers when an agent spawns or completes
- No automatic review step after an agent finishes work
- No automatic fix loop when review finds issues
- The `HookDispatcher` + `ChainEngine` support multi-event chains but aren't wired to agent lifecycle

### Requirements

#### Auto-WRFC on Agent Spawn
- When an engineer/tester agent is spawned, automatically create a WRFC workflow instance
- The workflow tracks the agent's progress through states
- State transitions happen automatically based on agent events:
  - Agent starts → `gather` or `apply` state
  - Agent completes tool execution → `review` state
  - Review finds issues → `revision` state → agent gets fix instructions → `apply` state
  - Review passes → `complete` state

#### Review Integration
- After an engineer agent completes, automatically spawn a reviewer agent (or use the same agent with a review prompt)
- Reviewer checks: code quality, test coverage, correctness, adherence to task requirements
- Review produces: pass/fail + list of issues
- On fail: original agent (or a new fix agent) receives the issues and attempts fixes
- Max fix attempts configurable (prevent infinite loops)

#### Quality Gates
- Optional validators at state transitions (already supported in edit tool's `validate` field):
  - typecheck (tsc --noEmit)
  - lint (eslint)
  - test (bun test)
  - build (bun run build)
- Gate failures block state transition and trigger revision

#### Hook Integration
- Agent lifecycle events should fire hooks:
  - `Pre:agent:spawn`, `Post:agent:spawn`
  - `Pre:agent:complete`, `Post:agent:complete`
  - `Pre:agent:review`, `Post:agent:review`
  - `Fail:agent:review` (when review finds issues)
- `ChainEngine` can then be used to define custom WRFC-like chains via hooks.json

#### Configuration
- Auto-WRFC should be opt-in (config setting or per-spawn flag)
- Max review cycles configurable
- Which validators to run at which gates configurable
- Templates can specify default WRFC behavior (e.g., engineer template auto-reviews, researcher template doesn't)

### Key Files
- `src/tools/workflow/index.ts` — `WorkflowManager`, `WORKFLOW_DEFINITIONS`, state machine
- `src/agents/orchestrator.ts` — `runAgent()` needs WRFC integration points
- `src/hooks/dispatcher.ts` — `HookDispatcher.fire()` for agent lifecycle events
- `src/hooks/chain-engine.ts` — `ChainEngine` for multi-event automation
- `src/hooks/types.ts` — hook event type definitions (need agent category events)
- `src/workflow/trigger-executor.ts` — `fireTriggers()` for event-driven automation
- `src/config/schema.ts` — needs new config keys for WRFC behavior

---

## Implementation Status

### Completed (v0.9.4)

| Item | Status | Notes |
|------|--------|-------|
| Agent session JSONL logging | DONE | Every agent run logs to `.goodvibes/tui/sessions/agent-{id}.jsonl` |
| Rich agent system prompt (5-layer) | DONE | Base + archetype + project context + conventions + task |
| Dynamic tool descriptions | DONE | Only tools the agent has are described; all 11 types covered |
| Project context auto-detection | DONE | cwd, package manager, TypeScript, test framework, entry points, scripts |
| Recovery strategy with context7 | DONE | Agents instructed to search MCP docs before guessing |
| Shared FileStateCache/ProjectIndex | DONE | Agents share cache/OCC state with main session |
| Process indicator below input | DONE | Focusable via down arrow, Enter opens process list |
| F-key tokenizer support | DONE | F1-F12 via SS3 and CSI sequences |
| Full-width process/detail modals | DONE | All modals use terminal width, show all agent statuses |
| Agent detail auto-refresh | DONE | JSONL log refreshes every 500ms, locked to latest 10 entries |
| Process/agent/live-tail/context modals wired in render | DONE | All 4 overlay modals render in main.ts viewport |

### Remaining

| Item | Status | Ref |
|------|--------|-----|
| Agent communication (parent/child/sibling messaging) | NOT STARTED | Section 7 |
| Agent output bubbling to main conversation | NOT STARTED | Section 7 |
| Automated WRFC chains | NOT STARTED | Section 8 |
| Agent lifecycle hooks (Pre/Post:agent:spawn/complete) | NOT STARTED | Section 8 |
| User session prefix (user- vs agent-) | NOT STARTED | Open Q1 |
| Permission inheritance for agents | NOT STARTED | Open Q3 |
| Agent failure notification in main conversation | NOT STARTED | Open Q5 |

---

## Open Questions

1. Should agent conversations be stored separately from user sessions, or in the same `/sessions` namespace?
- ANSWER: we should specifiy which are user and which are agent sessions. User sessions should have a user- prefix, and agent sessions should have an agent- prefix.
2. When an agent modifies files, should those changes be staged in a git worktree (`AgentWorktree`) by default, or committed directly?
- ANSWER: this will be something that the orchestrator determines. simple things very likely do not need worktree separation, but more complex overlapping tasks would benefit from them.
3. How should WRFC interact with the permission system? Should review agents auto-approve their own tool calls?
- ANSWER: agent sessions inherit permissions from the user session. if there is something happening in an agent session that requires permissions that have not been given, the permission should be immediately requested at the user session level, then when granted or denied the agent will be able to either continue or stop as necessary.
4. What's the token budget strategy for agents? Should they have a max context window independent of the main conversation?
- ANSWER - yes, independent context. agent sessions are essentially unattended autonomous user sessions, but their permission structure is tied to their highest-level parent session.
5. How do we handle agent failures gracefully in the UI? Currently a failed agent just sets `record.error` — should the main conversation be notified?
- ANSWER - report in the main conversation, just like success and completion.
