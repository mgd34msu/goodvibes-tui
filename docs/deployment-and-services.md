# Deployment and services

## Runtime shapes

GoodVibes supports a few distinct deployment shapes:

- local TUI only, with no daemon
- TUI connected to a daemon it adopted or autostarted (the default)
- a standalone `goodvibes-daemon` process, with no TUI attached
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

## Adopting or autostarting the daemon, and the in-process HTTP listener

The daemon (`goodvibes-daemon`) is a separate product with its own binary and its own service
unit. This app never constructs one in-process. What `daemon.enabled` (default `true`) actually
does on this side:

- adopt a compatible daemon already listening at the configured `controlPlane.host`/`controlPlane.port`
- if none is reachable but a daemon service is installed on this machine and simply stopped, start
  that installed service and wait for it to answer
- otherwise, run with no daemon. This surface still gives you the full TUI, tools, providers,
  knowledge system, artifacts, and local runtime surfaces. Cross-surface session visibility and
  daemon-hosted capabilities are simply unavailable until a daemon appears

The HTTP listener is different. It genuinely runs in-process in this app when enabled, controlled by:

- `danger.httpListener` (default `false`)

The compiled binary built by `bun run build` includes this path because it compiles `src/main.ts`, and the main runtime bootstraps external services through the deferred startup path.

## Running the daemon

`goodvibes-daemon` is built and released from its own repository. Run it directly:

```sh
goodvibes-daemon                      # run in the foreground
goodvibes-daemon install-service      # install and start the user service unit
```

This path is useful for service-style deployments, automation entrypoints, and local integrations that do not need the interactive terminal UI. See that repository's own documentation for its full CLI and configuration reference.

The installed package also exposes a `goodvibes-daemon` launcher. The suite installer (`goodvibes.sh/install.sh`) puts both `goodvibes` and `goodvibes-daemon` on `PATH`.

## Connecting the TUI to an already-running daemon

The TUI normally adopts a compatible GoodVibes daemon it finds already listening at its configured `controlPlane.host`/`controlPlane.port`, or starts an installed-but-stopped one, as described above. Adoption authenticates with a bearer token read from `<homeDirectory>/.goodvibes/daemon/operator-tokens.json`; if that file does not already hold the *same* token the target daemon was started with, the TUI cannot tell the two apart from a token it has never seen and will not adopt it.

Two ways to point a TUI instance at a daemon it did not start itself:

**Interactive.** In the onboarding wizard's Network step, set "GoodVibes daemon source" to "Connect to an existing running daemon," fill in that daemon's host, port, and token, and select "Connect to this daemon now." This installs the token into `operator-tokens.json`, applies the host/port, and restarts the external-services controller immediately so you see whether the connection succeeded before finishing the rest of onboarding.

**Non-interactive.** Set the `GOODVIBES_DAEMON_TOKEN` environment variable to run the daemon with a fixed, known token, and point the TUI at the same host/port and token:

```sh
# Start the daemon once, with a fixed, known token:
GOODVIBES_DAEMON_TOKEN=gv_shared_token goodvibes-daemon --hostname 0.0.0.0 --port 3421

# Point a TUI at it (any home directory, no shared operator-tokens.json needed):
GOODVIBES_DAEMON_TOKEN=gv_shared_token bun run dev \
  --config controlPlane.host=<daemon-host> \
  --config controlPlane.port=3421
```

`GOODVIBES_DAEMON_TOKEN` is read by both sides. The daemon uses it as the bearer token every route requires, and the TUI runtime uses it to install (or confirm) the matching entry in its own `operator-tokens.json` before probing that host/port, so adoption succeeds without hand-editing any files. This mirrors `src/verification/live-verifier.ts`'s existing fallback to the same variable when probing a daemon's HTTP surface from the outside.

## Background service and autostart

The fullscreen `/config` workspace exposes service settings under `Service`:

