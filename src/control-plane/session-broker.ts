import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { PersistentStore } from '../state/persistent-store.ts';
import { RouteBindingManager } from '../channels/index.ts';
import type { AutomationSurfaceKind } from '../automation/types.ts';
import type { AutomationRouteBinding } from '../automation/routes.ts';
import { AgentManager } from '../tools/agent/index.ts';
import { AgentMessageBus } from '../agents/message-bus.ts';

type SharedSessionStatus = 'active' | 'closed';
type SharedSessionMessageRole = 'user' | 'assistant' | 'system';

export interface SharedSessionParticipant {
  readonly surfaceKind: AutomationSurfaceKind;
  readonly surfaceId: string;
  readonly externalId?: string;
  readonly userId?: string;
  readonly displayName?: string;
  readonly routeId?: string;
  readonly lastSeenAt: number;
}

export interface SharedSessionMessage {
  readonly id: string;
  readonly sessionId: string;
  readonly role: SharedSessionMessageRole;
  readonly body: string;
  readonly createdAt: number;
  readonly surfaceKind?: AutomationSurfaceKind;
  readonly surfaceId?: string;
  readonly routeId?: string;
  readonly agentId?: string;
  readonly userId?: string;
  readonly displayName?: string;
  readonly metadata: Record<string, unknown>;
}

export interface SharedSessionRecord {
  readonly id: string;
  readonly title: string;
  readonly status: SharedSessionStatus;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly lastMessageAt?: number;
  readonly closedAt?: number;
  readonly messageCount: number;
  readonly routeIds: readonly string[];
  readonly surfaceKinds: readonly AutomationSurfaceKind[];
  readonly participants: readonly SharedSessionParticipant[];
  readonly activeAgentId?: string;
  readonly lastAgentId?: string;
  readonly lastError?: string;
  readonly metadata: Record<string, unknown>;
}

export interface SharedSessionSubmission {
  readonly session: SharedSessionRecord;
  readonly userMessage: SharedSessionMessage;
  readonly routeBinding?: AutomationRouteBinding;
  readonly mode: 'spawn' | 'continued-live';
  readonly task?: string;
  readonly activeAgentId?: string;
  readonly created: boolean;
}

interface SharedSessionStoreSnapshot extends Record<string, unknown> {
  readonly sessions: readonly SharedSessionRecord[];
  readonly messages: readonly SharedSessionMessage[];
}

export interface SubmitSharedSessionMessageInput {
  readonly sessionId?: string;
  readonly routeId?: string;
  readonly surfaceKind: AutomationSurfaceKind;
  readonly surfaceId: string;
  readonly externalId?: string;
  readonly threadId?: string;
  readonly userId?: string;
  readonly displayName?: string;
  readonly title?: string;
  readonly body: string;
  readonly metadata?: Record<string, unknown>;
}

export interface FindSharedSessionOptions {
  readonly surfaceKind?: AutomationSurfaceKind;
  readonly routeId?: string;
  readonly includeClosed?: boolean;
}

type SharedSessionAgentStatus = {
  readonly id: string;
  readonly status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
};

type SharedSessionAgentStatusProvider = {
  getStatus(agentId: string): SharedSessionAgentStatus | null | undefined;
};

type SharedSessionMessageSender = {
  send(fromId: string, toId: string, content: string, options?: { kind?: 'directive' }): boolean;
};
type SharedSessionEventPublisher = (event: string, payload: unknown) => void;

const STORE_PATH = join(process.cwd(), '.goodvibes', 'tui', 'control-plane', 'sessions.json');
const MAX_PERSISTED_MESSAGES = 2_000;
const MAX_CONTINUATION_MESSAGES = 16;

function sortSessions(records: Iterable<SharedSessionRecord>): SharedSessionRecord[] {
  return [...records].sort((a, b) => (b.updatedAt - a.updatedAt) || a.id.localeCompare(b.id));
}

function sortMessages(records: Iterable<SharedSessionMessage>): SharedSessionMessage[] {
  return [...records].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
}

