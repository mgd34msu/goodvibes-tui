# Documentation

This directory contains the current product documentation for `goodvibes-tui`.

## Guides

- [Getting started](getting-started.md)
  Installation, first-run setup, provider configuration, common paths, and basic run/build flows.

- [Configuration reference](configuration.md)
  The layered settings model, the key-settings table, permission modes and the policy/trust system, plus the TUI-owned namespaces you add by hand to settings.json: checkpoint root guard, the scriptable statusline, session behavior, and launch-time self-update.

- [Deployment and services](deployment-and-services.md)
  TUI-only mode, compiled binary behavior, adopting or autostarting the daemon, the in-process HTTP listener, inbound TLS, outbound trust configuration, control-plane entrypoints, the service registry and secret references, profiles and setup transfer, and integration helpers.

- [Remote access: a home server setup](remote-access.md)
  Step-by-step continuity setup: daemon on an always-on box, webui from any browser, TUI over SSH, Tailscale for reachability and TLS, validated by `goodvibes doctor`.

- [Providers and routing](providers-and-routing.md)
  Native providers, compatible/gateway providers, local discovery, synthetic failover, search providers, voice providers, and media providers.

- [Voice and live TTS](voice-and-live-tts.md)
  Live `/tts` playback, TTS provider/voice configuration, local player requirements, and streaming voice API behavior.

- [Cloudflare batch and control plane](cloudflare-batch.md)
  Optional Workers/Queues batch setup, bootstrap-token flow, daemon routes, onboarding fields, and `/cloudflare` commands.

- [Home Assistant surface](homeassistant-surface.md)
  Home Assistant companion setup, daemon callbacks, webhook security, and onboarding/settings fields.

- [Knowledge, artifacts, and multimodal](knowledge-artifacts-and-multimodal.md)
  Session memory, durable memory, structured knowledge, connectors, extractors, embeddings, artifacts, and multimodal analysis.

- [Project planning](project-planning.md)
  TUI-owned conversational planning loop, passive SDK planning artifacts, project-scoped knowledge spaces, readiness evaluation, and the Planning panel.

- [Channels, remote runtime, and API](channels-remote-and-api.md)
  Omnichannel surfaces, reply routing, remote peers, node-host contracts, and the daemon/control-plane HTTP + streaming surfaces.

- [Session durability](session-durability.md)
  Two-layer durability: post-turn snapshots plus periodic recovery files, and the fsync-per-record transcript journal replayed at every resume seam.

- [Share command](share-command.md)
  `/share` session export to HTML/JSON/Markdown with redaction, upload, clipboard, and open options.

- [CLI flags](cli-flags.md)
  Global flags reference: session lifecycle (`--continue`, `--resume`, `--fork`), confirmation bypass (`-y`/`--non-interactive`), output format consolidation, `--host` alias, and all other startup flags.

- [Tools and commands](tools-and-commands.md)
  Built-in tool families and a per-tool reference, slash-command families, the full keyboard-binding reference, the agent/archetype and hook systems, MCP and plugin extensibility, and the operator, diagnostics, and workflow surfaces that tie them together.

- [QEMU sandbox bootstrapping](qemu-sandbox.md)
  Sandbox isolation modes, host prerequisites, generated QEMU setup bundle files, Debian cloud-image bootstrapping, guest runtime installs, validation, and troubleshooting.

- [Release and publishing](release-and-publishing.md)
  Release validation, GitHub CD, compiled binary releases, npm distribution, and the GitHub Packages mirror.

- [Local verification](verification/local-verification.md)
  Inventory coverage, GoodVibes home audits, compiled CLI probes, authenticated daemon probes, and release-oriented local gates.

- [Panel authoring](panel-authoring.md)
  Class hierarchy, canonical example, palette convention, rendering utilities, input handling, performance instrumentation, and contract test registration for contributors building new TUI panels.

- [Changelog](../CHANGELOG.md)
  Current release history. Older per-version release-note files remain under `docs/releases/` for historical releases, but `CHANGELOG.md` is the canonical current stream.

- [Foundation artifacts](foundation-artifacts/README.md)
  Checked-in operator and peer contract manifests plus canonical knowledge GraphQL and SQL artifacts for release-gate and SDK extraction work.