| Key | Default | What it does |
| --- | --- | --- |
| `service.enabled` | `true` | Enable the service-install and daemon-management verbs |
| `service.autostart` | `false` | Install/enable or disable/remove the OS autostart service |
| `service.restartOnFailure` | `true` | Restart the managed daemon service after failure |
| `service.platform` | `auto` | Target service manager platform |
| `service.serviceName` | `goodvibes` | Service name used for host integration and install scripts |
| `service.logPath` | *(empty)* | File path for daemon/service logs; empty means the platform default under the configured service directory |

Changing `service.autostart` from the TUI is intended to reconcile the OS service, not just update JSON. On Linux this means writing/enabling/disabling the user `systemd` service. When service mode is enabled for the first time, the TUI installs the service definition, reloads user units, and starts/enables the daemon service if autostart is on. Disabling service mode or autostart removes/disables the OS-level autostart path.

Use these commands to inspect the live state:

```sh
goodvibes service status
goodvibes status --output json
```

The daemon uses the daemon home under `~/.goodvibes/daemon` for daemon-owned runtime state.

## Web/browser surface

The browser operator surface is controlled separately from the daemon control plane:

| Key | Default | What it does |
| --- | --- | --- |
| `web.enabled` | `true` | Enable the browser operator surface, bound to loopback until `web.hostMode` widens it |
| `web.hostMode` | `local` | Bind mode: `local`, `network`, or `custom` |
| `web.host` | `127.0.0.1` | Bind host for the web surface |
| `web.port` | `3423` | Bind port for the web surface |
| `web.publicBaseUrl` | `http://127.0.0.1:3423` | Public base URL for web links and notification deep links |
| `web.staticAssetsDir` | `dist/web` | Static asset directory for the embedded web surface |

The daemon/control-plane backend defaults to port `3421`, the webhook/event listener defaults to `3422`, and the browser surface defaults to `3423`.

Host modes resolve as:

- `local`: bind loopback (`127.0.0.1`)
- `network`: bind all interfaces (`0.0.0.0`)
- `custom`: bind the configured host

When the WebUI is launched by external tooling rather than by the TUI, it should read the same TUI settings file or be launched with matching env overrides. The canonical setting file is `~/.goodvibes/tui/settings.json`; setting `GOODVIBES_HOME` relocates the whole `.goodvibes` tree root, which moves that file to `<GOODVIBES_HOME>/.goodvibes/tui/settings.json`.

## Inbound TLS

GoodVibes now treats inbound TLS as an explicit server concern.

The control-plane daemon and the webhook listener each carry the same shape of TLS keys, under their own prefixes:

| Key (per prefix) | What it does |
| --- | --- |
| `controlPlane.hostMode` / `controlPlane.host` / `controlPlane.port`, `httpListener.host` / `httpListener.port` | The bind address and port; `hostMode` takes `local`, `network`, or `custom` |
| `controlPlane.enabled` | Whether the control plane serves at all |
| `<prefix>.tls.mode` | `off` (plain HTTP), `proxy` (a reverse proxy terminates HTTPS), or `direct` (GoodVibes terminates HTTPS itself) |
| `<prefix>.trustProxy` | Trust proxy forwarding headers such as `X-Forwarded-For` |
| `<prefix>.tls.certFile` / `<prefix>.tls.keyFile` | Certificate chain and private key PEM paths for `direct` mode; empty falls back to the default cert directory below |

### Proxy mode

`proxy` is the recommended deployment shape for public HTTPS exposure. In this mode:

- GoodVibes still binds plain HTTP locally
- a reverse proxy such as Nginx, Caddy, Traefik, or Nginx Proxy Manager terminates HTTPS
- GoodVibes only trusts forwarded headers when the relevant `trustProxy` setting is enabled

This is the right shape when a future web UI, browser clients, SSE, and WebSocket clients all need to share one public HTTPS origin.

### Direct mode

`direct` makes GoodVibes terminate HTTPS itself through Bun's native server TLS.

If no explicit certificate paths are configured, GoodVibes looks for:

