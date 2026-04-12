import type { AutomationJob } from '../../automation/jobs.ts';
import {
  normalizeAtSchedule,
  normalizeCronSchedule,
  normalizeEverySchedule,
  type AutomationScheduleDefinition,
} from '../../automation/index.ts';
import type { DaemonApiRouteHandlers } from '../../control-plane/routes/context.ts';
import type { DomainDispatch, RuntimeStore } from '../../runtime/store/index.ts';
import type { PendingSurfaceReply } from '../types.ts';

type JsonBody = Record<string, unknown>;

interface DaemonRuntimeRouteContext {
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
    }): Promise<{
      mode: 'continued-live' | 'spawn' | 'spawn-new';
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
    closeSession(sessionId: string): Promise<{ id: string } | null>;
    reopenSession(sessionId: string): Promise<{ id: string } | null>;
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
  readonly trySpawnAgent: (input: { mode: 'spawn'; task: string; model?: string; tools?: string[] | readonly string[]; provider?: string; context?: string }, logLabel: string, sessionId?: string) => import('../../tools/agent/index.ts').AgentRecord | Response;
  readonly queueSurfaceReplyFromBinding: (binding: import('../../automation/routes.ts').AutomationRouteBinding | undefined, input: { readonly agentId: string; readonly task: string; readonly sessionId?: string; }) => void;
  readonly surfaceDeliveryEnabled: (surface: 'slack' | 'discord' | 'ntfy' | 'webhook' | 'telegram' | 'google-chat' | 'signal' | 'whatsapp' | 'imessage' | 'msteams' | 'bluebubbles' | 'mattermost' | 'matrix') => boolean;
  readonly syncSpawnedAgentTask: (record: import('../../tools/agent/index.ts').AgentRecord, sessionId?: string) => void;
  readonly syncFinishedAgentTask: (record: import('../../tools/agent/index.ts').AgentRecord) => void;
  readonly configManager: {
    get(key: string): unknown;
  };
  readonly runtimeStore: RuntimeStore | null;
  readonly runtimeDispatch: DomainDispatch | null;
}

export function createDaemonRuntimeRouteHandlers(
  context: DaemonRuntimeRouteContext,
): Pick<
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
  | 'postSharedSessionMessage'
  | 'getRuntimeTask'
  | 'runtimeTaskAction'
  | 'getTaskStatus'
  | 'getSchedules'
  | 'postSchedule'
  | 'deleteSchedule'
  | 'setScheduleEnabled'
  | 'runScheduleNow'
> {
  return {
    createSharedSession: async (request) => handleCreateSharedSession(context, request),
    getAutomationJobs: () => Response.json({ jobs: context.automationManager.listJobs() }),
    postAutomationJob: async (request) => handlePostSchedule(context, request),
    getAutomationRuns: () => Response.json({ runs: context.automationManager.listRuns() }),
    getAutomationRun: (runId) => handleGetAutomationRun(context, runId),
    getAutomationHeartbeat: () => Response.json({ pending: [] }),
    postAutomationHeartbeat: async (request) => handlePostAutomationHeartbeat(context, request),
    automationRunAction: async (runId, action, request) => handleAutomationRunAction(context, runId, action, request),
    patchAutomationJob: async (jobId, request) => handlePatchSchedule(context, jobId, request),
    deleteAutomationJob: async (jobId) => handleDeleteSchedule(context, jobId),
    setAutomationJobEnabled: async (jobId, enabled) => handleSetScheduleEnabled(context, jobId, enabled),
    runAutomationJobNow: async (jobId) => handleRunScheduleNow(context, jobId),
    postTask: async (request) => handlePostTask(context, request),
    getSharedSession: async (sessionId) => handleGetSharedSession(context, sessionId),
    closeSharedSession: (sessionId) => handleSharedSessionLifecycle(context, sessionId, 'close'),
    reopenSharedSession: (sessionId) => handleSharedSessionLifecycle(context, sessionId, 'reopen'),
    getSharedSessionMessages: async (sessionId, url) => handleGetSharedSessionMessages(context, sessionId, url),
    postSharedSessionMessage: (sessionId, request) => handlePostSharedSessionMessage(context, sessionId, request),
    getRuntimeTask: (taskId) => handleGetRuntimeTask(context, taskId),
    runtimeTaskAction: (taskId, action, request) => handleRuntimeTaskAction(context, taskId, action, request),
    getTaskStatus: (agentId) => handleGetTaskStatus(context, agentId),
    getSchedules: () => handleGetSchedules(context),
    postSchedule: (request) => handlePostSchedule(context, request),
    deleteSchedule: async (scheduleId) => handleDeleteSchedule(context, scheduleId),
    setScheduleEnabled: (scheduleId, enabled) => handleSetScheduleEnabled(context, scheduleId, enabled),
    runScheduleNow: (scheduleId) => handleRunScheduleNow(context, scheduleId),
  };
}

