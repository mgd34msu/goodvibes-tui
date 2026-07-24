/**
 * session-picker-filter.ts — keep subagent transcripts out of user-facing
 * session pickers.
 *
 * Subagents spawned during a session get their own SessionManager-persisted
 * transcript, named `agent-<id>` (see the SDK's agent manager, which mints
 * ids as `agent-${uuid.slice(0, 8)}`). Those files are real, loadable
 * sessions — useful for forensic/debugging access — but they are not
 * sessions a user ever started, and in a workspace with many spawned agents
 * they drown the handful of sessions the user actually wants to pick from
 * in `/resume` and `/sessions`.
 *
 * Both pickers filter agent-shaped entries out of the LIST/BROWSE view only.
 * Direct resume by exact id/name (`/resume agent-xxxxxxxx`, `/session resume
 * agent-xxxxxxxx`) is untouched and still reaches them — this only affects
 * what shows up when the id isn't already known.
 */
import type { SessionInfo } from '@pellux/goodvibes-sdk/platform/sessions';

/** Whether a saved session's name follows the subagent-transcript naming convention. */
export function isAgentSessionName(name: string): boolean {
  return name.startsWith('agent-');
}

/** Filter a session list down to user-facing (non-subagent) entries. */
export function filterUserFacingSessions<T extends Pick<SessionInfo, 'name'>>(sessions: readonly T[]): T[] {
  return sessions.filter((s) => !isAgentSessionName(s.name));
}
