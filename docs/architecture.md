# Architecture

How the `goodvibes-tui` source is laid out, which directions imports may go, and the one place the TUI keeps the SDK's pane-era operator vocabulary.

## Source layout

| Directory | Holds |
| --- | --- |
| `src/main.ts`, `src/core/` | Terminal entrypoint, orchestrator, conversation and transcript state |
| `src/renderer/` | Raw ANSI compositor, overlays, modals, fullscreen workspaces, the modal kit (`surface-kit*.ts`) |
| `src/views/` | View content shown in modals: modal surfaces (`src/views/modals/`), the fleet read model and acts behind the Agents modal, the notification history feed, view drawing helpers (`polish*.ts`), and the operator API bridge (`view-panel-adapter.ts`) |
| `src/input/` | Slash commands, keybindings, composer, pickers, settings modals |
| `src/runtime/` | Bootstrap wiring, the typed runtime store, service composition, session recovery |
| `src/shell/` | Shell-level modal openers, blocking input, retry affordances |
| `src/test/` | The suite, mirroring the tree above (`src/test/views/` for `src/views/`) |

Every view opens as a modal over the conversation. There is no side-by-side layout and no persisted layout state: the runtime store has no slot for one, and a session saved by an older TUI that recorded one (`returnContext.openPanels` and an "Open panels: ..." line) loads without it. The SDK's session loader drops that legacy field, and every TUI save path writes the session back without it.

## Layer rules

`bun run architecture:check` (`scripts/check-architecture.ts`) enforces these import directions over `src/`. The layer of a file is its top-level directory under `src/`.

| Layer | Directories |
| --- | --- |
| 0 foundation | `config`, `providers`, `utils`, `permissions`, `tools`, `mcp`, `audio`, `export`, `verification`, `widget`, `scripts`, and the other leaf directories |
| 1 domain | `core` |
| 2 runtime | `runtime` (bootstrap files are composition roots and may import the UI layer) |
| 3 shell UI | `input`, `renderer`, `views` (they may import each other) |
| 4 entrypoint | `cli`, `daemon` |

Forbidden directions:

- `renderer`, `input` and `views` must not import `cli` or `daemon`.
- `config` and `providers` must not import `renderer`, `input`, `views`, `cli` or `daemon`.
- `channels` must not import `renderer`, `input` or `views`.
- `audio` must not import `renderer`, `input`, `views` or `cli`.
- `daemon` must not import `renderer`, `input` or `views`.

The same check also runs import-cycle detection, the source-file size gate, the raw hex color ratchet over `src/views/` and `src/renderer/`, the selected-index rule over `src/views/`, and the unused-export gate.

## The operator API bridge

The SDK's `IntegrationHelperService` serves the operator API verbs `panels.list` and `panels.open` (and their HTTP routes) from its `panelManager` option, typed `PanelManagerLike`. Remote clients, the web UI and the daemon already use those names, so they are an SDK and wire contract, not a TUI design choice, and the TUI does not rename them.

`src/views/view-panel-adapter.ts` (`createViewPanelAdapter`, wired in `src/runtime/services.ts`) is the only TUI module that implements that contract and the only place its vocabulary is kept:

- `panels.list` returns the views a remote client can open: Agents, Usage, Changes, Notifications and Sessions.
- `panels.open` opens the named view as its modal, through the opener the shell sets once the modal host exists.
- The contract's top and bottom lists of open items are always empty, because nothing is ever open outside a modal.

Other SDK names that belong to the same contract family and stay as they are: the notification router target `panel_only` (it now feeds the notification history), `Notification.panelId`, the notification action type `jump_to_panel`, and the daemon capability string `panels`.

The `/panel` slash command (`src/input/commands/legacy-panel-command.ts`) is a separate, deliberate alias: it takes the old view names people still type and opens the modal that holds that content now.
