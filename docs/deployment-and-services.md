# Deployment and Services

## Runtime shapes

GoodVibes supports a few distinct deployment shapes:

- local TUI only
- TUI with in-process daemon/API host
- source-run headless daemon/API host
- daemon/API host behind a reverse proxy with HTTPS termination
- daemon/API host with direct HTTPS from GoodVibes itself
- omnichannel runtime with external routes and channel delivery
- distributed runtime with remote peers and node-host runners

## TUI-only mode

This is the default development and local-use path:

```sh
bun run dev
```

or, for the compiled build:

```sh
./dist/goodvibes
```

In this mode you still get the full TUI, tools, providers, knowledge system, artifacts, and local runtime surfaces.

## In-process daemon and HTTP listener

The TUI runtime can host the daemon and HTTP listener in-process when these settings are enabled:

- `danger.daemon`
- `danger.httpListener`

The compiled binary built by `bun run build` includes this path because it compiles `src/main.ts`, and the main runtime bootstraps external services through the deferred startup path.

This is the easiest way to run:

- the interactive TUI
- the local daemon/API host
- the local HTTP listener

in one process.

## Headless daemon/API host

For a daemon-only process, use:

```sh
GOODVIBES_DAEMON_TOKEN=... GOODVIBES_HTTP_TOKEN=... bun run daemon
```

This runs the dedicated daemon CLI entrypoint from `src/daemon/cli.ts`. It starts:

- the daemon server
- the optional HTTP listener when `danger.httpListener` is enabled

This path is useful for service-style deployments, automation entrypoints, and local integrations that do not need the interactive terminal UI.

## Inbound TLS

GoodVibes now treats inbound TLS as an explicit server concern.

For the control-plane daemon:

- `controlPlane.tls.mode = off | proxy | direct`
- `controlPlane.trustProxy = true | false`
- `controlPlane.tls.certFile`
- `controlPlane.tls.keyFile`

For the webhook listener:

- `httpListener.host`
- `httpListener.port`
- `httpListener.tls.mode = off | proxy | direct`
- `httpListener.trustProxy = true | false`
- `httpListener.tls.certFile`
- `httpListener.tls.keyFile`

### Proxy mode

`proxy` is the recommended deployment shape for public HTTPS exposure. In this mode:

- GoodVibes still binds plain HTTP locally
- a reverse proxy such as Nginx, Caddy, Traefik, or Nginx Proxy Manager terminates HTTPS
- GoodVibes only trusts forwarded headers when the relevant `trustProxy` setting is enabled

This is the right shape when a future web UI, browser clients, SSE, and WebSocket clients all need to share one public HTTPS origin.

### Direct mode

`direct` makes GoodVibes terminate HTTPS itself through Bun’s native server TLS.

If no explicit certificate paths are configured, GoodVibes looks for:

- `~/.goodvibes/certs/fullchain.pem`
- `~/.goodvibes/certs/privkey.pem`

That convention also works well with self-hosted Let’s Encrypt deployment patterns where the operator copies or syncs certificate material into the GoodVibes home directory.

If `direct` is enabled and the certificate files are missing or invalid, GoodVibes fails that server startup clearly instead of silently downgrading to plain HTTP.

## Outbound HTTPS trust

GoodVibes now centralizes outbound trust handling for Bun `fetch` traffic. Provider calls, search, webhooks, downloads, telemetry, artifacts, and other fetch-based integrations inherit the same trust policy automatically.

Relevant config:

- `network.outboundTls.mode = bundled | bundled+custom | custom`
- `network.outboundTls.customCaFile`
- `network.outboundTls.customCaDir`
- `network.outboundTls.allowInsecureLocalhost`

Behavior:

- `bundled` uses Bun’s default bundled root certificates
- `bundled+custom` adds operator-provided PEM roots on top of the bundled roots
- `custom` trusts only the configured custom PEM roots
- `allowInsecureLocalhost` disables certificate verification only for loopback HTTPS targets and is intended for local development

This is the right place to add enterprise or internal roots for outbound HTTPS access to providers, registries, proxies, or internal services.

## Build behavior

`bun run build` compiles:

- entrypoint: `src/main.ts`
- output: `dist/goodvibes`

The default build does not produce a separate compiled daemon-only executable. If you want a compiled headless daemon binary later, that would need its own build target for `src/daemon/cli.ts`.

## Local auth and service tokens

The daemon and listener are protected by local auth plus optional service tokens.

Key environment variables:

- `GOODVIBES_DAEMON_TOKEN`
- `GOODVIBES_HTTP_TOKEN`

The runtime also supports:

- bootstrap credentials
- local user management
- password rotation
- session revocation
- local-auth review surfaces in the TUI and operator APIs

## Core control-plane entrypoints

The daemon exposes broad HTTP and streaming surfaces. The most important entrypoints are:

- `GET /status`
- `GET /api/control-plane`
- `GET /api/control-plane/web`
- `GET /api/control-plane/methods`
- `GET /api/control-plane/events/catalog`
- `GET /api/control-plane/events`
- `GET /api/control-plane/ws`
- `POST /task`
- `GET /api/tasks`
- `GET /api/service/status`

The control-plane method catalog is the canonical typed surface for external clients. It describes:

- methods
- categories
- scopes
- input/output schemas
- event domains
- transport metadata

## Service startup behavior inside the TUI

When the TUI owns the daemon/listener startup path, it probes the configured bind ports first and skips startup cleanly if another instance already owns them. That avoids duplicate local-service hangs while still allowing the TUI to run normally.

## Related docs

- [Channels, remote runtime, and API](channels-remote-and-api.md)
- [Providers and routing](providers-and-routing.md)
