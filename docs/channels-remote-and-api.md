# Channels, Remote Runtime, and API

## Channels

GoodVibes includes a shared channel/runtime layer with current surfaces for:

- `tui`
- `web`
- `slack`
- `discord`
- `ntfy`
- `webhook`
- `homeassistant`
- `telegram`
- `google-chat`
- `signal`
- `whatsapp`
- `imessage`
- `msteams`
- `bluebubbles`
- `mattermost`
- `matrix`

The channel runtime owns:

- inbound adapters
- setup and account metadata
- doctor hooks
- route bindings
- delivery strategy selection
- reply rendering and delivery

## Home Assistant

The Home Assistant surface is configured from onboarding or Settings > Surfaces. The TUI stores the SDK config keys and controls auto-start; the SDK daemon owns the actual Home Assistant API/tool surface, callback verification, account metadata, and channel actions.

Relevant settings:

- `surfaces.homeassistant.enabled`
- `surfaces.homeassistant.instanceUrl`
- `surfaces.homeassistant.accessToken`
- `surfaces.homeassistant.webhookSecret`
- `surfaces.homeassistant.defaultConversationId`
- `surfaces.homeassistant.remoteSessionTtlMs`
- `surfaces.homeassistant.deviceId`
- `surfaces.homeassistant.deviceName`
- `surfaces.homeassistant.eventType`

The inbound daemon callback path is `/webhook/homeassistant`. Authenticated Home Assistant Assist clients can also use `GET /api/homeassistant/health`, `POST /api/homeassistant/conversation`, `POST /api/homeassistant/conversation/stream`, and `POST /api/homeassistant/conversation/cancel`. These routes are SDK-owned isolated remote-chat paths with daemon-owned sessions. Responses report `mode: "remote-chat"` and expose `assistant.text` / `assistant.speechText`; Home Assistant clients should not expect `agentId`. Use a `goodvibes://` secret reference or an environment-backed secret for tokens when possible.

## Shared reply pipeline

The same runtime pipeline is used to render and deliver:

- progress updates
- reasoning updates
- tool output
- final replies

That keeps TUI, web, webhook, and channel-native surfaces aligned around the same runtime events.

## Daemon and control plane

The daemon is the backend surface for:

- tasks
- sessions
- control-plane snapshots and messages
- method catalog
- SSE and WebSocket event streams
- knowledge
- voice
- web search
- artifacts
- multimodal
- channel status and delivery surfaces
- remote peers and node-host contracts

Key entrypoints include:

- `GET /status`
- `GET /api/control-plane`
- `GET /api/control-plane/web`
- `GET /api/control-plane/methods`
- `GET /api/control-plane/events/catalog`
- `GET /api/control-plane/events`
- `GET /api/control-plane/ws`
- `POST /task`
- `GET /api/tasks`

The control-plane method catalog is the canonical external-client contract. External clients can use it to inspect method metadata, scopes, schemas, and transport information.

## Knowledge, media, and search APIs

The daemon also exposes dedicated product-domain APIs for:

- knowledge status, ingest, search, packets, jobs, schedules, projections, GraphQL, and reports
- voice status, providers, voices, TTS, streaming TTS, STT, and realtime sessions
- web-search providers and queries
- artifacts and artifact content
- multimodal status, providers, analyze, packet, and writeback

These surfaces are what make future web clients and companion apps straightforward to build without duplicating runtime logic.

Streaming TTS is exposed at `POST /api/voice/tts/stream` and returns raw binary audio. The existing `POST /api/voice/tts` JSON synthesis route is unchanged.

## Remote runtime

The remote runtime is a distributed peer system with:

- pair request and challenge verification
- scoped peer tokens
- heartbeat
- work pull / claim / lease / complete
- remote invoke
- disconnect, revoke, and rotate flows
- node-host contract inspection

Key remote API paths include:

- `POST /api/remote/pair/request`
- `POST /api/remote/pair/verify`
- `POST /api/remote/heartbeat`
- `POST /api/remote/work/pull`
- `POST /api/remote/work/{workId}/complete`
- `GET /api/remote/peers`
- `GET /api/remote/work`
- `GET /api/remote/node-host/contract`

## High-signal commands

- `/remote`
- `/remote show <runner>`
- `/remote capabilities [runner]`
- `/remote recover [runner]`
- `/remote dispatch ...`
- `/remote dispatch-pool <pool> ...`
- `/remote export <runner>`
- `/remote artifact show <id>`
- `/remote import <path>`
- `/remote setup`

## Related docs

- [Deployment and services](deployment-and-services.md)
- [Knowledge, artifacts, and multimodal](knowledge-artifacts-and-multimodal.md)
- [Tools and commands](tools-and-commands.md)
