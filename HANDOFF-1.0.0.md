# HANDOFF — Road to 1.0.0

**Written:** 2026-06-12, at the weekly usage wall. **Session:** "1.0.0 gates".
**Repo state at writing:** main @ `c998f2ae` (chore: release 0.24.0), tree clean, all work review-gated and pushed.

---

## 0. FIRST ACTION ON RESUME — finish the 0.24.0 release (if not already done)

A background sequence was relaunched at the wall to finish this; verify whether it completed:

```sh
git tag -l v0.24.0                      # exists?
npm view @pellux/goodvibes-tui version  # 0.24.0?
```

If npm shows 0.24.0 → done, skip to §1. If not, finish manually:

1. `gh run list --branch main --limit 1` — confirm CI green on `c998f2ae` (or current HEAD).
2. `git tag v0.24.0 && git push origin v0.24.0` — release.yml takes over (validate → 4-target builds → smoke → GitHub release → npm).
3. `gh run watch <release-run-id> --exit-status` — note: this is the **first live run of the new macOS smoke job** (added in `bf9eaef8`, structurally validated only). If it fails on something environmental (e.g. sqlite-vec addon path on darwin), it is release-blocking by design — fix is likely one line in `scripts/post-build-smoke.ts` or the workflow artifact wiring.
4. Confirm `npm view @pellux/goodvibes-tui version` → 0.24.0.

Known stale-failure noise: 13 background agents show "failed" from the process exit — ALL of their chains were already resolved and committed before the wall. Ignore them.

---

## 1. Program rules (unchanged, owner-mandated)

- WRFC with minimum score **10 = zero issues of any severity**; orchestrator owns ALL commits; agents never commit/stash/reset/checkout.
- Execute runtime `<gv>` directives immediately; **decline phantom-pass** (`complete` on sub-10 scores) and log it.
- Three-strikes orchestrator takeover; micro-fix prescribed remedies directly (still verified by gates).
- Docs ship WITH features. No planning IDs in code. No `any`. Releases as 0.x minors: CHANGELOG + bump → push → CI green → tag → release.yml → confirm npm.
- Agents die silently when the orchestrator idles (~25 min) — salvage verdicts from `tasks/<id>.output` transcripts (grep `REVIEW_COMPLETE`/`TASK_COMPLETE`) before respawning.
- For wiring-class features: enumerate EVERY caller of the load/restore primitive and require one e2e test per seam (lesson from the WAL 4/10).

## 2. DONE — for the record (do not rebuild)

- **All 31 remediation tasks + entire dive backlog (TASK-001..088)**: closed. Verify-close sweep (commit `51bf591e`) confirmed 38 stale checkboxes shipped across 0.21–0.23; suite-interference (TASK-088) verify-closed clean.
- **E-track landed:** E2 (composer editing), E4 (transcript search), E6, E7, E9 (push notifications), E10 (one-key retry), E11 (full failover track incl. cost delta, synthetic chain UI, health convergence), E12 (doctor + `/health term`), E13 (WAL journal, all three resume seams), E14, E18, E20. **E17 CANNED** by owner decision (terminal-dependent; `[image N]` slugs stay; see `.goodvibes/logs/decisions.md` — half-block mosaic alternative needs explicit owner sign-off).
- **F2 cockpit**: shipped in 0.22.0 (roster, real cost/tokens, stall flags, cancel everywhere). **UI-4/5/6**: shipped (verify-close confirmed).
- **P1/P2/P3**: shipped (golden frames, perf budgets fail-closed, architecture gate with Tarjan cycles + 8 layer rules).
- Releases shipped: 0.21.0, 0.22.0, 0.23.0 (all on npm), 0.24.0 (in flight per §0).

## 3. OUTSTANDING — the complete 1.0.0 gate

### 3a. E-track remainder (owner ordered "do the e-track enhancements" — this is the unfinished part of that order)

