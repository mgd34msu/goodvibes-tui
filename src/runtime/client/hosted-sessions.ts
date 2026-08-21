/**
 * hosted-sessions.ts, this terminal's handle on a conversation the DAEMON runs.
 *
 * A local session's loop lives in this process: the orchestrator, the tools and
 * the permission gate are all here, and closing the terminal ends the work. A
 * HOSTED session is the same loop composed on the other side of the wire, in
 * the daemon, driven by the five `sessions.hosted.*` verbs. Local stays the
 * default experience; hosting is something the user asks for.
 *
 * ── What this module is, and what it deliberately is not ──────────────────
 *
 * It is the five lifecycle verbs plus the ORDINARY session verbs a hosted id
 * also answers to. There is no `sessions.hosted.steer` and this file does not
 * invent one: `sessions.steer`, `sessions.followUp` and
 * `sessions.toolCalls.cancel` resolve a hosted session's id daemon-side, so
 * steering a hosted conversation is the same call as steering any other. Two
 * spellings of one action is how they drift apart.
 *
 * It is not the stream. The hosted loop is the ordinary Orchestrator, so its
 * tokens, tool calls and turn transitions arrive on the `turn` and `tools`
 * event domains stamped with the hosted session's id, see
 * hosted-session-stream.ts, which watches exactly what a local session watches
 * and filters on the id `attach` handed back.
 *
 * ── Why the verbs go through DaemonVerbCaller ─────────────────────────────
 *
 * Every `sessions.hosted.*` verb is declared `transport: ['ws']` with no REST
 * path of its own, so `sdk.operator.invoke` refuses them before making a
 * request. `createDaemonVerbCaller` (operator-endpoint.ts) already handles that
 * exact class by falling through to the generic gateway route, which IS the
 * binding for a ws-declared verb reached over HTTP.
 */
import { hostname } from 'node:os';
import type {
  CreateHostedSessionInput,
  HostedDetachPolicy,
  HostedSessionHistoryMessage,
  HostedSessionRecord,
} from '@pellux/goodvibes-sdk/platform/hosted-sessions';
import type { DaemonVerbCaller } from './operator-endpoint.ts';

export type {
  CreateHostedSessionInput,
  HostedDetachPolicy,
  HostedSessionHistoryMessage,
  HostedSessionRecord,
};

/** What `sessions.hosted.attach` answers with: the record, and what was said so far. */
export interface HostedSessionAttachment {
  readonly session: HostedSessionRecord;
  readonly history: readonly HostedSessionHistoryMessage[];
}

/**
 * How this terminal names itself to the daemon when it attaches.
 *
 * It has to be stable for the life of the process and distinct between two
 * terminals on one machine, because the detach policy is applied when the LAST
 * client leaves: two windows sharing one id would make the first `detach` look
 * like the last one. Host + pid is both, and it is readable in
 * `attachedClients`, a person reading the record can tell which terminal that
 * is.
 */
let cachedClientId: string | null = null;
export function terminalHostedClientId(): string {
  cachedClientId ??= `tui-${hostname()}-${process.pid}`;
  return cachedClientId;
}

/** The narrow client the command layer and the panel share. */
export interface HostedSessionsClient {
  /** This terminal's attach identity, the same string the records carry. */
  readonly clientId: string;
  list(options?: { readonly includeTerminated?: boolean }): Promise<readonly HostedSessionRecord[]>;
  create(input: Omit<CreateHostedSessionInput, 'clientId'>): Promise<HostedSessionRecord>;
  attach(sessionId: string): Promise<HostedSessionAttachment>;
  detach(sessionId: string): Promise<HostedSessionRecord>;
  kill(sessionId: string): Promise<HostedSessionRecord>;
  /** Send a message into a running hosted session, the ordinary steer verb. */
  steer(sessionId: string, body: string): Promise<void>;
  /** Queue a message for after the current turn, the ordinary follow-up verb. */
  followUp(sessionId: string, body: string): Promise<void>;
  /** Cancel one in-flight tool call, the ordinary live-turn verb. */
  cancelToolCall(sessionId: string, callId: string): Promise<boolean>;
}

/**
 * Drop the keys a verb was not given a value for.
 *
 * The gateway validates against the declared input schema and a present-but-
 * undefined property is not the same as an absent one on the wire; sending
 * `{ title: undefined }` is how a caller that meant "no title" gets a
 * validation refusal instead.
 */
function withoutUndefined(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

export function createHostedSessionsClient(verbs: DaemonVerbCaller): HostedSessionsClient {
  const clientId = terminalHostedClientId();
  return {
    clientId,
    async list(options): Promise<readonly HostedSessionRecord[]> {
      const result = await verbs.invoke<{ sessions: readonly HostedSessionRecord[] }>(
        'sessions.hosted.list',
        withoutUndefined({ includeTerminated: options?.includeTerminated }),
      );
      return result.sessions ?? [];
    },
    async create(input): Promise<HostedSessionRecord> {
      const result = await verbs.invoke<{ session: HostedSessionRecord }>(
        'sessions.hosted.create',
        withoutUndefined({
          workspaceRoot: input.workspaceRoot,
          title: input.title,
          modelId: input.modelId,
          initialPrompt: input.initialPrompt,
          detachPolicy: input.detachPolicy,
          clientId,
        }),
      );
      return result.session;
    },
    async attach(sessionId): Promise<HostedSessionAttachment> {
      const result = await verbs.invoke<HostedSessionAttachment>(
        'sessions.hosted.attach',
        { sessionId, clientId },
      );
      return { session: result.session, history: result.history ?? [] };
    },
    async detach(sessionId): Promise<HostedSessionRecord> {
      const result = await verbs.invoke<{ session: HostedSessionRecord }>(
        'sessions.hosted.detach',
        { sessionId, clientId },
      );
      return result.session;
    },
    async kill(sessionId): Promise<HostedSessionRecord> {
      const result = await verbs.invoke<{ session: HostedSessionRecord }>(
        'sessions.hosted.kill',
        { sessionId },
      );
      return result.session;
    },
    async steer(sessionId, body): Promise<void> {
      await verbs.invoke('sessions.steer', { sessionId, body, surfaceKind: 'tui' });
    },
    async followUp(sessionId, body): Promise<void> {
      await verbs.invoke('sessions.followUp', { sessionId, body, surfaceKind: 'tui' });
    },
    async cancelToolCall(sessionId, callId): Promise<boolean> {
      const result = await verbs.invoke<{ cancelled: boolean }>(
        'sessions.toolCalls.cancel',
        { sessionId, callId },
      );
      return result.cancelled === true;
    },
  };
}

/**
 * One line describing what leaving this session would do right now, in the
 * words the record itself carries.
 *
 * The policy is the daemon's answer, never this client's guess: a session
 * created with an override reports the override, and one following the setting
 * reports the setting's current value. Rendering a locally-remembered default
 * here is how a user learns the wrong thing about a quit.
 */
export function describeDetachEffect(record: HostedSessionRecord): string {
  const source = record.detachPolicy === null
    ? 'the hostedSessions.detachPolicy setting'
    : 'this session\'s own override';
  return record.effectiveDetachPolicy === 'survive'
    ? `leaving keeps it running (survive, from ${source})`
    : `leaving ends it (kill, from ${source})`;
}

/** A short, stable label for a record in a list. Never invents a title. */
export function hostedSessionLabel(record: HostedSessionRecord): string {
  return record.title.trim() || record.id;
}
