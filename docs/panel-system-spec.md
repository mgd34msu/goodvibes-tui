# Panel System — Full Specification

## Overview

A right-side panel system that transforms the TUI from a single-pane chat into a multi-pane workspace. Panels are modular, stackable, and independently renderable. The compositor splits horizontally, with the conversation viewport on the left and a panel stack on the right.

## Architecture

### Panel Interface

```typescript
export interface Panel {
  id: string;
  name: string;
  icon: string; // single char for tab bar
  category: 'development' | 'agent' | 'monitoring' | 'session' | 'ai';
  
  // Lifecycle
  onActivate(): void;   // called when panel becomes visible
  onDeactivate(): void; // called when panel is hidden
  onDestroy(): void;    // called when panel is removed
  
  // Rendering
  render(width: number, height: number): Line[];
  
  // State
  isTransient: boolean;  // auto-close when task completes
  isPinned: boolean;     // survives panel cycling
  
  // Input (optional — panels can handle their own keys)
  handleInput?(key: string): boolean; // return true if consumed
  
  // Data refresh
  needsRender: boolean; // dirty flag for selective re-render
}
```

### Panel Manager

```typescript
export class PanelManager {
  private panels: Panel[] = [];
  private activeIndex: number = 0;
  private visible: boolean = false;
  private splitRatio: number = 0.6; // left side gets 60%
  
  // Panel lifecycle
  register(panel: Panel): void;
  unregister(panelId: string): void;
  activate(panelId: string): void;
  
  // Navigation
  nextPanel(): void;    // Ctrl+]
  prevPanel(): void;    // Ctrl+[
  toggle(): void;       // Ctrl+\
  
  // Split control
  widenLeft(): void;    // Ctrl+}
  widenRight(): void;   // Ctrl+{
  
  // Rendering
  getActivePanel(): Panel | null;
  getTabBar(width: number): Line;
  isVisible(): boolean;
  getSplitRatio(): number;
  getLeftWidth(totalWidth: number): number;
  getRightWidth(totalWidth: number): number;
  
  // Panel browser
  getAvailablePanels(): Panel[];
  getPanelsByCategory(): Map<string, Panel[]>;
}
```

### Compositor Changes

Current flow: `header → viewport → footer` (full width)

New flow when panels visible:
```
┌─────────────────────┬──────────────┐
│      header (full width)           │
├─────────────────────┬──────────────┤
│                     │  tab bar     │
│   conversation      │──────────────│
│   viewport          │              │
│   (left split)      │  panel       │
│                     │  content     │
│                     │              │
├─────────────────────┴──────────────┤
│      footer (full width)           │
└────────────────────────────────────┘
```

- Header and footer remain full-width
- Viewport area splits horizontally
- Vertical separator bar: `│` with optional drag handle
- Left width = `floor(viewportWidth * splitRatio)`
- Right width = `viewportWidth - leftWidth - 1` (1 for separator)

### Keybindings

