import { createHash } from 'node:crypto';
import { createDomainDispatch } from '../runtime/store/index.ts';
import type { DomainDispatch, RuntimeStore } from '../runtime/store/index.ts';
import type { RuntimeEventBus } from '../runtime/events/index.ts';
import type { RouteSurfaceKind } from '../runtime/events/routes.ts';
import {
  emitRouteBindingCreated,
  emitRouteBindingFailed,
  emitRouteBindingResolved,
  emitRouteBindingUpdated,
  emitRouteReplyTargetCaptured,
} from '../runtime/emitters/index.ts';
import type { AutomationRouteBinding } from '../automation/routes.ts';
import type { AutomationSurfaceKind } from '../automation/types.ts';
import { AutomationRouteStore } from '../automation/store/routes.ts';

export interface UpsertRouteBindingInput {
  readonly id?: string;
  readonly kind: AutomationRouteBinding['kind'];
  readonly surfaceKind: AutomationRouteBinding['surfaceKind'];
  readonly surfaceId: string;
  readonly externalId: string;
  readonly sessionPolicy?: AutomationRouteBinding['sessionPolicy'];
  readonly threadPolicy?: AutomationRouteBinding['threadPolicy'];
  readonly deliveryGuarantee?: AutomationRouteBinding['deliveryGuarantee'];
  readonly threadId?: string;
  readonly channelId?: string;
  readonly sessionId?: string;
  readonly jobId?: string;
  readonly runId?: string;
  readonly title?: string;
  readonly metadata?: Record<string, unknown>;
}

export interface PatchRouteBindingInput {
  readonly sessionPolicy?: AutomationRouteBinding['sessionPolicy'];
  readonly threadPolicy?: AutomationRouteBinding['threadPolicy'];
  readonly deliveryGuarantee?: AutomationRouteBinding['deliveryGuarantee'];
  readonly threadId?: string;
  readonly channelId?: string;
  readonly sessionId?: string | null;
  readonly jobId?: string | null;
  readonly runId?: string | null;
  readonly title?: string;
  readonly metadata?: Record<string, unknown>;
}

function toEventSurfaceKind(surfaceKind: AutomationSurfaceKind): RouteSurfaceKind {
  switch (surfaceKind) {
    case 'tui':
    case 'slack':
    case 'discord':
    case 'web':
    case 'ntfy':
    case 'webhook':
    case 'telegram':
    case 'google-chat':
    case 'signal':
    case 'whatsapp':
    case 'imessage':
    case 'msteams':
    case 'bluebubbles':
    case 'mattermost':
    case 'matrix':
    case 'service':
      return surfaceKind;
  }
  const _exhaustive: never = surfaceKind;
  return _exhaustive;
}

function sortBindings(bindings: Iterable<AutomationRouteBinding>): AutomationRouteBinding[] {
  return [...bindings].sort((a, b) => b.lastSeenAt - a.lastSeenAt || a.id.localeCompare(b.id));
}

function routeNaturalKey(input: Pick<UpsertRouteBindingInput, 'surfaceKind' | 'surfaceId' | 'externalId' | 'threadId' | 'channelId'>): string {
  return [
    input.surfaceKind,
    input.surfaceId,
    input.externalId,
    input.threadId ?? '',
    input.channelId ?? '',
  ].join('\u001f');
}

function deterministicRouteId(input: Pick<UpsertRouteBindingInput, 'surfaceKind' | 'surfaceId' | 'externalId' | 'threadId' | 'channelId'>): string {
  return `route-${createHash('sha256').update(routeNaturalKey(input)).digest('hex').slice(0, 12)}`;
}

export class RouteBindingManager {
  private readonly store: AutomationRouteStore;
  private readonly bindings = new Map<string, AutomationRouteBinding>();
  private runtimeDispatch: DomainDispatch | null = null;
  private runtimeBus: RuntimeEventBus | null = null;
  private loaded = false;

  constructor(config: {
    readonly store?: AutomationRouteStore;
    readonly runtimeStore?: RuntimeStore;
    readonly runtimeBus?: RuntimeEventBus;
  } = {}) {
    this.store = config.store ?? new AutomationRouteStore();
    if (config.runtimeStore) this.runtimeDispatch = createDomainDispatch(config.runtimeStore);
    this.runtimeBus = config.runtimeBus ?? null;
  }

  attachRuntime(config: {
    readonly runtimeStore?: RuntimeStore | null;
    readonly runtimeBus?: RuntimeEventBus | null;
  }): void {
    if (config.runtimeStore) {
      this.runtimeDispatch = createDomainDispatch(config.runtimeStore);
      for (const binding of this.bindings.values()) {
        this.runtimeDispatch.syncRouteBinding(binding, 'routes.attach');
      }
    }
    if (config.runtimeBus) {
      this.runtimeBus = config.runtimeBus;
    }
  }