function dedupeSurfaceKinds(participants: readonly SharedSessionParticipant[]): AutomationSurfaceKind[] {
  return [...new Set(participants.map((participant) => participant.surfaceKind))];
}

export class SharedSessionBroker {
  private readonly store: PersistentStore<SharedSessionStoreSnapshot>;
  private readonly routeBindings: RouteBindingManager;
  private readonly agentStatusProvider: SharedSessionAgentStatusProvider;
  private readonly messageSender: SharedSessionMessageSender;
  private readonly sessions = new Map<string, SharedSessionRecord>();
  private readonly messages = new Map<string, SharedSessionMessage[]>();
  private eventPublisher: SharedSessionEventPublisher | null = null;
  private loaded = false;

  constructor(config: {
    readonly store?: PersistentStore<SharedSessionStoreSnapshot>;
    readonly routeBindings: RouteBindingManager;
    readonly agentStatusProvider: SharedSessionAgentStatusProvider;
    readonly messageSender: SharedSessionMessageSender;
  }) {
    this.store = config.store ?? new PersistentStore<SharedSessionStoreSnapshot>(STORE_PATH);
    this.routeBindings = config.routeBindings;
    this.agentStatusProvider = config.agentStatusProvider;
    this.messageSender = config.messageSender;
  }

  setEventPublisher(publisher: SharedSessionEventPublisher | null): void {
    this.eventPublisher = publisher;
  }

  async start(): Promise<void> {
    if (this.loaded) return;
    await this.routeBindings.start();
    const snapshot = await this.store.load();
    this.sessions.clear();
    this.messages.clear();
    for (const session of snapshot?.sessions ?? []) {
      this.sessions.set(session.id, session);
    }
    for (const message of snapshot?.messages ?? []) {
      const bucket = this.messages.get(message.sessionId) ?? [];
      bucket.push(message);
      this.messages.set(message.sessionId, bucket);
    }
    for (const [sessionId, bucket] of this.messages.entries()) {
      this.messages.set(sessionId, sortMessages(bucket));
    }
    this.loaded = true;
  }

  listSessions(limit = 100): SharedSessionRecord[] {
    return sortSessions(this.sessions.values()).slice(0, Math.max(1, limit));
  }

  getSession(sessionId: string): SharedSessionRecord | null {
    return this.sessions.get(sessionId) ?? null;
  }

  async findPreferredSession(options: FindSharedSessionOptions = {}): Promise<SharedSessionRecord | null> {
    await this.start();
    const candidates = this.listSessions(500).filter((session) => {
      if (!options.includeClosed && session.status === 'closed') return false;
      if (options.routeId && !session.routeIds.includes(options.routeId)) return false;
      if (options.surfaceKind && !session.surfaceKinds.includes(options.surfaceKind)) return false;
      return true;
    });
    return candidates[0] ?? null;
  }

  async ensureSession(input: {
    readonly sessionId?: string;
    readonly title?: string;
    readonly metadata?: Record<string, unknown>;
    readonly routeBinding?: AutomationRouteBinding;
    readonly participant?: SharedSessionParticipant;
  } = {}): Promise<SharedSessionRecord> {
    await this.start();
    if (input.sessionId) {
      const existing = this.sessions.get(input.sessionId);
      if (existing) {
        if (existing.status === 'closed') {
          return (await this.reopenSession(existing.id)) ?? existing;
        }
        return existing;
      }
    }
    return this.createSession({
      id: input.sessionId,
      title: input.title,
      metadata: input.metadata,
      routeBinding: input.routeBinding,
      participant: input.participant,
    });
  }

  getMessages(sessionId: string, limit = 100): SharedSessionMessage[] {
    const bucket = this.messages.get(sessionId) ?? [];
    return bucket.slice(-Math.max(1, limit));
  }