async function handleCreateSharedSession(context: DaemonRuntimeRouteContext, req: Request): Promise<Response> {
  const body = await context.parseJsonBody(req);
  if (body instanceof Response) return body;
  await context.sessionBroker.start();
  await context.routeBindings.start();
  const routeBinding = typeof body.routeId === 'string'
    ? context.routeBindings.getBinding(body.routeId)
    : undefined;
  const session = await context.sessionBroker.createSession({
    id: typeof body.id === 'string' ? body.id : undefined,
    title: typeof body.title === 'string' ? body.title : undefined,
    metadata: typeof body.metadata === 'object' && body.metadata !== null ? body.metadata as Record<string, unknown> : {},
    routeBinding,
    participant: typeof body.surfaceKind === 'string' && typeof body.surfaceId === 'string'
      ? {
          surfaceKind: body.surfaceKind as import('../../automation/types.ts').AutomationSurfaceKind,
          surfaceId: body.surfaceId,
          externalId: typeof body.externalId === 'string' ? body.externalId : undefined,
          userId: typeof body.userId === 'string' ? body.userId : undefined,
          displayName: typeof body.displayName === 'string' ? body.displayName : undefined,
          routeId: routeBinding?.id,
          lastSeenAt: Date.now(),
        }
      : undefined,
  });
  return context.recordApiResponse(req, `/api/sessions`, Response.json({ session }, { status: 201 }));
}

async function handlePostTask(context: DaemonRuntimeRouteContext, req: Request): Promise<Response> {
  const body = await context.parseJsonBody(req);
  if (body instanceof Response) return body;
  const task = body.task;
  if (!task || typeof task !== 'string' || task.trim() === '') {
    return Response.json({ error: 'Missing required field: task (non-empty string)' }, { status: 400 });
  }
  const model = typeof body.model === 'string' ? body.model : undefined;
  const tools = Array.isArray(body.tools) ? (body.tools as unknown[]).filter((t): t is string => typeof t === 'string') : undefined;
  const wantsSharedSession = typeof body.sessionId === 'string' || typeof body.routeId === 'string' || typeof body.surfaceKind === 'string';
  if (wantsSharedSession) {
    const submission = await context.sessionBroker.submitMessage({
      sessionId: typeof body.sessionId === 'string' ? body.sessionId : undefined,
      routeId: typeof body.routeId === 'string' ? body.routeId : undefined,
      surfaceKind: typeof body.surfaceKind === 'string' ? body.surfaceKind as import('../../automation/types.ts').AutomationSurfaceKind : 'web',
      surfaceId: typeof body.surfaceId === 'string' ? body.surfaceId : 'surface:web',
      externalId: typeof body.externalId === 'string' ? body.externalId : undefined,
      threadId: typeof body.threadId === 'string' ? body.threadId : undefined,
      userId: typeof body.userId === 'string' ? body.userId : undefined,
      displayName: typeof body.displayName === 'string' ? body.displayName : undefined,
      title: typeof body.title === 'string' ? body.title : undefined,
      body: task.trim(),
      metadata: typeof body.metadata === 'object' && body.metadata !== null ? body.metadata as Record<string, unknown> : {},
    });

    if (submission.mode === 'continued-live') {
      return context.recordApiResponse(req, '/task', Response.json({
        acknowledged: true,
        mode: submission.mode,
        sessionId: submission.session.id,
        agentId: submission.activeAgentId ?? null,
      }, { status: 202 }));
    }

    const sessionSpawn = context.trySpawnAgent({
      mode: 'spawn',
      task: submission.task!,
      ...(model !== undefined && { model }),
      ...(tools !== undefined && { tools }),
    }, 'DaemonServer.handlePostTask.sharedSession', submission.session.id);
    if (sessionSpawn instanceof Response) return sessionSpawn;
    await context.sessionBroker.bindAgent(submission.session.id, sessionSpawn.id);
    context.queueSurfaceReplyFromBinding(submission.routeBinding, {
      agentId: sessionSpawn.id,
      task,
      sessionId: submission.session.id,
    });
    return context.recordApiResponse(req, '/task', Response.json({
      acknowledged: true,
      mode: submission.mode,
      sessionId: submission.session.id,
      agentId: sessionSpawn.id,
      status: sessionSpawn.status,
    }, { status: 202 }));
  }

  const spawnResult = context.trySpawnAgent({
    mode: 'spawn',
    task,
    ...(model !== undefined && { model }),
    ...(tools !== undefined && { tools }),
  }, 'DaemonServer', typeof body.sessionId === 'string' ? body.sessionId : undefined);
  if (spawnResult instanceof Response) return spawnResult;
  const record = spawnResult;
  return context.recordApiResponse(req, '/task', Response.json({
    acknowledged: true,
    agentId: record.id,
    status: record.status,
    task: record.task,
    model: record.model ?? null,
    tools: record.tools,
  }, { status: 202 }));
}

