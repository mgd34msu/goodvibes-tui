# Deep Dive: Release & Verification Pipeline

**Generated**: 2026-06-11 ~21:15 | Scores: gate completeness 7, automation 8, regression detection 4, reproducibility 8

## Headline: the perf gate is theater
`perf:check` evaluates DEFAULT_BUDGETS against a ZERO-STATE synthetic snapshot (all metrics = 0) — it passes unconditionally and structurally cannot detect a regression. The budgets (frame.render.p95 ≤ 16ms, slo.turn_start.p95 ≤ 2000ms) are defined and tested for EXISTENCE, never fed a real measurement. Same pattern as everywhere: infrastructure built, last mile unwired.

## Findings (ranked)
1. perf:check false-confidence gate (zero snapshot) — P2 critical
2. No startup budget at all despite <150ms target; smoke:tui boots the binary and discards timing (near-free win)
3. performance-gate.test.ts asserts budget definitions, not behavior
4. live-verifier — the richest real-binary verification (CLI cmds + authenticated HTTP probes + ledger ≥ 90%) — is NOT wired into CI/release; operator-run only (low-effort win: warn-only step in release.yml)
5. Binary smoke linux-x64 only; darwin x64/arm64 + linux-arm64 ship unsmoked
6. eval:gate fail-OPEN: silently captures a baseline when missing — corrupted/deleted baseline = no-op pass
7. release.ts pre-tag validation (typecheck+build only) weaker than CI — a tag can be cut that never ran tests
8. No dep/security audit gate, no SBOM; 1-day artifact retention

## What's genuinely good
Full post-tag automation (4-target matrix build, install-smoke with exact version assertion, SHA256SUMS, dual-registry publish w/ npm view verification), pinned action SHAs, publish:check tarball hygiene (rejects test/memory leaks), architecture:check, real eval regression gate (>5%).

## P1/P2 feasibility
- P2 (perf budgets): HIGH — infra half-built. P2-1 rewrite buildCiSnapshot() to load recorded metrics + perf-bench step; P2-2 startup.cold.p95 budget measured in smoke:tui; P2-3 headless frame bench feeding frame.render.p95; P2-4 O(delta) streaming bench.
- P1 (golden-frame pty snapshots): MEDIUM — no pty dep exists yet; start with static surfaces (status/doctor output) + strict ANSI normalizer, linux-x64 first, before interactive flows.
- Quick wins: wire verification:live warn-only into release.yml; eval:gate fail-closed; macOS smoke runner; release.ts runs full gate suite pre-tag.
