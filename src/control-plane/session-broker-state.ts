import type { SharedSessionInputRecord } from './session-intents.ts';
import type { SharedSessionStoreSnapshot } from './session-broker-internals.ts';
import type { SharedSessionMessage, SharedSessionParticipant, SharedSessionRecord } from './session-types.ts';

export function sortSessions(records: Iterable<SharedSessionRecord>): SharedSessionRecord[] {
  return [...records].sort((a, b) => (b.updatedAt - a.updatedAt) || a.id.localeCompare(b.id));
}

export function sortMessages(records: Iterable<SharedSessionMessage>): SharedSessionMessage[] {
  return [...records].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
}

export function sortInputs(records: Iterable<SharedSessionInputRecord>): SharedSessionInputRecord[] {
  return [...records].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
}

export function loadSessionBrokerState(snapshot: SharedSessionStoreSnapshot | null | undefined): {
  readonly sessions: Map<string, SharedSessionRecord>;
  readonly messages: Map<string, SharedSessionMessage[]>;
  readonly inputs: Map<string, SharedSessionInputRecord[]>;
} {
  const sessions = new Map<string, SharedSessionRecord>();
  const messages = new Map<string, SharedSessionMessage[]>();
  const inputs = new Map<string, SharedSessionInputRecord[]>();
  for (const session of snapshot?.sessions ?? []) {
    sessions.set(session.id, session);
  }
  for (const message of snapshot?.messages ?? []) {
    const bucket = messages.get(message.sessionId) ?? [];
    bucket.push(message);
    messages.set(message.sessionId, bucket);
  }
  for (const input of snapshot?.inputs ?? []) {
    const bucket = inputs.get(input.sessionId) ?? [];
    bucket.push(input);
    inputs.set(input.sessionId, bucket);
  }
  for (const [sessionId, bucket] of messages.entries()) {
    messages.set(sessionId, sortMessages(bucket));
  }
  for (const [sessionId, bucket] of inputs.entries()) {
    inputs.set(sessionId, sortInputs(bucket));
  }
  return { sessions, messages, inputs };
}

export function createSessionBrokerSnapshot(
  state: {
    readonly sessions: ReadonlyMap<string, SharedSessionRecord>;
    readonly messages: ReadonlyMap<string, readonly SharedSessionMessage[]>;
    readonly inputs: ReadonlyMap<string, readonly SharedSessionInputRecord[]>;
  },
  maxPersistedMessages: number,
): SharedSessionStoreSnapshot {
  return {
    sessions: sortSessions(state.sessions.values()),
    messages: sortMessages(state.messages.values().flatMap((bucket) => bucket)).slice(-maxPersistedMessages),
    inputs: sortInputs(state.inputs.values().flatMap((bucket) => bucket)),
  };
}

export function upsertSessionParticipant(
  participants: readonly SharedSessionParticipant[],
  participant: SharedSessionParticipant,
): SharedSessionParticipant[] {
  const participantId = buildSessionParticipantId(participant);
  return [
    ...participants.filter((existing) => buildSessionParticipantId(existing) !== participantId),
    participant,
  ];
}

export function countPendingSessionInputs(records: readonly SharedSessionInputRecord[]): number {
  return records.filter((entry) =>
    entry.state === 'queued' || entry.state === 'delivered' || entry.state === 'spawned'
  ).length;
}

function buildSessionParticipantId(participant: SharedSessionParticipant): string {
  return `${participant.surfaceKind}:${participant.surfaceId}:${participant.externalId ?? ''}:${participant.userId ?? ''}`;
}
