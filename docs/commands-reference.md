<!-- GENERATED FILE — DO NOT EDIT BY HAND.
     Regenerate with `bun run docs:commands`.
     Source of truth: the slash-command registry (src/input/commands.ts).
     A drift check (src/test/release-gates/command-reference-gate.test.ts)
     fails CI if this file is stale. -->

# Command Reference

GoodVibes ships **144** built-in slash commands across **69** categories. Every command below is generated directly from the command registry, so this list is always complete and current. Type a command in the composer prefixed with `/`, or press `Ctrl+K` (or run `/palette`) to search them all in the command palette.

## Categories

- [Branches](#branches) — 3
- [Channels](#channels) — 1
- [Check-in](#check-in) — 1
- [Checkpoints](#checkpoints) — 3
- [CI](#ci) — 1
- [Cloudflare](#cloudflare) — 1
- [Codebase](#codebase) — 1
- [Configuration](#configuration) — 1
- [Control Room](#control-room) — 5
- [Conversation](#conversation) — 1
- [Cost](#cost) — 1
- [Diff & Review](#diff-review) — 2
- [Discovery](#discovery) — 1
- [Editor](#editor) — 1
- [Eval](#eval) — 1
- [Experience](#experience) — 8
- [Feature Flags](#feature-flags) — 1
- [Git](#git) — 1
- [Guidance](#guidance) — 2
- [Health](#health) — 1
- [Hooks](#hooks) — 1
- [Image](#image) — 1
- [Incidents](#incidents) — 1
- [Intelligence](#intelligence) — 1
- [Knowledge](#knowledge) — 1
- [Local Auth](#local-auth) — 1
- [Local Providers](#local-providers) — 1
- [Local Runtime](#local-runtime) — 10
- [Local Setup](#local-setup) — 1
- [Managed Runtime](#managed-runtime) — 1
- [Marketplace](#marketplace) — 1
- [MCP](#mcp) — 1
- [Memory](#memory) — 5
- [Notifications](#notifications) — 1
- [Onboarding](#onboarding) — 1
- [Operator](#operator) — 10
- [Permissions](#permissions) — 1
- [Planning](#planning) — 2
- [Platform](#platform) — 1
- [Platform Access](#platform-access) — 5
- [Platform Services](#platform-services) — 3
- [Plugins](#plugins) — 1
- [Policy](#policy) — 1
- [Principals](#principals) — 1
- [Product](#product) — 3
- [Profiles](#profiles) — 1
- [Provider Accounts](#provider-accounts) — 1
- [Providers](#providers) — 1
- [QR Codes](#qr-codes) — 1
- [Relay](#relay) — 1
- [Remote](#remote) — 2
- [Scheduling](#scheduling) — 1
- [Secrets](#secrets) — 1
- [Services](#services) — 1
- [Session Content](#session-content) — 10
- [Sessions & Replay](#sessions-replay) — 3
- [Settings Sync](#settings-sync) — 1
- [Sharing](#sharing) — 1
- [Shell & Session](#shell-session) — 16
- [Skills](#skills) — 1
- [Subscriptions](#subscriptions) — 1
- [Tasks](#tasks) — 1
- [Teamwork](#teamwork) — 1
- [Testing](#testing) — 1
- [Voice & TTS](#voice-tts) — 1
- [Web Search](#web-search) — 1
- [Work Plans](#work-plans) — 1
- [Workstreams](#workstreams) — 1
- [Worktrees](#worktrees) — 1

## Branches

| Command | Aliases | Usage | Description |
| --- | --- | --- | --- |
| `/branch` | `/br` | `[name]` | List conversation branches or switch to one |
| `/fork` | `/branch-save` | `[name]` | Save a named snapshot of the current conversation |
| `/merge` | — | `<name>` | Append messages from a branch after the fork point |

## Channels

| Command | Aliases | Usage | Description |
| --- | --- | --- | --- |
| `/channel` | `/channels` | `[pair [surface]\|status\|routes\|delivery\|policy\|profiles [list\|get\|set\|delete]] [--json]` | Pair channels and inspect routes, delivery strategies, ingress policies, and per-channel profile bindings |

## Check-in

| Command | Aliases | Usage | Description |
| --- | --- | --- | --- |
| `/checkin` | — | `[run]` | Proactive check-in: view config + recent receipts, or trigger one now |

## Checkpoints

| Command | Aliases | Usage | Description |
| --- | --- | --- | --- |
| `/checkpoint` | — | `[label]` | Create a manual workspace checkpoint (forensic retention) |
| `/checkpoints` | `/ckpts` | — | List workspace checkpoints, newest first |
| `/rewind` | — | `[<n\|turnId> [files\|conversation\|both]]` | Rewind files, conversation, or both to a completed turn (preview + confirm) |

## CI

| Command | Aliases | Usage | Description |
| --- | --- | --- | --- |
| `/ci` | — | `status <repo-or-pr> \| watch <repo-or-pr> <deliveryChannel> [--fix-session] \| watches \| unwatch <id>` | CI-watch: one-shot per-job status and standing watches over the operator surface |

## Cloudflare

| Command | Aliases | Usage | Description |
| --- | --- | --- | --- |
| `/cloudflare` | `/cf` | `[status\|setup\|requirements\|create-token\|discover\|validate\|provision\|verify\|disable] [flags]` | Inspect and manage optional Cloudflare batch/control-plane integration through daemon SDK routes |

## Codebase

| Command | Aliases | Usage | Description |
| --- | --- | --- | --- |
| `/codebase` | — | `build \| status \| search <query...> [--limit n]` | Repo source-tree code index — build, inspect, and search |

## Configuration

| Command | Aliases | Usage | Description |
| --- | --- | --- | --- |
| `/config` | `/cfg` | `[category\|key] \| set <key> <value>` | Open the fullscreen configuration workspace, or set a key directly |

## Control Room

| Command | Aliases | Usage | Description |
| --- | --- | --- | --- |
| `/cockpit` | — | — | Open the unified operator cockpit |
| `/communication` | `/comms` | — | Inspect structured agent communication routes and recent activity |
| `/orchestration` | `/orch` | `[show [graphId] \| cancel graph <graphId> \| cancel subtree <agentId>]` | Inspect orchestration graphs and cancel active graphs or subtrees |
| `/project-memory` | `/pmem` | `[open \| queue [limit] \| explain <task...> [--scope <path> ...]]` | Inspect durable project memory: risks, runbooks, and architecture notes |
| `/security` | — | `[review \| attack-paths \| tokens]` | Inspect security posture, attack paths, and review state |

## Conversation

| Command | Aliases | Usage | Description |
| --- | --- | --- | --- |
| `/conversation` | `/transcript`, `/composer` | `[review\|events [kind]\|groups [kind]\|hotspots\|composer\|find <query> [kind]\|next [kind]\|prev [kind]\|restore]` | Review conversation structure, transcript hotspots, and composer posture |

## Cost

| Command | Aliases | Usage | Description |
| --- | --- | --- | --- |
| `/cost` | — | `[panel\|budget <usd>\|attribution [24h\|7d] [--json]]` | Inspect session/agent cost tracking, windowed cost attribution, and the budget alert threshold |

## Diff & Review

| Command | Aliases | Usage | Description |
| --- | --- | --- | --- |
| `/diff` | `/d` | `[session\|head\|working\|staged\|<git-ref>]` | Show unified diff of session file changes. Uses git diff HEAD if in a git repo |
| `/review` | — | — | Review this session's diff hunk-by-hunk, steer comments, or revert a hunk |

## Discovery

| Command | Aliases | Usage | Description |
| --- | --- | --- | --- |
| `/scan` | — | — | Scan localhost and LAN for local LLM servers |

## Editor

| Command | Aliases | Usage | Description |
| --- | --- | --- | --- |
| `/editor` | `/ed` | — | Edit the current composer draft in your $EDITOR, then resume with the result |

## Eval

| Command | Aliases | Usage | Description |
| --- | --- | --- | --- |
| `/eval` | — | `<subcommand> [args]` | Evaluation harness: run benchmark suites, compare baselines, and gate regressions |

## Experience

| Command | Aliases | Usage | Description |
| --- | --- | --- | --- |
| `/approval` | `/approvals` | `[matrix\|review <kind>]` | Review action-specific approval classes and the specialized security UX matrix |
| `/bootstrap` | — | `[export <path>\|inspect <path>]` | Dedicated front-door for remote bootstrap bundle export and inspection |
| `/memory-review` | `/knowledge-review` | `[queue [limit]\|explain <task...> [--scope <path> ...]]` | Dedicated front-door for knowledge review queues and task-specific memory injection explanations |
| `/remote-env` | — | `[review\|export <path>]` | Dedicated front-door for remote environment snippets and portable env exports |
| `/remote-setup` | — | `[review\|export <path>]` | Dedicated front-door for remote setup review and portable setup bundles |
| `/runner-pool` | `/pool` | `[list\|show <id>\|create <id> <label...>\|assign <pool> <runner>\|unassign <pool> <runner>]` | Dedicated front-door for remote runner pool review and assignment flows |
| `/tunnel` | — | `[review\|export <path>]` | Dedicated front-door for remote tunnel review and export flows |
| `/voice` | — | `[review\|enable\|disable\|bundle export <path>\|bundle inspect <path>]` | Review or toggle always-speak mode (same switch as /tts on\|off) and package portable voice metadata |

## Feature Flags

| Command | Aliases | Usage | Description |
| --- | --- | --- | --- |
| `/flags` | — | `[list\|on <id>\|off <id>\|doctor\|graduation]` | List feature flags by state, toggle runtime-toggleable ones, surface dark subsystems, and report graduation readiness |

## Git

| Command | Aliases | Usage | Description |
| --- | --- | --- | --- |
| `/git` | `/g` | `[status\|log\|diff]` | Git repository commands — status, log, diff |

## Guidance

| Command | Aliases | Usage | Description |
| --- | --- | --- | --- |
| `/guidance` | — | `[review\|dismiss <id>\|reset [id]]` | Review contextual operational guidance without interrupting the main conversation flow |
| `/welcome` | `/guide` | `[open\|print]` | Open the product entry surface for the onboarding wizard, security, marketplace, remote, and operator workflows |

## Health

| Command | Aliases | Usage | Description |
| --- | --- | --- | --- |
| `/health` | `/doctor` | `[report\|review\|open\|setup\|services\|sandbox\|provider\|accounts\|auth\|settings\|intelligence\|remote\|mcp\|metrics\|continuity\|worktrees\|maintenance\|term\|repair [domain]] — bare and report stay a cross-domain transcript report (see also /health provider for the providers modal)` | Health workspace for startup posture, service readiness, sandbox posture, and provider health |

## Hooks

| Command | Aliases | Usage | Description |
| --- | --- | --- | --- |
| `/hooks` | — | `[contracts [filter] \| reload \| scaffold <name> <match> <type> \| chain <name> <event1,event2,...> \| remove <name> \| enable <name> \| disable <name> \| simulate <eventPath> \| inspect <path> \| import <path> [merge\|replace] \| export [path]]` | Inspect, author, simulate, and reload managed hook workflows |

## Image

| Command | Aliases | Usage | Description |
| --- | --- | --- | --- |
| `/imagine` | — | `<prompt>` | Generate an image from a prompt via a configured media provider |

## Incidents

| Command | Aliases | Usage | Description |
| --- | --- | --- | --- |
| `/incident` | — | `[open \| latest \| show <id\|latest> \| export <id\|latest> <path> \| capture <id\|latest>]` | Open, export, and capture incident review bundles |

## Intelligence

| Command | Aliases | Usage | Description |
| --- | --- | --- | --- |
| `/intelligence` | `/intel` | `[review\|panel\|diagnostics [file]\|symbols <file>\|outline <file>\|definition <file> <line> <column>\|references <file> <line> <column>\|hover <file> <line> <column>\|repair]` | Review workspace intelligence readiness, diagnostics posture, and symbol search availability |

## Knowledge

| Command | Aliases | Usage | Description |
| --- | --- | --- | --- |
| `/knowledge` | `/know` | `<subcommand> [args]` | Structured knowledge graph: ingest URLs/bookmarks, inspect issues, and build compact prompt packets |

## Local Auth

| Command | Aliases | Usage | Description |
| --- | --- | --- | --- |
| `/local-auth` | `/auth-local` | `[review\|panel\|add-user <username> <password> [roles]\|delete-user <username>\|rotate-password <username> <password>\|revoke-session <token-or-fingerprint>\|clear-bootstrap-file]` | Inspect and manage local daemon/listener auth users, sessions, and bootstrap credentials |

## Local Providers

| Command | Aliases | Usage | Description |
| --- | --- | --- | --- |
| `/provider` | `/p` | `[add <name> <baseURL> [apiKey] \| remove <name> \| <provider-name>]` | Switch provider or manage custom providers (add/remove) |

## Local Runtime

| Command | Aliases | Usage | Description |
| --- | --- | --- | --- |
| `/bookmarks` | `/bm` | — | List bookmarked blocks |
| `/collapse` | — | `[all\|thinking\|tool\|code]` | Collapse blocks by type |
| `/expand` | — | `[all\|thinking\|tool\|code]` | Expand blocks by type |
| `/image` | `/img` | `<path> [prompt text]` | Attach an image file to the next message |
| `/incident-review` | — | — | Alias for /incident open |
| `/pin` | — | `<model-id>` | Pin a model to the favorites list |
| `/refresh-models` | — | — | Refresh model catalog, benchmarks, and token limits |
| `/secrets` | — | `set <KEY> <value> [--user\|--project] [--secure\|--plaintext] \| link <KEY> <secret-ref> [--user\|--project] [--secure\|--plaintext] \| get <KEY> \| test <secret-ref> \| providers \| list \| delete <KEY> [--user\|--project] [--secure\|--plaintext]` | Manage hierarchy-aware secrets, external secret refs, and secure/plaintext storage policy controls |
| `/tools` | `/t` | `[review\|panel]` | List available tools and review compact native tool capability surfaces |
| `/unpin` | — | `<model-id>` | Unpin a model from the favorites list |

## Local Setup

| Command | Aliases | Usage | Description |
| --- | --- | --- | --- |
| `/setup` | `/startup` | `[review\|doctor\|services\|hooks\|remote\|sandbox\|onboarding\|support-bundle <dir>\|export <path>\|transfer <export\|inspect\|import> <path>\|link <surface> [target]\|open-link <uri>]` | Launch the onboarding wizard and review startup readiness, service posture, and sandbox bring-up |

## Managed Runtime

| Command | Aliases | Usage | Description |
| --- | --- | --- | --- |
| `/managed` | — | `[review\|staged\|rollback-history\|export <profile> <path>\|inspect <path>\|stage <path>\|apply <path> [key ...]\|apply-staged [key ...]\|rollback <token>\|lock <key> <source> <reason...>\|unlock <key>]` | Export, inspect, and apply managed settings bundles |

## Marketplace

| Command | Aliases | Usage | Description |
| --- | --- | --- | --- |
| `/marketplace` | `/catalog` | `[open\|overview\|recommend\|browse [query]\|review <plugin\|skill\|hook-pack\|policy-pack> <id>\|provenance <plugin\|skill\|hook-pack\|policy-pack> <id>\|install-hint <plugin\|skill\|hook-pack\|policy-pack> <id>\|install <plugin\|skill\|hook-pack\|policy-pack> <id> [project\|user]\|update <plugin\|skill\|hook-pack\|policy-pack> <id> [project\|user]\|rollback <plugin\|skill\|hook-pack\|policy-pack> <id> [project\|user] [backupId]\|history <plugin\|skill\|hook-pack\|policy-pack> <id> [project\|user]\|uninstall <plugin\|skill\|hook-pack\|policy-pack> <id> [project\|user]\|receipt <plugin\|skill\|hook-pack\|policy-pack> <id> [project\|user]\|bundle export <path> [project\|user]\|bundle inspect <path>\|bundle import <path> [project\|user]\|installed]` | Browse the unified plugin and skill marketplace |

## MCP

| Command | Aliases | Usage | Description |
| --- | --- | --- | --- |
| `/mcp` | — | `[add\|remove\|reload\|config\|review\|tools [<server>]\|auth-review\|repair [server]]` | Manage MCP servers and their tools |

## Memory

| Command | Aliases | Usage | Description |
| --- | --- | --- | --- |
| `/handoff` | — | `[export <path> [scope] \| inspect <path> \| import <path>]` | Dedicated front-door for reviewable memory handoff bundles |
| `/memory-sync` | `/memsync` | `[export <path> [scope] \| import <path>]` | Dedicated front-door for durable memory export/import and bundle exchange |
| `/recall` | `/rc`, `/memory`, `/mem` | `[<subcommand> [args]] — bare opens the modal; report prints the subcommand usage text` | Bare opens the Memory modal; project memory subcommands add decisions, constraints, incidents, and patterns with provenance |
| `/session-memory` | — | `[queue [limit] \| export <path> \| add <class> <summary...>]` | Dedicated front-door for session-scoped memory capture and review. All subcommands are filtered to scope=session |
| `/team-memory` | — | `[queue [limit] \| export <path> \| import <path> \| capture policy]` | Dedicated front-door for team/shared memory review and exchange. The queue and export subcommands are filtered to scope=team |

## Notifications

| Command | Aliases | Usage | Description |
| --- | --- | --- | --- |
| `/notify` | — | `add <url> \| remove <url> \| list \| clear \| test` | Manage webhook notification URLs (ntfy.sh format) |

## Onboarding

| Command | Aliases | Usage | Description |
| --- | --- | --- | --- |
| `/onboarding` | — | — | Open the onboarding wizard with current settings preloaded for review and editing |

## Operator

| Command | Aliases | Usage | Description |
| --- | --- | --- | --- |
| `/context` | `/ctx` | `[window [<size>\|clear]]` | Inspect context usage, or set/clear a custom context window for the current model |
| `/forensics` | `/foren` | `[latest \| show <id> \| export <id>]` | Failure Forensics: view, inspect, and export auto-classified failure reports |
| `/mode` | `/hitl` | `[quiet\|balanced\|operator\|show\|set-domain <domain> <verbosity>]` | Manage HITL UX notification mode (quiet/balanced/operator) |
| `/next-error` | `/ne` | — | Jump to the next error message in the conversation |
| `/ops` | — | `view \| task <cancel\|pause\|resume\|retry> <id> [note] \| agent cancel <id> [note]` | Operator Control Plane: view audit log, cancel/pause/resume/retry tasks and agents |
| `/panel` | `/panels` | `[open <id> [top\|bottom] [--target <id>[:<kind>]]\|close <id>\|list\|toggle\|move <top\|bottom\|other> [id]\|focus <top\|bottom\|toggle>\|split [show\|hide\|toggle]\|width <left\|right\|reset>\|height <up\|down\|reset>]` | Open, place, resize, or list panels. Usage: /panel [open <id> [top\|bottom]\|close <id>\|list\|toggle\|move\|focus\|split\|width\|height] |
| `/prev-error` | `/pe` | — | Jump to the previous error message in the conversation |
| `/profiles` | `/profile` | — | Browse and load config profiles |
| `/settings` | `/cfg-ui` | — | Open the fullscreen configuration workspace |
| `/tool` | — | `verify <name> \| verify-all \| contract show <name>` | Tool contract verification — verify registered tool contracts |

## Permissions

| Command | Aliases | Usage | Description |
| --- | --- | --- | --- |
| `/permissions` | `/perms` | — | Show permission settings in effect and where each value came from (provenance) |

## Planning

| Command | Aliases | Usage | Description |
| --- | --- | --- | --- |
| `/plan` | — | `[on \| off \| toggle]` | Enter or exit plan mode — a read-only planning posture where writes, commands, and network calls are blocked |
| `/project-plan` | `/planning` | `[panel \| approve \| dismiss \| answer <n> <text> \| list \| show <id> \| mode \| explain \| override <strategy> \| status \| clear \| <planning goal>]` | Inspect or seed TUI-owned project planning state |

## Platform

| Command | Aliases | Usage | Description |
| --- | --- | --- | --- |
| `/sandbox` | — | `[open\|review\|recommend\|profiles\|presets\|preset <id>\|apply-preset <id>\|probe\|doctor\|wrapper-test <profile>\|guest-test <profile>\|init-qemu <dir>\|qemu <setup [dir]\|bootstrap [dir] [size-gb]\|recover\|inspect-setup\|apply-setup> ...\|session ...\|bundle ...\|guest-bundle <export\|inspect> <path>\|scaffold-qemu-wrapper <path>\|set-mcp <mode>\|set-repl <mode>\|set-windows <mode>\|set-backend <mode>\|set-qemu-binary <path>\|set-qemu-image <path>\|set-qemu-wrapper <path>\|set-qemu-guest-host <host>\|set-qemu-guest-port <port>\|set-qemu-guest-user <user>\|set-qemu-workspace <path>\|set-qemu-session-mode <attach\|launch-per-command>]` | Review and configure VM isolation policy for MCP and evaluation runtimes |

## Platform Access

| Command | Aliases | Usage | Description |
| --- | --- | --- | --- |
| `/auth` | — | `[review\|show <provider>\|repair <provider>\|bundle export <path>\|bundle inspect <path>\|login <daemon\|listener> <baseUrl> <username> <password> [secretKey]\|local <review\|panel\|add-user\|delete-user\|rotate-password\|revoke-session\|clear-bootstrap-file>]` | Review auth posture and exchange session login tokens with local services |
| `/install` | — | `[review\|bundle export <path>\|bundle inspect <path>]` | Review install posture and export portable install bundles |
| `/login` | — | `[provider <name> start\|finish <code>\|service <daemon\|listener> <baseUrl> <username> <password> [secretKey]]` | Front-door login flow for provider subscriptions and local service sessions |
| `/logout` | — | `provider <name>` | Front-door logout flow for provider subscription sessions and supported overrides |
| `/update` | `/upgrade` | `[check\|apply\|rollback\|review\|bundle export <path>\|bundle inspect <path>]` | Check for a newer GoodVibes release and, for binary installs, download/verify/apply it or roll back to the kept previous version |

## Platform Services

| Command | Aliases | Usage | Description |
| --- | --- | --- | --- |
| `/deeplink` | `/link` | `[review\|open <surface> [target]\|bundle export <path>\|bundle inspect <path>]` | Review and package deep-link entrypoints for setup and operator surfaces |
| `/helpers` | `/integration-api` | `[review\|bundle export <path>\|bundle inspect <path>]` | Review local integration helper API surfaces for remote clients and future web frontends |
| `/storage` | — | `[review\|list\|delete <key>\|bundle export <path>\|bundle inspect <path>]` | Review secure storage posture and export portable storage metadata bundles |

## Plugins

| Command | Aliases | Usage | Description |
| --- | --- | --- | --- |
| `/plugin` | — | `list \| dirs \| inspect <name> \| review \| installed \| catalog-review <id> \| publish-local <id> <path> <summary...> \| unpublish <id> \| install <id> [project\|user] \| update <id> [project\|user] \| uninstall <id> [project\|user] \| enable <name> \| disable <name> \| reload` | Manage plugins, trust, review, and ecosystem paths |

## Policy

| Command | Aliases | Usage | Description |
| --- | --- | --- | --- |
| `/policy` | `/pol` | `<subcommand> [args]` | Open the policy panel or manage versioned policy bundles (load, simulate, diff, promote, rollback) |

## Principals

| Command | Aliases | Usage | Description |
| --- | --- | --- | --- |
| `/principals` | — | `[list\|get <id>\|create <name> <kind> [channel:value...]\|update <id> [--name x] [--kind x] [--identities c:v,c:v]\|delete <id>\|resolve <channel> <value>]` | Identity mappings: named principals and their channel identities |

## Product

| Command | Aliases | Usage | Description |
| --- | --- | --- | --- |
| `/bridge` | — | `[status\|pools\|assign <pool> <runner>\|runner <id>\|review <artifactId>\|export <artifactId> [path]\|import <path>]` | Review and operate self-hosted bridge and remote runner flows |
| `/release` | — | `[review\|checklist\|bundle export <path>\|bundle inspect <path>]` | Package certification and release-readiness operations |
| `/trust` | — | `[review\|workspace [trusted\|restricted]\|bundle export <path>\|bundle inspect <path>]` | Review trust posture, set this workspace's trust level, or export trust bundles |

## Profiles

| Command | Aliases | Usage | Description |
| --- | --- | --- | --- |
| `/profile-sync` | `/profilesync` | `[list\|export <path>\|inspect <path>\|import <path> [prefix]]` | Export, import, and inspect profile sync bundles |

## Provider Accounts

| Command | Aliases | Usage | Description |
| --- | --- | --- | --- |
| `/accounts` | `/account` | `[review\|panel\|show <provider>\|routes <provider>\|repair <provider>]` | Review provider auth routes, subscription windows, and billing-path safety |

## Providers

| Command | Aliases | Usage | Description |
| --- | --- | --- | --- |
| `/provider-opt` | `/prov-opt` | `<subcommand> [args]` | Manage provider routing optimizer (route, pin, explain, fallback) |

## QR Codes

| Command | Aliases | Usage | Description |
| --- | --- | --- | --- |
| `/qrcode` | `/qr`, `/pair` | `[regenerate]` | Open the companion-app pairing modal (QR code), or regenerate the pairing token |

## Relay

| Command | Aliases | Usage | Description |
| --- | --- | --- | --- |
| `/relay` | — | `[status\|pair]` | Outbound relay reachability status, or mint a QR-encodable pairing payload |

## Remote

| Command | Aliases | Usage | Description |
| --- | --- | --- | --- |
| `/remote` | — | `[list \| show [agentId] \| supervisor [runnerId] \| capabilities [runnerId] \| recover [runnerId] \| setup [export <path>] \| env [export <path>] \| tunnel [review\|export <path>] \| bootstrap [export <path>\|inspect <path>] \| session <export\|inspect\|import> <path> \| pool <list\|show\|create\|assign\|unassign> ... \| dispatch [template] <description> \| dispatch-pool <pool> [template] <description> \| contract [agentId] \| cancel <agentId> \| export <agentId> [path] \| artifact list \| artifact show <id> \| artifact export <id> [path] \| review <id> \| rerun-local <id> \| import <path>]` | Inspect, dispatch, and review self-hosted remote runners and artifacts |
| `/teleport` | — | `[export <path>\|inspect <path>\|import <path>]` | Package, inspect, and import portable remote-session handoff bundles |

## Scheduling

| Command | Aliases | Usage | Description |
| --- | --- | --- | --- |
| `/schedule` | `/sched` | `add <cron\|every\|at\|when> <value> <prompt...> \| list \| remove <id> \| enable <id> \| disable <id> \| run <id>` | Manage automation jobs and scheduled runs |

## Secrets

| Command | Aliases | Usage | Description |
| --- | --- | --- | --- |
| `/secret` | — | `/secret <NAME>` | Enter a secret with concealed (masked) input and store it as an environment variable — plaintext never enters the transcript |

## Services

| Command | Aliases | Usage | Description |
| --- | --- | --- | --- |
| `/services` | `/svc` | `[open\|list\|inspect <name>\|test <name>\|resolve <name>\|auth <name>\|auth-review\|doctor\|export <path>\|import <path>]` | Manage API service configurations |

## Session Content

| Command | Aliases | Usage | Description |
| --- | --- | --- | --- |
| `/export` | — | `[format] [path]` | Export conversation to a Markdown file |
| `/load` | — | `<name>` | Load a saved session |
| `/note` | — | `[list\|add <text>\|remove <id>]` | Manage session notes (pinned across context compaction) |
| `/redo` | — | `[rewind\|file]` | Redo last undone action. /redo rewind — re-apply the last undone /rewind. /redo file — re-apply last reverted file. /redo — restore conversation turn |
| `/retry` | `/r` | `[modified text]` | Re-send the last user message |
| `/save` | — | `[name]` | Save current session to .goodvibes/tui/sessions/ |
| `/sessions` | — | `[resume <id\|name>]` | List saved sessions |
| `/template` | `/tmpl` | `save <name> \| use <name> [args] \| list \| edit <name> \| delete <name>` | Manage and use prompt templates |
| `/title` | — | `[text]` | Show or set the conversation title |
| `/undo` | — | `[rewind\|file]` | Undo last action. /undo rewind — reverse the last /rewind. /undo file — revert last file write/edit. /undo — remove last conversation turn |

## Sessions & Replay

| Command | Aliases | Usage | Description |
| --- | --- | --- | --- |
| `/replay` | `/rep` | `[load [runId] \| step [n] \| seek <rev> \| diff \| export <path>]` | Deterministic replay: load, step, seek, diff, and export recorded runs |
| `/resume` | — | `[session-id-or-name]` | Resume a previous session — pick from a list, or pass an id/name |
| `/session` | `/sess` | `<subcommand> [args]` | Session lifecycle and orchestration: list, resume, fork, save, export, link-task, handoff, graph, cancel |

## Settings Sync

| Command | Aliases | Usage | Description |
| --- | --- | --- | --- |
| `/settings-sync` | `/settingssync` | `[panel\|report\|review\|show <key>\|staged\|conflicts\|resolve <key> <local\|synced>\|failures\|rollback-history\|export <path>\|inspect <path>\|pull <path>\|push <path>\|lock <key> <source> <reason...>\|unlock <key>] — bare opens the modal` | Open the settings sync modal (bare); review posture, export/import bundles, or resolve conflicts by subcommand |

## Sharing

| Command | Aliases | Usage | Description |
| --- | --- | --- | --- |
| `/share` | — | `<html\|json\|md> [path] [--redact] [--upload] [--copy] [--open]` | Export the current session to a shareable format (html, json, md) |

## Shell & Session

| Command | Aliases | Usage | Description |
| --- | --- | --- | --- |
| `/clear` | `/cls` | — | Clear the conversation display (keeps LLM context) |
| `/commands` | `/cmds` | — | Browse all commands in a scrollable list |
| `/compact` | — | — | Summarize conversation to free context window |
| `/compact-history` | `/compaction-history` | — | Show compaction history for this session |
| `/debug` | — | — | Toggle debug mode |
| `/effort` | `/e` | `[level]` | Show or set reasoning effort level |
| `/help` | `/h`, `/?` | — | Browse every command with its description; picking one runs it |
| `/keep` | — | `<text>` | Pin text to session memory (survives compaction) |
| `/keybindings` | `/kb` | — | List current keyboard bindings and their config file path |
| `/model` | `/m` | `[model-id]` | Select or display the current LLM model |
| `/palette` | `/k` | — | Open the command palette to search and run any slash command |
| `/paste` | `/clip` | — | Insert clipboard text or image into the prompt |
| `/quit` | `/:q` | — | Exit the application |
| `/reset` | — | — | Full reset: clear display and conversation context |
| `/shortcuts` | `/keys`, `/keybinds` | — | Show keyboard shortcuts reference |
| `/wq` | `/:wq` | — | Commit all git changes and then exit |

## Skills

| Command | Aliases | Usage | Description |
| --- | --- | --- | --- |
| `/skills` | `/skill` | `[open\|list\|show <name>\|origins\|browse [query]\|installed\|catalog-review <id>\|publish-local <id> <path> <summary...>\|unpublish <id>\|install-hint <catalog-id>\|install <id> [project\|user]\|update <id> [project\|user]\|uninstall <id> [project\|user]]` | Inspect installed skill packs |

## Subscriptions

| Command | Aliases | Usage | Description |
| --- | --- | --- | --- |
| `/subscription` | `/subs` | `[review\|list\|providers\|inspect <provider>\|login <provider> start [--no-browser] [--manual]\|finish <code-or-url>\|logout <provider>\|bundle export <path>\|bundle inspect <path>]` | Manage provider subscription sessions and, when supported, let them override ambient API keys for matching providers |

## Tasks

| Command | Aliases | Usage | Description |
| --- | --- | --- | --- |
| `/tasks` | `/task` | `[list [status\|kind] \| show <taskId> \| output <taskId> \| create <kind> <owner> <title...> \| update <taskId> <title\|description\|result> <value...> \| complete <taskId> [result] \| fail <taskId> <error...> \| cancel <taskId> [note] \| pause <taskId> [note] \| resume <taskId> [note] \| retry <taskId> [note]]` | Inspect and control runtime tasks |

## Teamwork

| Command | Aliases | Usage | Description |
| --- | --- | --- | --- |
| `/teamwork` | `/teammates` | `[review\|modes\|mode <id>\|create-mode <id> <title...>\|recipes\|recipe <id>\|templates\|archetypes\|validate\|archetype <name>\|create-archetype <name> <title...>]` | Packaged task modes, teammate templates, and orchestration recipes |

## Testing

| Command | Aliases | Usage | Description |
| --- | --- | --- | --- |
| `/test` | — | `[pattern]` | Run the project test script and show pass/fail results |

## Voice & TTS

| Command | Aliases | Usage | Description |
| --- | --- | --- | --- |
| `/tts` | — | `<prompt>\|stop\|on\|off` | Submit a prompt for live TTS playback, or control always-speak mode |

## Web Search

| Command | Aliases | Usage | Description |
| --- | --- | --- | --- |
| `/search` | — | `<query> [--limit <n>]` | Search the web and render ranked results with source labels |

## Work Plans

| Command | Aliases | Usage | Description |
| --- | --- | --- | --- |
| `/work-plan` | `/wp`, `/todo`, `/workplan` | `[panel\|list\|show\|export\|add <title> [--owner name] [--source label] [--notes text]\|edit <id> [<new title>] [--owner name] [--notes text]\|done <id>\|start <id>\|block <id>\|fail <id>\|cancel <id>\|pending <id>\|remove <id>\|clear-done]` | Track a persistent workspace-scoped work plan |

## Workstreams

| Command | Aliases | Usage | Description |
| --- | --- | --- | --- |
| `/workstream` | — | `create [--isolation shared\|worktree] <task...> \| list \| status [id] \| insert-phase <id> <description...> \| edit-item <id> <item#> <brief...> \| remove-item <id> <item#> \| move-item <id> <item#> <pos> \| approve <id> \| edit <id> [--isolation shared\|worktree] <task...> \| launch <id> [--force] \| cancel <id> \| attempts list\|diff\|judge\|pick` | Author and oversee multi-phase agent workstreams (orchestration engine) |

## Worktrees

| Command | Aliases | Usage | Description |
| --- | --- | --- | --- |
| `/worktree` | `/worktrees` | `[review\|panel\|inspect <path>\|setup <path>\|attach <path> <session\|task> <id>\|session <id>\|task <id>\|recover <session\|task> <id>\|pause <path>\|resume <path>\|keep <path>\|discard <path>\|cleanup <path>]` | Review and manage orchestrator-owned git worktrees |
