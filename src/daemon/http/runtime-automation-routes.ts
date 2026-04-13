import {
  normalizeAtSchedule,
  normalizeCronSchedule,
  normalizeEverySchedule,
} from '../../automation/index.ts';
import type { DaemonApiRouteHandlers } from '../../control-plane/routes/context.ts';
import type { DaemonRuntimeRouteContext } from './runtime-route-types.ts';

export function createDaemonRuntimeAutomationRouteHandlers(
  context: DaemonRuntimeRouteContext,
): Pick<
  DaemonApiRouteHandlers,
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
  | 'getSchedules'
  | 'postSchedule'
  | 'deleteSchedule'
  | 'setScheduleEnabled'
  | 'runScheduleNow'
> {
  return {
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
    getSchedules: () => handleGetSchedules(context),
    postSchedule: (request) => handlePostSchedule(context, request),
    deleteSchedule: async (scheduleId) => handleDeleteSchedule(context, scheduleId),
    setScheduleEnabled: (scheduleId, enabled) => handleSetScheduleEnabled(context, scheduleId, enabled),
    runScheduleNow: (scheduleId) => handleRunScheduleNow(context, scheduleId),
  };
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
  const job = findAutomationJob(context, id);
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
  const job = findAutomationJob(context, id);
  if (!job) return Response.json({ error: `Schedule not found: ${id}` }, { status: 404 });
  await context.automationManager.removeJob(job.id);
  return Response.json({ removed: true, id: job.id });
}

async function handleSetScheduleEnabled(context: DaemonRuntimeRouteContext, id: string, enabled: boolean): Promise<Response> {
  const job = findAutomationJob(context, id);
  if (!job) return Response.json({ error: `Schedule not found: ${id}` }, { status: 404 });
  const updated = await context.automationManager.setEnabled(job.id, enabled);
  return Response.json(updated ?? { id: job.id, enabled });
}

async function handleRunScheduleNow(context: DaemonRuntimeRouteContext, id: string): Promise<Response> {
  const job = findAutomationJob(context, id);
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

async function handleAutomationRunAction(
  context: DaemonRuntimeRouteContext,
  runId: string,
  action: 'cancel' | 'retry',
  req: Request,
): Promise<Response> {
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

function findAutomationJob(context: DaemonRuntimeRouteContext, id: string) {
  return context.automationManager.listJobs().find((entry) => entry.id === id || entry.id.startsWith(id));
}
