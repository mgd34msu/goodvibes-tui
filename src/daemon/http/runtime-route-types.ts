import type { DaemonApiRouteHandlers } from '../../control-plane/routes/context.ts';

export type JsonBody = Record<string, unknown>;

export type AutomationSurfaceKind = string;
export interface SharedSessionRoutingIntent {
  readonly modelId?: string;
  readonly providerId?: string;
  readonly tools?: readonly string[];
  readonly executionIntent?: unknown;
}
interface AutomationRouteBinding {
  readonly id?: string;
}
export type ExecutionIntent = unknown;
type AgentRecordLike = {
  readonly id: string;
  readonly status: string;
  readonly task: string;
  readonly model?: string | null;
  readonly tools: readonly string[];
  readonly startedAt: number;
  readonly completedAt?: number;
  readonly toolCallCount?: number;
  readonly progress?: string | null;
  readonly error?: string | null;
};
type AutomationJobLike = { readonly id: string };
type AutomationRunLike = {
  readonly id: string;
  readonly jobId: string;
  readonly agentId?: string;
  readonly status: string;
  readonly startedAt?: number;
  readonly queuedAt: number;
  readonly continuationMode?: string;
};
interface RuntimeTaskLike {
  readonly kind?: string;
  readonly owner?: string;
  readonly description?: string;
  readonly title?: string;
}
interface RuntimeTaskStateLike {
  readonly tasks: Map<string, RuntimeTaskLike>;
}