| Key | Action |
|-----|--------|
| `Ctrl+\` | Toggle panel visibility |
| `Ctrl+]` | Next panel tab |
| `Ctrl+[` | Previous panel tab |
| `Ctrl+}` | Widen left (shrink panels) |
| `Ctrl+{` | Widen right (grow panels) |
| `Ctrl+P` | Open panel browser/picker |

### Panel Browser

A modal (like model-picker) that lists all available panels grouped by category. User can search by name, select to open.

---

## Panel Specifications

### 1. Agent Live Logs
- **Category:** agent
- **Data source:** AgentManager.list() + agent session JSONL files
- **Content:** Streaming output from the selected running agent
- **Features:**
  - Agent selector (if multiple running)
  - Auto-follow (scroll to bottom on new output)
  - Pause/resume scrolling
  - Filter by message type (assistant, tool, error)
- **Refresh:** On agent events (subagent:complete, subagent:error, new tool call)

### 2. Git Panel
- **Category:** development
- **Data source:** git CLI commands
- **Content:**
  - Current branch + status
  - Staged changes (green)
  - Unstaged changes (red)
  - Recent commits (last 10)
  - Inline diff preview for selected file
- **Features:**
  - Navigate files with arrow keys
  - Enter to show diff
  - Stage/unstage with keybind
- **Refresh:** On file system events or periodic (5s)

### 3. File Explorer
- **Category:** development
- **Data source:** Project directory tree
- **Content:** Collapsible tree view of project files
- **Features:**
  - Expand/collapse directories
  - File type icons
  - Gitignore-aware
  - Enter to open file preview panel
  - Search/filter files
- **Refresh:** On file system events

### 4. File Preview
- **Category:** development
- **Data source:** File system read
- **Content:** Read-only syntax-highlighted file view
- **Features:**
  - Syntax highlighting (reuse tree-sitter)
  - Line numbers
  - Scroll with arrow keys
  - Jump to line
  - Opens when file is mentioned in conversation or selected in explorer
- **Refresh:** On file change events

### 5. Diff View
- **Category:** development
- **Data source:** Agent file modifications
- **Content:** Unified diff of changes made by agents
- **Features:**
  - Color-coded: green additions, red deletions
  - File selector when multiple files changed
  - Before/after line numbers
  - Auto-opens when agent modifies files
- **Transient:** auto-closes when agent completes

### 6. Symbol Outline
- **Category:** development
- **Data source:** Tree-sitter AST
- **Content:** Functions, classes, interfaces in current file
- **Features:**
  - Collapsible class/namespace hierarchy
  - Type indicators (fn, class, interface, type)
  - Click/enter to jump to line in file preview
- **Refresh:** On file change

### 7. Plan Dashboard
- **Category:** agent
- **Data source:** ExecutionPlanManager
- **Content:** Visual plan progress
- **Features:**
  - Phase headers with status badges
  - Item list with checkboxes and agent IDs
  - Progress bar per phase
  - Dependency arrows (ASCII art)
  - Overall completion percentage
- **Refresh:** On plan state changes

### 8. Agent Inspector
- **Category:** agent
- **Data source:** AgentManager + agent session JSONL
- **Content:** Detailed view of a specific agent
- **Features:**
  - Message timeline (user → assistant → tool → result)
  - Tool call details with expandable args/results
  - Token usage per turn
  - Status indicator (running, complete, failed)
  - Agent selector dropdown
- **Refresh:** On agent events

### 9. WRFC Chain View
- **Category:** agent
- **Data source:** WrfcController chains
- **Content:** Review chain status
- **Features:**
  - Chain list with scores and states
  - Score history graph (ASCII sparkline)
  - Issue list from reviews
  - Fix attempt counter
  - Gate status indicators
- **Refresh:** On WRFC events

### 10. Provider Stats
- **Category:** monitoring
- **Data source:** Provider request metrics
- **Content:** Per-provider performance
- **Features:**
  - Latency (avg, p50, p95, p99)
  - Error rate
  - Tokens/second throughput
  - Request count
  - Uptime indicator
  - Sparkline charts for trends
- **Refresh:** After each LLM call

### 11. Token Budget
- **Category:** monitoring
- **Data source:** Orchestrator usage tracking
- **Content:** Real-time token breakdown
- **Features:**
  - Input/output/cache read/cache write bars
  - Context window fill percentage
  - Per-turn token usage
  - Cumulative session total
  - Warning threshold indicators
- **Refresh:** After each LLM call

### 12. Cost Tracker
- **Category:** monitoring
- **Data source:** Token counts + model pricing
- **Content:** Estimated costs
- **Features:**
  - Per-session cost
  - Per-agent cost breakdown
  - Per-plan cost
  - Model pricing table
  - Budget alerts
- **Refresh:** After each LLM call

### 13. Session Browser
- **Category:** session
- **Data source:** SessionManager.list()
- **Content:** Browse old sessions
- **Features:**
  - Session list with date, model, message count, name
  - Preview first/last messages
  - Resume directly from panel
  - Search across sessions
  - Delete with confirmation
- **Refresh:** On session events

### 14. Documentation Panel
- **Category:** session
- **Data source:** Model/tool definitions
- **Content:** Inline reference docs
- **Features:**
  - Tool list with parameter descriptions
  - Model capabilities and context windows
  - Keyboard shortcut reference
  - Searchable
- **Static:** No refresh needed

### 15. Thinking/Reasoning Panel
- **Category:** ai
- **Data source:** LLM streaming response (reasoning tokens)
- **Content:** Model's chain-of-thought
- **Features:**
  - Real-time streaming of thinking tokens
  - Separate from main conversation display
  - Collapsible reasoning blocks
  - Always visible during model thinking
- **Refresh:** On streaming events

### 16. Tool Call Inspector
- **Category:** ai
- **Data source:** Orchestrator tool dispatch
- **Content:** Live feed of tool calls
- **Features:**
  - Chronological list of tool calls
  - Expandable args and results
  - Duration per call
  - Filter by tool type
  - Error highlighting
  - Auto-repair indicators
- **Refresh:** On tool call events

### 17. Context Window Visualizer
- **Category:** ai
- **Data source:** Message construction pipeline
- **Content:** What the model actually sees
- **Features:**
  - Stacked bar: system prompt, tier supplement, plan injection, conversation, tools
  - Token count per section
  - Total vs limit
  - Highlights what gets compacted
  - Shows injected system messages (event replays, nudges)
- **Refresh:** Before each LLM call

---

## Execution Plan

### Phase 1: Foundation [PENDING]
Must complete before any panels can be built.

- [ ] Panel types and interface — PENDING
- [ ] Panel Manager class — PENDING
- [ ] Compositor horizontal split — PENDING (depends: Panel types)
- [ ] Keybinding integration — PENDING (depends: Panel Manager)
- [ ] Panel browser/picker modal — PENDING (depends: Panel Manager)
- [ ] Tab bar renderer — PENDING (depends: Panel Manager)

### Phase 2: Development Panels [PENDING]
Can run in parallel once foundation lands.

- [ ] Git panel — PENDING (depends: Phase 1)
- [ ] File explorer panel — PENDING (depends: Phase 1)
- [ ] File preview panel — PENDING (depends: Phase 1)
- [ ] Diff view panel — PENDING (depends: Phase 1)
- [ ] Symbol outline panel — PENDING (depends: Phase 1)

### Phase 3: Agent & Plan Panels [PENDING]
Can run in parallel with Phase 2.

- [ ] Agent live logs panel — PENDING (depends: Phase 1)
- [ ] Plan dashboard panel — PENDING (depends: Phase 1)
- [ ] Agent inspector panel — PENDING (depends: Phase 1)
- [ ] WRFC chain view panel — PENDING (depends: Phase 1)

### Phase 4: Monitoring & AI Panels [PENDING]
Can run in parallel with Phases 2-3.

- [ ] Provider stats panel — PENDING (depends: Phase 1)
- [ ] Token budget panel — PENDING (depends: Phase 1)
- [ ] Cost tracker panel — PENDING (depends: Phase 1)
- [ ] Session browser panel — PENDING (depends: Phase 1)
- [ ] Documentation panel — PENDING (depends: Phase 1)
- [ ] Thinking/reasoning panel — PENDING (depends: Phase 1)
- [ ] Tool call inspector panel — PENDING (depends: Phase 1)
- [ ] Context window visualizer panel — PENDING (depends: Phase 1)

---

## Parallel Execution Strategy (12 WRFC chains)

### Batch 1: Foundation (6 chains)
1. Panel types + interface definitions
2. Panel Manager class
3. Compositor horizontal split changes
4. Keybinding integration
5. Panel browser/picker modal
6. Tab bar renderer

### Batch 2: Panels Wave 1 (12 chains — max parallel)
Once foundation merges, all panels can build simultaneously:
1. Git panel
2. File explorer panel
3. File preview panel
4. Diff view panel
5. Symbol outline panel
6. Agent live logs panel
7. Plan dashboard panel
8. Agent inspector panel
9. WRFC chain view panel
10. Provider stats panel
11. Token budget panel
12. Cost tracker panel

### Batch 3: Panels Wave 2 (5 chains)
13. Session browser panel
14. Documentation panel
15. Thinking/reasoning panel
16. Tool call inspector panel
17. Context window visualizer panel

### Batch 4: Integration (1 chain)
- Wire all panels into main.ts
- Register default panel set
- Add /panel command
- Final integration testing
