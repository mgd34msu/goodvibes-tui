# Tools and Commands

## Built-in tools

GoodVibes ships a broad built-in tool set. Current tool families include:

- file and code operations: `read`, `write`, `edit`, `find`
- execution and inspection: `exec`, `analyze`, `inspect`
- network and research: `fetch`, `web_search`
- orchestration: `agent`, `workflow`, `task`, `team`, `worklist`
- runtime/control surfaces: `state`, `registry`, `control`, `channel`, `remote`
- external integration surfaces: `mcp`
- structured query/eval surfaces: `repl`, `query`, `packet`

The tool registry is part of the main runtime and is shared across the TUI, agents, automation, and daemon-backed flows.

## High-value tool families

### File and code work

- `read` for token-efficient file reading, outlines, symbols, AST views, and paginated batch reads
- `write` for atomic writes, overwrite modes, and auto-heal pipelines
- `edit` for structural code edits with validation and rollback
- `find` for files, content, symbols, references, and structural search

### Execution and analysis

- `exec` for shell execution, background processes, retries, and process tracking
- `analyze` for impact, dependencies, dead code, upgrade, semantic diff, and security checks
- `inspect` for project/frontend/runtime inspection

### Research and retrieval

- `fetch` for HTTP retrieval and extraction
- `web_search` for provider-backed search and evidence shaping
- `packet` for compact knowledge/context packets
- `query` and `repl` for bounded query/eval work

### Coordination and product control

- `agent` for in-process agent work
- `workflow` for WRFC and related execution flows
- `remote` for distributed runtime control
- `channel` for channel-aware runtime and delivery surfaces
- `control` and `state` for product/runtime introspection

## Slash-command families

Representative slash-command families include:

- `/model`
- `/settings`
- `/config`
- `/recall`
- `/knowledge`
- `/remote`
- `/sandbox`
- `/plugin`
- `/marketplace`
- `/workflow`
- `/schedule`
- `/voice`
- `/mcp`
- `/incident`
- `/replay`
- `/eval`

## Operator surfaces

Many commands also have matching panels and control rooms. High-signal examples:

- provider accounts and health
- knowledge and memory review
- remote peers and work queues
- channels and deliveries
- MCP trust and reconnect posture
- approvals, policy, security, and diagnostics
- tasks, orchestration, worktrees, and agents

## Workflow-oriented commands

Some command families are especially important when you are running GoodVibes as an operational console rather than just a chat surface:

- `/workflow` for WRFC and related execution chains
- `/schedule` for cron-like and interval-based automation
- `/hooks` for managed hook inspection and simulation
- `/remote` for dispatching and recovering distributed work
- `/sandbox` for isolation review and QEMU/bootstrap flows

## Related docs

- [Getting started](getting-started.md)
- [Deployment and services](deployment-and-services.md)
- [Channels, remote runtime, and API](channels-remote-and-api.md)
