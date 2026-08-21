# Session durability

GoodVibes TUI uses a two-layer durability strategy to protect conversation history from data loss.

## Snapshot layer (baseline)

After every completed assistant turn (`TURN_COMPLETED`), `persistConversation` writes a full
conversation snapshot via `SessionManager`. A periodic recovery file is also written every 60
seconds via `writeRecoveryFile` (`src/runtime/recovery-autosave.ts`), on the same 60-second tick
as a liveness marker that records this session as actively open. On the next startup the TUI
checks for a recovery file and offers to restore it, unless the marker shows the session is
still live in another terminal right now, in which case the file belongs to that other terminal's
live state rather than to a crash, and the offer is skipped.

**Gap**: between the last periodic recovery file and a SIGKILL, any turns that completed without
triggering a recovery-file write would be lost.

## WAL journal layer (gap-filler)

The transcript journal (the SDK's `TranscriptJournal`, wired in `src/core/turn-event-wiring.ts`)
fills this gap with a per-session append-only NDJSON file that records durable conversation events
**before** the turn snapshot is written.

### How it works

1. **User submits a turn** (`TURN_SUBMITTED`) → the current conversation snapshot is appended to
   the journal as a `user_message` record. This ensures the user's message survives even if the
   process is killed during the subsequent stream.

2. **Turn completes** (`TURN_COMPLETED`) → `persistConversation` writes the full snapshot.
   If the snapshot succeeds, `journal.rotate()` deletes the journal (it is no longer needed as a
   gap-filler). If the snapshot fails, the full conversation state is appended as an
   `assistant_turn` record so recovery can still reconstruct it.

3. **Restart / session resume** → `replayJournalForSession()` (the SDK's, called from
   `resumeSessionCore` in `src/core/session-resume-core.ts`) is reached from two call sites:
   (a) `session-workflow.ts`, which handles `/session resume` directly and is also where
   `--continue`, `--resume`, and `--fork` route through (see [CLI flags](cli-flags.md)); and
   (b) `bootstrap-hook-bridge.ts`'s `createResumeSessionHandler`, used both for the automatic
   startup recovery modal (see "The startup recovery modal" in
   [getting-started.md](getting-started.md)) and for in-TUI panel resume.
   It calls `replayJournal(journalPath, snapshotTimestamp)` to find records that post-date
   the loaded snapshot, applies the final record's messages to the live conversation (each
   record carries the full snapshot, so the last record is authoritative), writes a fresh
   snapshot via the SessionManager, and calls `journal.rotate()`. Only the `session-workflow.ts`
   seam prints the replay notice to the conversation (`[Recovery] Replayed N journal record(s):
   restored turns since last snapshot.`); the startup-modal and panel-resume seam replays
   silently. When the journal tail was quarantined as corrupt, `session-workflow.ts` also prints
   one of two follow-up lines. When no record could be replayed, it prints a "journal tail was
   corrupt or unrecognised, proceeding with snapshot only" notice. When at least one record did
   survive, it prints a "journal tail was partially corrupt, replay stopped at last good record"
   notice instead.

The journal that `turn-event-wiring.ts` opens for the running session is wrapped so that a
session switch (`/session resume` or `/session fork` reassigning `runtime.sessionId` on the live
`MutableRuntimeState`) re-checks the session id before every append and, if it changed, calls
`journal.rebind()` to point at the new session's file. Without this, a session switch would keep
appending the new session's records into the old session's journal file, and a later resume of
the old session would replay the wrong conversation into it.

### File format

The journal is NDJSON (one JSON object per line):

```
line 0  — header:  { "version": 1, "sessionId": "...", "createdAt": <epochMs> }
line 1+ — records: { "type": "...", "seq": <n>, "ts": <epochMs>, "messages": [...] }
```

Record types: `user_message`, `assistant_turn`, `tool_results`, `compaction`.

The `seq` field is monotonically increasing within each journal file (resets to 0 after rotation).
The `ts` field is the wall-clock time (`Date.now()`) at the moment of the append.

### File location

```
<homeDirectory>/.goodvibes/tui/transcript-<sessionId>.journal
```

This mirrors the recovery file location (homeDirectory-scoped, not project-scoped) so all
per-session durability artefacts live together.

### Durability guarantee

At most one in-flight record append is lost on SIGKILL. A partial (truncated) JSON line at the
tail of the journal is tolerated: replay stops at the first unparseable line and renames the
remainder to `<path>.unrecognized` (the same quarantine convention used by `readVersioned`).

### Performance tradeoff

`appendRecord()` performs one `appendFileSync` + one `fsyncSync` per call. This means one fsync
per durable conversation event (user message submitted, assistant turn finalised, tool results
batch, compaction). It does **not** fsync per streaming token. The streaming path never calls
`appendRecord()`.

At typical usage (2–6 events per minute), the write amplification is negligible on any modern
filesystem.

### Orphaned journal cleanup

`journal.rotate()` deletes a journal once its records have been folded into a snapshot or
replayed, but a session that crashes and is never resumed never reaches either step, so its
journal would otherwise stay on disk forever. A reaper (`reapOrphanedJournals`, wired into the
TUI's bootstrap at `src/runtime/services.ts` through the SDK's `createDurabilityServices`, which
runs it once at startup and then every six hours) sweeps the journal directory and deletes a
file that is neither the current process's own session nor apparently open in another running
process, provided it is either empty or has gone untouched for longer than seven days. Whatever
survives those two rules is then capped at 50 files, oldest deleted first.

The rules are based on modification time and liveness, never on whether the file parses, because
an unparseable tail is the normal, expected shape of a journal killed mid-append, exactly the
data replay exists to salvage. A parse failure alone never makes a journal eligible for deletion.

### schemaVersion gate

The journal header carries `"version": 1`. `replayJournal` checks for an exact match, so any
header that carries a different version, from a future process or a corrupted write, is
quarantined rather than partially trusted or crashed on (the same convention as `readVersioned`).

## Summary

| Layer | Cadence | What is protected |
|---|---|---|
| Recovery file | Every 60 s | Full snapshot |
| SessionManager snapshot | Every completed turn | Full snapshot |
| Transcript journal | Every durable event | User messages + completed turns |

A SIGKILL at any moment loses **at most the in-flight append** (one partial JSON line), never a
full conversation turn. `--continue`/`--resume`/`--fork`, `/session resume`,
the startup recovery modal, and in-TUI panel resume are every resume path, and each routes
through `resumeSessionCore`, which calls `replayJournalForSession`, so the gap is closed on
whichever path the user takes.

### Known limit: `--continue` with no last-session pointer

If a session was killed before the first snapshot was written (i.e., no last-session pointer
exists), `--continue` does nothing. It does not fall through to onboarding or start any other
flow. The journal for that session is still present on disk. **Recovery path:** launch the TUI
normally; the startup recovery modal (see "The startup recovery modal" in
[getting-started.md](getting-started.md)) offers to resume from the recovery snapshot if one
exists, or use `/session resume <id>` once a snapshot exists. This is a known limit with no
automatic workaround. It only affects sessions that were never snapshotted.
