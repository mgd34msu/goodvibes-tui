# Session Durability

GoodVibes TUI uses a two-layer durability strategy to protect conversation history from data loss.

## Snapshot layer (baseline)

After every completed assistant turn (`TURN_COMPLETED`), `persistConversation` writes a full
conversation snapshot via `SessionManager`. A periodic recovery file is also written every 60
seconds via `writeRecoveryFile`. On the next startup, if a recovery file exists, the TUI offers
to restore the previous session.

**Gap**: between the last periodic recovery file and a SIGKILL, any turns that completed without
triggering a recovery-file write would be lost.

## WAL journal layer (gap-filler)

The transcript journal (`src/core/transcript-journal.ts`) fills this gap with a per-session
append-only NDJSON file that records durable conversation events **before** the turn snapshot is
written.

### How it works

1. **User submits a turn** (`TURN_SUBMITTED`) → the current conversation snapshot is appended to
   the journal as a `user_message` record. This ensures the user’s message survives even if the
   process is killed during the subsequent stream.

2. **Turn completes** (`TURN_COMPLETED`) → `persistConversation` writes the full snapshot.
   If the snapshot succeeds, `journal.rotate()` deletes the journal (it is no longer needed as a
   gap-filler). If the snapshot fails, the full conversation state is appended as an
   `assistant_turn` record so recovery can still reconstruct it.

3. **Restart / session resume** → `replayJournalForSession()` (`src/core/session-recovery.ts`)
   is called from three wired seams: (a) `session-workflow.ts` for `--continue`, `--resume`,
   `/session resume`, and `--fork`; (b) `blocking-input.ts` for Ctrl+R crash recovery;
   (c) `bootstrap-hook-bridge.ts` `createResumeSessionHandler` for in-TUI panel resume.
   It calls `replayJournal(journalPath, snapshotTimestamp)` to find records that post-date
   the loaded snapshot, applies the final record’s messages to the live conversation (each
   record carries the full snapshot, so the last record is authoritative), writes a fresh
   snapshot via the SessionManager, and calls `journal.rotate()`. Of the three seams, only
   `session-workflow.ts` prints the replay notice to the conversation (`[Recovery] Replayed
   N journal record(s) — restored turns since last snapshot.`); the Ctrl+R and panel-resume
   seams replay silently.

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
batch, compaction). It does **not** fsync per streaming token — the streaming path never calls
`appendRecord()`.

At typical usage (2–6 events per minute), the write amplification is negligible on any modern
filesystem.

### schemaVersion gate

The journal header carries `"version": 1`. If a future process writes a higher version,
`replayJournal` quarantines the file rather than crashing (the same convention as `readVersioned`).

## Summary

| Layer | Cadence | What is protected |
|---|---|---|
| Recovery file | Every 60 s | Full snapshot |
| SessionManager snapshot | Every completed turn | Full snapshot |
| Transcript journal | Every durable event | User messages + completed turns |

A SIGKILL at any moment loses **at most the in-flight append** (one partial JSON line), never a
full conversation turn. All three resume paths (CLI flags, Ctrl+R recovery, and in-TUI panel
resume) call `replayJournalForSession` so the gap is closed on whichever path the user takes.

### Known limit: `--continue` with no last-session pointer

If a session was killed before the first snapshot was written (i.e., no last-session pointer
exists), `--continue` falls through to onboarding with no journal replay entry point. The journal
for that session is still present on disk. **Recovery path:** launch the TUI normally; the Ctrl+R
prompt will appear if a recovery file exists, or use `/session resume <id>` once a snapshot
exists. This is a known limit with no automatic workaround — it only affects sessions that were
never snapshotted.