  async start(): Promise<void> {
    if (this.loaded) return;
    const snapshot = await this.store.load();
    this.bindings.clear();
    for (const binding of snapshot.routes) {
      this.bindings.set(binding.id, binding);
      this.runtimeDispatch?.syncRouteBinding(binding, 'routes.load');
    }
    this.loaded = true;
  }

  listBindings(): AutomationRouteBinding[] {
    return sortBindings(this.bindings.values());
  }

  getBinding(bindingId: string): AutomationRouteBinding | undefined {
    return this.bindings.get(bindingId);
  }

  resolve(surfaceKind: AutomationSurfaceKind, externalId: string, threadId?: string): AutomationRouteBinding | undefined {
    const binding = this.listBindings().find((entry) => {
      if (entry.surfaceKind !== surfaceKind) return false;
      if (entry.externalId !== externalId) return false;
      if (threadId) {
        return entry.threadId === threadId || entry.channelId === threadId;
      }
      return true;
    });
    if (!binding) return undefined;
    const eventSurfaceKind = toEventSurfaceKind(binding.surfaceKind);
    if (this.runtimeBus) {
      const targetId = binding.sessionId ?? binding.runId ?? binding.jobId ?? binding.externalId;
      const targetKind = binding.sessionId ? 'session' : binding.runId ? 'run' : binding.jobId ? 'job' : 'message';
      emitRouteBindingResolved(this.runtimeBus, {
        sessionId: binding.sessionId ?? 'routes',
        source: 'route-binding-manager',
        traceId: binding.id,
      }, {
        bindingId: binding.id,
        surfaceKind: eventSurfaceKind,
        externalId: binding.externalId,
        targetKind,
        targetId,
      });
    }
    return binding;
  }

  async upsertBinding(input: UpsertRouteBindingInput): Promise<AutomationRouteBinding> {
    await this.start();
    const now = Date.now();
    const previous = input.id
      ? this.bindings.get(input.id)
      : this.listBindings().find((entry) => routeNaturalKey(entry) === routeNaturalKey(input));
    const binding: AutomationRouteBinding = {
      id: input.id ?? previous?.id ?? deterministicRouteId(input),
      kind: input.kind,
      surfaceKind: input.surfaceKind,
      surfaceId: input.surfaceId,
      externalId: input.externalId,
      sessionPolicy: input.sessionPolicy ?? previous?.sessionPolicy ?? 'create-or-bind',
      threadPolicy: input.threadPolicy ?? previous?.threadPolicy ?? 'preserve',
      deliveryGuarantee: input.deliveryGuarantee ?? previous?.deliveryGuarantee ?? 'best-effort',
      threadId: input.threadId ?? previous?.threadId,
      channelId: input.channelId ?? previous?.channelId,
      sessionId: input.sessionId ?? previous?.sessionId,
      jobId: input.jobId ?? previous?.jobId,
      runId: input.runId ?? previous?.runId,
      title: input.title ?? previous?.title,
      lastSeenAt: now,
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
      metadata: {
        ...(previous?.metadata ?? {}),
        ...(input.metadata ?? {}),
      },
    };
    this.bindings.set(binding.id, binding);
    await this.store.save(sortBindings(this.bindings.values()));
    this.runtimeDispatch?.syncRouteBinding(binding, 'routes.upsert');

    const eventSurfaceKind = toEventSurfaceKind(binding.surfaceKind);
    if (this.runtimeBus) {
      const targetId = binding.sessionId ?? binding.runId ?? binding.jobId ?? binding.externalId;
      const targetKind = binding.sessionId ? 'session' : binding.runId ? 'run' : binding.jobId ? 'job' : 'message';
      if (previous) {
        emitRouteBindingUpdated(this.runtimeBus, {
          sessionId: binding.sessionId ?? 'routes',
          source: 'route-binding-manager',
          traceId: binding.id,
        }, {
          bindingId: binding.id,
          changedFields: ['sessionPolicy', 'threadPolicy', 'deliveryGuarantee', 'threadId', 'channelId', 'sessionId', 'jobId', 'runId', 'metadata'],
        });
      } else {
        emitRouteBindingCreated(this.runtimeBus, {
          sessionId: binding.sessionId ?? 'routes',
          source: 'route-binding-manager',
          traceId: binding.id,
        }, {
          bindingId: binding.id,
          surfaceKind: eventSurfaceKind,
          externalId: binding.externalId,
          targetKind,
          targetId,
        });
      }
    }

    return binding;
  }