async function handleGetSharedSession(context: DaemonRuntimeRouteContext, sessionId: string): Promise<Response> {
  await context.sessionBroker.start();
  const session = context.sessionBroker.getSession(sessionId);
  if (!session) {
    return Response.json({ error: 'Unknown shared session' }, { status: 404 });
  }
  return Response.json({
    session,
    messages: context.sessionBroker.getMessages(sessionId, 100),
  });
}

async function handleSharedSessionLifecycle(context: DaemonRuntimeRouteContext, sessionId: string, action: 'close' | 'reopen'): Promise<Response> {
  await context.sessionBroker.start();
  const session = action === 'close'
    ? await context.sessionBroker.closeSession(sessionId)
    : await context.sessionBroker.reopenSession(sessionId);
  return session
    ? Response.json({ session })
    : Response.json({ error: 'Unknown shared session' }, { status: 404 });
}

async function handleGetSharedSessionMessages(context: DaemonRuntimeRouteContext, sessionId: string, url: URL): Promise<Response> {
  await context.sessionBroker.start();
  const session = context.sessionBroker.getSession(sessionId);
  if (!session) {
    return Response.json({ error: 'Unknown shared session' }, { status: 404 });
  }
  const limit = Number(url.searchParams.get('limit') ?? 100);
  return Response.json({
    session,
    messages: context.sessionBroker.getMessages(sessionId, limit),
  });
}

