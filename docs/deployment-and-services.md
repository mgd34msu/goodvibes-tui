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

The TUI runtime hosts the daemon in-process by default (`daemon.enabled`, on by default)
and can also host the HTTP listener and the shared control-plane surface when these
settings are enabled:

- `daemon.enabled` (default `true`)
- `controlPlane.enabled`
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

The installed package also exposes a `goodvibes-daemon` launcher. Global installs should put both `goodvibes` and `goodvibes-daemon` on `PATH`.

## Connecting the TUI to an already-running daemon

The TUI normally adopts a compatible GoodVibes daemon it finds already listening at its configured `controlPlane.host`/`controlPlane.port`, or starts its own if none is found. Adoption authenticates with a bearer token read from `<homeDirectory>/.goodvibes/daemon/operator-tokens.json`; if that file does not already hold the *same* token the target daemon was started with, the TUI cannot tell the two apart from a token it has never seen and will not adopt it.

Two ways to point a TUI instance at a daemon it did not start itself:

**Interactive** — in the onboarding wizard's Network step, set "GoodVibes daemon source" to "Connect to an existing running daemon," fill in that daemon's host, port, and token, and select "Connect to this daemon now." This installs the token into `operator-tokens.json`, applies the host/port, and restarts the external-services controller immediately so you see whether the connection succeeded before finishing the rest of onboarding.

**Non-interactive** — set the same `GOODVIBES_DAEMON_TOKEN` environment variable used above to start a headless daemon with a fixed token, and point the TUI (or another daemon) at the same host/port and token:

```sh
# Start the daemon once, with a fixed, known token:
GOODVIBES_DAEMON_TOKEN=gv_shared_token bun run daemon --hostname 0.0.0.0 --port 3421

# Point a TUI at it (any home directory — no shared operator-tokens.json needed):
GOODVIBES_DAEMON_TOKEN=gv_shared_token bun run dev \
  --config controlPlane.host=<daemon-host> \
  --config controlPlane.port=3421
```

`GOODVIBES_DAEMON_TOKEN` is read by both sides: the daemon CLI uses it as the bearer token every route requires, and the TUI runtime uses it to install (or confirm) the matching entry in its own `operator-tokens.json` before probing that host/port, so adoption succeeds without hand-editing any files. This mirrors `src/verification/live-verifier.ts`'s existing fallback to the same variable when probing a daemon's HTTP surface from the outside.

## Background service and autostart

The fullscreen `/config` workspace exposes service settings under `Service`:

- `service.enabled`
- `service.autostart`
- `service.restartOnFailure`
- `service.platform`
- `service.name`
- `service.logPath`

Changing `service.autostart` from the TUI is intended to reconcile the OS service, not just update JSON. On Linux this means writing/enabling/disabling the user `systemd` service. When service mode is enabled for the first time, the TUI installs the service definition, reloads user units, and starts/enables the daemon service if autostart is on. Disabling service mode or autostart removes/disables the OS-level autostart path.

Use these commands to inspect the live state:

```sh
goodvibes service status
goodvibes status --output json
```

The daemon uses the daemon home under `~/.goodvibes/daemon` for daemon-owned runtime state. A TUI-owned in-process daemon may still use the active TUI/project configuration to derive its runtime settings.

## Web/browser surface

The browser operator surface is controlled separately from the daemon control plane:

- `web.enabled`
- `web.hostMode = local | network | custom`
- `web.host`
- `web.port` (default `3423`)
- `web.publicBaseUrl`
- `web.staticAssetsDir`

The daemon/control-plane backend defaults to port `3421`, the webhook/event listener defaults to `3422`, and the browser surface defaults to `3423`.

Host modes resolve as:

- `local`: bind loopback (`127.0.0.1`)
- `network`: bind all interfaces (`0.0.0.0`)
- `custom`: bind the configured host

When the WebUI is launched by external tooling rather than by the TUI, it should read the same TUI settings file or be launched with matching env overrides. The canonical setting file is `~/.goodvibes/tui/settings.json` unless `GOODVIBES_TUI_SETTINGS_PATH` points elsewhere.

## Inbound TLS

GoodVibes now treats inbound TLS as an explicit server concern.

For the control-plane daemon:

- `controlPlane.hostMode = local | network | custom`
- `controlPlane.host`
- `controlPlane.port`
- `controlPlane.enabled`
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

- `~/.goodvibes/tui/certs/fullchain.pem`
- `~/.goodvibes/tui/certs/privkey.pem`

