# Reference node host

This is a Bun/TypeScript reference client for the GoodVibes distributed remote contract.

It demonstrates the full node-host lifecycle against the existing `/api/remote` surface:

- pair request
- operator approval
- pair verification
- heartbeat
- work pull
- work completion
- reconnect and backoff

It also includes built-in handlers for these work types:

- `status.request`
- `location.request`
- `session.message`
- `automation.run`
- `invoke`

## Usage

```bash
cd examples/reference-node-host
bun src/cli.ts --config ./config.example.json start
```

For a first pairing run, the daemon must approve the pair request before verification succeeds. If you supply an `operatorToken` in your config, the reference client can approve its own request through the operator endpoint for local testing.

## State

The client persists token and pairing state to the configured `statePath`. The sample config stores it under:

`~/.goodvibes/reference-node-host/state.json`

## Notes

- Command allowlisting is enforced before any generic `invoke` handling runs.
- The client does not execute arbitrary shell commands.
- The work handlers are reference implementations. Replace them with your real node-host logic when you are ready.