- `~/.goodvibes/tui/certs/fullchain.pem`
- `~/.goodvibes/tui/certs/privkey.pem`

That convention also works well with self-hosted Let's Encrypt deployment patterns where the operator copies or syncs certificate material into the GoodVibes home directory.

If `direct` is enabled and the certificate files are missing or invalid, GoodVibes fails that server startup clearly instead of silently downgrading to plain HTTP.

### TLS plaintext warning

If a control plane or HTTP listener is configured with `hostMode` other than `local` and `tls.mode = off`, GoodVibes emits a `[SECURITY]` warning in the WRFC panel at startup. The same warning appears in the onboarding wizard network step whenever a network-facing service is selected without TLS.

To suppress the warning, set `controlPlane.tls.mode` or `httpListener.tls.mode` to `direct` (or use the `proxy` deployment shape with a terminating reverse proxy).

### Cloudflare Zero Trust Tunnel and trustProxy

When the onboarding wizard applies with the Zero Trust Tunnel Cloudflare component selected, it writes:

- `controlPlane.trustProxy = true`
- `httpListener.trustProxy = true`
- `httpListener.trustCloudflare = true`

The two `trustProxy` keys let the login rate-limiter key on the client address the tunnel forwards rather than the tunnel's own egress address. On their own, that address is read from `X-Forwarded-For`.

**What `X-Forwarded-For` alone leaves open:** it is a header any client can set. A client that reaches the port directly, bypassing the tunnel, sets its own rate-limit bucket key and can rotate it at will.

`httpListener.trustCloudflare` closes that gap for the HTTP listener. The client address comes from `CF-Connecting-IP`, and only when the connecting peer is itself inside Cloudflare's published ranges (`isCloudflareIp`); otherwise the header is ignored. It requires `httpListener.trustProxy`. With that off, `CF-Connecting-IP` is ignored whatever this says, and the onboarding wizard's Zero Trust Tunnel step writes both, so this route arrives with the narrower read already on.

**What is still open:** the control plane has no `trustCloudflare` equivalent, so its rate-limiter is still keyed on `X-Forwarded-For`. Keep both ports reachable only through the tunnel. Restrict inbound traffic to Cloudflare egress IPs, which is what you want regardless, since direct exposure also bypasses tunnel-level access policies.

### CORS configuration

CORS enforcement is off by default (permissive, no origin checking) and is meant for multi-user, internet-exposed, or enterprise deployments where browser-based CSRF is a concern.

The listener takes `enforceCors` and `allowedOrigins` as constructor parameters, and neither is a `ConfigKey` the onboarding wizard can write. What it does read from config when the constructor says nothing is the shared control-plane allowlist, so those are the settings to write:

```json
{
  "controlPlane": {
    "cors": {
      "enabled": true,
      "allowedOrigins": "https://your-origin.example.com,https://another.example.com"
    }
  }
}
```

`allowedOrigins` is a comma-separated string, and the same allowlist governs the control-plane router and the webhook listener. Restart the daemon after editing. With enforcement on, a listener bound to a network address refuses to start on an empty allowlist rather than serving every origin.

## Outbound HTTPS trust

GoodVibes now centralizes outbound trust handling for Bun `fetch` traffic. Provider calls, search, webhooks, downloads, telemetry, artifacts, and other fetch-based integrations inherit the same trust policy automatically.

Four keys configure it:

| Key | Default | What it does |
| --- | --- | --- |
| `network.outboundTls.mode` | `bundled` | `bundled` uses Bun's default bundled root certificates; `bundled+custom` adds operator-provided PEM roots on top; `custom` trusts only the configured custom roots |
| `network.outboundTls.customCaFile` | *(empty)* | Additional PEM file to trust in `bundled+custom` or `custom` mode |
| `network.outboundTls.customCaDir` | *(empty)* | Directory of PEM/CRT/CER files to trust in `bundled+custom` or `custom` mode |
| `network.outboundTls.allowInsecureLocalhost` | `false` | Disable certificate verification only for loopback HTTPS targets; intended for local development |