| ID | Item | Effort | Notes |
|---|---|---|---|
| E1 | User keybindings file + chords; KeyName union as schema vocabulary | M | Pair with E19. Defaults-collision lint already exists (keybindings.test.ts) — extend to user files |
| E19 | Contextual `?` help per panel (generated keymaps, can't go stale) | M | Builds on E1; overlaps UI-1 keymap-footer helper — sequence E1/E19 with UI-1 |
| E3 | Mouse: scroll, click rows, click OSC-8 links | M | compositor OSC-8 hooks exist |
| E8 | Turn replay scrubbing | M | session-export infra exists |
| E16 | Tree-sitter as ONLY highlighter; delete 5 regex tokenizers | M | finalize-only highlight already landed |
| E15 | Virtualized transcript (viewport-only compositing) | **L** | long play; double-buffer compositor is the base |
| E21 | Plugin API (panels/commands/providers) | **L** | long play; registry + panel contract are the base |

### 3b. Flagship Five remainder

| ID | Item | Effort |
|---|---|---|
| F1 | Universal fuzzy palette (Ctrl+K): commands, panels, sessions, models, settings, recent files | M |
| F5 | Adaptive theming: OSC 11 background detection, 3 built-in themes, user theme files | M |
| F4 | Zero-config first chat: env-key detect → best model → chatting <2s; wizard becomes opt-in `/setup` | M |
| F3 | Inline diff review: agent edits as unified diffs in-transcript, per-hunk y/n/a | **L** |

Roadmap sequencing: F1 → F5 → F4 → F3 (F2 done).

### 3c. UI Redesign track remainder (`ui-design-audit.md`)

| ID | Item | Effort |
|---|---|---|
| UI-1 | `buildKeymapFooter` helper in polish.ts + migrate all 52 inline footers across 31 files | M |
| UI-2 | Panel FRAME standard (bordered title bar matching modal language) + summary-strip anatomy | M |
| UI-3 | One canonical selection treatment (buildPanelListRow); kill the other two mechanisms | M |
| UI-7 | Modal key/value section renderer (kill flat text dumps); scroll gutter affordance | M |
| UI-8 | Palette sourcing consolidation via extendPalette; migrate 23 hand-rolled panels onto base classes; delete agent-logs dead helpers | M/L |

(UI-4/5/6 verified shipped — only verify against the audit's ASCII sketches if re-diving.)

### 3d. K-track — self-improving knowledge system (all open; owner-protected: keep + elevate)

| ID | Item | Effort |
|---|---|---|
| K1 | Auto-injection at agent spawn: scoped memory + graph packets via selectKnowledgeForTask/packets.buildPrompt (bridge exists, unwired) | M |
| K2 | Outcome feedback loop: reinforce records injected into successes, flag failure-correlated (the self-improving core) | **L** |
| K5 | Auto-capture candidate memories → `/recall review` queue | M |
| K3 | Graph↔memory promotion (the two stores never talk) | M |
| K4 | Scheduled consolidation surfaced in the review queue | M |
| K6 | Knowledge health panel (stats, stale sources, injection hit-rate) | M |

Sequencing: K1 → K2 → K5 → K3/K4 → K6.

### 3e. Process

- **P4**: coverage ratchet bot (builds on the coverage gate). P5 is ongoing practice, not a work item.

### 3f. Planning capstone (LAST feature track, before final re-dives)

- Orchestrator writes the full design spec (principles locked in `remediation-plan.md` PLAN-TRACK section: explicit invocation only, plans as durable schema-versioned objects, WRFC/cockpit/K-track integration, honest UX).
- **Spec goes to the owner for review BEFORE any implementation.**
- Implementation through normal min-10 WRFC gates.

### 3g. Exit criteria (DEFINITION OF DONE in remediation-plan.md)

1. **Re-dive all 15 subsystems to 10/10 on every dimension** (audio/TTS is the ready first candidate — its finish-track completed). SDK-capped dimensions documented instead of faked.
2. **Final full 10-dimension UX-first review re-run** — baseline 5.3, target 10/10 weighted; any shortfall spawns a new wave and the loop continues.
3. **v1.0.0**: CHANGELOG, bump, green CI, tag, npm. (Pre-1.0 versioning policy ends only when the owner says so.)

## 4. Routed OUT of 1.0 scope (do not pull back in)

- **SDK session** (`../goodvibes-sdk/HANDOFF-FROM-TUI-SESSION-20260611.md`, Items 1–9 + 5b): phantom-pass directives, agent watchdog, auth hardening (CF-Connecting-IP), session durability APIs (snapshot/restore — blocks `/compact-history` restore), `requiresRestart` on ConfigSetting (TASK-050 partial), `enforceCors`/`allowedOrigins` in ConfigKey union (TASK-037 partial), retry-in-place.
- **Claude-plugin fixes**: directive treadmill noise, silent agent deaths — evidence accumulated in `.goodvibes/logs/errors.md`.
- **E17 inline images**: canned (owner, 2026-06-12).

## 5. Suggested wave order on resume

1. §0 release finish-out (0.24.0 on npm).
2. Wave: E1+E19+UI-1 (keybinding/help/footer cluster) ∥ E3 mouse ∥ E16 tree-sitter ∥ F1 palette ∥ E8 replay ∥ F5 theming (6 chains, file-disjoint).
3. Wave: UI-2/3/7/8 ∥ F4 ∥ K1 (then K2 needs K1's signal).
4. Wave: E15 ∥ E21 ∥ F3 (the three long plays) ∥ K2 → K5 → K3/K4/K6 ∥ P4.
5. Capstone spec → owner review → build.
6. Re-dive sweep (15 subsystems) → fix waves → final 10-dimension UX re-run → v1.0.0.

Interim releases (0.25.0, 0.26.0…) after each wave that lands cleanly — keep banking on npm.
