# Deep Dive: Export & Integrations

**Generated**: 2026-06-11 ~21:20 | Scores: export quality 9, integration completeness 8, webhook value delivery 8, tests 8

## Headline: the COUNTER-EXAMPLE — the inbound loop is genuinely connected
Unlike the failover/context patterns, external chat → agent → reply-to-origin is fully wired: daemon emits COMPANION_MESSAGE_RECEIVED (incl. ntfy chat topics) → bootstrap-core ~:501 feeds it to the orchestrator as a real turn → reply streams back to BOTH the TUI conversation and the originating channel with surface-origin correlation. Slack/Discord/ntfy/HomeAssistant clients are substantial; outbound WebhookNotifier fully attached (bounded concurrency, HMAC, DLQ + SLO metrics).

## Gaps
1. F-EXP-02 (E20 blocker): /share is LOCAL-FILE ONLY — no upload target, no link generation anywhere in src/. The shareable promise is unmet | M
2. F-EXP-01: /share never passes live session cost although exportToHTML/JSON accept {cost} — cost summary absent/zero in exports | S
3. F-INT-01: inbound GitHub events reach the AGENT (eventToPrompt → PR comments/reviews) but are never narrated to the OPERATOR — no system message says "PR #42 opened → agent triggered" despite the router existing | M
4. F-CHAN-01: full omnichannel substrate (routes/policies/delivery/reply pipeline) with only a read-only routes-panel — no /channel command | M
5. F-NAME-01: integration-runtime.ts is actually the /plugin command — misleading name | XS

## E20 track
T1 cost passthrough (S) → T2 upload target + link (Gist via existing PAT pattern / generic HTTP PUT) (M) → T3 --copy/--open flags (S) → T4 post-export hint line (S) → T5 docs ship with it (S) → T6 tests (XS).
