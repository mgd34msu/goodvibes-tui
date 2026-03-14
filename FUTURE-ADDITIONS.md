# GoodVibes TUI: Future Module Candidates

> Modules that extend the base TUI substrate with specialized capabilities.
> These are NOT part of the base additions -- they build on top of the completed base.

---

## @goodvibes/git

**Purpose:** Deep git integration for the coding agent workflow. Commit assistance, diff review, PR creation, branch management.

**Key Features:**
- `git-status` tool: structured git status as tool output (not raw text)
- `git-diff` tool: semantic diff with file grouping and change classification
- `git-commit` tool: AI-assisted commit message generation from staged changes
- `git-branch` tool: branch creation, switching, listing with context awareness
- PR creation: generate PR title and description from commit history
- Conflict resolution: detect merge conflicts, offer resolution suggestions
- Auto-stage: suggest files to stage based on conversation context

**Integration Points:**
- Registers as tool provider in the tool registry (`src/tools/registry.ts`)
- Uses permission system for destructive operations (commit, push, force-push)
- Diff output renders via the existing diff-view renderer (`src/renderer/diff-view.ts`)
- Commit messages use the active LLM provider for generation

**Slash Commands:**
- `/git status` -- show structured status
- `/git diff [file]` -- show diff in the conversation
- `/git commit [message]` -- commit with AI-generated or provided message
- `/git branch [name]` -- branch operations

**Dependencies:**
- Base tool system (complete)
- Permission model (complete)
- Diff renderer (complete)
- `@goodvibes/project` (optional -- for detecting repo root)

---

## @goodvibes/project

**Purpose:** Project detection, build system integration, and workspace awareness. Makes the agent understand what kind of project it's working in.

**Key Features:**
- Project type detection: Node.js, Python, Rust, Go, etc. via marker files
- Build system detection: npm/yarn/pnpm/bun, pip/poetry, cargo, go modules
- Package manager commands: `build`, `test`, `lint`, `format` mapped to detected system
- Workspace/monorepo detection: detect workspaces, list packages
- File significance: classify files (source, test, config, generated, vendor)
- Project summary: generate a structured overview for the system prompt