export interface DaemonRuntimeRouteContext {
  readonly parseJsonBody: (req: Request) => Promise<JsonBody | Response>;
  readonly parseOptionalJsonBody: (req: Request) => Promise<JsonBody | null | Response>;
  readonly recordApiResponse: (req: Request, path: string, response: Response) => Response;
  readonly requireAdmin: (req: Request) => Response | null;
  readonly sessionBroker: {
    start(): Promise<void>;
    submitMessage(input: {
      sessionId?: string;
      routeId?: string;
      surfaceKind: AutomationSurfaceKind;
      surfaceId: string;
      externalId?: string;
      threadId?: string;
      userId?: string;
      displayName?: string;
      title?: string;
      body: string;
      metadata?: Record<string, unknown>;
      routing?: SharedSessionRoutingIntent;
    }): Promise<{
      mode: 'continued-live' | 'spawn' | 'queued-follow-up' | 'rejected';
      input: { id: string; routing?: SharedSessionRoutingIntent };
      session: { id: string; status: string };
      routeBinding?: AutomationRouteBinding;
      task?: string;
      activeAgentId?: string | null;
      userMessage?: unknown;
    }>;
    steerMessage(input: {
      sessionId?: string;
      routeId?: string;
      surfaceKind: AutomationSurfaceKind;
      surfaceId: string;
      externalId?: string;
      threadId?: string;
      userId?: string;
      displayName?: string;
      title?: string;
      body: string;
      metadata?: Record<string, unknown>;
      routing?: SharedSessionRoutingIntent;
      allowSpawnFallback?: boolean;
    }): Promise<{
      mode: 'continued-live' | 'spawn' | 'queued-follow-up' | 'rejected';
      input: { id: string; state: string; routing?: SharedSessionRoutingIntent };
      session: { id: string; status: string };
      routeBinding?: AutomationRouteBinding;
      task?: string;
      activeAgentId?: string | null;
      userMessage?: unknown;
    }>;
    followUpMessage(input: {
      sessionId?: string;
      routeId?: string;
      surfaceKind: AutomationSurfaceKind;
      surfaceId: string;
      externalId?: string;
      threadId?: string;
      userId?: string;
      displayName?: string;
      title?: string;
      body: string;
      metadata?: Record<string, unknown>;
      routing?: SharedSessionRoutingIntent;
    }): Promise<{
      mode: 'continued-live' | 'spawn' | 'queued-follow-up' | 'rejected';
      input: { id: string; state: string; routing?: SharedSessionRoutingIntent };
      session: { id: string; status: string };
      routeBinding?: AutomationRouteBinding;
      task?: string;
      activeAgentId?: string | null;
      userMessage?: unknown;
    }>;
    bindAgent(sessionId: string, agentId: string): Promise<unknown>;
    createSession(input: {
      id?: string;
      title?: string;
      metadata?: Record<string, unknown>;
      routeBinding?: AutomationRouteBinding;
      participant?: {
        surfaceKind: AutomationSurfaceKind;
        surfaceId: string;
        externalId?: string;
        userId?: string;
        displayName?: string;
        routeId?: string;
        lastSeenAt: number;
      };
    }): Promise<{ id: string }>;
    getSession(sessionId: string): { id: string; status: string; messageCount: number; activeAgentId?: string } | null;
    getMessages(sessionId: string, limit: number): unknown[];
    getInputs(sessionId: string, limit: number): unknown[];
    closeSession(sessionId: string): Promise<{ id: string } | null>;
    reopenSession(sessionId: string): Promise<{ id: string } | null>;
    cancelInput(sessionId: string, inputId: string): Promise<unknown | null>;
    completeAgent(sessionId: string, agentId: string, message: string, meta: { status: string; routeId?: string }): Promise<void>;
  };
  readonly agentManager: {
    getStatus(agentId: string): AgentRecordLike | null;
    cancel(agentId: string): void;
  };
  readonly automationManager: {
    listJobs(): AutomationJobLike[];
    listRuns(): AutomationRunLike[];
    getRun(runId: string): AutomationRunLike | null | undefined;
    triggerHeartbeat(input: { source: string }): Promise<unknown>;
    cancelRun(runId: string, reason: string): Promise<unknown | null>;
    retryRun(runId: string): Promise<unknown>;
    createJob(input: Record<string, unknown>): Promise<AutomationJobLike>;
    updateJob(jobId: string, input: Record<string, unknown>): Promise<AutomationJobLike | null>;
    removeJob(jobId: string): Promise<void>;
    setEnabled(jobId: string, enabled: boolean): Promise<AutomationJobLike | null>;
    runNow(jobId: string): Promise<{ id: string; agentId?: string; status: string }>;
  };
  readonly normalizeAtSchedule: (at: number) => unknown;
  readonly normalizeEverySchedule: (interval: string | number, anchorAt?: number) => unknown;
  readonly normalizeCronSchedule: (expression: string, timezone?: string, staggerMs?: unknown) => unknown;
  readonly routeBindings: {
    start(): Promise<void>;
    getBinding(id: string): AutomationRouteBinding | undefined;
  };
  readonly trySpawnAgent: (input: {
    mode: 'spawn';
    task: string;
    model?: string;
    tools?: string[] | readonly string[];
    provider?: string;
    context?: string;
    executionIntent?: ExecutionIntent;
  }, logLabel: string, sessionId?: string) => AgentRecordLike | Response;
  readonly queueSurfaceReplyFromBinding: (
    binding: AutomationRouteBinding | undefined,
    input: { readonly agentId: string; readonly task: string; readonly sessionId?: string; },
  ) => void;
  readonly surfaceDeliveryEnabled: (surface: 'slack' | 'discord' | 'ntfy' | 'webhook' | 'telegram' | 'google-chat' | 'signal' | 'whatsapp' | 'imessage' | 'msteams' | 'bluebubbles' | 'mattermost' | 'matrix') => boolean;
  readonly syncSpawnedAgentTask: (record: AgentRecordLike, sessionId?: string) => void;
  readonly syncFinishedAgentTask: (record: AgentRecordLike) => void;
  readonly configManager: {
    get(key: string): unknown;
  };
  readonly runtimeStore: { getState(): { tasks: RuntimeTaskStateLike } } | null;
  readonly runtimeDispatch: {
    transitionRuntimeTask(
      taskId: string,
      status: string,
      patch: Record<string, unknown>,
      source: string,
    ): void;
  } | null;
}

export type DaemonRuntimeRouteHandlerMap = Pick<
  DaemonApiRouteHandlers,
  | 'createSharedSession'
  | 'getAutomationJobs'
  | 'postAutomationJob'
  | 'getAutomationRuns'
  | 'getAutomationRun'
  | 'getAutomationHeartbeat'
  | 'postAutomationHeartbeat'
  | 'automationRunAction'
  | 'patchAutomationJob'
  | 'deleteAutomationJob'
  | 'setAutomationJobEnabled'
  | 'runAutomationJobNow'
  | 'postTask'
  | 'getSharedSession'
  | 'closeSharedSession'
  | 'reopenSharedSession'
  | 'getSharedSessionMessages'
  | 'getSharedSessionInputs'
  | 'postSharedSessionMessage'
  | 'postSharedSessionSteer'
  | 'postSharedSessionFollowUp'
  | 'cancelSharedSessionInput'
  | 'getRuntimeTask'
  | 'runtimeTaskAction'
  | 'getTaskStatus'
  | 'getSchedules'
  | 'postSchedule'
  | 'deleteSchedule'
  | 'setScheduleEnabled'
  | 'runScheduleNow'
>;
