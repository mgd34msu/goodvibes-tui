# Deep Dive: Onboarding as a Product — Redesigned Flow Spec

**Generated**: 2026-06-11 ~22:40 | Read-only; full spec with file:line carriers

## Today
First run = full 8-step wizard, always (no env-key short-circuit, no opt-in path). Minimum 5 screens before chat on the leanest path; realistically 20-40 decisions. Marker written ON OPEN (handler-interactions.ts:14-26) — quit at step 1 and you're never re-prompted (the Review step literally says "Already marked as shown"). Env-key alias map EXISTS (derivation.ts:13-47) but is never checked against live process.env. "Apply & Continue" label lies (nothing persists until Review). No resume artifact. No broken-key repair path. The auth-before-exposure gate is correct and must be preserved in any redesign.

## The redesign (three paths)
- **Path A — zero-config** (keys detected): skip the wizard entirely; auto-pick provider+model; one non-blocking banner stating what was chosen and how to change it (/setup, /model). 0 decisions to chat.
- **Path B — no keys**: ONE lean screen — provider pick + masked key + live validation → chat. 1-2 decisions. Servers/integrations deferred to /setup.
- **Path C — full /setup** (opt-in): current steps regrouped into honest sections; auth gate verbatim in Section 3; the C1/TLS/CORS security nudges (TASK-035/036/037) land in Section 5 and never gate A/B; honest per-section save semantics.
- **Resume**: onboarding-progress.json (atomic, debounced) + Resume/Start-over/Skip prompt at startup; deleted on apply.
- **Broken-key repair**: 401-class provider error → targeted micro-prompt (re-enter / switch / /setup) + retry the pending turn; never the full wizard.
- **Honest marker**: written on APPLY success (apply.ts), never on open; Path A marks on first successful chat turn.

## Task breakdown (sequenced)
1. TASK-012a remove open-time marker write (S, handler-interactions.ts:14-26) + TASK-012b marker-on-apply + Review text fix (S) + TASK-014 label honesty (S) — FIRST SLICE
2. TASK-F4a detectEnvProviderKeys + pickDefaultModelForProvider (S/M, beside derivation.ts)
3. TASK-F4b Path A startup branch + banner (M, tui-startup.ts — wait for CLI chain commit) ; TASK-F4c Path B lean screen (M)
4. TASK-012c progress artifact (M, markers.ts + atomicWriteFileSync) ; TASK-012d resume prompt (M)
5. TASK-013 required-field section gate (S)
6. TASK-C1 wizard becomes opt-in + section regroup (M) ; TASK-035/036/037 nudges in Section 5 (M/L)
7. TASK-BK1 broken-key micro-prompt (M)

Open verification points: apply-success hook location in runtime/onboarding/apply.ts; whether a reusable validate-credential call exists; Path A marker-on-first-turn vs never-until-setup (owner UX call — flagged).