  async createSession(input: {
    readonly id?: string;
    readonly title?: string;
    readonly metadata?: Record<string, unknown>;
    readonly routeBinding?: AutomationRouteBinding;
    readonly participant?: SharedSessionParticipant;
  } = {}): Promise<SharedSessionRecord> {
    await this.start();
    const now = Date.now();
    const sessionId = input.id ?? `sess-${randomUUID().slice(0, 8)}`;
    const participant = input.participant;
    const participants = participant ? [participant] : [];
    const routeIds = input.routeBinding?.id ? [input.routeBinding.id] : [];
    const session: SharedSessionRecord = {
      id: sessionId,
      title: input.title?.trim() || input.routeBinding?.title || `Session ${sessionId}`,
      status: 'active',
      createdAt: now,
      updatedAt: now,
      lastMessageAt: undefined,
      closedAt: undefined,
      messageCount: 0,
      routeIds,
      surfaceKinds: participant ? [participant.surfaceKind] : input.routeBinding ? [input.routeBinding.surfaceKind] : [],
      participants,
      activeAgentId: undefined,
      lastAgentId: undefined,
      lastError: undefined,
      metadata: {
        ...(input.metadata ?? {}),
      },
    };
    this.sessions.set(session.id, session);
    if (input.routeBinding?.id) {
      await this.routeBindings.patchBinding(input.routeBinding.id, { sessionId: session.id });
    }
    await this.persist();
    this.publishUpdate('session-created', session);
    return session;
  }

  async closeSession(sessionId: string): Promise<SharedSessionRecord | null> {
    await this.start();
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    const updated: SharedSessionRecord = {
      ...session,
      status: 'closed',
      activeAgentId: undefined,
      updatedAt: Date.now(),
      closedAt: Date.now(),
    };
    this.sessions.set(sessionId, updated);
    await this.persist();
    this.publishUpdate('session-closed', updated);
    return updated;
  }

  async reopenSession(sessionId: string): Promise<SharedSessionRecord | null> {
    await this.start();
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    const updated: SharedSessionRecord = {
      ...session,
      status: 'active',
      updatedAt: Date.now(),
      closedAt: undefined,
    };
    this.sessions.set(sessionId, updated);
    await this.persist();
    this.publishUpdate('session-reopened', updated);
    return updated;
  }

  async bindAgent(sessionId: string, agentId: string): Promise<SharedSessionRecord | null> {
    await this.start();
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    const updated: SharedSessionRecord = {
      ...session,
      activeAgentId: agentId,
      lastAgentId: agentId,
      updatedAt: Date.now(),
    };
    this.sessions.set(sessionId, updated);
    await this.persist();
    this.publishUpdate('session-agent-bound', updated);
    return updated;
  }

  async submitMessage(input: SubmitSharedSessionMessageInput): Promise<SharedSessionSubmission> {
    await this.start();

    const binding = await this.resolveBinding(input);
    let session = input.sessionId ? this.sessions.get(input.sessionId) ?? undefined : undefined;
    let created = false;
    if (!session && binding?.sessionId) {
      session = this.sessions.get(binding.sessionId) ?? undefined;
    }
    if (!session) {
      const participant: SharedSessionParticipant = {
        surfaceKind: input.surfaceKind,
        surfaceId: input.surfaceId,
        externalId: input.externalId,
        userId: input.userId,
        displayName: input.displayName,
        routeId: binding?.id,
        lastSeenAt: Date.now(),
      };
      session = await this.createSession({
        title: input.title,
        metadata: input.metadata,
        routeBinding: binding ?? undefined,
        participant,
      });
      created = true;
    }

    const updatedSession = await this.attachParticipantAndRoute(session, input, binding ?? undefined);
    const userMessage = await this.appendMessage(updatedSession.id, {
      role: 'user',
      body: input.body,
      surfaceKind: input.surfaceKind,
      surfaceId: input.surfaceId,
      routeId: binding?.id,
      userId: input.userId,
      displayName: input.displayName,
      metadata: input.metadata ?? {},
    });

    const activeAgentId = this.resolveActiveAgentId(updatedSession);
    if (activeAgentId) {
      const sent = this.messageSender.send('orchestrator', activeAgentId, input.body, { kind: 'directive' });
      if (sent) {
        this.publishUpdate('session-message-forwarded', {
          sessionId: updatedSession.id,
          agentId: activeAgentId,
          messageId: userMessage.id,
        });
        return {
          session: this.sessions.get(updatedSession.id)!,
          userMessage,
          routeBinding: binding ?? undefined,
          mode: 'continued-live',
          activeAgentId,
          created,
        };
      }
    }

    const task = this.buildContinuationTask(updatedSession.id);
    return {
      session: this.sessions.get(updatedSession.id)!,
      userMessage,
      routeBinding: binding ?? undefined,
      mode: 'spawn',
      task,
      created,
    };
  }

