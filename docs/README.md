# Documentation

This directory contains the current product documentation for `goodvibes-tui`.

## Guides

- [Getting started](getting-started.md)
  Installation, first-run setup, provider configuration, common paths, and basic run/build flows.

- [Deployment and services](deployment-and-services.md)
  TUI-only mode, compiled binary behavior, in-process daemon/listener hosting, source-run daemon mode, inbound TLS, outbound trust configuration, and control-plane entrypoints.

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

- [Tools and commands](tools-and-commands.md)
  Built-in tool families, slash-command families, and the operator/workflow surfaces that tie them together.

- [Release and publishing](release-and-publishing.md)
  Release validation, GitHub CD, compiled binary releases, npm distribution, and the GitHub Packages mirror.

- [Panel authoring](panel-authoring.md)
  Class hierarchy, canonical example, palette convention, rendering utilities, input handling, performance instrumentation, and contract test registration for contributors building new TUI panels.

- [Release notes](releases/0.19.35.md)
  Version-specific release notes for shipped TUI releases.

- [Foundation artifacts](foundation-artifacts/README.md)
  Checked-in operator and peer contract manifests plus canonical knowledge GraphQL and SQL artifacts for release-gate and SDK extraction work.
