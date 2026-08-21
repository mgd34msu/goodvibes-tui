# Reference HTTP client

This is the smallest remote reference consumer for the current GoodVibes operator and peer transports.

It demonstrates:

- creating the HTTP transport (`createHttpTransport`) against a running daemon, authenticated with a bearer token
- reading the operator surface's provider snapshot and control-plane snapshot, the same data an operator UI reads to show which providers and clients are active
- fetching the peer/node-host contract, the base path and transport a node-host reference client needs before it can pair against this daemon

Required environment:

- `GOODVIBES_BASE_URL`, the daemon's base URL, for example `http://127.0.0.1:39421`
- `GOODVIBES_TOKEN`, a shared bearer token or session token

Run it with:

```bash
GOODVIBES_BASE_URL=http://127.0.0.1:39421 \
GOODVIBES_TOKEN=your-token \
bun examples/reference-http-client/index.ts
```

It prints a JSON summary covering the transport kind, the number of
configured providers, the number of active clients the daemon's control
plane reports, and the peer contract's base path and transport.
