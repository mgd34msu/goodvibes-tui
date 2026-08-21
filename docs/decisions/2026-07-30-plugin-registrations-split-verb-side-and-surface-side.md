# Decision: which plugin registrations survive this app becoming a pure client, and which are now orphaned

Date: 2026-07-30
Scope: the plugin verb-side / surface-side split, moved into the daemon-separation conversion
Status: accepted; the open item is settled below (2026-07-31)
Repo: goodvibes-tui (the plugin API itself is the SDK's; this record is about what it reaches here)

## Why this had to be settled with the conversion, not after it

A plugin registers into whatever registries the host hands its loader. When this app hosted a
daemon, all eleven of them were live and every registration meant something. Dropping to a
pure client silently changes the answer for three of them. The registry is still there, the
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

## Surface-side: still live, still correct

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

## Daemon-side: a registration made here now reaches nothing

| Registration | What it needed | Where that is now |
|---|---|---|
| `registerGatewayMethod` | A catalog something SERVES | The client's catalog is empty by construction and no `DaemonServer` is built (`adoptOnly`), so a descriptor registered here has no listener behind it. |
| `registerChannelPlugin` | The process that receives inbound channel messages | The daemon. Its inbox pollers and its cluster single-reader election are what decide who answers a message. |
| `registerDeliveryStrategy` | The delivery router that actually sends | The daemon's. This app composes a router for its own outbound notices; a plugin strategy registered on it does not touch how the daemon replies to a Telegram message. |

## The open item for the daemon-side round

The daemon repository loads plugins through the same SDK loader, so the three rows above want
a home there. A plugin that adds a gateway verb, a channel, or a delivery strategy should be
discovered and loaded by the daemon, and the same plugin's commands and tools should be
discovered and loaded here. That is one plugin, loaded twice, with each host taking the half it
can honour, which is the shape the SDK's loader already supports (it takes the registries the
host has) and which needs no new plugin API.

What was NOT settled, and was deliberately left: whether a single plugin manifest declares both
halves, or whether the two hosts read the same directory and each ignores what it cannot use.

## Settled (2026-07-31): one plugin package, each host loads what it can serve

**One plugin package. Both hosts read the same directories. Each loads the registrations it can
serve and ignores the rest.** No manifest change, no per-half declaration, no new plugin API.

An author writes one plugin. Where it is installed decides nothing about which halves run; what
decides that is which host loaded it. This is the direction the platform already runs in:

- **It is already true on disk.** Neither host passes `additionalDirectories`, so both scan
  `<cwd>/.goodvibes/plugins` and `~/.goodvibes/plugins`. A manifest that declared halves would
  be describing a split that the filesystem does not have.
- **The manifest cannot express it anyway.** The capability vocabulary in the SDK's plugin
  manifest types has no channel, delivery or gateway entry. The two it does list for
  registration (`register.panel`, `register.hook`) are backed by no API method at all. Making a
  manifest declare halves means inventing a vocabulary for a distinction the author does not
  have to care about.
- **It matches the degrade the composition already relies on.** A registration into a catalog
  nothing serves is accepted and cataloged rather than refused. That is what this record's
  middle section describes for the client's gateway catalog today. The daemon's side of that is
  now written the same way, and made honest: see below.
- **Two hosts, one enabled-set.** Both resolve their plugin state to `~/.goodvibes/tui/plugins.json`
  (the daemon's surface root is deliberately still `tui` for Phase A). Enabling a plugin enables
  it for both, which is the same answer as "one plugin package", and it is the behaviour an
  author writing one plugin would expect. Worth naming as a consequence rather than an accident:
  two hosts write that file with a whole-file, last-writer-wins save.

### What that means the daemon had to do, and now does

The daemon repository constructed a `PluginManager` and never called `init` on it. It could list
a plugin directory and load nothing out of it. `enable` persisted a flag that turned nothing on.
Every one of the three rows above therefore reached nothing no matter where the plugin was
installed. The daemon now builds its loader dependencies (`src/runtime/plugin-composition.ts`)
and initialises the manager at boot, with:

- **the three verb-side registries served for real**: the gateway catalog this process answers
  from, the channel registry its inbound pollers and cluster election read, and the delivery
  router replies actually leave through (`deliveryManager.getDeliveryRouter()`, not a second
  router built from the same arguments);
- **the provider-shaped registries it genuinely has**: providers, memory embeddings, voice,
  media, web search;
- **the two surface-side kinds accepted and named.** `PluginLoaderDeps` has no optional members
  and the plugin API guards nothing, so a host that supplies nothing for a registry does not
  decline that kind. It throws inside the plugin's own `init`, and the loader drops the WHOLE
  plugin, including the halves that host could have run. "Ignores the rest" therefore has to be
  a registry that accepts the registration and goes nowhere. Both stand-ins log what they took
  and that nothing here will run it, so the same plugin loaded by a surface is visibly where
  that half happens.

`registerTool` stays on the surface-side list, as classified above, and that classification was
written when the daemon hosted no runs of its own. The daemon does host runs, and they build
their tools through the agent orchestrator's own registry rather than through a registry a
plugin can reach. The round that moves session hosting daemon-side is the one that re-examines
this row.

## What was NOT done here, and why

No warning was added inside the SDK loader for a registration that lands in a catalog nothing
serves. The right place for it is the loader that knows which host it is running in, which is an
SDK change; the daemon says it at its own stand-ins instead, where the fact is local and certain.

Nothing was built for a plugin that does not exist. There are still zero installed plugins and
zero bundled ones. What changed is that a plugin dropped into either host's directory now
loads, in both hosts, and a test drives that end to end against a real fixture on disk
(`goodvibes-daemon/src/test/runtime/plugin-composition.test.ts`). Until this round no test in
any repository had executed the loader's init path at all.
