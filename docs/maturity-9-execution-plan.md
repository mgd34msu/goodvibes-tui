# GoodVibes TUI 9/10 Maturity Execution Plan

This plan targets product maturity without relying on wizard end-to-end testing or cross-terminal manual testing. The goal is to make the TUI operationally clear, scriptable, secure by default, diagnosable, and release-verifiable.

## Deployment Strategy

1. Ship improvements in small releasable slices.
2. Each slice must include focused tests, local quality gates, and an explicit completeness check.
3. Prefer additive output fields and clearer text over disruptive command changes.
4. Keep breaking compatibility shims out of scope while the project is pre-1.0.
5. Use `doctor` as the primary operator-facing truth surface for posture and remediation.
6. Use JSON CLI contracts for automation and text output for operator clarity.
7. Keep release gates green after every slice.

## Areas And Tasks

### Product UX

- Make `doctor` actionable: every warning includes cause, impact, and next action.
- Improve provider/model labeling with setup class: local, no-key/free, subscription, API-key, self-hosted, cloud-account, unknown.
- Make dangerous states explicit: LAN exposure, unauthenticated network surfaces, listener enabled, permissive permissions.
- Add clearer empty states for providers, models, sessions, tasks, services, surfaces, and secrets.
- Expand user-facing terms at least once where they matter: Human-in-the-Loop (HITL), control plane, listener, daemon, surface.

### CLI

- Define stable command contracts for `status`, `doctor`, `providers`, `models`, `secrets`, `surfaces`, `listener test`, `control-plane status`, `bundle`, and `run`.
- Lock JSON output schemas with tests.
- Lock exit codes for usage error, config error, auth error, unavailable service, failed operation, and success.
- Improve `run --output stream-json` event shape and document it.
- Add command-level help for major command families.
- Keep aliases only where they reduce friction and do not create ambiguity.

### Daemon And Services

- Make service lifecycle state first-class: installed, enabled, running, pid, port, autostart, restart policy, last error.
- Add stale service/pid detection and remediation.
- Verify `service.enabled`, `service.autostart`, and `service.restartOnFailure` stay coherent.
- Improve daemon start failure messages for occupied ports, bad auth store, invalid config, and missing permissions.
- Make daemon home versus project state obvious in status output.

### Network And Listener

- Add bind posture summaries: local, LAN, custom, public-risk.
- Detect and explain unsafe combinations, especially `0.0.0.0` without completed local auth.
- Make port collision checks consistent across daemon, control plane, web, and listener.
- Improve `listener test` to validate enabled state, bind address, port availability/reachability, and auth/signature posture.
- Add webhook readiness summaries per enabled surface.

### Auth And Security

- Make local admin/bootstrap state explicit: bootstrap present, admin exists, session token exists, bootstrap retired.
- Add token inventory and revocation visibility.
- Confirm LAN/network features require auth setup or clearly block/warn.
- Tighten permission-mode display: Ask before powerful actions, Allow everything, Custom rules.
- Add high-signal warnings for `allow-all`, plaintext secrets, and exposed listeners.
- Ensure all status, doctor, support, and CLI JSON outputs redact secrets.

### Secrets

- Treat `goodvibes://secrets/...` as the only first-class secret URI.
- Add source readiness checks for env, file, 1Password, Bitwarden, Vaultwarden, BWS, and GoodVibes local store.
- Improve malformed GoodVibes ref errors without implying older schemes exist.
- Add tests that secret values never appear in config output, doctor output, logs, bundles, or CLI JSON.
- Make secure storage policy visible wherever secrets are configured.

### Providers And Models

- Classify providers by setup path: local, no-key/free, subscription, API-key, self-hosted, cloud-account, unknown.
- Highlight whether the active provider is actually usable.
- Add model availability status: catalog present, configured provider, auth present, selected model exists.
- Make OpenAI subscription status distinct from OpenAI API-key status.
- Add recommended working path logic without requiring paid API keys.

### Runtime And State

- Audit config writes for atomicity and rollback.
- Add typed config snapshots for key operational areas.
- Improve drift detection between config, runtime state, service state, and marker state.
- Ensure SDK feature flags that gate subsystems are consistently passed through runtime construction.
- Keep generated SDK artifacts verified against the installed SDK.

### Observability

- Add correlation IDs for daemon requests, listener events, onboarding/apply operations, and CLI run turns.
- Make logs discoverable from `status` and `doctor`.
- Add redacted support bundle export with config posture, versions, service state, ports, logs tail, and provider readiness.
- Track last daemon/listener/web/control-plane failure with timestamp and summarized cause.

### Release And Packaging

- Keep current release gates.
- Add package install verification for CLI command names specifically.
- Verify npm tarball includes only intended files.
- Check binary wrappers resolve local build, vendored binaries, and source fallback correctly.
- Keep GitHub Release assets and npm package version synchronized.

### Maintainability

- Reduce wizard/controller field-id string coupling with a typed field/config manifest.
- Split large CLI management files by command family.
- Add architecture rules for CLI, onboarding, daemon/service, and secrets boundaries.
- Document which settings are intentionally not exposed in onboarding.
- Add tests that new config keys are either wizard-included or explicitly excluded.

## Dependency Graph

```text
Plan/criteria
  -> Doctor diagnostics
      -> Network/auth/security warnings
      -> Support bundle diagnostics
  -> Provider setup classification
      -> Provider/model recommendation logic
      -> Wizard provider copy improvements
  -> CLI contract manifest
      -> JSON schema tests
      -> Command-level help
      -> Exit-code tests
  -> Secret redaction checks
      -> Bundle redaction checks
      -> Doctor/support redaction checks
  -> Service state model
      -> Daemon lifecycle checks
      -> Listener readiness checks
      -> Surface readiness checks
  -> Config coverage manifest
      -> Onboarding inclusion/exclusion tests
      -> Runtime drift detection
```

## Concurrent Work Queues

- Queue A: Product UX and `doctor` diagnostics.
- Queue B: Provider/model setup classification and recommendation logic.
- Queue C: CLI contracts, output schemas, exit codes, and command help.
- Queue D: Secrets, redaction, and bundle safety.
- Queue E: Daemon/service/listener readiness and failure diagnostics.
- Queue F: Maintainability, architecture boundaries, and config coverage manifest.

Queue A and Queue B can run immediately. Queue C can run after A establishes diagnostic shape. Queue D can run immediately but must review A/C outputs. Queue E depends on the service-state model. Queue F can run continuously as refactors land.

## Quality Checks

- Focused unit tests for each changed helper or renderer.
- Focused command tests for each changed CLI output shape.
- `bun test <changed test files>` after each slice.
- `./node_modules/.bin/tsc --noEmit --pretty false` after each slice.
- `bun run architecture:check` after boundary/refactor work.
- Full `bun run test` before commit.
- Release gates before publish: typecheck, test, architecture, perf, eval, build, generated SDK artifacts, publish check, daemon smoke.

## Completeness Verification

- Each task must have a test or a documented reason it is not testable at that layer.
- Each diagnostic warning must include cause, impact, and action.
- Each CLI JSON addition must be stable and covered by tests.
- Each network-exposing state must be visible in `doctor`.
- Each secret-handling path must be redaction-checked.
- Each shipped config setting must be either covered by onboarding/doctor or explicitly excluded.