async function handlePostSharedSessionMessage(context: DaemonRuntimeRouteContext, sessionId: string, req: Request): Promise<Response> {
  const body = await context.parseJsonBody(req);
  if (body instanceof Response) return body;
  const message = typeof body.message === 'string'
    ? body.message.trim()
    : typeof body.body === 'string'
      ? body.body.trim()
      : typeof body.text === 'string'
        ? body.text.trim()
        : '';
  if (!message) {
    return Response.json({ error: 'Missing shared session message body' }, { status: 400 });
  }
  const submission = await context.sessionBroker.submitMessage({
    sessionId,
    surfaceKind: typeof body.surfaceKind === 'string' ? body.surfaceKind as import('../../automation/types.ts').AutomationSurfaceKind : 'web',
    surfaceId: typeof body.surfaceId === 'string' ? body.surfaceId : 'surface:web',
    externalId: typeof body.externalId === 'string' ? body.externalId : undefined,
    threadId: typeof body.threadId === 'string' ? body.threadId : undefined,
    userId: typeof body.userId === 'string' ? body.userId : undefined,
    displayName: typeof body.displayName === 'string' ? body.displayName : undefined,
    title: typeof body.title === 'string' ? body.title : undefined,
    routeId: typeof body.routeId === 'string' ? body.routeId : undefined,
    body: message,
    metadata: typeof body.metadata === 'object' && body.metadata !== null ? body.metadata as Record<string, unknown> : {},
  });

  if (submission.mode === 'continued-live') {
    return context.recordApiResponse(req, `/api/sessions/${sessionId}/messages`, Response.json({
      session: submission.session,
      message: submission.userMessage,
      mode: submission.mode,
      agentId: submission.activeAgentId ?? null,
    }, { status: 202 }));
  }

  const spawnResult = context.trySpawnAgent({
    mode: 'spawn',
    task: submission.task!,
    context: `shared-session:${submission.session.id}`,
  }, 'DaemonServer.handlePostSharedSessionMessage');
  if (spawnResult instanceof Response) return spawnResult;
  await context.sessionBroker.bindAgent(submission.session.id, spawnResult.id);
  context.queueSurfaceReplyFromBinding(submission.routeBinding, {
    agentId: spawnResult.id,
    task: message,
    sessionId: submission.session.id,
  });
  return context.recordApiResponse(req, `/api/sessions/${sessionId}/messages`, Response.json({
    session: context.sessionBroker.getSession(submission.session.id),
    message: submission.userMessage,
    mode: submission.mode,
    agentId: spawnResult.id,
  }, { status: 202 }));
}

function handleGetRuntimeTask(context: DaemonRuntimeRouteContext, taskId: string): Response {
  const task = context.runtimeStore?.getState().tasks.tasks.get(taskId);
  if (!task) {
    return Response.json({ error: 'Unknown runtime task' }, { status: 404 });
  }
  return Response.json({ task });
}

function handleRuntimeTaskAction(context: DaemonRuntimeRouteContext, taskId: string, action: string, _req: Request): Response {
  if (!context.runtimeStore || !context.runtimeDispatch) {
    return Response.json({ error: 'Runtime store unavailable' }, { status: 503 });
  }
  const task = context.runtimeStore.getState().tasks.tasks.get(taskId);
  if (!task) {
    return Response.json({ error: 'Unknown runtime task' }, { status: 404 });
  }
  if (action === 'cancel') {
    if (task.kind === 'agent' && task.owner) {
      context.agentManager.cancel(task.owner);
    }
    context.runtimeDispatch.transitionRuntimeTask(taskId, 'cancelled', {
      endedAt: Date.now(),
      error: 'Cancelled via control plane',
    }, 'daemon.server.tasks.cancel');
    return Response.json({ task: context.runtimeStore.getState().tasks.tasks.get(taskId) });
  }
  if (action === 'retry') {
    if (task.kind !== 'agent') {
      return Response.json({ error: 'Retry is only implemented for agent tasks' }, { status: 400 });
    }
    const spawnResult = context.trySpawnAgent({
      mode: 'spawn',
      task: task.description ?? task.title ?? '',
    }, 'DaemonServer.handleRuntimeTaskAction');
    if (spawnResult instanceof Response) return spawnResult;
    context.runtimeDispatch.transitionRuntimeTask(taskId, 'queued', {
      startedAt: undefined,
      endedAt: undefined,
      error: undefined,
      result: undefined,
    }, 'daemon.server.tasks.retry');
    return Response.json({
      retried: true,
      task: context.runtimeStore.getState().tasks.tasks.get(taskId),
      agentId: spawnResult.id,
    });
  }
  return Response.json({ error: 'Unsupported task action' }, { status: 400 });
}

