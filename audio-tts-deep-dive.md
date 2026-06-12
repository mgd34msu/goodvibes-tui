# Deep Dive: Audio/TTS — VERDICT: FINISH (high confidence)

**Generated**: 2026-06-11 ~21:05 | Scores: completeness 8, UX 7, robustness 9, tests 8

NOT an abandoned experiment — a finished, well-engineered feature: production-wired in main.ts, full config surface + pickers, per-turn LLM routing (Proxy override that auto-restores), 18+ tests with proper injection seams, 6 docs, graceful degradation without mpv/ffplay, correct STREAM_END-is-non-terminal handling, serialized playback chain, per-chunk AbortControllers.

Engine: SDK VoiceService (OpenAI/ElevenLabs streaming) → local mpv/ffplay subprocess. Trigger: opt-in per turn via /tts.

## Finish list (each independently shippable, docs ship with each)
1. `tts.enabled` persistent toggle (+ /tts on|off) — "always speak" mode | S
2. `tts.speed` surfaced through synth options + modal (verify SDK accepts speed first) | S
3. Explicit config defaults for all tts.* keys (typed rows on fresh profiles) | S
4. Integration smoke test for the main.ts wiring seam (full event sequence → bytes reach player) | S
5. Optional: one-time install-guidance hint when no player found | XS

Strip plan: not needed; flip condition = SDK VoiceService removal or product de-scope (neither indicated).
