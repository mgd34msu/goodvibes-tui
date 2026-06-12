# Codebase Review Report — UX-First Deep Review

**Project**: goodvibes-tui
**Generated**: 2026-06-11T19:45:00-05:00 (regenerated 20:15 after unexplained deletion — see .goodvibes/logs/errors.md)
**Method**: 6 parallel review agents, custom UX-weighted rubric (71% user-facing dimensions)
**Overall Score**: 5.3/10 (weighted)

## Executive Summary

- Critical: 2 issues (dead keys in eval-panel; onboarding loses all progress on quit)
- High: 13 issues
- Medium: 14 issues
- Low: 7 issues

**The through-line**: in nearly every dimension, the right infrastructure was built and then never connected to the user-facing end. The tokenizer standardized lowercase key names — panels never migrated. A typed system-message severity system exists — error navigation greps `/error/i` strings. Wizard snapshot capture/restore is fully implemented — never persisted to disk. `TURN_ERROR` is consumed by six peripheral surfaces — not the transcript. Atomic writes exist in one store — three others do bare `writeFileSync`. `version: 1` is stamped on ~25 write paths — no read ever checks it. Type-extraction leaf files exist (`cli/types.ts`, `onboarding-wizard-types.ts`) — the central types were left behind, causing 14 of the 15 circular dependencies. This codebase does not need redesign; it needs ~30 last-mile completions.

## Score Breakdown

| # | Dimension | Weight | Score | Grade | Key issue |
|---|-----------|--------|-------|-------|----------|
| 1 | Interaction & Input UX | 15% | 4.0 | D | Dead arrow/Enter/Escape keys in 3 panels (casing mismatch vs tokenizer) |
| 2 | Visual Rendering & Layout | 12% | 7.0 | B- | Strong compositor; no NO_COLOR/light-theme support |
| 3 | Feedback & Responsiveness | 12% | 6.0 | C | No elapsed time/TTFT anywhere; static `...` on running tools |
| 4 | Error Experience & Recovery | 12% | 6.0 | C | Transcript never subscribes to TURN_ERROR; raw error.message shown |
| 5 | Onboarding & First-Run | 10% | 5.0 | C- | Quit mid-wizard = total loss + no re-prompt; `required` unenforced |
| 6 | Command Surface Consistency | 10% | 4.0 | D | 2 duplicate command names, 4 alias collisions, last-write-wins registry |
| 7 | Architecture Coherence | 10% | 4.0 | D | 15 circular deps from one repeated unfinished pattern; no layer direction |
| 8 | State & Data Integrity | 7% | 5.0 | C- | Torn-write risk in 3 stores; RMW race on acknowledgements |
| 9 | Performance | 6% | 6.0 | C | Full markdown re-parse per delta; per-cell cursor addressing |
| 10 | Test & Quality Posture | 6% | 7.5 | B | 493 files, zero skips; but zero coverage instrumentation |
| | **Weighted total** | 100% | **5.3** | **C-** | |

## Detailed Findings

### 1. Interaction & Input UX (4.0/10)

| Sev | Finding | Location | Fix | Effort |
|-----|---------|----------|-----|--------|
| CRIT | eval-panel arrows/Enter/Escape dead — 7 comparisons against `'ArrowUp'`/`'Enter'`/`'Escape'`; tokenizer emits lowercase only | `src/panels/eval-panel.ts:143,148,153,164,169,178` | Lowercase names; tokenizer-fed panel test | S |
| HIGH | subscription-panel arrows dead, Enter works | `src/panels/subscription-panel.ts:104,110` vs `:116,129` | `'up'`/`'down'` | S |
| HIGH | knowledge-panel dead `'Enter'` + dead ArrowUp shim | `src/panels/knowledge-panel.ts:152,190-191` | Remove shims, lowercase | S |
| HIGH | Delete key = 3 behaviors: delete-backward / no-op / wipe-draft-no-undo | `search-focus.ts:19`, `handler-modal-routes.ts:139`, `project-planning-panel.ts:107-115` | One policy; confirm destructive clear | M |
| MED | 3 confirm conventions: y/n (Enter ignored), Enter/x, q-only exits | `confirm-state.ts:38-39`, `subscription-panel.ts:116,129`, `forensics-panel.ts:120,127` | Enter/y confirm, Esc/n cancel everywhere | M |
| MED | handleInput(key: string) untyped across 40+ panels — root cause | `src/panels/types.ts:38` | KeyName union | M |
| LOW | Panel-first escape consumption undocumented | `handler-feed-routes.ts:62-75` | Document + test | S |

