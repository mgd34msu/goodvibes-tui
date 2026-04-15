import { randomUUID } from 'node:crypto';
import { PersistentStore } from '@pellux/goodvibes-sdk/platform/state/persistent-store';
import { RouteBindingManager } from '@pellux/goodvibes-sdk/platform/channels/index';
import type { AutomationRouteBinding } from '@pellux/goodvibes-sdk/platform/automation/routes';
import type { AutomationSurfaceKind } from '@pellux/goodvibes-sdk/platform/automation/types';
import type {
  SharedSessionCompletion,
  SharedSessionContinuationRunner,
  SharedSessionInputIntent,
  SharedSessionInputRecord,
} from '@pellux/goodvibes-sdk/platform/control-plane/session-intents';
import type {
  FindSharedSessionOptions,
  SharedSessionMessage,
  SharedSessionMessageRole,
  SharedSessionParticipant,
  SharedSessionRecord,
  SharedSessionSubmission,
  SteerSharedSessionMessageInput,
  SubmitSharedSessionMessageInput,
} from '@pellux/goodvibes-sdk/platform/control-plane/session-types';
import {
  dedupeSessionSurfaceKinds,
  type SharedSessionAgentStatusProvider,
  type SharedSessionEventPublisher,
  type SharedSessionMessageSender,
  type SharedSessionStoreSnapshot,
} from '@pellux/goodvibes-sdk/platform/control-plane/session-broker-internals';
import {
  countPendingSessionInputs,
  createSessionBrokerSnapshot,
  loadSessionBrokerState,
  sortInputs,
  sortMessages,
  sortSessions,
  upsertSessionParticipant,
} from '@pellux/goodvibes-sdk/platform/control-plane/session-broker-state';

const MAX_PERSISTED_MESSAGES = 2_000;
const MAX_CONTINUATION_MESSAGES = 16;

export class SharedSessionBroker {
  private readonly store: PersistentStore<SharedSessionStoreSnapshot>;
  private readonly routeBindings: RouteBindingManager;
  private readonly agentStatusProvider: SharedSessionAgentStatusProvider;
  private readonly messageSender: SharedSessionMessageSender;
  private readonly sessions = new Map<string, SharedSessionRecord>();
  private readonly messages = new Map<string, SharedSessionMessage[]>();
  private readonly inputs = new Map<string, SharedSessionInputRecord[]>();
  private eventPublisher: SharedSessionEventPublisher | null = null;
  private continuationRunner: SharedSessionContinuationRunner | null = null;
  private loaded = false;

  constructor(config: {
    readonly store?: PersistentStore<SharedSessionStoreSnapshot>;
    readonly storePath?: string;
    readonly routeBindings: RouteBindingManager;
    readonly agentStatusProvider: SharedSessionAgentStatusProvider;
    readonly messageSender: SharedSessionMessageSender;
  }) {
    if (!config.store && !config.storePath) {
      throw new Error('SharedSessionBroker requires an explicit store or storePath.');
    }
    const storePath = config.storePath;
    this.store = config.store ?? new PersistentStore<SharedSessionStoreSnapshot>(storePath as string);
    this.routeBindings = config.routeBindings;
    this.agentStatusProvider = config.agentStatusProvider;
    this.messageSender = config.messageSender;
  }

  setEventPublisher(publisher: SharedSessionEventPublisher | null): void {
    this.eventPublisher = publisher;
  }

  setContinuationRunner(runner: SharedSessionContinuationRunner | null): void {
    this.continuationRunner = runner;
  }

