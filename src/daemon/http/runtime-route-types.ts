import type { AutomationJob } from '../../automation/jobs.ts';
import type { DaemonApiRouteHandlers } from '../../control-plane/routes/context.ts';
import type { DomainDispatch, RuntimeStore } from '../../runtime/store/index.ts';

export type JsonBody = Record<string, unknown>;

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
      surfaceKind: import('../../automation/types.ts').AutomationSurfaceKind;
      surfaceId: string;
      externalId?: string;
      threadId?: string;
      userId?: string;
      displayName?: string;
      title?: string;
      body: string;
      metadata?: Record<string, unknown>;
      routing?: import('../../control-plane/index.ts').SharedSessionRoutingIntent;
    }): Promise<{
      mode: 'continued-live' | 'spawn' | 'queued-follow-up' | 'rejected';
      input: { id: string; routing?: import('../../control-plane/index.ts').SharedSessionRoutingIntent };
      session: { id: string; status: string };
      routeBinding?: import('../../automation/routes.ts').AutomationRouteBinding;
      task?: string;
      activeAgentId?: string | null;
      userMessage?: unknown;
    }>;
    steerMessage(input: {
      sessionId?: string;
      routeId?: string;
      surfaceKind: import('../../automation/types.ts').AutomationSurfaceKind;
      surfaceId: string;
      externalId?: string;
      threadId?: string;
      userId?: string;
      displayName?: string;
      title?: string;
      body: string;
      metadata?: Record<string, unknown>;
      routing?: import('../../control-plane/index.ts').SharedSessionRoutingIntent;
      allowSpawnFallback?: boolean;
    }): Promise<{
      mode: 'continued-live' | 'spawn' | 'queued-follow-up' | 'rejected';
      input: { id: string; state: string; routing?: import('../../control-plane/index.ts').SharedSessionRoutingIntent };
      session: { id: string; status: string };
      routeBinding?: import('../../automation/routes.ts').AutomationRouteBinding;
      task?: string;
      activeAgentId?: string | null;
      userMessage?: unknown;
    }>;
    followUpMessage(input: {
      sessionId?: string;
      routeId?: string;
      surfaceKind: import('../../automation/types.ts').AutomationSurfaceKind;
      surfaceId: string;
      externalId?: string;
      threadId?: string;
      userId?: string;
      displayName?: string;
      title?: string;
      body: string;
      metadata?: Record<string, unknown>;
      routing?: import('../../control-plane/index.ts').SharedSessionRoutingIntent;
    }): Promise<{
      mode: 'continued-live' | 'spawn' | 'queued-follow-up' | 'rejected';
      input: { id: string; state: string; routing?: import('../../control-plane/index.ts').SharedSessionRoutingIntent };
      session: { id: string; status: string };
      routeBinding?: import('../../automation/routes.ts').AutomationRouteBinding;
      task?: string;
      activeAgentId?: string | null;
      userMessage?: unknown;
    }>;
    bindAgent(sessionId: string, agentId: string): Promise<unknown>;
    createSession(input: {
      id?: string;
      title?: string;
      metadata?: Record<string, unknown>;
      routeBinding?: import('../../automation/routes.ts').AutomationRouteBinding;
      participant?: {
        surfaceKind: import('../../automation/types.ts').AutomationSurfaceKind;
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
    getStatus(agentId: string): import('../../tools/agent/index.ts').AgentRecord | null;
    cancel(agentId: string): void;
  };
  readonly automationManager: {
    listJobs(): AutomationJob[];
    listRuns(): Array<{ id: string; jobId: string; agentId?: string; status: string; startedAt?: number; queuedAt: number; continuationMode?: string }>;
    getRun(runId: string): { id: string; jobId: string; agentId?: string; status: string; startedAt?: number; queuedAt: number; continuationMode?: string } | null | undefined;
    triggerHeartbeat(input: { source: string }): Promise<unknown>;
    cancelRun(runId: string, reason: string): Promise<unknown | null>;
    retryRun(runId: string): Promise<unknown>;
    createJob(input: Record<string, unknown>): Promise<AutomationJob>;
    updateJob(jobId: string, input: Record<string, unknown>): Promise<AutomationJob | null>;
    removeJob(jobId: string): Promise<void>;
    setEnabled(jobId: string, enabled: boolean): Promise<AutomationJob | null>;
    runNow(jobId: string): Promise<{ id: string; agentId?: string; status: string }>;
  };
  readonly routeBindings: {
    start(): Promise<void>;
    getBinding(id: string): import('../../automation/routes.ts').AutomationRouteBinding | undefined;
  };
  readonly trySpawnAgent: (input: {
    mode: 'spawn';
    task: string;
    model?: string;
    tools?: string[] | readonly string[];
    provider?: string;
    context?: string;
    executionIntent?: import('../../runtime/execution-intents.ts').ExecutionIntent;
  }, logLabel: string, sessionId?: string) => import('../../tools/agent/index.ts').AgentRecord | Response;
  readonly queueSurfaceReplyFromBinding: (
    binding: import('../../automation/routes.ts').AutomationRouteBinding | undefined,
    input: { readonly agentId: string; readonly task: string; readonly sessionId?: string; },
  ) => void;
  readonly surfaceDeliveryEnabled: (surface: 'slack' | 'discord' | 'ntfy' | 'webhook' | 'telegram' | 'google-chat' | 'signal' | 'whatsapp' | 'imessage' | 'msteams' | 'bluebubbles' | 'mattermost' | 'matrix') => boolean;
  readonly syncSpawnedAgentTask: (record: import('../../tools/agent/index.ts').AgentRecord, sessionId?: string) => void;
  readonly syncFinishedAgentTask: (record: import('../../tools/agent/index.ts').AgentRecord) => void;
  readonly configManager: {
    get(key: string): unknown;
  };
  readonly runtimeStore: RuntimeStore | null;
  readonly runtimeDispatch: DomainDispatch | null;
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