### 2. Visual Rendering & Layout (7.0/10) & 9. Performance (6.0/10)

| Sev | Finding | Location | Fix | Effort |
|-----|---------|----------|-----|--------|
| HIGH | No color-capability gate: NO_COLOR/TERM=dumb ignored, truecolor always | `src/renderer/diff.ts:79-128` | Probe + downsample | M |
| HIGH | Hardcoded dark-theme hex (code `#ffcc00` on `#1a1a1a`, headers `#00ffff`, links `#00aaff`, search `#806600`) | `markdown.ts:104,115,303,305`, `compositor.ts:259-261`, `conversation-rendering.ts` | Theme tokens | M |
| MED | Per-cell cursor address, no run-coalescing (~200 seqs per changed row) | `diff.ts:40-50` | Run-coalesce | M |
| MED | Highlight cache keyed on full-code hash — ~50 wasted parses per streamed block | `syntax-highlighter.ts:470-484,490-531` | Finalize-only highlight | M |
| MED | Full markdown re-parse of entire message per delta | `conversation.ts:185-194` | Incremental tail render | M |
| MED | getDisplayWidth/wrapText ANSI-unaware (latent) | `terminal-width.ts:6-83` | Strip SGR internally | S |
| LOW | Resize = full repaint per event, no debounce | `main.ts:221-225` | Debounce 30-50ms | S |
| LOW | Fence detection misses ~~~, info strings, indented fences | `markdown.ts:74` | Broaden regex | S |

Positive: double-buffer + dirty-row diff, correct CJK widths, OSC-8 links, ANSI sanitization; settings-modal twin files are a genuine controller/render split, not a fork.

### 3. Feedback (6.0/10) & 4. Error Experience (6.0/10)

| Sev | Finding | Location | Fix | Effort |
|-----|---------|----------|-----|--------|
| HIGH | No elapsed/TTFT anywhere; streamStartTime captured, never rendered | `ui-factory.ts:384`, `main.ts:596-607,713-721` | Render elapsed + TTFT | S |
| HIGH | Transcript never subscribes TURN_ERROR (6 peripheral surfaces do) | `main.ts:688-737` | Humanized handler + action | M |
| MED | Token speed counts deltas, off by default; real counter at main.ts:603 | `main.ts:596,719-721` | Real tokens, default on | S |
| MED | Executing tools render static `...` | `tool-call.ts:177-178` | Live elapsed | S |
| MED | Raw error.message interpolated into banners | `main.ts:212-217`, `bootstrap-command-parts.ts:229` | formatUserFacingError classifier | M |
| LOW | Error-jump = /error/i substring despite typed SystemMessageKind | `conversation.ts:73-74,448-477` | Typed severity registry | M |
| LOW | No stream-stall watchdog | `main.ts:710-721` | 30s no-delta hint | M |

Positive: zero empty catches in non-test src (4 commented best-effort sites), crash recovery, auto-save, cascade detection.

### 5. Onboarding (5.0/10) & 6. Command Surface (4.0/10)

| Sev | Finding | Location | Fix | Effort |
|-----|---------|----------|-----|--------|
| CRIT | Onboarding marked shown on OPEN; zero disk persistence — quit = total loss, no re-prompt | `onboarding-wizard-steps.ts:785`, snapshot infra unused `handler-onboarding.ts:175,193` | Shown-on-apply; persist; resume prompt | M |
| HIGH | `required` cosmetic — apply proceeds with empty admin password | `onboarding-wizard-apply.ts:21-178` (0 checks), `steps.ts:660,673` | Pre-apply gate | M |
| HIGH | Alias collisions silently shadow (p, kb, sess, know); lint test skips check claiming impossible | `command-registry.ts:237-241`, `command-aliases-lint.test.ts:9-10` | Throw + static assertion | S |
| HIGH | 2 duplicate primary names: knowledge (×2), session (×2) — one handler unreachable | `knowledge.ts:133`+`control-room-runtime.ts:199`; `session.ts:325`+`session-workflow.ts:446` | Rename + guard | S |
| MED | No --yes/--force/--non-interactive in 26-flag CLI | `cli/parser.ts`, `types.ts` | Global -y | M |
| MED | Overlapping flags: --host/--hostname; --json/--output/--output-format | `cli/types.ts` | Consolidate | S |
| LOW | No naming grammar across 110+ commands | `commands/*` | Grammar + lint | M |

