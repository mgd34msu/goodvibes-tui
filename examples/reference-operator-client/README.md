# Reference operator client

This is the smallest in-process reference consumer for the current GoodVibes foundation surface.

It demonstrates:

- building an explicit runtime service graph (`createRuntimeServices`) over an isolated runtime store, event bus, and config manager rooted in a throwaway temp directory
- creating the direct in-process transport (`createDirectTransport`) over that service graph, instead of the HTTP transport a remote consumer would use
- using the operator surface to create a session (`transport.operator.sessions.ensureSession`)
- reading the operator surface's provider snapshot for the configured provider count
- inspecting the combined transport snapshot (`transport.snapshot()`), which carries both the operator side's control-plane session list and the peer side's node-host contract in one call

Run it with:

```bash
bun examples/reference-operator-client/index.ts
```

It prints a JSON summary covering the transport kind, the created session's
id, the provider count, the number of sessions the control plane reports,
and the peer contract's base path. The temp directory it works in is
removed when the example exits.
