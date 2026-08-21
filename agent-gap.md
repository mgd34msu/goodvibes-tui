# Agent gap: wedged-state bootstrap (2026-08-06 laptop incident)

## What happened

The laptop's goodvibes said "unable to connect". Root state: the local daemon
service was stopped/disabled AND the agent setting `daemon.enabled` was
explicitly `false`, a stale leftover from the old split-brain semantics of
that key. The agent auto-updated itself to 2.0.9 at launch (the npm update
path works without the daemon) but honored the stale flag into a dead end.
The assistant model running there then spent a session probing the daemon
with shell commands through the exec sandbox and misdiagnosed the containment
as the defect. The sandbox is network-isolated by design since 2.0.10, so its
127.0.0.1 is never the host's. The owner had to relay fix instructions by
hand across machines.

## Why it could not self-heal

Every self-healing path the platform has (auto-update coordination, settings
repair, remote diagnosis) flows through a live daemon channel. A machine
carrying both the stopped service and the off-flag has no channel left to
receive the cure. Bootstrapping out of that wedged state currently requires
a human.

## Items for the next round

1. **Agent boot self-heal.** When the agent boots and finds
   `daemon.enabled: false` together with a stopped local daemon service, it
   states that in one line and offers the one-touch repair: enable the flag,
   start the service, verify the connection, leave a receipt. One action,
   platform drives.
2. **Sandbox self-label names the right tools.** When a command inside the
   exec boundary probes host loopback or the user systemd bus, the refusal
   text should point at the agent's built-in daemon/settings tools by name,
   so third-party assistant models are redirected instead of spiraling.
3. **Migrate stale off-flags.** A `daemon.enabled: false` written by
   pre-split builds should be migrated with a receipt like other pre-split
   state, not honored silently.
