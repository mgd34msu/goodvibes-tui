import type {
  ControlPlaneRecentEvent,
  SharedApprovalRecord,
  SharedSessionInputRecord,
  SharedSessionMessage,
  SharedSessionRecord,
  SharedSessionSubmission,
  SteerSharedSessionMessageInput,
  SubmitSharedSessionMessageInput,
} from '@pellux/goodvibes-sdk/platform/control-plane/index';
import type { RequestSharedApprovalInput } from '@pellux/goodvibes-sdk/platform/control-plane/index';
import type { PermissionPromptDecision } from '@pellux/goodvibes-sdk/platform/permissions/prompt';
import { buildAuthInspectionSnapshot, type AuthInspectionSnapshot } from '@pellux/goodvibes-sdk/platform/runtime/auth/inspection';
import { buildProviderAccountSnapshot, type ProviderAccountSnapshot } from '@pellux/goodvibes-sdk/platform/runtime/provider-accounts/registry';
import type { ProviderRuntimeSnapshot, ProviderUsageSnapshot } from '@pellux/goodvibes-sdk/platform/providers/runtime-snapshot';
import { getProviderRuntimeSnapshot, getProviderUsageSnapshot, listProviderRuntimeSnapshots } from '@pellux/goodvibes-sdk/platform/providers/runtime-snapshot';
import type { OperatorClientServices } from '@pellux/goodvibes-sdk/platform/runtime/foundation-services';
import type { RuntimeTask } from '@pellux/goodvibes-sdk/platform/runtime/store/domains/tasks';
import type { UiControlPlaneSnapshot, UiSessionSnapshot, UiTasksSnapshot } from './ui-read-models.ts';
import type { UiRuntimeEvents } from '@pellux/goodvibes-sdk/platform/runtime/ui-events';
import type { ShellPathService } from '@pellux/goodvibes-sdk/platform/runtime/shell-paths';

export interface OperatorControlPlaneSnapshot extends UiControlPlaneSnapshot {}

export interface OperatorProvidersSnapshot {
  readonly providerIds: readonly string[];
  readonly runtimeSnapshots: readonly ProviderRuntimeSnapshot[];
  readonly accountSnapshot: ProviderAccountSnapshot;
  readonly authInspection: AuthInspectionSnapshot;
}

export interface OperatorSessionsClient {
  current(): UiSessionSnapshot;
  list(limit?: number): readonly SharedSessionRecord[];
  get(sessionId: string): SharedSessionRecord | null;
  messages(sessionId: string, limit?: number): readonly SharedSessionMessage[];
  inputs(sessionId: string, limit?: number): readonly SharedSessionInputRecord[];
  ensureSession(input?: OperatorSessionEnsureInput): Promise<SharedSessionRecord>;
  close(sessionId: string): Promise<SharedSessionRecord | null>;
  reopen(sessionId: string): Promise<SharedSessionRecord | null>;
  bindAgent(sessionId: string, agentId: string): Promise<SharedSessionRecord | null>;
  submitMessage(input: SubmitSharedSessionMessageInput): Promise<SharedSessionSubmission>;
  steerMessage(input: SteerSharedSessionMessageInput): Promise<SharedSessionSubmission>;
  followUpMessage(input: SubmitSharedSessionMessageInput): Promise<SharedSessionSubmission>;
  cancelInput(sessionId: string, inputId: string): Promise<SharedSessionInputRecord | null>;
}

export interface OperatorTasksClient {
  snapshot(): UiTasksSnapshot;
  list(limit?: number): readonly RuntimeTask[];
  get(taskId: string): RuntimeTask | null;
  running(): readonly RuntimeTask[];
}

export interface OperatorApprovalsClient {
  list(limit?: number): readonly SharedApprovalRecord[];
  get(approvalId: string): SharedApprovalRecord | null;
  request(input: RequestSharedApprovalInput): Promise<PermissionPromptDecision>;
  claim(approvalId: string, actor: string, actorSurface?: string, note?: string): Promise<SharedApprovalRecord | null>;
  resolve(
    approvalId: string,
    input: {
      readonly approved: boolean;
      readonly remember?: boolean;
      readonly actor: string;
      readonly actorSurface?: string;
      readonly note?: string;
    },
  ): Promise<SharedApprovalRecord | null>;
  approve(approvalId: string, actor: string, actorSurface?: string, note?: string): Promise<SharedApprovalRecord | null>;
  deny(approvalId: string, actor: string, actorSurface?: string, note?: string): Promise<SharedApprovalRecord | null>;
  cancel(approvalId: string, actor: string, actorSurface?: string, note?: string): Promise<SharedApprovalRecord | null>;
  update(
    approvalId: string,
    input: {
      readonly actor: string;
      readonly actorSurface?: string;
      readonly note?: string;
      readonly metadata?: Record<string, unknown>;
    },
  ): Promise<SharedApprovalRecord | null>;
}

