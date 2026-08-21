# Channels, remote runtime, and API

## Channels

GoodVibes includes a shared channel/runtime layer. Every surface it drives
(the SDK's `ChannelSurface` type) is one of the following:

| Surface | What it is |
| --- | --- |
| `tui` | This terminal app itself. |
| `web` | The browser cockpit surface. |
| `slack` | Slack workspace integration. |
| `discord` | Discord surface integration. |
| `ntfy` | ntfy push-notification topics. |
| `webhook` | The generic inbound/outbound webhook surface. |
| `homeassistant` | The Home Assistant daemon surface (see below). |
| `telegram` | Telegram bot integration. |
| `google-chat` | Google Chat surface integration. |
| `signal` | Signal bridge integration. |
| `whatsapp` | WhatsApp surface integration. |
| `telephony` | SMS/voice via Twilio or a bridge. |
| `imessage` | The iMessage bridge surface. |
| `msteams` | Microsoft Teams surface integration. |
| `bluebubbles` | BlueBubbles (an iMessage server) integration. |
| `mattermost` | Mattermost surface integration. |
| `matrix` | Matrix surface integration. |

Every one of those surfaces is driven by the same channel runtime, which owns
inbound adapters, setup and account metadata, doctor hooks, route bindings,
delivery strategy selection, and reply rendering and delivery. That shared
ownership is what keeps a new surface from needing its own copy of routing,
delivery, or reply logic.

## Home Assistant

The Home Assistant surface is configured from onboarding or Settings > Surfaces. The TUI stores the SDK config keys and controls auto-start; the SDK daemon owns the actual Home Assistant API/tool surface, callback verification, account metadata, and channel actions.

Relevant settings:

| Key | Default | What it does |
| --- | --- | --- |
| `surfaces.homeassistant.enabled` | `false` | Enable the Home Assistant daemon surface |
| `surfaces.homeassistant.instanceUrl` | *(empty)* | Home Assistant base URL, for example `http://homeassistant.local:8123` |
| `surfaces.homeassistant.accessToken` | *(empty)* | Long-lived access token or `goodvibes://` secret URI |
| `surfaces.homeassistant.webhookSecret` | *(empty)* | Shared secret used to verify inbound Home Assistant callbacks |
| `surfaces.homeassistant.defaultConversationId` | `goodvibes` | Default conversation id used for route binding |
| `surfaces.homeassistant.remoteSessionTtlMs` | `1200000` | Idle TTL before the daemon closes a remote conversation session (20 minutes) |
| `surfaces.homeassistant.deviceId` | `goodvibes-daemon` | Stable Home Assistant device identifier for this daemon |
| `surfaces.homeassistant.deviceName` | `GoodVibes Daemon` | Device display name |
| `surfaces.homeassistant.eventType` | `goodvibes_message` | Event type used for daemon-to-Home Assistant deliveries |

The inbound daemon callback path is `/webhook/homeassistant`. Authenticated Home Assistant Assist clients can also use `GET /api/homeassistant/health`, `POST /api/homeassistant/conversation`, `POST /api/homeassistant/conversation/stream`, and `POST /api/homeassistant/conversation/cancel`. These routes are SDK-owned isolated remote-chat paths with daemon-owned sessions. Responses report `mode: "remote-chat"` and expose `assistant.text` / `assistant.speechText`; Home Assistant clients should not expect `agentId`. Use a `goodvibes://` secret reference or an environment-backed secret for tokens when possible.

## Shared reply pipeline

The same runtime pipeline renders and delivers progress updates, reasoning updates, tool output, and final replies. That keeps TUI, web, webhook, and channel-native surfaces aligned around the same runtime events.

## Daemon and control plane

The daemon is the backend surface behind everything the TUI and other
clients do. It runs tasks and sessions, holds the control-plane snapshots
and messages that keep every connected surface in sync, and publishes the
method catalog those surfaces read to know what they can call. It streams
events over SSE and WebSocket, and it fronts the product-domain APIs
covered below (knowledge, voice, web search, artifacts, and multimodal). It
also carries channel status and delivery surfaces, and remote peer and
node-host contracts for the distributed runtime described later in this
document.

Key entrypoints include:

| Entrypoint | Serves |
| --- | --- |
| `GET /status` | Daemon liveness and posture |
| `GET /api/control-plane` | The control-plane descriptor |
| `GET /api/control-plane/web` | The web-surface descriptor |
| `GET /api/control-plane/methods` | The typed method catalog |
| `GET /api/control-plane/events/catalog` | The event catalog |
| `GET /api/control-plane/events` | The SSE event stream |
| `GET /api/control-plane/ws` | The WebSocket transport |
| `POST /task` | Task submission |
| `GET /api/tasks` | The task list |

The control-plane method catalog is the canonical external-client contract. External clients can use it to inspect method metadata, scopes, schemas, and transport information.

## Knowledge, media, and search APIs

The daemon also exposes dedicated product-domain APIs:

| Domain | Covers |
| --- | --- |
| Knowledge | Status, ingest, search, packets, jobs, schedules, projections, GraphQL, and reports |
| Voice | Status, providers, voices, TTS, streaming TTS, STT, and realtime sessions |
| Web search | Providers and queries |
| Artifacts | Artifact records and their content |
| Multimodal | Status, providers, analyze, packet, and writeback |

These surfaces are what make future web clients and companion apps straightforward to build without duplicating runtime logic.

Streaming TTS is exposed at `POST /api/voice/tts/stream` and returns raw binary audio. The existing `POST /api/voice/tts` JSON synthesis route is unchanged.

## Remote runtime

The remote runtime is a distributed peer system. A peer joins through a pair request with challenge verification and receives a scoped peer token, then heartbeats while connected. Work moves through pull, claim, lease, and complete steps, with direct remote invoke alongside, and peers can be disconnected, revoked, or have their tokens rotated. Node hosts additionally expose an inspectable contract describing what they will run.

Key remote API paths:

| Path | Purpose |
| --- | --- |
| `POST /api/remote/pair/request` | Start a pairing request |
| `POST /api/remote/pair/verify` | Answer the pairing challenge |
| `POST /api/remote/heartbeat` | Peer liveness heartbeat |
| `POST /api/remote/work/pull` | Pull available work |
| `POST /api/remote/work/{workId}/complete` | Report a work item complete |
| `GET /api/remote/peers` | List paired peers |
| `GET /api/remote/work` | List work items |
| `GET /api/remote/node-host/contract` | Inspect a node host's contract |

## High-signal commands

`/remote` inspects, dispatches, and reviews self-hosted remote runners and artifacts. The subcommands most work reaches for:

| Command | Does |
| --- | --- |
| `/remote` | List runners and their state |
| `/remote show <runner>` | Show one runner in detail |
| `/remote capabilities [runner]` | Show what a runner can execute |
| `/remote recover [runner]` | Recover a runner's stalled work |
| `/remote dispatch ...` | Dispatch work to a runner |
| `/remote dispatch-pool <pool> ...` | Dispatch work to a runner pool |
| `/remote export <runner>` | Export a runner's work record |
| `/remote artifact show <id>` | Show a produced artifact |
| `/remote import <path>` | Import an exported record |
| `/remote setup` | Review or export the remote setup |

## /channel command

The `/channel` command gives in-session visibility into the channel runtime state.

| Invocation | Output |
|---|---|
| `/channel` | Opens the Routes panel in the TUI |
| `/channel panel` | Same as above |
| `/channel pair [surface]` | Guided channel pairing: lists adapters, collects declared credentials, verifies them |
| `/channel status` | Builds a full integration review (routes, delivery, sessions, tasks, pending approvals) |
| `/channel routes` | Raw route binding snapshot from the integration helper service |
| `/channel delivery` | Current delivery snapshot: per-route delivery counts and last-error state |
| `/channel policy` | Configured channel surfaces (enabled/disabled) and the location of fine-grained ingress policies |
| `/channel profiles [list\|get\|set\|delete]` | Per-channel model and permission-mode profile bindings |

`status`, `routes`, `delivery`, and `policy` accept `--json` for
machine-readable output; `pair` and `profiles` are interactive/CRUD
subcommands and do not take it.

Examples:

```
/channel routes
/channel status --json
/channel delivery
/channel policy
```

## GitHub event narration

When the daemon receives an inbound GitHub webhook event, it is narrated into the live transcript as a low-priority system message before the event is dispatched to the orchestrator. The narration format is:

```
[GitHub] <detail> → agent triggered
```

Examples:

- `[GitHub] PR #42 (owner/repo) opened → agent triggered`
- `[GitHub] Issue #7 (owner/repo) closed → agent triggered`
- `[GitHub] push in owner/repo → agent triggered`

Other channel surfaces use a generic format. ntfy includes the topic when available; all others use `inbound event`:

```
[Slack] inbound event → agent triggered
[ntfy] inbound message on topic 'alerts' → agent triggered
[Webhook] inbound event → agent triggered
```

This narration is purely informational; it does not affect routing or delivery.

## Push notifications on long-task completion

When a turn or agent task runs longer than the configured threshold, GoodVibes fires a push notification.

### Configuration

Set `behavior.notifyAfterSeconds` in `/config behavior` (or `settings.json`):

```json
{
  "behavior": {
    "notifyAfterSeconds": 60
  }
}
```

- **Default**: 60 seconds
- **Off**: set to `0` to disable all push notifications

### Delivery targets

Notifications are delivered in this order:

1. **Desktop notification.** `notify-send` on Linux, `osascript` on macOS. The SDK handles platform detection; the call is a silent no-op when neither is available.
2. **Outbound webhook / ntfy topic.** If you have webhook URLs configured (via `/notify add <url>`), the notification is also sent as a plain-text POST to all configured endpoints. This works with ntfy.sh topics and any service accepting a plain POST body.

### Notification content

Notification text contains only structural metadata (task kind, elapsed time, ok/fail status, and the first 8 characters of the session ID). Conversation content (user messages, assistant replies, tool outputs) is **never included**.

### Focus state

Notifications are gated by `behavior.notifyOnlyWhenUnfocused` (on by default). They fire only when the terminal is unfocused, or when focus state was never observed. Set it to `false` to fire regardless of focus.

### Wiring

The threshold is read inside `wireTurnEventHandlers` on every `TURN_COMPLETED` event. The `behavior.notifyAfterSeconds` key is a TUI-local synthetic setting; it is not yet in the SDK ConfigKey union.

## Related docs

- [Deployment and services](deployment-and-services.md)
- [Knowledge, artifacts, and multimodal](knowledge-artifacts-and-multimodal.md)
- [Tools and commands](tools-and-commands.md)
