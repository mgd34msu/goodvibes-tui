# Reference HTTP client

This is the smallest remote reference consumer for the current GoodVibes operator and peer transports.

It demonstrates:

- creating the HTTP transport against a running daemon
- inspecting the operator/provider snapshot surface
- fetching the peer/node-host contract

Required environment:

- `GOODVIBES_BASE_URL`: for example `http://127.0.0.1:39421`
- `GOODVIBES_TOKEN`: shared bearer token or session token

Run it with:

```bash
GOODVIBES_BASE_URL=http://127.0.0.1:39421 \
GOODVIBES_TOKEN=your-token \
bun examples/reference-http-client/index.ts
```
