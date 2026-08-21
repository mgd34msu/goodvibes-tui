# Project planning

GoodVibes TUI owns the active project-planning loop. The SDK provides passive storage and readiness evaluation only.

## Boundary

The TUI owns:

- natural-language planning intent detection in the main terminal conversation
- the relentless planning interview loop
- one-question-at-a-time clarification
- the project planning panel
- execution approval
- agent handoff metadata and future agent assignment UX

The SDK owns:

- durable project-scoped planning artifacts in knowledge spaces named `project:<projectId>`
- readiness evaluation and next-question hints
- project-language records
- decision records
- task, dependency, verification, and agent-assignment metadata
- passive daemon routes and operator methods

Daemon, web, webhook, ntfy, Home Assistant, Slack, Discord, and companion surfaces do not enter planning loops. They can use the SDK routes as storage/evaluation APIs, but conversation control stays in the TUI.

## TUI behavior

The TUI derives a stable `projectId` from the workspace path and passes it to the SDK `ProjectPlanningService`. Planning artifacts are stored under the matching `project:<projectId>` knowledge space, so unrelated workspaces do not share planning state.

Normal conversation can start planning when the user uses planning language such as implementation plan, execution strategy, dependency graph, verification gates, or agent handoff. The TUI then:

- opens the `Planning` panel
- persists the current planning state through the SDK
- records active open questions and user answers
- calls SDK readiness evaluation for gaps and the suggested next question
- injects a planning-only system instruction for that turn so the assistant asks one focused question instead of executing

The planning loop can be paused with natural language such as "stop planning" or "pause planning".

## Planning panel

Open the panel through the panel picker or with `/plan panel`.

The panel shows:

- workspace project id and knowledge space, and live SDK artifact counts (states/decisions/language) from the planning status route
- readiness and approval state
- goal, scope, known context, and current next question
- blocking/advisory readiness gaps
- task graph and verification gates
- agent handoff candidates
- answered questions (prompt + recorded answer, most recent first)
- durable decisions
- project language and ambiguity resolutions

Panel keys:

- `r` refreshes SDK-backed planning artifacts.
- `a` marks the current structurally ready plan as approved for execution.
- `Ctrl+R` / `Ctrl+A` are alternate bindings for refresh/approve that stay reachable while a question is active. Plain `r`/`a` type into the draft answer in that mode instead.
- Up/Down chooses available answer actions when a question is active, or scrolls panel content when there is no active answer list.
- Type while the panel is focused to draft a custom answer.
- `Enter` submits the selected or drafted answer through the normal planning chat path.
- The answer list includes a dismiss action that pauses planning for the workspace and returns focus to normal chat.
- Keyword-matched canned answer suggestions (scope/task/verification/recommended) are de-duplicated by answer text, so a question that matches more than one category never shows the same suggested answer twice.

## `/plan`

`/plan` is retained as a command surface for inspection and seeding, but it is no longer the primary planning UX.

- `/plan` prints current project-planning readiness and opens the panel.
- `/plan panel` opens the panel.
- `/plan approve` records explicit execution approval.
- `/plan <goal>` seeds project planning state.
- `/plan list` and `/plan show <id>` still inspect older execution-plan records.
- `/plan mode|explain|override|status|clear` still route to the adaptive runtime controls.

Use natural language such as "stop planning" or the panel dismiss action when the TUI has entered planning but the current work should continue as normal chat.

## Work Plan

GoodVibes also has a lightweight persistent work-plan tracker for concrete implementation tasks. It is separate from the planning interview state and is intended for visible, durable checklists while work is in progress.

Commands:

- `/work-plan` or `/work-plan panel`
- `/work-plan add <title> [--owner name] [--source label] [--notes text]`
- `/work-plan list`
- `/work-plan done|start|block|fail|cancel|pending <id>`
- `/work-plan remove <id>`
- `/work-plan clear-done`

The TUI stores work-plan state under `~/.goodvibes/tui/work-plans/` and renders it in the `Work Plan` panel.

Panel keys:

- Up/Down navigates items; `Enter`/`Space` cycles status; `1`-`6` set status directly (pending/active/blocked/done/failed/cancelled).
- `a` opens an inline add form (title/owner/notes fields); `e` opens the same form pre-filled to edit the selected item. `Tab` cycles fields, `Enter` saves, `Esc` cancels.
- `d`/`Delete` removes the selected item; `c` clears completed (done/cancelled) items; `r` refreshes from disk.
- `x` exports the current plan to a Markdown file next to the JSON store (`<store-file>.md`) using the same rendering `/work-plan list` and `toMarkdown()` share.
- When the selected item has linked ids (`item.linked`: `agentId`/`wrfcId`/`taskId`/`sessionId`), the detail block shows them with their jump key: `i` opens the Inspector on the linked agent, `w` opens the WRFC panel on the linked chain.

## SDK routes and operator methods

The TUI does not need to call daemon routes for its own local planning loop, but the updated SDK exposes passive routes and methods:

- `GET /api/projects/planning/status`
- `GET|POST /api/projects/planning/state`
- `POST /api/projects/planning/evaluate`
- `GET|POST /api/projects/planning/decisions`
- `GET|POST /api/projects/planning/language`
- `projectPlanning.status`
- `projectPlanning.state.get`
- `projectPlanning.state.upsert`
- `projectPlanning.evaluate`
- `projectPlanning.decisions.list`
- `projectPlanning.decisions.record`
- `projectPlanning.language.get`
- `projectPlanning.language.upsert`
