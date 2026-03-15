# GoodVibes TUI: Enhancement Spec

> Enhancements to existing features, organized by priority and effort.
> Based on the 44 features shipped in ADDITIONS.md phases A-F.

---

## Approved Enhancements

### A1: Shared Project/Global Config System

**Priority:** High — foundational, affects all goodvibes programs

**Design:**
- TUI config: `~/.goodvibes/tui/settings.json` (global) and `.goodvibes/tui/settings.json` (project)
- Shared config: `~/.goodvibes/goodvibes.json` (cross-app settings shared by all goodvibes programs)
- Load order: defaults < global shared < global TUI < project shared < project TUI < env vars < CLI args
- On startup: read all files, merge (most specific wins), add missing keys with defaults — NEVER overwrite existing values
- On setting change: update in-memory AND write to the appropriate file immediately
- Files are append-only at startup (only add keys that don't exist yet)
- Before any write: check if directory/file exists, create if missing
- TUI-specific files (settings, history, sessions, profiles, templates) all live under `tui/` subdirectory

**File layout:**
```
~/.goodvibes/
  goodvibes.json          # shared cross-app settings
  SYSTEM.md               # base system prompt
  GOODVIBES.md            # global user extensions
  tui/
    settings.json         # TUI-specific config
    input-history.json    # prompt history
    profiles/             # config profiles
    templates/            # prompt templates
    sessions/             # saved sessions
    bookmarks/            # saved bookmarks
```

**Migration:** Current `~/.config/goodvibes/config.json` migrates to `~/.goodvibes/tui/settings.json`.

### A2: Config Profiles

**Priority:** Medium

**Design:**
- `/config profile save <name>` — saves current TUI-specific settings only
- `/config profile load <name>` — loads only TUI settings, doesn't touch other app settings
- Profiles stored in `~/.goodvibes/tui/profiles/<name>.json` or `.goodvibes/tui/profiles/<name>.json`
- Profile only contains keys under the TUI namespace — loading a profile must NOT overwrite settings belonging to other goodvibes programs

### A3: Config Diff

**Priority:** Low

- `/config diff` — shows all settings that differ from defaults

---

### B1: Thinking/Reasoning Display

**Priority:** Medium

- Show reasoning/thinking content in a dimmed collapsible block above the response
- Config key: `display.showThinking` (boolean, default: `false`)
- Only displays when the provider emits reasoning deltas (already captured via `onDelta({ reasoning })`) 
- Collapsible using existing Tab toggle infrastructure

### B2: Tokens/Sec Counter

**Priority:** Low

- Show streaming speed (tokens/sec) in the footer during streaming
- Config key: `display.showTokenSpeed` (boolean, default: `false`)
- Calculate from delta count / elapsed time since stream-start

### B3: Partial Tool Call Preview

**Priority:** Low

- Show tool name + args as they stream in, before execution starts
- Config key: `display.showToolPreview` (boolean, default: `false`)
- Uses existing tool call delta events from streaming

---

### C1: Multi-File @ References

**Priority:** High

- Allow multiple `@path` references in a single prompt: `@src/config/ @src/main.ts explain these`
- Each @ opens the file picker, selected path is inserted, user can immediately type another @
- Already partially works — verify and fix if multiple @ in one prompt don't conflict

### C2: !@ Content Injection

**Priority:** High

- `!@filepath` reads the file and injects its full contents directly into the prompt text
- Regular `@filepath` keeps current behavior (inserts path string)
- On submit, `!@` markers are expanded to file contents before sending to LLM
- Use existing file picker for !@ — just change the trigger from `@` to `!@`

### C3: Tab Completion for File Paths

**Priority:** Medium

- When typing a path-like string in the prompt (after @ or !@, or standalone), Tab offers completions
- Reuses the file picker's file list and fuzzy matching
- Different from command-mode Tab (which completes slash commands)

### C4: Undo/Redo in Prompt Editing

**Priority:** Medium

- Ctrl+Z: undo last edit operation in the prompt
- Ctrl+Shift+Z: redo
- Track edit history as a stack of (prompt, cursorPos) snapshots
- Snapshot on: text insert, delete, paste, kill (Ctrl+K), word delete (Ctrl+W)

### C5: Prompt Templates with Variables

**Priority:** High — complex system, needs careful design

**Design:**

```
/template save <name>          Save current prompt as template
/template use <name> [args]    Execute template with variable substitution
/template list                 List available templates
/template edit <name>          Edit a template
/template delete <name>        Delete a template
```

**Variable system:**
- Variables: `{{var_name}}` syntax in template text
- Variable types: text, file path, image, template reference
- Multiple variables per template
- Variables are positional or named: `/template use review-file @src/main.ts` or `/template use review-file file=@src/main.ts`
- Templates can reference other templates: `{{template:setup-context}}` chains execution
- Templates stored in `.goodvibes/tui/templates/<name>.md` or `~/.goodvibes/tui/templates/<name>.md`

**Example:**
```markdown
# review-file
Review {{file}} for:
- Bugs and logic errors
- Security issues  
- Performance concerns

Context: {{template:project-context}}
```

**Macro behavior:** A template is essentially a macro — it expands variables, chains sub-templates, and produces a final prompt that is submitted as if the user typed it.

---

### D3: Reasoning Summary Display

**Priority:** Low

- When Mercury-2 returns `reasoningSummary`, display it in a dimmed block
- Config key: `display.showReasoningSummary` (boolean, default: `false`)
- Uses existing `ChatResponse.reasoningSummary` field

---

### E1: Search Within Output

**Priority:** High

- Ctrl+F or `/search <query>` — search conversation output
- Highlights matching text, jump between matches with n/N
- Search is across the full conversation history (all rendered lines)

### E2: Clickable Links

**Priority:** Medium

- File paths rendered as OSC 8 hyperlinks (clickable in supporting terminals)
- URLs rendered as clickable hyperlinks
- Images: on click/action, open in OS default viewer (`xdg-open` on Linux, `open` on macOS)

### E3: Expand/Collapse by Component Type

**Priority:** Medium

- `/expand [type]` and `/collapse [type]`
- Types: `all`, `thinking`, `tool`, `code`, `user`, `system`
- `/collapse thinking` — collapse all thinking blocks
- `/expand all` — expand everything

### E4: Block Bookmarks

**Priority:** Medium

- Ctrl+B: bookmark the nearest block
- Ctrl+S: save current output/block to file
- `/bookmarks` — list bookmarks, jump to them
- On compaction: bookmarked blocks that are about to be compacted are saved to `.goodvibes/tui/bookmarks/{descriptive-filename}.md` — spawn background agent to generate the filename and format the content
- Bookmark display: small `🔖` indicator on bookmarked blocks

---

### F1: Named Sessions

**Priority:** High

- `/save <name>` — save current session
- `/load <name>` — load a saved session
- `/sessions` — list saved sessions with timestamps and titles
- Sessions stored in `.goodvibes/tui/sessions/<name>.jsonl`

### F2: Undo Last Message

**Priority:** High

- `/undo` — remove last user+assistant turn pair from live context
- In session file (JSONL): mark the messages with `{"removed": true}` rather than deleting
- Removed messages don't appear in conversation or go to the LLM
- `/redo` — restore the last undone turn

### F3: Token Data Per Message (for future cost tracking)

**Priority:** Low — save data now, build features later

- Each message in the session file includes: `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_write_tokens`
- No cost calculation or display yet — just data collection
- Enables retroactive cost tracking when pricing data is added later

### F7: Retry

**Priority:** Medium

- `/retry` — re-send the last user message
- `/retry <edits>` — modify and re-send
- Removes the previous response before re-sending

### F8: Notification on Completion

**Priority:** Low

- Terminal bell (`\x07`) when a long response finishes (>5s)
- Desktop notification via `notify-send` (Linux) or `osascript` (macOS) for responses >30s
- Config key: `behavior.notifyOnComplete` (boolean, default: `true`)

---

### X1: System Prompt Chain Loading

**Priority:** High — foundational

**Design:**
- Global: `~/.goodvibes/SYSTEM.md` (base system prompt, one location only)
- Global: `~/.goodvibes/GOODVIBES.md` (user-editable extensions)
- Project: `.goodvibes/GOODVIBES.md` (project-specific instructions)
- Load order: SYSTEM.md + global GOODVIBES.md + project GOODVIBES.md (concatenated)
- `@` notation in prompt files: `@path/to/file.md` includes that file's contents (chain-loading)
- Users edit GOODVIBES.md files; SYSTEM.md is the base that rarely changes

### X2: Dual Progress Bars in Footer

**Priority:** Medium

- Bar 1: Token budget (input + output tokens used / model context window)
- Bar 2: Context remaining before auto-compact threshold
- Both use the existing progress bar rendering from `src/renderer/progress.ts`

### X3: Granular Permission Settings

**Priority:** Medium

- `/permissions` — show current permission settings
- `/permissions allow-all` — allow everything always ("no-worries-just-vibes" mode)
- `/permissions tool <name> allow|prompt|deny` — per-tool settings
- Config keys: `permissions.mode` (enum: `prompt`, `allow-all`, `custom`)
- When `custom`: `permissions.tools.file_read`, `permissions.tools.shell_exec`, etc.
- Persisted to config file

---

## Deferred to Future

| Item | Reason | File |
|------|--------|------|
| D1: Auto-effort | Counterintuitive, leave manual | — |
| D2: Cost estimate | Not needed now | — |
| E5: Diff syntax in prose | Maybe later | ideas-for-future.md |
| F4: Git-aware context | Future git module | ideas-for-future.md |
| F5: /commit command | Future git module | ideas-for-future.md |
| F6: Tool result caching | Own tooling handles this | — |
| F3: Cost display | Save data now, display later | — |

---

## Execution Priority

### Batch 1: Foundation (affects everything else)
- A1: Shared config system (~/.goodvibes/tui/settings.json + ~/.goodvibes/goodvibes.json)
- X1: System prompt chain loading
- F1: Named sessions (JSONL format)

### Batch 2: Core UX
- C1: Multi-file @ references
- C2: !@ content injection
- F2: Undo last message
- F7: Retry
- E1: Search within output

### Batch 3: Input Power Features
- C3: Tab completion for paths
- C4: Undo/redo in prompt
- C5: Prompt templates with variables
- X3: Granular permissions

### Batch 4: Display & Polish
- B1: Thinking display
- D3: Reasoning summary
- E2: Clickable links
- E3: Expand/collapse by type
- E4: Block bookmarks
- X2: Dual progress bars
- A2: Config profiles

### Batch 5: Nice-to-Have
- A3: Config diff
- B2: Tokens/sec
- B3: Tool call preview
- F3: Token data collection
- F8: Notifications