This is the right place to add enterprise or internal roots for outbound HTTPS access to providers, registries, proxies, or internal services.

## Build behavior

`bun run build` compiles:

- entrypoint: `src/main.ts`
- output: `dist/goodvibes`

This build does not produce a daemon executable. The daemon binary is built and released from the `goodvibes-daemon` repository.

## Local auth and service tokens

The daemon and listener are protected by local auth plus optional service tokens.

Two environment variables carry the tokens: `GOODVIBES_DAEMON_TOKEN` is the bearer token every daemon route requires, and `GOODVIBES_HTTP_TOKEN` protects the webhook HTTP listener.

Beyond fixed tokens, the runtime supports bootstrap credentials for first contact, local user management with password rotation (`goodvibes auth add-user` / `auth rotate-password`), session revocation, and local-auth review surfaces in the TUI and operator APIs.

## Services, profiles, and setup transfer

The services/config side is productized beyond a flat JSON file. It includes:

- a named service registry with inspect, auth resolution, connectivity tests, auth review, and doctor output
- first-class SecretRef-backed service credentials through env, GoodVibes local storage, file, exec, 1Password, Bitwarden, Vaultwarden, and Bitwarden Secrets Manager providers
- live profile management plus portable profile sync bundle export/import
- setup transfer bundles that can move config/services/ecosystem posture between environments

Key commands:

| Command | Does |
| --- | --- |
| `/services inspect\|test\|resolve\|auth\|auth-review\|doctor\|export\|import` | Manage API service configurations |
| `/profiles` | Browse and load config profiles |
| `/profile-sync` (alias `/profilesync`) | Export, import, and inspect profile sync bundles |
| `/setup transfer export\|inspect\|import` | Move setup-transfer bundles between environments |

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

GoodVibes exposes integration-helper and control/state APIs for external clients and helpers. This layer is explicitly control/state APIs, not a UI protocol. It is meant for callers like another GoodVibes instance, a future web frontend or companion app, setup/auth helpers, and operational integrations that need session, approval, account, health, knowledge, search, artifact, or delivery posture.

The front doors into this layer cover provider login/logout flows, install and update posture review, trust review bundles, bridge status/review/export/import paths, setup deep links, and portable install/update/auth review bundles with deeplink review and bundle packaging for operator surfaces.

The setup surface is broader than a single readiness screen. It also covers onboarding and doctor flows, review of services, hooks, remote, and sandbox posture, support-bundle export, setup-transfer export/inspect/import, and deep links into the cockpit, security, remote, knowledge, incident, hooks, orchestration, and tasks operator surfaces.

## Core control-plane entrypoints

The daemon exposes broad HTTP and streaming surfaces. The most important entrypoints:

| Entrypoint | Serves |
| --- | --- |
| `GET /status` | Daemon liveness and posture |
| `GET /api/control-plane` | The control-plane descriptor |
| `GET /api/control-plane/web` | The web-surface descriptor |
| `GET /api/control-plane/methods` | The typed method catalog |
| `GET /api/control-plane/events/catalog` | The event catalog |
| `GET /api/control-plane/events` | The event stream |
| `GET /api/control-plane/ws` | The WebSocket transport |
| `POST /task` | Task submission |
| `GET /api/tasks` | The task list |
| `GET /api/service/status` | Managed-service status |

The control-plane method catalog is the canonical typed surface for external clients. For every method it describes the method itself, its category and scopes, its input and output schemas, its event domains, and its transport metadata.

## Service startup behavior inside the TUI

Before adopting or autostarting a daemon, and before starting its own in-process HTTP listener, the TUI probes the configured bind ports first and skips startup cleanly if another instance already owns them. That avoids duplicate local-service hangs while still allowing the TUI to run normally.

## Related docs

- [Channels, remote runtime, and API](channels-remote-and-api.md)
- [Providers and routing](providers-and-routing.md)