  async appendSystemMessage(sessionId: string, body: string, metadata: Record<string, unknown> = {}): Promise<SharedSessionMessage | null> {
    if (!body.trim()) return null;
    return this.appendMessage(sessionId, {
      role: 'system',
      body,
      metadata,
    });
  }

  async completeAgent(sessionId: string, agentId: string, body: string, metadata: Record<string, unknown> = {}): Promise<SharedSessionRecord | null> {
    await this.start();
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    await this.appendMessage(sessionId, {
      role: metadata.status === 'failed' || metadata.status === 'cancelled' ? 'system' : 'assistant',
      body,
      agentId,
      metadata,
    });
    const updated: SharedSessionRecord = {
      ...(this.sessions.get(sessionId) ?? session),
      activeAgentId: (this.sessions.get(sessionId)?.activeAgentId === agentId) ? undefined : this.sessions.get(sessionId)?.activeAgentId,
      lastAgentId: agentId,
      updatedAt: Date.now(),
      ...(metadata.status === 'failed' ? { lastError: body } : {}),
    };
    this.sessions.set(sessionId, updated);
    await this.persist();
    this.publishUpdate('session-agent-completed', {
      sessionId,
      agentId,
      status: metadata.status ?? 'completed',
    });
    return updated;
  }

  async rebindRoute(bindingId: string, sessionId: string): Promise<SharedSessionRecord | null> {
    await this.start();
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    const binding = await this.routeBindings.patchBinding(bindingId, { sessionId });
    if (!binding) return null;
    return this.attachParticipantAndRoute(session, {
      surfaceKind: binding.surfaceKind,
      surfaceId: binding.surfaceId,
      externalId: binding.externalId,
      threadId: binding.threadId,
      userId: typeof binding.metadata.userId === 'string' ? binding.metadata.userId : undefined,
      displayName: typeof binding.metadata.userName === 'string' ? binding.metadata.userName : undefined,
      body: '',
    }, binding);
  }

  private async appendMessage(
    sessionId: string,
    input: {
      readonly role: SharedSessionMessageRole;
      readonly body: string;
      readonly surfaceKind?: AutomationSurfaceKind;
      readonly surfaceId?: string;
      readonly routeId?: string;
      readonly agentId?: string;
      readonly userId?: string;
      readonly displayName?: string;
      readonly metadata?: Record<string, unknown>;
    },
  ): Promise<SharedSessionMessage> {
    await this.start();
    const message: SharedSessionMessage = {
      id: `smsg-${randomUUID().slice(0, 8)}`,
      sessionId,
      role: input.role,
      body: input.body,
      createdAt: Date.now(),
      surfaceKind: input.surfaceKind,
      surfaceId: input.surfaceId,
      routeId: input.routeId,
      agentId: input.agentId,
      userId: input.userId,
      displayName: input.displayName,
      metadata: input.metadata ?? {},
    };
    const bucket = this.messages.get(sessionId) ?? [];
    bucket.push(message);
    while (bucket.length > MAX_PERSISTED_MESSAGES) {
      bucket.shift();
    }
    this.messages.set(sessionId, bucket);
    const session = this.sessions.get(sessionId);
    if (session) {
      const updated: SharedSessionRecord = {
        ...session,
        messageCount: bucket.length,
        lastMessageAt: message.createdAt,
        updatedAt: message.createdAt,
      };
      this.sessions.set(sessionId, updated);
    }
    await this.persist();
    this.publishUpdate('session-message-appended', {
      sessionId,
      message,
    });
    return message;
  }

