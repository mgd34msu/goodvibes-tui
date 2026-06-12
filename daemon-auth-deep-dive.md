# Deep Dive: Daemon, Remote Access & Auth

**Generated**: 2026-06-11 ~20:35 | Scores: auth security 8.5, transport security 6.5, remote-setup UX 7.5, multi-user maturity 5.5, tests 6

## CRITICAL — C1: rate-limiter granularity collapses behind the Cloudflare tunnel
`http-listener.js:262` keys throttling on extractForwardedClientIp(req, trustProxy). Behind the tunnel with trustProxy=false: ALL remote clients share one 5/min /login budget (self-lockout + loss of per-attacker brute-force granularity). With trustProxy=true and unvalidated headers: attacker rotates x-forwarded-for to bypass the limiter entirely. FOR THE OWNER'S REMOTE-DRIVING SETUP THIS IS THE HIGHEST-STAKES DEFECT. Fix: trust only CF-Connecting-IP validated against Cloudflare's published ranges; tunnel wizard auto-configures trustProxy + trusted header. (TUI wizard part editable here; validation logic is SDK.)

## High
- H1: TLS opt-in with no wizard nudge — network mode over plaintext lets LAN attackers sniff bearer tokens/cookies. Wizard must warn hard or require TLS when hostMode≠local. (TUI)
- H2: SDK atomicWriteSecretFile does tmp+rename but NO fsync(file)+fsync(dir) — auth rotations/deletions can revert on power loss. TUI's own atomic-write.ts does this right. (SDK)
- H3: No per-account lockout — only IP throttling. (SDK)

## Medium
- M1: enforceCors fully built in SDK, never wired into the TUI wizard — network/browser exposure runs permissive CORS. Classic unfinished decision. (TUI)
- M2: /local-auth rotate-password takes the password in argv → shell history leak; masked panel path exists, CLI should warn/redirect. (TUI)
- M3: cleartext auth-bootstrap.txt lingers indefinitely for non-wizard bootstrap users. Auto-retire post-first-login. (SDK+TUI)
- M4: 429s lack Retry-After. (SDK)

## What's genuinely strong
scrypt + per-user salt + timingSafeEqual; 256-bit session tokens, 1h TTL, fingerprint-only logging; HttpOnly/SameSite/Secure cookies; no-enumeration login errors; structured AUTH_FAILED/SUCCEEDED audit events + OTel counters; loopback-by-default with a deliberate danger-gate for network exposure; wizard forces credentials BEFORE any listener exposure (good design, three validation layers confirmed — the earlier empty-admin-password concern is mitigated in current code).

## Earlier finding resolved
The "apply proceeds with empty admin password" review finding is defended today at 3 layers (wizard required-gate → apply.ts:56 throws on empty → SDK addUser rejects <8 chars). The TASK-013 pre-apply UX gate remains worthwhile for friendlier failure, but the security hole is closed.

## Priority list
1. C1 trustProxy/CF-Connecting-IP (wizard + SDK validation)
2. H1 TLS nudge/require for network mode (TUI wizard)
3. H2 fsync parity in SDK secret writer (SDK handoff)
4. H3 account lockout (SDK handoff)
5. M1 wire enforceCors into wizard (TUI)
6. M2 masked password entry (TUI)
7. M3/M4 bootstrap retire + Retry-After
8. Tests: limiter behavior, forwarded-IP spoofing, durability, SDK empty-password regression
