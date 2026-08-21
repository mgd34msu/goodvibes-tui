# Project planning

GoodVibes TUI owns the active project-planning loop. The SDK provides passive storage and readiness evaluation only.

## Boundary

Responsibility is split cleanly between the two layers:

| Responsibility | Owner |
| --- | --- |
| Natural-language planning intent detection in the main terminal conversation | TUI |
| The planning interview loop and one-question-at-a-time clarification | TUI |
| The project planning panel | TUI |
| Execution approval | TUI |
| Agent handoff metadata and future agent assignment UX | TUI |
| Durable project-scoped planning artifacts in knowledge spaces named `project:<projectId>` | SDK |
| Readiness evaluation and next-question hints | SDK |
| Project-language and decision records | SDK |
| Task, dependency, verification, and agent-assignment metadata | SDK |
| Passive daemon routes and operator methods | SDK |

Daemon, web, webhook, ntfy, Home Assistant, Slack, Discord, and companion surfaces do not enter planning loops. They can use the SDK routes as storage/evaluation APIs, but conversation control stays in the TUI.

## TUI behavior

The TUI derives a stable `projectId` from the workspace path and passes it to the SDK `ProjectPlanningService`. Planning artifacts are stored under the matching `project:<projectId>` knowledge space, so unrelated workspaces do not share planning state.

Normal conversation can start planning when the user uses planning language such as implementation plan, execution strategy, dependency graph, verification gates, or agent handoff. The TUI then opens the `Planning` panel and persists the current planning state through the SDK, recording active open questions and user answers as they accumulate. It calls SDK readiness evaluation to find gaps and the suggested next question, and injects a planning-only system instruction for that turn so the assistant asks one focused question instead of executing.

The planning loop can be paused with natural language such as "stop planning" or "pause planning".

## Planning panel

Open the panel through the panel picker or with `/project-plan panel`.

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

The panel's keys:

| Key | Action |
| --- | --- |
| `r` | Refresh SDK-backed planning artifacts |
| `a` | Mark the current structurally ready plan as approved for execution |
| `Ctrl+R` / `Ctrl+A` | Alternate refresh/approve bindings that stay reachable while a question is active; plain `r`/`a` type into the draft answer in that mode instead |
| Up/Down | Choose answer actions when a question is active, or scroll panel content otherwise |
| Any typing | Draft a custom answer while the panel is focused |
| `Enter` | Submit the selected or drafted answer through the normal planning chat path |

The answer list includes a dismiss action that pauses planning for the workspace and returns focus to normal chat. Keyword-matched canned answer suggestions (scope/task/verification/recommended) are de-duplicated by answer text, so a question that matches more than one category never shows the same suggested answer twice.

## `/project-plan`

`/project-plan` (alias `/planning`) is the command surface for inspection and seeding, but it is no longer the primary planning UX; natural conversation is.

| Command | Does |
| --- | --- |
| `/project-plan` | Print current project-planning readiness and open the panel |
| `/project-plan panel` | Open the panel |
| `/project-plan approve` | Record explicit execution approval |
| `/project-plan dismiss` | Archive the active plan and mark the interview inactive so the next `/project-plan <goal>` starts fresh; refused while a plan is mid-execution (run `/workstream cancel` first) |
| `/project-plan answer <question-number\|question-id> <text>` | Record an answer to an open planning question outside the panel |
| `/project-plan <goal>` | Seed project planning state |
| `/project-plan list` and `/project-plan show <id>` | Inspect older execution-plan records |
| `/project-plan mode\|explain\|override\|status\|clear` | Route to the adaptive runtime controls |

Use natural language such as "stop planning" or the panel dismiss action when the TUI has entered planning but the current work should continue as normal chat.

`/project-plan` is unrelated to the plain `/plan` command, which only toggles the session's read-only permission plan mode (writes, commands, and network calls blocked until you exit). `/plan` never touches project-planning state; `Shift+Tab` cycles the same permission mode.

## Work Plan

GoodVibes also has a lightweight persistent work-plan tracker for concrete implementation tasks. It is separate from the planning interview state and is intended for visible, durable checklists while work is in progress.

The command surface (aliases `/wp`, `/todo`, `/workplan`):