export type OperatorSessionEnsureInput = NonNullable<Parameters<OperatorClientServices['sessionBroker']['ensureSession']>[0]>;

export interface OperatorProvidersClient {
  listIds(): readonly string[];
  runtimeSnapshots(): Promise<readonly ProviderRuntimeSnapshot[]>;
  runtimeSnapshot(providerId: string): Promise<ProviderRuntimeSnapshot | null>;
  usageSnapshot(providerId: string): Promise<ProviderUsageSnapshot | null>;
  snapshot(): Promise<OperatorProvidersSnapshot>;
  accountSnapshot(): Promise<ProviderAccountSnapshot>;
  authInspection(): Promise<AuthInspectionSnapshot>;
}

export interface OperatorControlPlaneClient {
  snapshot(): OperatorControlPlaneSnapshot;
  recentEvents(limit?: number): readonly ControlPlaneRecentEvent[];
}

export interface OperatorClient {
  readonly sessions: OperatorSessionsClient;
  readonly tasks: OperatorTasksClient;
  readonly approvals: OperatorApprovalsClient;
  readonly providers: OperatorProvidersClient;
  readonly controlPlane: OperatorControlPlaneClient;
  readonly events: UiRuntimeEvents;
  readonly shellPaths: ShellPathService;
}

function normalizeLimit(limit: number): number {
  if (!Number.isFinite(limit)) return 1;
  return Math.max(1, Math.floor(limit));
}

function listTasksSnapshot(snapshot: UiTasksSnapshot, limit = 100): readonly RuntimeTask[] {
  return snapshot.tasks.slice(0, normalizeLimit(limit));
}

function getTaskSnapshot(snapshot: UiTasksSnapshot, taskId: string): RuntimeTask | null {
  return snapshot.tasks.find((task) => task.id === taskId) ?? null;
}