  async captureReplyTarget(bindingId: string, replyTargetId: string, threadId?: string): Promise<AutomationRouteBinding | null> {
    await this.start();
    const binding = this.bindings.get(bindingId);
    if (!binding) return null;
    const updated: AutomationRouteBinding = {
      ...binding,
      threadId: threadId ?? binding.threadId,
      updatedAt: Date.now(),
      lastSeenAt: Date.now(),
      metadata: {
        ...binding.metadata,
        replyTargetId,
      },
    };
    this.bindings.set(bindingId, updated);
    await this.store.save(sortBindings(this.bindings.values()));
    this.runtimeDispatch?.syncRouteBinding(updated, 'routes.reply-target');
    const eventSurfaceKind = toEventSurfaceKind(updated.surfaceKind);
    if (this.runtimeBus) {
      emitRouteReplyTargetCaptured(this.runtimeBus, {
        sessionId: updated.sessionId ?? 'routes',
        source: 'route-binding-manager',
        traceId: updated.id,
      }, {
        bindingId: updated.id,
        surfaceKind: eventSurfaceKind,
        externalId: updated.externalId,
        replyTargetId,
        threadId: updated.threadId ?? '',
      });
    }
    return updated;
  }

  async patchBinding(bindingId: string, patch: PatchRouteBindingInput): Promise<AutomationRouteBinding | null> {
    await this.start();
    const binding = this.bindings.get(bindingId);
    if (!binding) return null;
    const updated: AutomationRouteBinding = {
      ...binding,
      ...(patch.sessionPolicy !== undefined ? { sessionPolicy: patch.sessionPolicy } : {}),
      ...(patch.threadPolicy !== undefined ? { threadPolicy: patch.threadPolicy } : {}),
      ...(patch.deliveryGuarantee !== undefined ? { deliveryGuarantee: patch.deliveryGuarantee } : {}),
      ...(patch.threadId !== undefined ? { threadId: patch.threadId } : {}),
      ...(patch.channelId !== undefined ? { channelId: patch.channelId } : {}),
      ...(patch.sessionId !== undefined ? { sessionId: patch.sessionId ?? undefined } : {}),
      ...(patch.jobId !== undefined ? { jobId: patch.jobId ?? undefined } : {}),
      ...(patch.runId !== undefined ? { runId: patch.runId ?? undefined } : {}),
      ...(patch.title !== undefined ? { title: patch.title } : {}),
      updatedAt: Date.now(),
      lastSeenAt: Date.now(),
      metadata: {
        ...binding.metadata,
        ...(patch.metadata ?? {}),
      },
    };
    this.bindings.set(bindingId, updated);
    await this.store.save(sortBindings(this.bindings.values()));
    this.runtimeDispatch?.syncRouteBinding(updated, 'routes.patch');

    const eventSurfaceKind = toEventSurfaceKind(updated.surfaceKind);
    if (this.runtimeBus) {
      emitRouteBindingUpdated(this.runtimeBus, {
        sessionId: updated.sessionId ?? 'routes',
        source: 'route-binding-manager',
        traceId: updated.id,
      }, {
        bindingId: updated.id,
        changedFields: [
          ...(patch.threadId !== undefined ? ['threadId'] : []),
          ...(patch.channelId !== undefined ? ['channelId'] : []),
          ...(patch.sessionId !== undefined ? ['sessionId'] : []),
          ...(patch.jobId !== undefined ? ['jobId'] : []),
          ...(patch.runId !== undefined ? ['runId'] : []),
          ...(patch.title !== undefined ? ['title'] : []),
          ...(patch.metadata ? ['metadata'] : []),
        ],
      });
    }

    return updated;
  }

  async removeBinding(bindingId: string): Promise<boolean> {
    await this.start();
    const removed = this.bindings.delete(bindingId);
    if (!removed) return false;
    await this.store.save(sortBindings(this.bindings.values()));
    return true;
  }

  recordFailure(surfaceKind: AutomationSurfaceKind, externalId: string, error: string): void {
    this.runtimeDispatch?.recordRouteBindingFailure(surfaceKind, externalId, 'routes.failure');
    const eventSurfaceKind = toEventSurfaceKind(surfaceKind);
    if (this.runtimeBus) {
      emitRouteBindingFailed(this.runtimeBus, {
        sessionId: 'routes',
        source: 'route-binding-manager',
        traceId: `${surfaceKind}:${externalId}`,
      }, {
        surfaceKind: eventSurfaceKind,
        externalId,
        error,
      });
    }
  }
}
