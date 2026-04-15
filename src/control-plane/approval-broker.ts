import { randomUUID } from 'node:crypto';
import { PersistentStore } from '@pellux/goodvibes-sdk/platform/state/persistent-store';
import type { PermissionPromptDecision, PermissionPromptRequest, PermissionRequestHandler } from '../permissions/prompt.ts';
import type { ControlPlaneSurfaceMessage } from '@pellux/goodvibes-sdk/platform/control-plane/types';

export type SharedApprovalStatus = 'pending' | 'claimed' | 'approved' | 'denied' | 'cancelled' | 'expired';

export interface SharedApprovalAuditRecord {
  readonly id: string;
  readonly action: 'created' | 'claimed' | 'approved' | 'denied' | 'cancelled' | 'expired' | 'updated';
  readonly actor: string;
  readonly actorSurface?: string;
  readonly createdAt: number;
  readonly note?: string;
}

export interface SharedApprovalRecord {
  readonly id: string;
  readonly callId: string;
  readonly sessionId?: string;
  readonly routeId?: string;
  readonly status: SharedApprovalStatus;
  readonly request: PermissionPromptRequest;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly claimedBy?: string;
  readonly claimedAt?: number;
  readonly resolvedAt?: number;
  readonly resolvedBy?: string;
  readonly decision?: PermissionPromptDecision;
  readonly metadata: Record<string, unknown>;
  readonly audit: readonly SharedApprovalAuditRecord[];
}

interface SharedApprovalStoreSnapshot extends Record<string, unknown> {
  readonly approvals: readonly SharedApprovalRecord[];
}

export interface RequestSharedApprovalInput {
  readonly request: PermissionPromptRequest;
  readonly sessionId?: string;
  readonly routeId?: string;
  readonly metadata?: Record<string, unknown>;
  readonly localPrompt?: PermissionRequestHandler;
  readonly timeoutMs?: number;
}

type ApprovalListener = (approval: SharedApprovalRecord) => void;
type ApprovalPublisher = {
  publishEvent(event: string, payload: unknown): void;
  publishSurfaceMessage(message: Omit<ControlPlaneSurfaceMessage, 'id' | 'createdAt'>): void;
};

function sortApprovals(records: Iterable<SharedApprovalRecord>): SharedApprovalRecord[] {
  return [...records].sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
}

function buildAudit(action: SharedApprovalAuditRecord['action'], actor: string, actorSurface?: string, note?: string): SharedApprovalAuditRecord {
  return {
    id: `apra-${randomUUID().slice(0, 8)}`,
    action,
    actor,
    actorSurface,
    createdAt: Date.now(),
    ...(note ? { note } : {}),
  };
}

export class ApprovalBroker {
  private readonly store: PersistentStore<SharedApprovalStoreSnapshot>;
  private readonly approvals = new Map<string, SharedApprovalRecord>();
  private readonly pendingResolvers = new Map<string, {
    resolve: (decision: PermissionPromptDecision) => void;
    timer?: ReturnType<typeof setTimeout>;
  }>();
  private readonly listeners = new Set<ApprovalListener>();
  private publisher: ApprovalPublisher | null = null;
  private loaded = false;

  constructor(
    options: {
      readonly store?: PersistentStore<SharedApprovalStoreSnapshot>;
      readonly storePath?: string;
    },
  ) {
    if (!options.store && !options.storePath) {
      throw new Error('ApprovalBroker requires an explicit store or storePath.');
    }
    const storePath = options.storePath;
    this.store = options.store ?? new PersistentStore<SharedApprovalStoreSnapshot>(storePath as string);
  }