  async start(): Promise<void> {
    if (this.loaded) return;
    await this.routeBindings.start();
    const { sessions, messages, inputs } = loadSessionBrokerState(await this.store.load());
    this.sessions.clear();
    this.messages.clear();
    this.inputs.clear();
    for (const session of sessions.values()) {
      this.sessions.set(session.id, session);
    }
    for (const [sessionId, bucket] of messages.entries()) {
      this.messages.set(sessionId, bucket);
    }
    for (const [sessionId, bucket] of inputs.entries()) {
      this.inputs.set(sessionId, bucket);
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

  getInputs(sessionId: string, limit = 100): SharedSessionInputRecord[] {
    const bucket = this.inputs.get(sessionId) ?? [];
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
      pendingInputCount: 0,
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
    const claimed = this.claimNextQueuedInput(sessionId, agentId);
    await this.persist();
    this.publishUpdate('session-agent-bound', updated);
    if (claimed) {
      this.publishInputLifecycleEvent('session-input-spawned', claimed, {
        agentId,
      });
    }
    return updated;
  }

  async submitMessage(input: SubmitSharedSessionMessageInput): Promise<SharedSessionSubmission> {
    return await this.handleIntent('submit', input, true);
  }

  async steerMessage(input: SteerSharedSessionMessageInput): Promise<SharedSessionSubmission> {
    return await this.handleIntent('steer', input, input.allowSpawnFallback === true);
  }

  async followUpMessage(input: SubmitSharedSessionMessageInput): Promise<SharedSessionSubmission> {
    return await this.handleIntent('follow-up', input, true);
  }

  async appendSystemMessage(sessionId: string, body: string, metadata: Record<string, unknown> = {}): Promise<SharedSessionMessage | null> {
    if (!body.trim()) return null;
    return this.appendMessage(sessionId, {
      role: 'system',
      body,
      metadata,
    });
  }

  async completeAgent(sessionId: string, agentId: string, body: string, metadata: Record<string, unknown> = {}): Promise<SharedSessionCompletion | null> {
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
    const finalizedInputs = this.finalizeAgentInputs(
      sessionId,
      agentId,
      metadata.status === 'failed' ? 'failed' : metadata.status === 'cancelled' ? 'cancelled' : 'completed',
      metadata.status === 'failed' ? body : undefined,
    );
    await this.persist();
    this.publishUpdate('session-agent-completed', {
      sessionId,
      agentId,
      status: metadata.status ?? 'completed',
    });
    for (const finalized of finalizedInputs) {
      this.publishInputLifecycleEvent(`session-input-${finalized.state}`, finalized, { agentId });
    }
    const continuation = await this.runQueuedFollowUp(sessionId);
    return {
      session: this.sessions.get(sessionId)!,
      ...(continuation?.input ? { continuedInput: continuation.input } : {}),
      ...(continuation?.agentId ? { continuedAgentId: continuation.agentId } : {}),
    };
  }

  async cancelInput(sessionId: string, inputId: string): Promise<SharedSessionInputRecord | null> {
    await this.start();
    const updated = this.updateInput(sessionId, inputId, (entry) => {
      if (entry.state !== 'queued') return entry;
      return {
        ...entry,
        state: 'cancelled',
        updatedAt: Date.now(),
      };
    });
    if (!updated) return null;
    this.refreshPendingInputCount(sessionId);
    await this.persist();
    this.publishInputLifecycleEvent('session-input-cancelled', updated);
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
    const participants = upsertSessionParticipant(existing.participants, {
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
      surfaceKinds: dedupeSessionSurfaceKinds(participants),
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
    await this.store.persist(createSessionBrokerSnapshot({
      sessions: this.sessions,
      messages: this.messages,
      inputs: this.inputs,
    }, MAX_PERSISTED_MESSAGES));
  }

  private publishUpdate(event: string, payload: unknown): void {
    this.eventPublisher?.('session-update', {
      event,
      payload,
      createdAt: Date.now(),
    });
  }

  private publishInputLifecycleEvent(
    event: string,
    input: SharedSessionInputRecord,
    extra: Record<string, unknown> = {},
  ): void {
    this.publishUpdate(event, {
      sessionId: input.sessionId,
      inputId: input.id,
      intent: input.intent,
      state: input.state,
      correlationId: input.correlationId,
      causationId: input.causationId ?? null,
      ...(input.activeAgentId ? { activeAgentId: input.activeAgentId } : {}),
      ...extra,
    });
  }

  private async handleIntent(
    intent: SharedSessionInputIntent,
    input: SubmitSharedSessionMessageInput,
    allowSpawnFallback: boolean,
  ): Promise<SharedSessionSubmission> {
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
      metadata: {
        ...(input.metadata ?? {}),
        sessionIntent: intent,
      },
    });
    const queuedInput = this.recordInput(updatedSession.id, intent, input, binding?.id, userMessage.id);
    this.publishInputLifecycleEvent('session-input-queued', queuedInput, {
      messageId: userMessage.id,
    });

    const activeAgentId = this.resolveActiveAgentId(updatedSession);
    if (intent !== 'follow-up' && activeAgentId) {
      const sent = this.messageSender.send('orchestrator', activeAgentId, input.body, { kind: 'directive' });
      if (sent) {
        const delivered = this.updateInput(updatedSession.id, queuedInput.id, (entry) => ({
          ...entry,
          state: 'delivered',
          activeAgentId,
          updatedAt: Date.now(),
        })) ?? queuedInput;
        await this.persist();
        this.publishInputLifecycleEvent('session-input-delivered', delivered, {
          agentId: activeAgentId,
          messageId: userMessage.id,
        });
        this.publishUpdate('session-message-forwarded', {
          sessionId: updatedSession.id,
          agentId: activeAgentId,
          messageId: userMessage.id,
          inputId: delivered.id,
          intent,
        });
        return {
          session: this.sessions.get(updatedSession.id)!,
          userMessage,
          routeBinding: binding ?? undefined,
          input: delivered,
          intent,
          mode: 'continued-live',
          state: delivered.state,
          activeAgentId,
          created,
        };
      }
      if (intent === 'steer' && !allowSpawnFallback) {
        const rejected = this.updateInput(updatedSession.id, queuedInput.id, (entry) => ({
          ...entry,
          state: 'rejected',
          updatedAt: Date.now(),
          error: 'No active agent accepted the steer request.',
        })) ?? queuedInput;
        await this.persist();
        this.publishInputLifecycleEvent('session-input-rejected', rejected, {
          messageId: userMessage.id,
        });
        return {
          session: this.sessions.get(updatedSession.id)!,
          userMessage,
          routeBinding: binding ?? undefined,
          input: rejected,
          intent,
          mode: 'rejected',
          state: rejected.state,
          created,
        };
      }
    }

    if (intent === 'follow-up' && activeAgentId) {
      await this.persist();
      this.publishInputLifecycleEvent('session-follow-up-queued', queuedInput, {
        agentId: activeAgentId,
        messageId: userMessage.id,
      });
      return {
        session: this.sessions.get(updatedSession.id)!,
        userMessage,
        routeBinding: binding ?? undefined,
        input: queuedInput,
        intent,
        mode: 'queued-follow-up',
        state: queuedInput.state,
        activeAgentId,
        created,
      };
    }

    await this.persist();
    return {
      session: this.sessions.get(updatedSession.id)!,
      userMessage,
      routeBinding: binding ?? undefined,
      input: queuedInput,
      intent,
      mode: 'spawn',
      state: queuedInput.state,
      task: this.buildContinuationTask(updatedSession.id),
      created,
    };
  }

  private recordInput(
    sessionId: string,
    intent: SharedSessionInputIntent,
    input: SubmitSharedSessionMessageInput,
    routeId?: string,
    causationId?: string,
  ): SharedSessionInputRecord {
    const id = `sin-${randomUUID().slice(0, 8)}`;
    const entry: SharedSessionInputRecord = {
      id,
      sessionId,
      intent,
      state: 'queued',
      correlationId: typeof input.metadata?.correlationId === 'string' ? input.metadata.correlationId : `session-input:${id}`,
      ...(causationId ? { causationId } : {}),
      body: input.body,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      routeId,
      surfaceKind: input.surfaceKind,
      surfaceId: input.surfaceId,
      externalId: input.externalId,
      threadId: input.threadId,
      userId: input.userId,
      displayName: input.displayName,
      metadata: input.metadata ?? {},
      routing: input.routing,
    };
    const bucket = this.inputs.get(sessionId) ?? [];
    bucket.push(entry);
    this.inputs.set(sessionId, sortInputs(bucket));
    this.refreshPendingInputCount(sessionId);
    return entry;
  }

  private updateInput(
    sessionId: string,
    inputId: string,
    transform: (input: SharedSessionInputRecord) => SharedSessionInputRecord,
  ): SharedSessionInputRecord | null {
    const bucket = this.inputs.get(sessionId);
    if (!bucket) return null;
    const index = bucket.findIndex((entry) => entry.id === inputId);
    if (index < 0) return null;
    const updated = transform(bucket[index]);
    bucket[index] = updated;
    this.inputs.set(sessionId, bucket);
    this.refreshPendingInputCount(sessionId);
    return updated;
  }

  private claimNextQueuedInput(sessionId: string, agentId: string): SharedSessionInputRecord | null {
    const bucket = this.inputs.get(sessionId) ?? [];
    const next = bucket.find((entry) => entry.state === 'queued');
    if (!next) return null;
    return this.updateInput(sessionId, next.id, (entry) => ({
      ...entry,
      state: 'spawned',
      activeAgentId: agentId,
      updatedAt: Date.now(),
    }));
  }

  private finalizeAgentInputs(
    sessionId: string,
    agentId: string,
    nextState: Extract<SharedSessionInputRecord['state'], 'completed' | 'failed' | 'cancelled'>,
    error?: string,
  ): SharedSessionInputRecord[] {
    const bucket = this.inputs.get(sessionId);
    if (!bucket) return [];
    let changed = false;
    const updatedInputs: SharedSessionInputRecord[] = [];
    for (let index = 0; index < bucket.length; index += 1) {
      const entry = bucket[index];
      if (entry.activeAgentId !== agentId) continue;
      if (entry.state !== 'delivered' && entry.state !== 'spawned') continue;
      bucket[index] = {
        ...entry,
        state: nextState,
        updatedAt: Date.now(),
        ...(error ? { error } : {}),
      };
      updatedInputs.push(bucket[index]!);
      changed = true;
    }
    if (changed) {
      this.inputs.set(sessionId, bucket);
      this.refreshPendingInputCount(sessionId);
    }
    return updatedInputs;
  }

  private async runQueuedFollowUp(sessionId: string): Promise<{ input: SharedSessionInputRecord; agentId: string } | null> {
    if (!this.continuationRunner) return null;
    const bucket = this.inputs.get(sessionId) ?? [];
    const next = bucket.find((entry) => entry.intent === 'follow-up' && entry.state === 'queued');
    if (!next) return null;
    const routeBinding = next.routeId ? this.routeBindings.getBinding(next.routeId) : undefined;
    const task = this.buildContinuationTask(sessionId);
    const spawned = await this.continuationRunner({
      sessionId,
      input: next,
      task,
      routeBinding,
    });
    if (!spawned?.agentId) return null;
    await this.bindAgent(sessionId, spawned.agentId);
    const claimed = this.inputs.get(sessionId)?.find((entry) => entry.activeAgentId === spawned.agentId && entry.state === 'spawned') ?? null;
    if (claimed) {
      this.publishInputLifecycleEvent('session-follow-up-spawned', claimed, {
        agentId: spawned.agentId,
      });
    }
    await this.persist();
    return claimed ? { input: claimed, agentId: spawned.agentId } : null;
  }

  private refreshPendingInputCount(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    const pendingInputCount = countPendingSessionInputs(this.inputs.get(sessionId) ?? []);
    this.sessions.set(sessionId, {
      ...session,
      pendingInputCount,
      updatedAt: Date.now(),
    });
  }
}
