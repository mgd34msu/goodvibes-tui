# Home Assistant Surface

GoodVibes can expose a Home Assistant companion surface through the daemon. The TUI owns onboarding, settings, and auto-start selection; the SDK daemon owns Home Assistant API calls, callback verification, tool/action metadata, and event delivery.

## Onboarding

Select `Connect GoodVibes to external apps and services`, then select `Home Assistant surface`. The dedicated Home Assistant setup screen includes:

- Auto-start this surface: writes `surfaces.homeassistant.enabled`.
- Home Assistant URL: writes `surfaces.homeassistant.instanceUrl`.
- Home Assistant access token: writes `surfaces.homeassistant.accessToken`; raw values are stored as `goodvibes://` secret refs through the wizard secret policy.
- Home Assistant webhook secret: writes `surfaces.homeassistant.webhookSecret`.
- Default conversation ID: writes `surfaces.homeassistant.defaultConversationId`.
- Remote session idle TTL: writes `surfaces.homeassistant.remoteSessionTtlMs`, defaulting to 20 minutes.
- Device ID and device name: identify the GoodVibes daemon inside Home Assistant metadata.
- Event type: defaults to `goodvibes_message` for daemon-to-Home Assistant events.

If auto-start is set to `No`, the setup values are saved but the surface stays idle until `surfaces.homeassistant.enabled` is turned on from Settings > Surfaces.

## Daemon Contract

The inbound callback path is:

```text
/webhook/homeassistant
```

The authenticated Home Assistant conversation routes are:

```text
GET  /api/homeassistant/health
POST /api/homeassistant/conversation
POST /api/homeassistant/conversation/stream
POST /api/homeassistant/conversation/cancel
```

`POST /api/homeassistant/conversation` is the submit-and-wait Assist path for companion clients. `POST /api/homeassistant/conversation/stream` streams the response. `POST /api/homeassistant/conversation/cancel` cancels an active Home Assistant remote conversation. Remote sessions are daemon-owned and close after `surfaces.homeassistant.remoteSessionTtlMs` of inactivity.

The SDK advertises Home Assistant account, setup, capabilities, tools, actions, directory, target-resolution metadata, and direct conversation routes through the channel daemon routes. The TUI should not call Home Assistant APIs directly.

Home Assistant ingress is handled as direct non-WRFC work by the SDK daemon. The TUI configures the surface and credentials, but Home Assistant messages should not spawn engineer/reviewer/fixer chains.

## Secrets

Prefer GoodVibes secret references or environment-backed secrets for Home Assistant credentials:

```text
goodvibes://secrets/goodvibes/GOODVIBES_SURFACES_HOMEASSISTANT_ACCESS_TOKEN
goodvibes://secrets/goodvibes/GOODVIBES_SURFACES_HOMEASSISTANT_WEBHOOK_SECRET
```

The SDK also recognizes environment fallbacks such as `HOMEASSISTANT_ACCESS_TOKEN`, `HOME_ASSISTANT_ACCESS_TOKEN`, `HA_ACCESS_TOKEN`, `HOMEASSISTANT_URL`, `HOME_ASSISTANT_URL`, `HA_URL`, `HOMEASSISTANT_WEBHOOK_SECRET`, `HOME_ASSISTANT_WEBHOOK_SECRET`, and `HA_GOODVIBES_WEBHOOK_SECRET`.
