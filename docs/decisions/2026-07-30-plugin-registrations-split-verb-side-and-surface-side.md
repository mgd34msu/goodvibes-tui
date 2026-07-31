# Decision: which plugin registrations survive this app becoming a pure client, and which are now orphaned

Date: 2026-07-30
Scope: the plugin verb-side / surface-side split, moved into the daemon-separation conversion
Status: accepted, with one item left open for the daemon-side round
Repo: goodvibes-tui (the plugin API itself is the SDK's; this record is about what it reaches here)

## Why this had to be settled with the conversion, not after it

A plugin registers into whatever registries the host hands its loader. When this app hosted a
daemon, all eleven of them were live and every registration meant something. Dropping to a
pure client silently changes the answer for three of them — the registry is still there, the
registration still succeeds, and nothing it was registered for ever runs. That is the failure
class this whole separation exists to remove, so leaving it for a later round would have
shipped it.

## The survey, on this machine and in this repository

- **Installed plugins: none.** There is no plugin directory under `~/.goodvibes`, and
  `~/.goodvibes/tui/plugins.json` does not exist.
- **Plugins bundled with this product: none.** `src/plugins/index.ts` is a re-export of the
  SDK's discovery and loader functions; the package ships no plugin sources and no bundle
  index. `goodvibes plugin bundles` browses a remote index that has to be named on the
  command line.

**So what actually splits today is nothing.** No registration is currently orphaned, because
there is nothing registering. What follows is the classification the API surface forces, which
is what the next installed plugin will hit.

## Surface-side — still live, still correct

These reach things a turn genuinely needs in this process, all of which the client composition
still builds:

| Registration | Why it stays |
|---|---|
| `registerCommand` | Slash commands are drawn and dispatched by this app's own command registry. |
| `registerTool` | A tool is called by the conversation loop, and the loop runs here. |
| `registerProvider` / `registerProviderInstance` / `registerRuntimeProvider` | The model stack is part of the SDK's client shape; this process makes the provider call. |
| `registerVoiceProvider` | The microphone and the speaker are attached to this terminal. |
| `registerMediaProvider` | Media generation/analysis is composed here, over this surface's artifact store. |
| `registerWebSearchProvider` | The web-search service is in the client shape; a turn's search runs here. |
| `registerMemoryEmbeddingProvider` | The embedding registry backs this surface's own memory store and code index. |

## Daemon-side — a registration made here now reaches nothing

| Registration | What it needed | Where that is now |
|---|---|---|
| `registerGatewayMethod` | A catalog something SERVES | The client's catalog is empty by construction and no `DaemonServer` is built (`adoptOnly`), so a descriptor registered here has no listener behind it. |
| `registerChannelPlugin` | The process that receives inbound channel messages | The daemon. Its inbox pollers and its cluster single-reader election are what decide who answers a message. |
| `registerDeliveryStrategy` | The delivery router that actually sends | The daemon's. This app composes a router for its own outbound notices; a plugin strategy registered on it does not touch how the daemon replies to a Telegram message. |

## The open item for the daemon-side round

The daemon repository loads plugins through the same SDK loader, so the three rows above want
a home there: a plugin that adds a gateway verb, a channel, or a delivery strategy should be
discovered and loaded by the daemon, and the same plugin's commands and tools should be
discovered and loaded here. That is one plugin, loaded twice, with each host taking the half it
can honour — which is the shape the SDK's loader already supports (it takes the registries the
host has) and which needs no new plugin API.

What is NOT settled, and is deliberately left: whether a single plugin manifest declares both
halves, or whether the two hosts read the same directory and each ignores what it cannot use.
Both work; the choice is about what an author has to write, and it should be made when there
is an author to ask. Until then the classification above is the honest statement of what
happens, and no plugin is affected because none is installed.

## What was NOT done here, and why

No warning was added at load time for a registration that lands in the empty catalog. With
zero installed plugins it would fire for nobody, and the right place for it is the loader that
knows which host it is running in — which is an SDK change, on the round that gives the daemon
its plugin loading.