export function createOperatorClient(services: OperatorClientServices): OperatorClient {
  const sessions = {
    current: (): UiSessionSnapshot => services.readModels.session.getSnapshot(),
    list: (limit = 100): readonly SharedSessionRecord[] => services.sessionBroker.listSessions(normalizeLimit(limit)),
    get: (sessionId: string): SharedSessionRecord | null => services.sessionBroker.getSession(sessionId),
    messages: (sessionId: string, limit = 100): readonly SharedSessionMessage[] => services.sessionBroker.getMessages(sessionId, normalizeLimit(limit)),
    inputs: (sessionId: string, limit = 100): readonly SharedSessionInputRecord[] => services.sessionBroker.getInputs(sessionId, normalizeLimit(limit)),
    ensureSession: (input: Parameters<OperatorClientServices['sessionBroker']['ensureSession']>[0] = {}): Promise<SharedSessionRecord> => services.sessionBroker.ensureSession(input),
    close: (sessionId: string): Promise<SharedSessionRecord | null> => services.sessionBroker.closeSession(sessionId),
    reopen: (sessionId: string): Promise<SharedSessionRecord | null> => services.sessionBroker.reopenSession(sessionId),
    bindAgent: (sessionId: string, agentId: string): Promise<SharedSessionRecord | null> => services.sessionBroker.bindAgent(sessionId, agentId),
    submitMessage: (input: SubmitSharedSessionMessageInput): Promise<SharedSessionSubmission> => services.sessionBroker.submitMessage(input),
    steerMessage: (input: SteerSharedSessionMessageInput): Promise<SharedSessionSubmission> => services.sessionBroker.steerMessage(input),
    followUpMessage: (input: SubmitSharedSessionMessageInput): Promise<SharedSessionSubmission> => services.sessionBroker.followUpMessage(input),
    cancelInput: (sessionId: string, inputId: string): Promise<SharedSessionInputRecord | null> => services.sessionBroker.cancelInput(sessionId, inputId),
  } satisfies OperatorSessionsClient;

  const tasks = {
    snapshot: (): UiTasksSnapshot => services.readModels.tasks.getSnapshot(),
    list: (limit = 100): readonly RuntimeTask[] => listTasksSnapshot(services.readModels.tasks.getSnapshot(), limit),
    get: (taskId: string): RuntimeTask | null => getTaskSnapshot(services.readModels.tasks.getSnapshot(), taskId),
    running: (): readonly RuntimeTask[] => services.readModels.tasks.getSnapshot().tasks.filter((task) => task.status === 'running'),
  } satisfies OperatorTasksClient;

  const approvals = {
    list: (limit = 100): readonly SharedApprovalRecord[] => services.approvalBroker.listApprovals(normalizeLimit(limit)),
    get: (approvalId: string): SharedApprovalRecord | null => services.approvalBroker.getApproval(approvalId),
    request: (input: RequestSharedApprovalInput): Promise<PermissionPromptDecision> => services.approvalBroker.requestApproval(input),
    claim: (approvalId: string, actor: string, actorSurface = 'operator', note?: string): Promise<SharedApprovalRecord | null> => services.approvalBroker.claimApproval(approvalId, actor, actorSurface, note),
    resolve: (approvalId: string, input: {
      readonly approved: boolean;
      readonly remember?: boolean;
      readonly actor: string;
      readonly actorSurface?: string;
      readonly note?: string;
    }): Promise<SharedApprovalRecord | null> => services.approvalBroker.resolveApproval(approvalId, input),
    approve: (approvalId: string, actor: string, actorSurface = 'operator', note?: string): Promise<SharedApprovalRecord | null> => services.approvalBroker.resolveApproval(approvalId, {
      approved: true,
      actor,
      actorSurface,
      note,
    }),
    deny: (approvalId: string, actor: string, actorSurface = 'operator', note?: string): Promise<SharedApprovalRecord | null> => services.approvalBroker.resolveApproval(approvalId, {
      approved: false,
      actor,
      actorSurface,
      note,
    }),
    cancel: (approvalId: string, actor: string, actorSurface = 'operator', note?: string): Promise<SharedApprovalRecord | null> => services.approvalBroker.cancelApproval(approvalId, actor, actorSurface, note),
    update: (approvalId: string, input: {
      readonly actor: string;
      readonly actorSurface?: string;
      readonly note?: string;
      readonly metadata?: Record<string, unknown>;
    }): Promise<SharedApprovalRecord | null> => services.approvalBroker.recordRemoteUpdate(approvalId, input),
  } satisfies OperatorApprovalsClient;

  const providers = {
    listIds: (): readonly string[] => services.readModels.providers.getSnapshot().providerIds,
    runtimeSnapshots: (): Promise<readonly ProviderRuntimeSnapshot[]> => listProviderRuntimeSnapshots(services.providerRegistry),
    runtimeSnapshot: (providerId: string): Promise<ProviderRuntimeSnapshot | null> => getProviderRuntimeSnapshot(services.providerRegistry, providerId),
    usageSnapshot: (providerId: string): Promise<ProviderUsageSnapshot | null> => getProviderUsageSnapshot(services.providerRegistry, providerId),
    accountSnapshot: (): Promise<ProviderAccountSnapshot> => buildProviderAccountSnapshot({
      providerRegistry: services.providerRegistry,
      serviceRegistry: services.serviceRegistry,
      subscriptionManager: services.subscriptionManager,
      secretsManager: services.secretsManager,
    }),
    authInspection: (): Promise<AuthInspectionSnapshot> => buildAuthInspectionSnapshot({
      serviceRegistry: services.serviceRegistry,
      subscriptionManager: services.subscriptionManager,
      secretsManager: services.secretsManager,
    }),
    snapshot: async (): Promise<OperatorProvidersSnapshot> => {
      const [runtimeSnapshots, accountSnapshot, authInspection] = await Promise.all([
        listProviderRuntimeSnapshots(services.providerRegistry),
        buildProviderAccountSnapshot({
          providerRegistry: services.providerRegistry,
          serviceRegistry: services.serviceRegistry,
          subscriptionManager: services.subscriptionManager,
          secretsManager: services.secretsManager,
        }),
        buildAuthInspectionSnapshot({
          serviceRegistry: services.serviceRegistry,
          subscriptionManager: services.subscriptionManager,
          secretsManager: services.secretsManager,
        }),
      ]);
      return {
        providerIds: services.readModels.providers.getSnapshot().providerIds,
        runtimeSnapshots,
        accountSnapshot,
        authInspection,
      };
    },
  } satisfies OperatorProvidersClient;

  const controlPlane = {
    snapshot: (): OperatorControlPlaneSnapshot => services.readModels.controlPlane.getSnapshot(),
    recentEvents: (limit = 6): readonly ControlPlaneRecentEvent[] => services.readModels.controlPlane.getSnapshot().recentEvents.slice(0, normalizeLimit(limit)),
  } satisfies OperatorControlPlaneClient;

  return Object.freeze({
    sessions,
    tasks,
    approvals,
    providers,
    controlPlane,
    events: services.events,
    shellPaths: services.shellPaths,
  });
}
