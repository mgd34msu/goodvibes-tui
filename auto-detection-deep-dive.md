# Deep Dive: Project & Plan Auto-Detection — Verdict: STRIP (high confidence; owner sign-off required)

**Generated**: 2026-06-11 ~22:50

## Two subsystems, only one is the problem
- **Project Planning auto-coordinator (the "horrible" half)**: regex intent-matching (including bare `\bplan\b`) runs on EVERY chat message (main.ts:334). On match: writes planning state to the knowledge store 3×, auto-opens the 28KB planning panel, and — worst — returns handledLocally:true so main.ts SWALLOWS YOUR TURN: the message never reaches the LLM. Once active it intercepts every subsequent turn until a cancel phrase. No config flag, no off switch. The panel's interactive answer path literally throws 'Planning answer submission is not wired yet' (bootstrap-shell.ts:119).
- **Work Plan (/workplan)**: fully manual, atomic-write-backed TODO store. Fine. Not implicated.

## Evidence for strip
- Zero downstream consumers: WRFC/sessions/agents never read planning output (grep-confirmed).
- Four rescue commits on this exact subsystem (1dae8a6e, debd3a93, e13b0885, 03e6a467); panel edited again TODAY — chronic maintenance magnet.
- The trigger is structurally unfixable: 'plan' is an unavoidable word in a coding agent.
- Worst failure mode in the product: silently eating user messages.
- Manual replacements ALREADY EXIST: /plan <goal> (seed), /plan panel, /workplan. Stored state stays readable. No migration needed.

## Options (costed)
1. **STRIP** — delete coordinator (544 LOC) + its test, remove main.ts call site (~70 LOC); KEEP /plan, /workplan, and the panel behind /plan panel. ~1-2h, near-zero risk. ← RECOMMENDED
2. **FIX** — opt-in config flag, no turn-swallowing, explicit affordance instead of regex, wire the answer path. 1-2 days, HIGH residual risk (the rescue-commit history says this feature resists fixing).
3. **SHRINK** — just unhook the call site (~30 min); leaves 620 LOC dormant dead weight.

Flip condition for FIX: a planned hard integration where planning state gates real execution (none exists today).