Positive: wizard step navigation solid; Cloudflare/external surfaces correctly opt-in; /commands, /help, autocomplete exist.

### 7. Architecture (4.0/10) & 8. State Integrity (5.0/10)

| Sev | Finding | Location | Fix | Effort |
|-----|---------|----------|-----|--------|
| HIGH | CLI cluster: 4 cycles via CliCommandRuntime back-import; cli/types.ts exists | `service-command.ts:2`, `bundle-command.ts:12` | Move type → kills 4 | S |
| HIGH | Wizard: types file exists, Controller left behind — 7+ cycles | `onboarding-wizard-apply.ts:19`, `steps.ts:12` | Finish extraction | M |
| MED | handler: *ForHandler functions import concrete class — 3 cycles | `handler-interactions.ts:7`, `handler-onboarding.ts:12` | Interface leaf | M |
| MED | No layer direction: renderer→input(18), input→renderer(5), core→renderer(4), core→input(1) | various | Enforce core→renderer→input | L |
| HIGH | Bare writeFileSync in 3 stores (torn-write); work-plan-store has correct pattern | `input-history.ts:244`, `state.ts:137`, `markers.ts:144` | Shared atomic helper | S |
| HIGH | Unguarded RMW on acknowledgements (daemon+TUI) — lost updates | `state.ts:120-135` | Single authority/lock | M |
| MED | version:1 stamped ~25 paths, zero read-side migration | `state.ts:123`, `markers.ts:135`, `types.ts:312,321` | readVersioned helper | M |
| LOW | 12 files ≥29KB; cycle hubs = most-edited UX surfaces | sizes verified | Extractions + splits | L |

### 10. Tests (7.5/10) + Hygiene

| Sev | Finding | Location | Fix | Effort |
|-----|---------|----------|-----|--------|
| HIGH | Zero coverage instrumentation (no bunfig, no thresholds, 493 test files) | `package.json:44`, `run-tests.ts:46` | bunfig + ratchet | M |
| HIGH | Temp leak: makeProjectTempDir no cleanup; runner sweeps only .test-tmp/suite | `project-temp.ts:13-14`, `run-tests.ts:7,26,43,56` | Sweep + auto-teardown | S |
| MED | Resize handler zero tests | `main.ts:761` | Behavior test | S |
| LOW | Backspace/Delete byte mapping unpinned | `main.ts:725,739` | Byte-level test | S |
| LOW | Two temp-dir helpers, divergent cleanup | `setup.ts:78-86` | Consolidate | S |
| INFO | .test-tmp/ + .goodvibes/state/ gitignored — secret-scan hits cannot leak via repo | `.gitignore:17,29` | Scope scanners | — |
| INFO | ~/CLAUDE.md (outside repo) held leftover temp-password note | — | User cleared | — |

## Unfinished Design Decisions (23 — the full list)

1. Tokenizer lowercase vocabulary — panels never migrated
2. KeyName typing never added to 40-panel contract
3. delete/backspace split — consumers never reconciled
4. ConfirmState built — 2 surfaces ignore it
5. onboarding-wizard-types.ts created — controller type left behind (7+ cycles)
6. cli/types.ts created — CliCommandRuntime left behind (4 cycles)
7. *ForHandler sharding — interface never extracted (3 cycles)
8. Atomic write proven once — never propagated
9. version:1 stamped — no reader consumes it
10. Snapshot capture/restore built — persistence never connected
11. field.required in types+labels — gate never built
12. "Apply & Continue" label — nothing commits until Review
13. Alias-collision risk documented — check skipped as "impossible" (it isn't)
14. streamStartTime captured — elapsed/TTFT never built
15. Real token counter tracked — display uses delta count, off by default
16. Typed SystemMessageKind — error-jump greps strings
17. TURN_ERROR consumed by 6 surfaces — transcript left out
18. NO_COLOR honored for children — never for own renderer
19. sanitizeColor chokepoint built — token vocabulary never built on top
20. Tree-sitter built — cache thrash makes regex path permanent
21. Custom runner built — coverage never wired
22. Two temp helpers — cleanup unified in none
23. decisions.json: 14 SDK entries, 0 module-boundary decisions — layering accreted by default
