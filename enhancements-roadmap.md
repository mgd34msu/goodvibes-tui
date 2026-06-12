# Enhancements Roadmap — Best-in-Class Targets

**Generated**: 2026-06-11 (regenerated 20:15 after unexplained deletion)
**Premise**: separate from the 31 remediation tasks. Those finish what exists; this takes each surface past Claude Code / Gemini CLI / Codex parity. "Builds on" cites existing infrastructure — most items are NOT greenfield.

## The Flagship Five

### F1. Universal fuzzy palette (Ctrl+K)
One overlay fuzzy-searching everything: 110+ commands, panels, sessions, models, settings, recent files. Solves discoverability permanently.
- Builds on: command registry getAll(), autocomplete-overlay, panel infra | Effort: M

### F2. Live multi-agent cockpit
The runtime engine (WRFC chains, event bus, agent telemetry) is the product's unique asset — invisible today. Panel with live agent tree, per-agent status/elapsed/tokens, kill/inspect actions.
- Builds on: runtime events (agent:spawned/progress/completed), panel system | Effort: M-L

### F3. Inline diff review with accept/reject
Agent edits render as unified diffs in-transcript with per-hunk y/n/a.
- Builds on: diff-dirty-bitmap test infra, compositor, KeyName work | Effort: L

### F4. Zero-config first chat
Detect env keys → best model → chatting in <2s. Wizard becomes opt-in /setup.
- Builds on: TASK-012 persistence, provider registry | Effort: M

### F5. Adaptive theming with OSC 11 background detection
Auto dark/light token set + 3 built-in themes + user theme files. Natural completion of TASK-022/023.
- Builds on: term-caps probe (landed), sanitizeColor chokepoint | Effort: M

## Interaction
| ID | Enhancement | Builds on | Effort |
|----|-------------|-----------|--------|
| E1 | User keybindings file + chords; KeyName union as schema vocabulary | tokenizer + TASK-002 | M |
| E2 | Composer: undo/redo, kill-ring, word-nav, multi-line indicator | composer-state, input-history | M |
| E3 | Mouse: scroll, click rows, click OSC-8 links | compositor OSC-8 | M |
| E4 | Transcript search (/) with highlight + n/N | search highlight in compositor:259 | S-M |
| E5 | Vim mode for composer | tokenizer modes | L |

## Liveness & Transparency
| E6 | Rich status line: model · ctx% · cost · tok/s · elapsed · agents | TASK-006/008 + cost-tracker | S after W2 |
| E7 | Context meter + compaction preview | compactTriggered machinery | M |
| E8 | Turn replay scrubbing | session-export infra | M |
| E9 | Push notifications on long-task completion | runtime_external webhook listener + 4 normalizers (unused!) | S-M |

## Resilience
| E10 | One-key retry: r retry, m model-picker, from TASK-009 errors | TASK-009 classifier | S after W2 |
| E11 | Provider failover policy (opt-in auto-switch) | provider registry, TURN_ERROR | M |
| E12 | goodvibes doctor: keys, term caps, daemon, state integrity | runtime_status checks, term-caps | S-M |
| E13 | WAL-style transcript journal (SIGKILL-proof) | atomic-write helper + auto-save | M |

## Rendering
| E14 | ✅ LANDED with TASK-022: DEC 2026 synced output | diff emit path | S |
| E15 | Virtualized transcript (viewport-only compositing) | double-buffer compositor | L |
| E16 | Tree-sitter as only highlighter; delete 5 regex tokenizers | TASK-024 finalize-only | M |
| E17 | Inline images (Kitty/iTerm2/sixel) | term-caps probe | L |

## Command Surface & Ecosystem
| E18 | Shell completions generated from registry | TASK-003 | S |
| E19 | Contextual ? help per panel (generated keymaps, can't go stale) | KeyName + keybindings | M |
| E20 | /share → sanitized HTML/markdown transcript export | session-export + ansi-sanitize | M |
| E21 | Plugin API (panels/commands/providers) | registry + panel contract | L |

## K-Track — Self-Improving Knowledge System (owner-protected: keep + elevate)

The graph (SDK KnowledgeApi) stays, period. These make it live up to "self-improving":

| ID | Enhancement | Builds on | Effort |
|----|-------------|-----------|--------|
| K1 | Auto-injection at agent spawn: top-N scoped memory + relevant graph packets injected into every agent task via selectKnowledgeForTask/packets.buildPrompt (today operator-only) | injection bridge exists, unwired | M |
| K2 | Outcome feedback loop: when a turn/chain succeeds or fails, feed the result back — reinforce records that were injected into successes, flag ones present in failures for review (the self-improving core) | WRFC chain outcomes + memory review states | L |
| K3 | Graph↔memory promotion: promote high-value ingested nodes into durable memory records and vice versa; today the two stores never talk | KnowledgeApi.consolidation + memory promote | M |
| K4 | Scheduled consolidation: periodic dedup/merge-candidate detection for memory (graph already has consolidation jobs); surfaced in the review queue | memory registry + review UX | M |
| K5 | Auto-capture candidates: detect decision/constraint/incident-shaped moments in conversations and queue them as suggested memory records (operator approves via /recall review) | recall capture/review pipeline exists | M |
| K6 | Knowledge health panel: graph stats, stale-source detection, injection hit-rate, top-consulted records — make the self-improvement visible | panel system + K2 telemetry | M |

Sequencing: K1 first (single highest-leverage wire, unblocks K2's signal), then K2 → K5 → K3/K4 → K6. Consolidation cleanups from memory-duality-deep-dive.md (scope-filter no-op, panel merge, naming) land BEFORE K-track so the surfaces being elevated are the clean ones.

## Engineering Process
| P1 | Golden-frame pty snapshot tests | compositor determinism | M |
| P2 | Perf budgets in CI (startup <150ms, frame <16ms, O(delta) streaming) | render-perf.test.ts | M |
| P3 | Layer-boundary + cycle enforcement in CI | TASK-021 | S after W5 |
| P4 | Coverage ratchet bot | TASK-025 | S after W7 |
| P5 | UX decision log in .goodvibes/memory (fixes "0 architecture decisions") | goodvibes memory | S, ongoing |

## Sequencing
- Quick wins between waves: E18, E9, E6, E10 (E14 already landed)
- Flagship arc after Wave 5: F1 → F5 → F4 → F2 → F3
- Long plays: E15, E21, E17
- P1/P2 alongside Wave 6

> E17 status (2026-06-12, owner decision): CANNED. Terminal-graphics protocols are inherently terminal-dependent (Kitty/iTerm2/sixel coverage gaps in Alacritty, GNOME Terminal, tmux); images continue to render as [image #] text slugs identically everywhere. The one universal alternative (half-block mosaic preview, identical in all truecolor terminals) is recorded in .goodvibes/logs/decisions.md and requires explicit owner sign-off before any build.