That convention also works well with self-hosted Let’s Encrypt deployment patterns where the operator copies or syncs certificate material into the GoodVibes home directory.

If `direct` is enabled and the certificate files are missing or invalid, GoodVibes fails that server startup clearly instead of silently downgrading to plain HTTP.

### TLS plaintext warning

If a control plane or HTTP listener is configured with `hostMode` other than `local` and `tls.mode = off`, GoodVibes emits a `[SECURITY]` warning in the WRFC panel at startup. The same warning appears in the onboarding wizard network step whenever a network-facing service is selected without TLS.

To suppress the warning: set `controlPlane.tls.mode` or `httpListener.tls.mode` to `direct` (or use the `proxy` deployment shape with a terminating reverse proxy).

### Cloudflare Zero Trust Tunnel and trustProxy

When the onboarding wizard applies with the Zero Trust Tunnel Cloudflare component selected, it writes:

- `controlPlane.trustProxy = true`
- `httpListener.trustProxy = true`

This allows the login rate-limiter to key on the real client IP from the `CF-Connecting-IP` header rather than the tunnel egress address.

**Residual exposure:** the SDK now validates `CF-Connecting-IP` against Cloudflare's published IP ranges before trusting it (`isCloudflareIp` in the SDK HTTP listener), so a client reaching the listener directly cannot spoof the header to bypass the per-IP rate-limiter. Direct exposure of the listener port still bypasses tunnel-level access policies, so keep inbound traffic restricted to Cloudflare egress IPs wherever the tunnel is the intended front door.

### CORS configuration

`httpListener.enforceCors` and `httpListener.allowedOrigins` are HttpListener constructor parameters and are not in the SDK `ConfigKey` union (SDK handoff Item 5). The onboarding wizard cannot write them via `setConfig()`.

To enable CORS enforcement, edit `~/.goodvibes/tui/settings.json` directly:

```json
{
  "httpListener": {
    "enforceCors": true,
    "allowedOrigins": ["https://your-origin.example.com"]
  }
}
```

Then restart the daemon. This limitation will be resolved when the SDK adds these keys to `ConfigKey`.

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

## Services, profiles, and setup transfer

The services/config side is productized beyond a flat JSON file. It includes:

- a named service registry with inspect, auth resolution, connectivity tests, auth review, and doctor output
- first-class SecretRef-backed service credentials through env, GoodVibes local storage, file, exec, 1Password, Bitwarden, Vaultwarden, and Bitwarden Secrets Manager providers
- live profile management plus portable profile sync bundle export/import
- setup transfer bundles that can move config/services/ecosystem posture between environments

Key commands:

- `/services inspect|test|resolve|auth|auth-review|doctor|export|import`
- `/profiles`
- `/profile-sync` (alias: `/profilesync`)
- `/setup transfer export|inspect|import`

Service entries can use an existing `tokenKey` field, a SecretRef in the key field, or explicit `tokenRef` / `passwordRef` / `webhookUrlRef` / `signingSecretRef` / `publicKeyRef` / `appTokenRef` fields:

```json
{
  "slack": {
    "name": "slack",
    "authType": "bearer",
    "tokenKey": "SLACK_BOT_TOKEN",
    "appTokenKey": "SLACK_APP_TOKEN",
    "tokenRef": {
      "source": "vaultwarden",
      "item": "GoodVibes Slack",
      "field": "password",
      "server": "https://vault.example.test"
    },
    "appTokenRef": {
      "source": "vaultwarden",
      "item": "GoodVibes Slack App",
      "field": "password",
      "server": "https://vault.example.test"
    }
  }
}
```

## Integration helpers

GoodVibes exposes integration-helper and control/state APIs for external clients and helpers — this layer is explicitly control/state APIs, not a UI protocol. It is meant for callers like another GoodVibes instance, a future web frontend or companion app, setup/auth helpers, and operational integrations that need session, approval, account, health, knowledge, search, artifact, or delivery posture.

The front doors into this layer:

- provider login/logout flows
- install and update posture review
- trust review bundles
- bridge status/review/export/import paths
- setup deep links and portable install/update/auth review bundles
- deeplink review and bundle packaging for operator surfaces

The setup surface is broader than a single readiness screen, and also covers:

- onboarding and doctor flows
- service, hook, remote, and sandbox review
- support-bundle export
- setup-transfer export / inspect / import
- deep links into the cockpit, security, remote, knowledge, incident, hooks, orchestration, and tasks operator surfaces

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