  private async attachParticipantAndRoute(
    session: SharedSessionRecord,
    input: Omit<SubmitSharedSessionMessageInput, 'metadata'>,
    binding?: AutomationRouteBinding,
  ): Promise<SharedSessionRecord> {
    const existing = this.sessions.get(session.id) ?? session;
    const nextRouteIds = binding?.id
      ? [...new Set([...existing.routeIds, binding.id])]
      : [...existing.routeIds];
    const participantId = `${input.surfaceKind}:${input.surfaceId}:${input.externalId ?? ''}:${input.userId ?? ''}`;
    const participants = existing.participants.filter((participant) =>
      `${participant.surfaceKind}:${participant.surfaceId}:${participant.externalId ?? ''}:${participant.userId ?? ''}` !== participantId,
    );
    participants.push({
      surfaceKind: input.surfaceKind,
      surfaceId: input.surfaceId,
      externalId: input.externalId,
      userId: input.userId,
      displayName: input.displayName,
      routeId: binding?.id,
      lastSeenAt: Date.now(),
    });
    const updated: SharedSessionRecord = {
      ...existing,
      title: input.title?.trim() || existing.title,
      status: existing.status === 'closed' ? 'active' : existing.status,
      updatedAt: Date.now(),
      closedAt: existing.status === 'closed' ? undefined : existing.closedAt,
      routeIds: nextRouteIds,
      participants,
      surfaceKinds: dedupeSurfaceKinds(participants),
      metadata: {
        ...existing.metadata,
      },
    };
    this.sessions.set(updated.id, updated);
    if (binding?.id) {
      await this.routeBindings.patchBinding(binding.id, { sessionId: updated.id });
    }
    await this.persist();
    this.publishUpdate('session-route-attached', {
      sessionId: updated.id,
      routeId: binding?.id,
    });
    return updated;
  }

  private resolveActiveAgentId(session: SharedSessionRecord): string | undefined {
    if (!session.activeAgentId) return undefined;
    const agent = this.agentStatusProvider.getStatus(session.activeAgentId);
    if (!agent) return undefined;
    return agent.status === 'pending' || agent.status === 'running' ? agent.id : undefined;
  }

  private async resolveBinding(input: SubmitSharedSessionMessageInput): Promise<AutomationRouteBinding | null> {
    if (input.routeId) {
      return this.routeBindings.getBinding(input.routeId) ?? null;
    }
    if (!input.externalId) return null;
    return this.routeBindings.resolve(input.surfaceKind, input.externalId, input.threadId) ?? null;
  }

  private buildContinuationTask(sessionId: string): string {
    const session = this.sessions.get(sessionId);
    const history = this.getMessages(sessionId, MAX_CONTINUATION_MESSAGES);
    const transcript = history
      .map((message) => {
        const speaker = message.role === 'assistant'
          ? 'Assistant'
          : message.role === 'system'
            ? 'System'
            : `${message.displayName ?? message.userId ?? 'User'}`;
        return `${speaker}: ${message.body}`;
      })
      .join('\n\n');
    return [
      `Continue the shared control-plane session "${session?.title ?? sessionId}".`,
      'Preserve continuity with the recent transcript and answer the newest user message directly.',
      transcript ? `Recent transcript:\n${transcript}` : '',
    ].filter(Boolean).join('\n\n');
  }

  private async persist(): Promise<void> {
    await this.store.persist({
      sessions: sortSessions(this.sessions.values()),
      messages: sortMessages(this.messages.values().flatMap((bucket) => bucket)).slice(-MAX_PERSISTED_MESSAGES),
    });
  }

  private publishUpdate(event: string, payload: unknown): void {
    this.eventPublisher?.('session-update', {
      event,
      payload,
      createdAt: Date.now(),
    });
  }
}