**Integration Points:**
- Provides context to the system prompt (enriches the agent's understanding)
- Registers project-aware tools: `project-build`, `project-test`, `project-lint`
- Feeds into `@goodvibes/git` for smart staging recommendations
- Informs the file picker (`src/input/file-picker.ts`) with project-aware filtering

**Slash Commands:**
- `/project` -- show detected project info
- `/build` -- run the detected build command
- `/test [pattern]` -- run tests with optional filter
- `/lint [--fix]` -- run linter

**Dependencies:**
- Base tool system (complete)
- Shell exec tool (complete)
- Config system (Phase A -- for project-specific overrides)

---

## @goodvibes/mcp

**Purpose:** Model Context Protocol server discovery and tool registration. Connect to external MCP servers and make their tools available to the agent.

**Key Features:**
- MCP server discovery: scan for `mcp.json` config files, environment variables
- Server lifecycle: start, stop, restart MCP server processes
- Tool registration: enumerate MCP server tools and register them in the tool registry
- Resource access: MCP resources surfaced as context for the agent
- Prompt templates: MCP prompts available as slash commands
- Transport support: stdio (primary), HTTP/SSE (secondary)

**Integration Points:**
- Dynamically registers tools in `src/tools/registry.ts` at runtime
- Permission system gates all MCP tool calls (category: 'external')
- MCP tool results rendered via the existing tool-call renderer
- Server processes managed alongside ACP subagents (`src/acp/manager.ts`)
- Config: MCP server definitions stored in config system

**Slash Commands:**
- `/mcp` -- list connected MCP servers and their tools
- `/mcp connect <server>` -- connect to an MCP server
- `/mcp disconnect <server>` -- disconnect
- `/mcp restart <server>` -- restart a server

**Dependencies:**
- Base tool system (complete)
- Permission model (complete)
- Config system (Phase A -- for server definitions)
- ACP infrastructure (complete -- similar process management)

---

## @goodvibes/agents

**Purpose:** Multi-agent orchestration via ACP. Spawn specialized agents, coordinate work, manage parallel tasks.

**Key Features:**
- Agent templates: pre-defined agent configurations (researcher, coder, reviewer)
- Parallel task decomposition: split complex tasks across multiple agents
- Agent communication: structured message passing between agents
- Task queue: manage pending, running, and completed agent tasks
- Result aggregation: combine outputs from multiple agents
- Agent monitoring: real-time status display for running agents

**Integration Points:**
- Extends the existing ACP system (`src/acp/`) with higher-level orchestration
- Agent status rendered in a dedicated panel or section of the conversation
- Uses the event bus for agent lifecycle events (already has subagent events)
- Config: default agent configurations, max concurrent agents

**Slash Commands:**
- `/agents` -- list running agents and their status
- `/spawn <template> <task>` -- spawn an agent from a template
- `/kill <agent-id>` -- terminate a running agent
- `/agents config` -- configure agent defaults

**Dependencies:**
- ACP system (complete)
- Event bus (complete)
- Config system (Phase A)
- `@goodvibes/project` (optional -- for project-aware agent tasks)

---

## @goodvibes/web

**Purpose:** Web search, URL fetching, and documentation lookup. Give the agent access to external information.

**Key Features:**
- Web search: search via configurable backend (DuckDuckGo, Google, Brave)
- URL fetch: retrieve and extract content from URLs (markdown conversion)
- Documentation lookup: search package docs (npm, PyPI, crates.io, pkg.go.dev)
- Link preview: show title, description, and key content from URLs
- Cache: local cache for fetched URLs to avoid repeated requests
- Rate limiting: respect rate limits and robots.txt

**Integration Points:**
- Registers as tool provider: `web-search`, `url-fetch`, `docs-lookup`
- Results rendered as markdown in the conversation
- Permission system gates web access (category: 'network')
- Config: search backend selection, cache settings, proxy

**Slash Commands:**
- `/search <query>` -- search the web
- `/fetch <url>` -- fetch and display URL content
- `/docs <package>` -- look up package documentation

**Dependencies:**
- Base tool system (complete)
- Permission model (complete)
- Config system (Phase A)
- Markdown renderer (complete)

---

## @goodvibes/notebook

**Purpose:** Code execution cells and REPL functionality. Run code snippets inline and display results.

**Key Features:**
- Code cells: execute code blocks in the conversation (like Jupyter cells)
- Language support: JavaScript/TypeScript (Bun), Python, shell
- Output capture: stdout, stderr, return values, images
- State persistence: REPL state persists across cells within a session
- Cell history: re-run, edit, and reference previous cells
- Variable inspector: show current REPL state variables

**Integration Points:**
- Registers as tool: `code-exec` with language parameter
- Output rendered inline in the conversation (text, tables, images)
- Permission system gates code execution (category: 'execute')
- Uses existing shell-exec infrastructure for subprocess management
- Config: default language, timeout, max output size

**Slash Commands:**
- `/run <code>` -- execute inline code
- `/repl [language]` -- enter REPL mode
- `/cells` -- list executed cells
- `/vars` -- show REPL state

**Dependencies:**
- Base tool system (complete)
- Shell exec tool (complete)
- Permission model (complete)
- Config system (Phase A)

---

## @goodvibes/voice

**Purpose:** Speech-to-text and text-to-speech for hands-free agent interaction.

**Key Features:**
- Speech-to-text: microphone input transcribed to text via Whisper API or local model
- Text-to-speech: assistant responses spoken aloud via TTS API or local model
- Voice activation: push-to-talk or voice activity detection
- Transcription display: show real-time transcription in the input area
- Audio feedback: sound effects for events (turn start, tool complete, error)

**Integration Points:**
- Input handler extended with audio capture mode
- TTS output runs alongside text rendering
- Config: input device, output device, TTS voice, STT model, activation mode
- Event bus: new events for voice state (recording, transcribing, speaking)

**Slash Commands:**
- `/voice on|off` -- toggle voice mode
- `/voice input` -- toggle speech-to-text only
- `/voice output` -- toggle text-to-speech only
- `/say <text>` -- speak text aloud

**Dependencies:**
- Config system (Phase A)
- Input system (complete)
- Event bus (complete)
- External: audio libraries (portaudio bindings or Web Audio via Bun)

---

## @goodvibes/themes

**Purpose:** Color schemes, layout customization, and visual configuration.

**Key Features:**
- Theme definitions: named color schemes with semantic color roles
- Built-in themes: vaporwave (default), monokai, solarized, dracula, catppuccin, nord
- Custom themes: user-defined themes in `~/.config/goodvibes/themes/`
- Layout modes: compact, comfortable, spacious (line spacing and padding)
- Accent customization: override individual colors without a full theme
- Live preview: theme changes apply immediately

**Theme Schema:**
```typescript
export interface Theme {
  name: string;
  colors: {
    primary: string;      // Main accent color
    secondary: string;    // Secondary accent
    background: string;   // Terminal background hint
    text: string;         // Default text
    dimmed: string;       // Muted text
    error: string;        // Error messages
    warning: string;      // Warnings
    success: string;      // Success indicators
    info: string;         // Informational
    border: string;       // Box borders
    highlight: string;    // Selection/highlight
    code: {
      keyword: string;
      string: string;
      comment: string;
      function: string;
      number: string;
      operator: string;
    };
  };
  spacing: {
    blockGap: number;     // Lines between blocks
    indent: number;       // Indentation width
    gutterWidth: number;  // Line number gutter
  };
}
```

**Integration Points:**
- Config key: `display.theme` (already in Phase A spec)
- All renderers (`src/renderer/*.ts`) read colors from active theme
- Code block renderer uses theme's code color scheme
- Compositor uses theme spacing for layout

**Slash Commands:**
- `/theme [name]` -- switch theme or list available themes
- `/theme preview <name>` -- preview a theme without applying
- `/theme create <name>` -- create a new theme from current settings

**Dependencies:**
- Config system (Phase A)
- Renderer pipeline (complete)
- All base rendering features should be stable before theming

---

## Module Priority Ranking

| Priority | Module | Rationale |
|---|---|---|
| 1 | `@goodvibes/git` | Core coding agent workflow -- most requested, highest impact |
| 2 | `@goodvibes/project` | Context awareness dramatically improves agent quality |
| 3 | `@goodvibes/mcp` | Ecosystem integration -- connects to the broader tool landscape |
| 4 | `@goodvibes/themes` | Visual customization -- high user satisfaction, relatively simple |
| 5 | `@goodvibes/agents` | Advanced orchestration -- powerful but needs stable base first |
| 6 | `@goodvibes/web` | Information access -- useful but many alternatives exist |
| 7 | `@goodvibes/notebook` | Code execution -- niche use case, complex sandboxing |
| 8 | `@goodvibes/voice` | Accessibility/convenience -- requires audio stack, most complex |

---

## Module Dependency Graph

```
Base TUI (complete + Phase A-F)
    │
    ├── @goodvibes/git ──────────── standalone (optional: @goodvibes/project)
    │
    ├── @goodvibes/project ──────── standalone
    │       │
    │       └── informs: @goodvibes/git, @goodvibes/agents
    │
    ├── @goodvibes/mcp ──────────── standalone
    │
    ├── @goodvibes/themes ───────── standalone (after base renderers stable)
    │
    ├── @goodvibes/agents ───────── extends: ACP system
    │       │                       optional: @goodvibes/project
    │       └── depends on: stable base orchestrator
    │
    ├── @goodvibes/web ──────────── standalone
    │
    ├── @goodvibes/notebook ─────── standalone
    │
    └── @goodvibes/voice ────────── standalone (external audio deps)
```

All modules depend on the completed base (Phases A-F). No module depends on another module as a hard requirement -- dependencies between modules are optional enhancements.