| Command | Does |
| --- | --- |
| `/work-plan` or `/work-plan panel` | Open the Work Plan panel |
| `/work-plan add <title> [--owner name] [--source label] [--notes text]` | Add an item |
| `/work-plan edit <id> [<new title>] [--owner name] [--source label] [--notes text]` | Edit an item's title or fields |
| `/work-plan list` | Print the plan as a list |
| `/work-plan show` (alias `markdown`) | Print the plan rendered as Markdown |
| `/work-plan export` | Write that same Markdown rendering to a file next to the JSON store |
| `/work-plan done\|start\|block\|fail\|cancel\|pending <id>` | Set an item's status directly |
| `/work-plan cycle <id>` (alias `toggle`) | Advance the item to its next status |
| `/work-plan remove <id>` | Remove an item |
| `/work-plan clear-done` | Clear completed (done/cancelled) items |

The TUI stores work-plan state under `~/.goodvibes/tui/work-plans/<projectId>.json` and renders it in the `Work Plan` panel. Terminal items (done or cancelled) age out automatically once they pass a time and count bound; open, in-progress, blocked, and failed items are never reclaimed. Anything a sweep removes is recorded on the plan as a housekeeping note rather than deleted silently, and a plan file that is unreadable (for example torn by a crash) is quarantined alongside the original rather than overwritten, so the list can still be recovered by hand.

The panel's keys:

| Key | Action |
| --- | --- |
| Up/Down | Navigate items |
| `Enter` / `Space` | Cycle the selected item's status |
| `1`-`6` | Set status directly (pending/active/blocked/done/failed/cancelled) |
| `a` | Open an inline add form (title/owner/notes fields) |
| `e` | Open the same form pre-filled to edit the selected item |
| `Tab` / `Enter` / `Esc` | In the form: cycle fields, save, cancel |
| `d` / `Delete` | Remove the selected item |
| `c` | Clear completed (done/cancelled) items |
| `r` | Refresh from disk |
| `x` | Export to a Markdown file next to the JSON store (`<store-file>.md`), the same rendering `/work-plan show` prints |
| `i` / `w` | On an item with linked ids, open the Inspector on the linked agent or the WRFC panel on the linked chain |

When the selected item has linked ids (`item.linked` holds any of `agentId`, `wrfcId`, `taskId`, `sessionId`), the detail block shows them with their jump key.

## SDK routes and operator methods

The TUI does not need to call daemon routes for its own local planning loop, but the updated SDK exposes passive routes, each with a matching operator method:

| Route | Operator method(s) | Purpose |
| --- | --- | --- |
| `GET /api/projects/planning/status` | `projectPlanning.status` | Read planning readiness and artifact counts |
| `GET\|POST /api/projects/planning/state` | `projectPlanning.state.get` / `projectPlanning.state.upsert` | Read or write the planning state artifact |
| `POST /api/projects/planning/evaluate` | `projectPlanning.evaluate` | Run readiness evaluation |
| `GET\|POST /api/projects/planning/decisions` | `projectPlanning.decisions.list` / `projectPlanning.decisions.record` | List or record durable decisions |
| `GET\|POST /api/projects/planning/language` | `projectPlanning.language.get` / `projectPlanning.language.upsert` | Read or write project-language records |

A separate set of routes covers the task graph shown in the panel:

| Route | Operator method |
| --- | --- |
| `GET /api/projects/planning/work-plan` | `projectPlanning.workPlan.snapshot` |
| `GET /api/projects/planning/work-plan/tasks` | `projectPlanning.workPlan.tasks.list` |
| `GET /api/projects/planning/work-plan/tasks/{taskId}` | `projectPlanning.workPlan.task.get` |
| `POST /api/projects/planning/work-plan/tasks` | `projectPlanning.workPlan.task.create` |
| `PATCH /api/projects/planning/work-plan/tasks/{taskId}` | `projectPlanning.workPlan.task.update` |
| `POST /api/projects/planning/work-plan/tasks/{taskId}/status` | `projectPlanning.workPlan.task.status` |
| `POST /api/projects/planning/work-plan/tasks/reorder` | `projectPlanning.workPlan.tasks.reorder` |
| `DELETE /api/projects/planning/work-plan/tasks/{taskId}` | `projectPlanning.workPlan.task.delete` |
| `POST /api/projects/planning/work-plan/clear-completed` | `projectPlanning.workPlan.clearCompleted` |