  subscribe(listener: ApprovalListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  setPublisher(publisher: ApprovalPublisher | null): void {
    this.publisher = publisher;
  }

  async start(): Promise<void> {
    if (this.loaded) return;
    const snapshot = await this.store.load();
    this.approvals.clear();
    for (const approval of snapshot?.approvals ?? []) {
      this.approvals.set(approval.id, approval);
    }
    this.loaded = true;
  }

  listApprovals(limit = 100): SharedApprovalRecord[] {
    return sortApprovals(this.approvals.values()).slice(0, Math.max(1, limit));
  }

  getApproval(approvalId: string): SharedApprovalRecord | null {
    return this.approvals.get(approvalId) ?? null;
  }

  async requestApproval(input: RequestSharedApprovalInput): Promise<PermissionPromptDecision> {
    await this.start();
    const now = Date.now();
    const approval: SharedApprovalRecord = {
      id: `approval-${randomUUID().slice(0, 8)}`,
      callId: input.request.callId,
      sessionId: input.sessionId,
      routeId: input.routeId,
      status: 'pending',
      request: input.request,
      createdAt: now,
      updatedAt: now,
      metadata: input.metadata ?? {},
      audit: [buildAudit('created', 'approval-broker', 'service')],
    };
    const pendingDecision = new Promise<PermissionPromptDecision>((resolve) => {
      const timer = input.timeoutMs && input.timeoutMs > 0
        ? setTimeout(() => {
            void this.expireApproval(approval.id, `timed out after ${input.timeoutMs}ms`);
          }, input.timeoutMs)
        : undefined;
      this.pendingResolvers.set(approval.id, { resolve, timer });
    });
    this.approvals.set(approval.id, approval);
    try {
      await this.persist();
    } catch (error) {
      const pending = this.pendingResolvers.get(approval.id);
      if (pending) {
        if (pending.timer) clearTimeout(pending.timer);
        this.pendingResolvers.delete(approval.id);
      }
      this.approvals.delete(approval.id);
      throw error;
    }
    this.publish(approval);

    if (input.localPrompt) {
      void input.localPrompt(input.request)
        .then((decision) => this.resolveApproval(approval.id, {
          approved: decision.approved,
          remember: decision.remember,
          actor: 'tui-local',
          actorSurface: 'tui',
        }))
        .catch(() => {});
    }

    return pendingDecision;
  }

  async claimApproval(approvalId: string, actor: string, actorSurface = 'web', note?: string): Promise<SharedApprovalRecord | null> {
    await this.start();
    const approval = this.approvals.get(approvalId);
    if (!approval) return null;
    if (approval.status !== 'pending' && approval.status !== 'claimed') return approval;
    const updated: SharedApprovalRecord = {
      ...approval,
      status: 'claimed',
      claimedBy: actor,
      claimedAt: Date.now(),
      updatedAt: Date.now(),
      audit: [...approval.audit, buildAudit('claimed', actor, actorSurface, note)],
    };
    this.approvals.set(approvalId, updated);
    await this.persist();
    this.publish(updated);
    return updated;
  }

  async resolveApproval(
    approvalId: string,
    input: {
      readonly approved: boolean;
      readonly remember?: boolean;
      readonly actor: string;
      readonly actorSurface?: string;
      readonly note?: string;
    },
  ): Promise<SharedApprovalRecord | null> {
    await this.start();
    const approval = this.approvals.get(approvalId);
    if (!approval) return null;
    if (approval.status === 'approved' || approval.status === 'denied' || approval.status === 'cancelled' || approval.status === 'expired') {
      return approval;
    }
    const updated: SharedApprovalRecord = {
      ...approval,
      status: input.approved ? 'approved' : 'denied',
      updatedAt: Date.now(),
      resolvedAt: Date.now(),
      resolvedBy: input.actor,
      decision: {
        approved: input.approved,
        ...(input.remember !== undefined ? { remember: input.remember } : {}),
      },
      audit: [
        ...approval.audit,
        buildAudit(input.approved ? 'approved' : 'denied', input.actor, input.actorSurface, input.note),
      ],
    };
    this.approvals.set(approvalId, updated);
    await this.persist();
    this.publish(updated);

    const pending = this.pendingResolvers.get(approvalId);
    if (pending) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.resolve(updated.decision ?? { approved: input.approved });
      this.pendingResolvers.delete(approvalId);
    }
    return updated;
  }