function handleGetTaskStatus(context: DaemonRuntimeRouteContext, agentId: string): Response {
  const record = context.agentManager.getStatus(agentId);
  if (!record) {
    return Response.json({ error: `Agent not found: ${agentId}` }, { status: 404 });
  }
  if (record.status === 'completed' || record.status === 'failed' || record.status === 'cancelled') {
    context.syncFinishedAgentTask(record);
  }
  const durationMs = record.completedAt !== undefined
    ? record.completedAt - record.startedAt
    : Date.now() - record.startedAt;
  return Response.json({
    agentId: record.id,
    task: record.task,
    status: record.status,
    model: record.model ?? null,
    tools: record.tools,
    durationMs,
    toolCallCount: record.toolCallCount,
    progress: record.progress ?? null,
    error: record.error ?? null,
  });
}

function handleGetSchedules(context: DaemonRuntimeRouteContext): Response {
  const jobs = context.automationManager.listJobs();
  const runs = context.automationManager.listRuns().slice(0, 50);
  return Response.json({ jobs, runs });
}

async function handlePostSchedule(context: DaemonRuntimeRouteContext, req: Request): Promise<Response> {
  const body = await context.parseJsonBody(req);
  if (body instanceof Response) return body;
  const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : undefined;
  const kind = typeof body.kind === 'string' ? body.kind : 'cron';
  const cron = typeof body.cron === 'string' ? body.cron : undefined;
  const every = typeof body.every === 'string' ? body.every : undefined;
  const at = typeof body.at === 'string' || typeof body.at === 'number' ? body.at : undefined;
  const timezone = typeof body.timezone === 'string' ? body.timezone : undefined;
  if (!prompt) {
    return Response.json({ error: 'Missing required field: prompt (string)' }, { status: 400 });
  }
  if (prompt.length > 10_000) {
    return Response.json({ error: 'prompt exceeds maximum length of 10000 characters' }, { status: 400 });
  }
  try {
    const fallbackModelsSource = body.fallbackModels ?? body.fallbacks;
    const fallbackModels = Array.isArray(fallbackModelsSource)
      ? fallbackModelsSource.filter((value): value is string => typeof value === 'string')
      : undefined;
    const schedule = kind === 'every'
      ? normalizeEverySchedule(every ?? '')
      : kind === 'at'
        ? normalizeAtSchedule(typeof at === 'number' ? at : Date.parse(String(at)))
        : normalizeCronSchedule(cron ?? '', timezone, body.staggerMs ?? body.stagger);
    const job = await context.automationManager.createJob({
      name: typeof body.name === 'string' ? body.name : prompt.slice(0, 40),
      prompt,
      schedule,
      description: prompt,
      model: typeof body.model === 'string' ? body.model : undefined,
      provider: typeof body.provider === 'string' ? body.provider : undefined,
      fallbackModels,
      template: typeof body.template === 'string' ? body.template : undefined,
      target: typeof body.target === 'object' && body.target !== null ? body.target as Record<string, unknown> : undefined,
      reasoningEffort: body.reasoningEffort,
      thinking: typeof body.thinking === 'string' ? body.thinking : undefined,
      wakeMode: body.wakeMode,
      timeoutMs: typeof body.timeoutMs === 'number' ? body.timeoutMs : undefined,
      toolAllowlist: Array.isArray(body.toolAllowlist) ? body.toolAllowlist.filter((value: unknown): value is string => typeof value === 'string') : undefined,
      autoApprove: typeof body.autoApprove === 'boolean' ? body.autoApprove : undefined,
      allowUnsafeExternalContent: typeof body.allowUnsafeExternalContent === 'boolean' ? body.allowUnsafeExternalContent : undefined,
      externalContentSource: body.externalContentSource,
      lightContext: typeof body.lightContext === 'boolean' ? body.lightContext : undefined,
      delivery: typeof body.delivery === 'object' && body.delivery !== null ? body.delivery : undefined,
      failure: typeof body.failure === 'object' && body.failure !== null ? body.failure : undefined,
      enabled: body.enabled !== false,
      deleteAfterRun: typeof body.deleteAfterRun === 'boolean' ? body.deleteAfterRun : undefined,
    });
    return Response.json(job, { status: 201 });
  } catch (e: unknown) {
    return Response.json({ error: e instanceof Error ? e.message : 'Failed to create schedule' }, { status: 400 });
  }
}

