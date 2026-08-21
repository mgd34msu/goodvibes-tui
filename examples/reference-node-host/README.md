# Reference node host

This is a Bun/TypeScript reference client for the GoodVibes distributed remote contract.

It demonstrates the full node-host lifecycle against the existing `/api/remote` surface. Each step below maps to one HTTP call the client makes against the daemon.

- pair request, `POST /api/remote/pair/request`, registers this node host and receives a pairing challenge back
- operator approval, `POST /api/remote/pair/requests/<id>/approve`, the step an operator (or, for local testing, this client itself when given an `operatorToken`) takes to approve the pending request
- pair verification, `POST /api/remote/pair/verify`, exchanges the challenge for a peer token once approval has happened
- heartbeat, `POST /api/remote/heartbeat`, keeps the peer record alive and reports its capabilities and commands
- work pull, `POST /api/remote/work/pull`, claims pending work items up to a configured lease and batch size
- work completion, `POST /api/remote/work/<id>/complete`, reports each claimed item's outcome back to the daemon
- reconnect and backoff, an exponential backoff with jitter that resets after every successful pass and lengthens after every failed one, so a client that loses its peer token or its network connection recovers on its own

It also includes built-in handlers for five work types, each returning a
small JSON result rather than executing anything on the host. `status.request`
reports the client's uptime and configured heartbeat/work-pull intervals.
`location.request` reports the host's hostname, platform, architecture, and
working directory. `session.message` echoes the received message back as
acknowledged. `automation.run` records that an automation request arrived,
along with its run and job ids. `invoke` is the generic command path used
when no other type matches, subject to the same allowlist as every other
type.

## Usage

```bash
cd examples/reference-node-host
bun src/cli.ts --config ./config.example.json start
```

`start` runs the full lifecycle in a loop until the process is stopped. The
CLI also accepts single-step commands for exercising one part of the flow at
a time. `contract` fetches and prints the node-host contract, `pair` sends
only the pair request, `verify` attempts pairing verification against
whatever state was already saved, and `once` runs a single
heartbeat-and-work-pull pass and prints its summary.

For a first pairing run, the daemon must approve the pair request before verification succeeds. If you supply an `operatorToken` in your config, the reference client can approve its own request through the operator endpoint for local testing.

## State

The client persists token and pairing state to the configured `statePath`. The sample config stores it under:

`~/.goodvibes/reference-node-host/state.json`

## Notes

- Command allowlisting is enforced before any work item is handled, not
  just `invoke` items. Every work type resolves to a command string first,
  and an unlisted command fails the item instead of reaching a handler.
- The client does not execute arbitrary shell commands. Every handler above
  returns a descriptive JSON result; none of them shells out.
- The work handlers are reference implementations. Replace them with your real node-host logic when you are ready.