  async recordRemoteUpdate(
    approvalId: string,
    input: {
      readonly actor: string;
      readonly actorSurface?: string;
      readonly note?: string;
      readonly metadata?: Record<string, unknown>;
    },
  ): Promise<SharedApprovalRecord | null> {
    await this.start();
    const approval = this.approvals.get(approvalId);
    if (!approval) return null;
    const updated: SharedApprovalRecord = {
      ...approval,
      updatedAt: Date.now(),
      metadata: {
        ...approval.metadata,
        ...(input.metadata ?? {}),
      },
      audit: [...approval.audit, buildAudit('updated', input.actor, input.actorSurface, input.note)],
    };
    this.approvals.set(approvalId, updated);
    await this.persist();
    this.publish(updated);
    return updated;
  }

  async cancelApproval(approvalId: string, actor: string, actorSurface = 'web', note?: string): Promise<SharedApprovalRecord | null> {
    await this.start();
    const approval = this.approvals.get(approvalId);
    if (!approval) return null;
    if (approval.status === 'approved' || approval.status === 'denied' || approval.status === 'cancelled' || approval.status === 'expired') {
      return approval;
    }
    const updated: SharedApprovalRecord = {
      ...approval,
      status: 'cancelled',
      updatedAt: Date.now(),
      resolvedAt: Date.now(),
      resolvedBy: actor,
      decision: { approved: false, remember: false },
      audit: [...approval.audit, buildAudit('cancelled', actor, actorSurface, note)],
    };
    this.approvals.set(approvalId, updated);
    await this.persist();
    this.publish(updated);
    const pending = this.pendingResolvers.get(approvalId);
    if (pending) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.resolve({ approved: false, remember: false });
      this.pendingResolvers.delete(approvalId);
    }
    return updated;
  }

  private async expireApproval(approvalId: string, note: string): Promise<void> {
    const approval = this.approvals.get(approvalId);
    if (!approval) return;
    if (approval.status !== 'pending' && approval.status !== 'claimed') return;
    const updated: SharedApprovalRecord = {
      ...approval,
      status: 'expired',
      updatedAt: Date.now(),
      resolvedAt: Date.now(),
      resolvedBy: 'approval-broker',
      decision: { approved: false, remember: false },
      audit: [...approval.audit, buildAudit('expired', 'approval-broker', 'service', note)],
    };
    this.approvals.set(approvalId, updated);
    await this.persist();
    this.publish(updated);
    const pending = this.pendingResolvers.get(approvalId);
    if (pending) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.resolve({ approved: false, remember: false });
      this.pendingResolvers.delete(approvalId);
    }
  }

  private async persist(): Promise<void> {
    await this.store.persist({
      approvals: sortApprovals(this.approvals.values()),
    });
  }

  private publish(approval: SharedApprovalRecord): void {
    this.publisher?.publishEvent('approval-update', {
      approval,
      createdAt: Date.now(),
    });
    this.publisher?.publishSurfaceMessage({
      surface: 'web',
      title: approval.status === 'pending' || approval.status === 'claimed' ? 'Approval required' : 'Approval resolved',
      body: `${approval.request.tool}: ${approval.request.analysis.summary}`,
      level: approval.status === 'approved'
        ? 'success'
        : approval.status === 'denied' || approval.status === 'expired'
          ? 'warn'
          : 'info',
      metadata: {
        approvalId: approval.id,
        status: approval.status,
        callId: approval.callId,
        sessionId: approval.sessionId,
        routeId: approval.routeId,
      },
    });
    for (const listener of this.listeners) {
      try {
        listener(approval);
      } catch {
        // Best-effort observer channel.
      }
    }
  }
}