async function handlePatchSchedule(context: DaemonRuntimeRouteContext, id: string, req: Request): Promise<Response> {
  const job = context.automationManager.listJobs().find((entry) => entry.id === id || entry.id.startsWith(id));
  if (!job) return Response.json({ error: `Schedule not found: ${id}` }, { status: 404 });
  const body = await context.parseJsonBody(req);
  if (body instanceof Response) return body;
  try {
    const updated = await context.automationManager.updateJob(job.id, body as Record<string, unknown>);
    return updated
      ? Response.json(updated)
      : Response.json({ error: `Schedule not found: ${id}` }, { status: 404 });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : 'Failed to update schedule' }, { status: 400 });
  }
}

async function handleDeleteSchedule(context: DaemonRuntimeRouteContext, id: string): Promise<Response> {
  const job = context.automationManager.listJobs().find((entry) => entry.id === id || entry.id.startsWith(id));
  if (!job) return Response.json({ error: `Schedule not found: ${id}` }, { status: 404 });
  await context.automationManager.removeJob(job.id);
  return Response.json({ removed: true, id: job.id });
}

async function handleSetScheduleEnabled(context: DaemonRuntimeRouteContext, id: string, enabled: boolean): Promise<Response> {
  const job = context.automationManager.listJobs().find((entry) => entry.id === id || entry.id.startsWith(id));
  if (!job) return Response.json({ error: `Schedule not found: ${id}` }, { status: 404 });
  const updated = await context.automationManager.setEnabled(job.id, enabled);
  return Response.json(updated ?? { id: job.id, enabled });
}

async function handleRunScheduleNow(context: DaemonRuntimeRouteContext, id: string): Promise<Response> {
  const job = context.automationManager.listJobs().find((entry) => entry.id === id || entry.id.startsWith(id));
  if (!job) return Response.json({ error: `Schedule not found: ${id}` }, { status: 404 });
  try {
    const run = await context.automationManager.runNow(job.id);
    return Response.json({ jobId: job.id, runId: run.id, agentId: run.agentId, status: run.status });
  } catch (e: unknown) {
    return Response.json({ error: e instanceof Error ? e.message : 'Failed to run schedule' }, { status: 500 });
  }
}

async function handlePostAutomationHeartbeat(context: DaemonRuntimeRouteContext, req: Request): Promise<Response> {
  const body = await context.parseOptionalJsonBody(req);
  if (body instanceof Response) return body;
  const result = await context.automationManager.triggerHeartbeat({
    source: body && typeof body.source === 'string' ? body.source : 'api',
  });
  return Response.json(result);
}

async function handleAutomationRunAction(context: DaemonRuntimeRouteContext, runId: string, action: 'cancel' | 'retry', req: Request): Promise<Response> {
  if (action === 'cancel') {
    const body = await context.parseOptionalJsonBody(req);
    const reason = body instanceof Response
      ? 'operator-cancelled'
      : body && typeof body.reason === 'string'
        ? body.reason
        : 'operator-cancelled';
    const run = await context.automationManager.cancelRun(runId, reason);
    return run
      ? context.recordApiResponse(req, `/api/automation/runs/${runId}/${action}`, Response.json({ run }))
      : context.recordApiResponse(req, `/api/automation/runs/${runId}/${action}`, Response.json({ error: 'Unknown automation run' }, { status: 404 }));
  }
  try {
    const run = await context.automationManager.retryRun(runId);
    return context.recordApiResponse(req, `/api/automation/runs/${runId}/${action}`, Response.json({ run }, { status: 202 }));
  } catch (error) {
    return context.recordApiResponse(req, `/api/automation/runs/${runId}/${action}`, Response.json({
      error: error instanceof Error ? error.message : 'Failed to retry automation run',
    }, { status: 400 }));
  }
}

function handleGetAutomationRun(context: DaemonRuntimeRouteContext, runId: string): Response {
  const run = context.automationManager.getRun(runId);
  if (!run) {
    return Response.json({ error: 'Unknown automation run' }, { status: 404 });
  }
  return Response.json({ run, deliveries: [] });
}
