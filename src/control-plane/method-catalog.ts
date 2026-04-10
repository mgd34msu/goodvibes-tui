import type { RuntimeEventDomain } from '../runtime/events/index.ts';

export type GatewayMethodTransport = 'http' | 'ws' | 'internal';
export type GatewayMethodSource = 'builtin' | 'plugin';
export type GatewayMethodAccess = 'authenticated' | 'admin' | 'remote-peer';
export type GatewayEventTransport = 'sse' | 'ws' | 'internal';

export interface GatewayHttpBinding {
  readonly method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  readonly path: string;
}

export interface GatewayMethodDescriptor {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly category: string;
  readonly source: GatewayMethodSource;
  readonly access: GatewayMethodAccess;
  readonly transport: readonly GatewayMethodTransport[];
  readonly scopes: readonly string[];
  readonly http?: GatewayHttpBinding;
  readonly events?: readonly string[];
  readonly inputSchema?: Record<string, unknown>;
  readonly outputSchema?: Record<string, unknown>;
  readonly pluginId?: string;
  readonly dangerous?: boolean;
  readonly invokable?: boolean;
  readonly metadata?: Record<string, unknown>;
}

export interface GatewayEventDescriptor {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly category: string;
  readonly source: GatewayMethodSource;
  readonly transport: readonly GatewayEventTransport[];
  readonly scopes: readonly string[];
  readonly domains?: readonly RuntimeEventDomain[];
  readonly wireEvents?: readonly string[];
  readonly outputSchema?: Record<string, unknown>;
  readonly pluginId?: string;
  readonly metadata?: Record<string, unknown>;
}

export interface GatewayMethodInvocationContext {
  readonly principalId?: string;
  readonly principalKind?: 'user' | 'bot' | 'service' | 'token' | 'remote-peer';
  readonly admin?: boolean;
  readonly scopes?: readonly string[];
  readonly clientKind?: string;
  readonly authToken?: string;
  readonly metadata?: Record<string, unknown>;
}

export interface GatewayMethodInvocation {
  readonly body?: unknown;
  readonly query?: Record<string, unknown>;
  readonly context: GatewayMethodInvocationContext;
}

export type GatewayMethodHandler = (input: GatewayMethodInvocation) => unknown | Promise<unknown>;

interface RegisteredGatewayMethod {
  readonly descriptor: GatewayMethodDescriptor;
  readonly handler?: GatewayMethodHandler;
}

interface RegisteredGatewayEvent {
  readonly descriptor: GatewayEventDescriptor;
}

export interface GatewayMethodListOptions {
  readonly category?: string;
  readonly source?: GatewayMethodSource;
  readonly pluginId?: string;
}

export interface GatewayEventListOptions {
  readonly category?: string;
  readonly source?: GatewayMethodSource;
  readonly pluginId?: string;
  readonly domain?: RuntimeEventDomain;
}

const GENERIC_OBJECT_SCHEMA = { type: 'object', additionalProperties: true } as const;
const EMPTY_OBJECT_SCHEMA = { type: 'object', properties: {}, additionalProperties: false } as const;
const STRING_SCHEMA = { type: 'string' } as const;
const BOOLEAN_SCHEMA = { type: 'boolean' } as const;
const NUMBER_SCHEMA = { type: 'number' } as const;

function arraySchema(itemSchema: Record<string, unknown> = GENERIC_OBJECT_SCHEMA): Record<string, unknown> {
  return { type: 'array', items: itemSchema };
}

function objectSchema(
  properties: Record<string, Record<string, unknown>>,
  required: readonly string[] = [],
  options: { readonly additionalProperties?: boolean } = {},
): Record<string, unknown> {
  return {
    type: 'object',
    properties,
    ...(required.length > 0 ? { required: [...required] } : {}),
    additionalProperties: options.additionalProperties ?? false,
  };
}

function listOutputSchema(key: string): Record<string, unknown> {
  return objectSchema({ [key]: arraySchema(GENERIC_OBJECT_SCHEMA) }, [key], { additionalProperties: false });
}

function entityOutputSchema(key: string): Record<string, unknown> {
  return objectSchema({ [key]: GENERIC_OBJECT_SCHEMA }, [key], { additionalProperties: false });
}

function actionResultOutputSchema(key: string): Record<string, unknown> {
  return objectSchema({
    [key]: GENERIC_OBJECT_SCHEMA,
  }, [key], { additionalProperties: true });
}

function bodyEnvelopeSchema(
  properties: Record<string, Record<string, unknown>> = {},
  required: readonly string[] = [],
): Record<string, unknown> {
  return objectSchema({
    ...properties,
  }, required, { additionalProperties: true });
}

function methodDescriptor(input: Omit<GatewayMethodDescriptor, 'source' | 'transport' | 'access'> & Partial<Pick<GatewayMethodDescriptor, 'source' | 'transport' | 'access'>>): GatewayMethodDescriptor {
  return {
    source: input.source ?? 'builtin',
    transport: input.transport ?? ['http', 'ws'],
    access: input.access ?? 'authenticated',
    ...input,
  };
}

function eventDescriptor(input: Omit<GatewayEventDescriptor, 'source'> & Partial<Pick<GatewayEventDescriptor, 'source'>>): GatewayEventDescriptor {
  return {
    source: input.source ?? 'builtin',
    ...input,
  };
}

function runtimeEventId(domain: RuntimeEventDomain): string {
  return `runtime.${domain}`;
}

function runtimeDomainEvent(domain: RuntimeEventDomain, description: string): GatewayEventDescriptor {
  return eventDescriptor({
    id: runtimeEventId(domain),
    title: `${domain} Domain Events`,
    description,
    category: 'runtime-domain',
    transport: ['sse', 'ws'],
    scopes: ['read:events'],
    domains: [domain],
    wireEvents: [domain],
    outputSchema: GENERIC_OBJECT_SCHEMA,
  });
}

const BUILTIN_GATEWAY_EVENTS: readonly GatewayEventDescriptor[] = [
  runtimeDomainEvent('session', 'Shared-session lifecycle, participant, and message events.'),
  runtimeDomainEvent('turn', 'Turn submission and completion events.'),
  runtimeDomainEvent('providers', 'Provider health, selection, and routing events.'),
  runtimeDomainEvent('tools', 'Tool start, result, and failure events.'),
  runtimeDomainEvent('tasks', 'Runtime task lifecycle and status events.'),
  runtimeDomainEvent('agents', 'Agent lifecycle, planning, and completion events.'),
  runtimeDomainEvent('workflows', 'Workflow orchestration events.'),
  runtimeDomainEvent('orchestration', 'Higher-level orchestration and planner coordination events.'),
  runtimeDomainEvent('communication', 'Agent communication and policy events.'),
  runtimeDomainEvent('planner', 'Planner updates and plan mutation events.'),
  runtimeDomainEvent('permissions', 'Approval and permission prompt events.'),
  runtimeDomainEvent('plugins', 'Plugin registration and lifecycle events.'),
  runtimeDomainEvent('mcp', 'MCP server, tool, and connection events.'),
  runtimeDomainEvent('transport', 'Transport connect, disconnect, and lifecycle events.'),
  runtimeDomainEvent('compaction', 'Context compaction and summary events.'),
  runtimeDomainEvent('ui', 'UI-focused state and operational events.'),
  runtimeDomainEvent('ops', 'Operational diagnostics and control events.'),
  runtimeDomainEvent('forensics', 'Forensics and incident trail events.'),
  runtimeDomainEvent('security', 'Security posture and policy events.'),
  runtimeDomainEvent('automation', 'Automation job, schedule, and run events.'),
  runtimeDomainEvent('routes', 'Route binding and surface-link events.'),
  runtimeDomainEvent('control-plane', 'Control-plane client, auth, and subscription events.'),
  runtimeDomainEvent('deliveries', 'Delivery queue and outcome events.'),
  runtimeDomainEvent('watchers', 'Watcher state and heartbeat events.'),
  runtimeDomainEvent('surfaces', 'Surface registration and health events.'),
  eventDescriptor({
    id: 'control.ready',
    title: 'Ready Handshake',
    description: 'Initial SSE/WebSocket handshake event emitted after a control-plane subscription is opened.',
    category: 'transport',
    transport: ['sse', 'ws'],
    scopes: ['read:events'],
    wireEvents: ['ready'],
    outputSchema: objectSchema({
      clientId: STRING_SCHEMA,
      domains: arraySchema(STRING_SCHEMA),
      transport: STRING_SCHEMA,
    }, ['clientId', 'domains'], { additionalProperties: true }),
  }),
  eventDescriptor({
    id: 'control.heartbeat',
    title: 'Heartbeat',
    description: 'Keepalive event emitted by the SSE control-plane transport.',
    category: 'transport',
    transport: ['sse', 'ws'],
    scopes: ['read:events'],
    wireEvents: ['heartbeat'],
    outputSchema: objectSchema({
      clientId: STRING_SCHEMA,
      ts: NUMBER_SCHEMA,
    }, ['clientId', 'ts'], { additionalProperties: false }),
  }),
  eventDescriptor({
    id: 'control.surface_message',
    title: 'Surface Message',
    description: 'Out-of-band control-plane surface messages for operators and connected clients.',
    category: 'transport',
    transport: ['sse', 'ws'],
    scopes: ['read:events'],
    wireEvents: ['surface-message'],
    outputSchema: GENERIC_OBJECT_SCHEMA,
  }),
];

const BUILTIN_GATEWAY_METHODS: readonly GatewayMethodDescriptor[] = [
  methodDescriptor({
    id: 'control.status',
    title: 'Daemon Status',
    description: 'Return daemon status and version.',
    category: 'control-plane',
    scopes: ['read:control-plane'],
    http: { method: 'GET', path: '/status' },
    inputSchema: EMPTY_OBJECT_SCHEMA,
    outputSchema: objectSchema({
      status: STRING_SCHEMA,
      version: STRING_SCHEMA,
    }, ['status', 'version'], { additionalProperties: true }),
  }),
  methodDescriptor({
    id: 'control.snapshot',
    title: 'Control-Plane Snapshot',
    description: 'Return the current control-plane gateway snapshot.',
    category: 'control-plane',
    scopes: ['read:control-plane'],
    http: { method: 'GET', path: '/api/control-plane' },
    events: [runtimeEventId('control-plane')],
    inputSchema: EMPTY_OBJECT_SCHEMA,
    outputSchema: GENERIC_OBJECT_SCHEMA,
  }),
  methodDescriptor({
    id: 'control.web',
    title: 'Control-Plane Web Shell',
    description: 'Return the built-in control-plane HTML shell for external clients.',
    category: 'control-plane',
    scopes: ['read:control-plane'],
    transport: ['http'],
    http: { method: 'GET', path: '/api/control-plane/web' },
    inputSchema: EMPTY_OBJECT_SCHEMA,
    outputSchema: objectSchema({ html: STRING_SCHEMA }, ['html']),
    invokable: false,
    metadata: { responseKind: 'html' },
  }),
  methodDescriptor({
    id: 'control.messages.list',
    title: 'List Control-Plane Messages',
    description: 'Return recent surface messages published through the control plane.',
    category: 'control-plane',
    scopes: ['read:control-plane'],
    http: { method: 'GET', path: '/api/control-plane/messages' },
    inputSchema: EMPTY_OBJECT_SCHEMA,
    outputSchema: listOutputSchema('messages'),
  }),
  methodDescriptor({
    id: 'control.clients.list',
    title: 'List Control-Plane Clients',
    description: 'Return authenticated and recently connected control-plane clients.',
    category: 'control-plane',
    scopes: ['read:control-plane'],
    http: { method: 'GET', path: '/api/control-plane/clients' },
    inputSchema: EMPTY_OBJECT_SCHEMA,
    outputSchema: listOutputSchema('clients'),
  }),
  methodDescriptor({
    id: 'control.methods.list',
    title: 'List Gateway Methods',
    description: 'Return the gateway method catalog.',
    category: 'control-plane',
    scopes: ['read:control-plane'],
    http: { method: 'GET', path: '/api/control-plane/methods' },
    inputSchema: objectSchema({
      category: STRING_SCHEMA,
      source: STRING_SCHEMA,
    }),
    outputSchema: listOutputSchema('methods'),
  }),
  methodDescriptor({
    id: 'control.methods.get',
    title: 'Get Gateway Method',
    description: 'Return a single gateway method descriptor.',
    category: 'control-plane',
    scopes: ['read:control-plane'],
    http: { method: 'GET', path: '/api/control-plane/methods/{methodId}' },
    inputSchema: objectSchema({
      methodId: STRING_SCHEMA,
    }, ['methodId']),
    outputSchema: entityOutputSchema('method'),
  }),
  methodDescriptor({
    id: 'control.events.catalog',
    title: 'List Gateway Events',
    description: 'Return the event catalog for SSE and WebSocket control-plane subscriptions.',
    category: 'control-plane',
    scopes: ['read:control-plane', 'read:events'],
    http: { method: 'GET', path: '/api/control-plane/events/catalog' },
    inputSchema: objectSchema({
      category: STRING_SCHEMA,
      domain: STRING_SCHEMA,
    }),
    outputSchema: listOutputSchema('events'),
  }),
  methodDescriptor({
    id: 'control.events.stream',
    title: 'Open Control-Plane Event Stream',
    description: 'Open the SSE control-plane event stream.',
    category: 'control-plane',
    scopes: ['read:events'],
    transport: ['http'],
    http: { method: 'GET', path: '/api/control-plane/events' },
    inputSchema: objectSchema({
      domains: STRING_SCHEMA,
    }),
    outputSchema: objectSchema({
      contentType: STRING_SCHEMA,
      mode: STRING_SCHEMA,
    }, ['contentType', 'mode']),
    invokable: false,
    metadata: { responseKind: 'sse', stream: true },
  }),
  methodDescriptor({
    id: 'review.snapshot',
    title: 'Review Snapshot',
    description: 'Return the integration review snapshot used by external helpers.',
    category: 'review',
    scopes: ['read:automation'],
    http: { method: 'GET', path: '/api/review' },
    inputSchema: EMPTY_OBJECT_SCHEMA,
    outputSchema: GENERIC_OBJECT_SCHEMA,
  }),
  methodDescriptor({
    id: 'sessions.integration.snapshot',
    title: 'Legacy Session Snapshot',
    description: 'Return the legacy integration session snapshot.',
    category: 'sessions',
    scopes: ['read:sessions'],
    http: { method: 'GET', path: '/api/session' },
    inputSchema: EMPTY_OBJECT_SCHEMA,
    outputSchema: GENERIC_OBJECT_SCHEMA,
  }),
  methodDescriptor({
    id: 'sessions.list',
    title: 'List Shared Sessions',
    description: 'Return shared-session integration state.',
    category: 'sessions',
    scopes: ['read:sessions'],
    http: { method: 'GET', path: '/api/sessions' },
    events: [runtimeEventId('session')],
    inputSchema: EMPTY_OBJECT_SCHEMA,
    outputSchema: GENERIC_OBJECT_SCHEMA,
  }),
  methodDescriptor({
    id: 'sessions.create',
    title: 'Create Shared Session',
    description: 'Create a shared session for a surface, route, or web client.',
    category: 'sessions',
    scopes: ['write:sessions'],
    http: { method: 'POST', path: '/api/sessions' },
    inputSchema: bodyEnvelopeSchema({
      title: STRING_SCHEMA,
      surfaceKind: STRING_SCHEMA,
      surfaceId: STRING_SCHEMA,
    }),
    outputSchema: actionResultOutputSchema('session'),
  }),
  methodDescriptor({
    id: 'sessions.get',
    title: 'Get Shared Session',
    description: 'Return metadata for a shared session.',
    category: 'sessions',
    scopes: ['read:sessions'],
    http: { method: 'GET', path: '/api/sessions/{sessionId}' },
    inputSchema: objectSchema({ sessionId: STRING_SCHEMA }, ['sessionId']),
    outputSchema: actionResultOutputSchema('session'),
  }),
  methodDescriptor({
    id: 'sessions.close',
    title: 'Close Shared Session',
    description: 'Mark a shared session as closed.',
    category: 'sessions',
    scopes: ['write:sessions'],
    http: { method: 'POST', path: '/api/sessions/{sessionId}/close' },
    inputSchema: objectSchema({ sessionId: STRING_SCHEMA }, ['sessionId']),
    outputSchema: actionResultOutputSchema('session'),
  }),
  methodDescriptor({
    id: 'sessions.reopen',
    title: 'Reopen Shared Session',
    description: 'Reopen a previously closed shared session.',
    category: 'sessions',
    scopes: ['write:sessions'],
    http: { method: 'POST', path: '/api/sessions/{sessionId}/reopen' },
    inputSchema: objectSchema({ sessionId: STRING_SCHEMA }, ['sessionId']),
    outputSchema: actionResultOutputSchema('session'),
  }),
  methodDescriptor({
    id: 'sessions.messages.list',
    title: 'List Shared Session Messages',
    description: 'Return message history for a shared session.',
    category: 'sessions',
    scopes: ['read:sessions'],
    http: { method: 'GET', path: '/api/sessions/{sessionId}/messages' },
    inputSchema: objectSchema({
      sessionId: STRING_SCHEMA,
      limit: NUMBER_SCHEMA,
      before: STRING_SCHEMA,
    }, ['sessionId']),
    outputSchema: GENERIC_OBJECT_SCHEMA,
  }),
  methodDescriptor({
    id: 'sessions.messages.create',
    title: 'Post Shared Session Message',
    description: 'Append a user message to a shared session and queue assistant work.',
    category: 'sessions',
    scopes: ['write:sessions'],
    http: { method: 'POST', path: '/api/sessions/{sessionId}/messages' },
    inputSchema: bodyEnvelopeSchema({
      body: STRING_SCHEMA,
      surfaceKind: STRING_SCHEMA,
      surfaceId: STRING_SCHEMA,
    }, ['body']),
    outputSchema: GENERIC_OBJECT_SCHEMA,
  }),
  methodDescriptor({
    id: 'tasks.list',
    title: 'List Runtime Tasks',
    description: 'Return the integration snapshot for runtime tasks.',
    category: 'tasks',
    scopes: ['read:tasks'],
    http: { method: 'GET', path: '/api/tasks' },
    inputSchema: EMPTY_OBJECT_SCHEMA,
    outputSchema: GENERIC_OBJECT_SCHEMA,
  }),
  methodDescriptor({
    id: 'tasks.create',
    title: 'Create Task',
    description: 'Submit a task to the daemon or a shared session.',
    category: 'tasks',
    scopes: ['write:tasks'],
    http: { method: 'POST', path: '/task' },
    events: [runtimeEventId('tasks')],
    inputSchema: GENERIC_OBJECT_SCHEMA,
    outputSchema: GENERIC_OBJECT_SCHEMA,
  }),
  methodDescriptor({
    id: 'tasks.get',
    title: 'Get Runtime Task',
    description: 'Return a single runtime task record.',
    category: 'tasks',
    scopes: ['read:tasks'],
    http: { method: 'GET', path: '/api/tasks/{taskId}' },
    inputSchema: objectSchema({ taskId: STRING_SCHEMA }, ['taskId']),
    outputSchema: GENERIC_OBJECT_SCHEMA,
  }),
  methodDescriptor({
    id: 'tasks.cancel',
    title: 'Cancel Runtime Task',
    description: 'Cancel an in-flight runtime task.',
    category: 'tasks',
    scopes: ['write:tasks'],
    http: { method: 'POST', path: '/api/tasks/{taskId}/cancel' },
    inputSchema: objectSchema({ taskId: STRING_SCHEMA }, ['taskId']),
    outputSchema: GENERIC_OBJECT_SCHEMA,
  }),
  methodDescriptor({
    id: 'tasks.retry',
    title: 'Retry Runtime Task',
    description: 'Retry a runtime task through the task action endpoint.',
    category: 'tasks',
    scopes: ['write:tasks'],
    http: { method: 'POST', path: '/api/tasks/{taskId}/retry' },
    inputSchema: objectSchema({ taskId: STRING_SCHEMA }, ['taskId']),
    outputSchema: GENERIC_OBJECT_SCHEMA,
  }),
  methodDescriptor({
    id: 'tasks.status',
    title: 'Get Task Status',
    description: 'Return lightweight runtime task status by agent id.',
    category: 'tasks',
    scopes: ['read:tasks'],
    http: { method: 'GET', path: '/task/{agentId}' },
    inputSchema: objectSchema({ agentId: STRING_SCHEMA }, ['agentId']),
    outputSchema: GENERIC_OBJECT_SCHEMA,
  }),
  methodDescriptor({
    id: 'automation.integration.snapshot',
    title: 'Automation Integration Snapshot',
    description: 'Return the legacy integration automation snapshot.',
    category: 'automation',
    scopes: ['read:automation'],
    http: { method: 'GET', path: '/api/automation' },
    inputSchema: EMPTY_OBJECT_SCHEMA,
    outputSchema: GENERIC_OBJECT_SCHEMA,
  }),
  methodDescriptor({
    id: 'automation.jobs.list',
    title: 'List Automation Jobs',
    description: 'Return automation jobs and recent runs.',
    category: 'automation',
    scopes: ['read:automation'],
    http: { method: 'GET', path: '/api/automation/jobs' },
    events: [runtimeEventId('automation')],
    inputSchema: EMPTY_OBJECT_SCHEMA,
    outputSchema: GENERIC_OBJECT_SCHEMA,
  }),
  methodDescriptor({
    id: 'automation.jobs.create',
    title: 'Create Automation Job',
    description: 'Create a durable automation job.',
    category: 'automation',
    scopes: ['write:automation'],
    http: { method: 'POST', path: '/api/automation/jobs' },
    events: [runtimeEventId('automation')],
    inputSchema: GENERIC_OBJECT_SCHEMA,
    outputSchema: GENERIC_OBJECT_SCHEMA,
  }),
  methodDescriptor({
    id: 'automation.jobs.patch',
    title: 'Patch Automation Job',
    description: 'Patch a durable automation job.',
    category: 'automation',
    scopes: ['write:automation'],
    http: { method: 'PATCH', path: '/api/automation/jobs/{jobId}' },
    events: [runtimeEventId('automation')],
    inputSchema: GENERIC_OBJECT_SCHEMA,
    outputSchema: GENERIC_OBJECT_SCHEMA,
  }),
  methodDescriptor({
    id: 'automation.jobs.delete',
    title: 'Delete Automation Job',
    description: 'Delete a durable automation job.',
    category: 'automation',
    scopes: ['write:automation'],
    http: { method: 'DELETE', path: '/api/automation/jobs/{jobId}' },
    events: [runtimeEventId('automation')],
    inputSchema: objectSchema({ jobId: STRING_SCHEMA }, ['jobId']),
    outputSchema: GENERIC_OBJECT_SCHEMA,
    dangerous: true,
  }),
  methodDescriptor({
    id: 'automation.jobs.enable',
    title: 'Enable Automation Job',
    description: 'Enable a durable automation job.',
    category: 'automation',
    scopes: ['write:automation'],
    http: { method: 'POST', path: '/api/automation/jobs/{jobId}/enable' },
    events: [runtimeEventId('automation')],
    inputSchema: objectSchema({ jobId: STRING_SCHEMA }, ['jobId']),
    outputSchema: GENERIC_OBJECT_SCHEMA,
  }),
  methodDescriptor({
    id: 'automation.jobs.disable',
    title: 'Disable Automation Job',
    description: 'Disable a durable automation job.',
    category: 'automation',
    scopes: ['write:automation'],
    http: { method: 'POST', path: '/api/automation/jobs/{jobId}/disable' },
    events: [runtimeEventId('automation')],
    inputSchema: objectSchema({ jobId: STRING_SCHEMA }, ['jobId']),
    outputSchema: GENERIC_OBJECT_SCHEMA,
  }),
  methodDescriptor({
    id: 'automation.jobs.pause',
    title: 'Pause Automation Job',
    description: 'Pause a durable automation job.',
    category: 'automation',
    scopes: ['write:automation'],
    http: { method: 'POST', path: '/api/automation/jobs/{jobId}/pause' },
    events: [runtimeEventId('automation')],
    inputSchema: objectSchema({ jobId: STRING_SCHEMA }, ['jobId']),
    outputSchema: GENERIC_OBJECT_SCHEMA,
  }),
  methodDescriptor({
    id: 'automation.jobs.resume',
    title: 'Resume Automation Job',
    description: 'Resume a durable automation job.',
    category: 'automation',
    scopes: ['write:automation'],
    http: { method: 'POST', path: '/api/automation/jobs/{jobId}/resume' },
    events: [runtimeEventId('automation')],
    inputSchema: objectSchema({ jobId: STRING_SCHEMA }, ['jobId']),
    outputSchema: GENERIC_OBJECT_SCHEMA,
  }),
  methodDescriptor({
    id: 'automation.jobs.run',
    title: 'Run Automation Job Now',
    description: 'Trigger an automation job immediately.',
    category: 'automation',
    scopes: ['write:automation'],
    http: { method: 'POST', path: '/api/automation/jobs/{jobId}/run' },
    events: [runtimeEventId('automation')],
    inputSchema: objectSchema({ jobId: STRING_SCHEMA }, ['jobId']),
    outputSchema: GENERIC_OBJECT_SCHEMA,
  }),
  methodDescriptor({
    id: 'automation.runs.list',
    title: 'List Automation Runs',
    description: 'Return automation run history.',
    category: 'automation',
    scopes: ['read:automation'],
    http: { method: 'GET', path: '/api/automation/runs' },
    inputSchema: EMPTY_OBJECT_SCHEMA,
    outputSchema: GENERIC_OBJECT_SCHEMA,
  }),
  methodDescriptor({
    id: 'automation.runs.get',
    title: 'Get Automation Run',
    description: 'Return a single automation run record.',
    category: 'automation',
    scopes: ['read:automation'],
    http: { method: 'GET', path: '/api/automation/runs/{runId}' },
    inputSchema: objectSchema({ runId: STRING_SCHEMA }, ['runId']),
    outputSchema: GENERIC_OBJECT_SCHEMA,
  }),
  methodDescriptor({
    id: 'automation.runs.cancel',
    title: 'Cancel Automation Run',
    description: 'Cancel an active automation run.',
    category: 'automation',
    scopes: ['write:automation'],
    http: { method: 'POST', path: '/api/automation/runs/{runId}/cancel' },
    inputSchema: objectSchema({ runId: STRING_SCHEMA }, ['runId']),
    outputSchema: GENERIC_OBJECT_SCHEMA,
  }),
  methodDescriptor({
    id: 'automation.runs.retry',
    title: 'Retry Automation Run',
    description: 'Retry a completed or failed automation run.',
    category: 'automation',
    scopes: ['write:automation'],
    http: { method: 'POST', path: '/api/automation/runs/{runId}/retry' },
    inputSchema: objectSchema({ runId: STRING_SCHEMA }, ['runId']),
    outputSchema: GENERIC_OBJECT_SCHEMA,
  }),
  methodDescriptor({
    id: 'automation.heartbeat.list',
    title: 'List Automation Heartbeat Queue',
    description: 'Return automation jobs queued for the next heartbeat.',
    category: 'automation',
    scopes: ['read:automation'],
    http: { method: 'GET', path: '/api/automation/heartbeat' },
    inputSchema: EMPTY_OBJECT_SCHEMA,
    outputSchema: objectSchema({ pending: arraySchema(GENERIC_OBJECT_SCHEMA) }, ['pending']),
  }),
  methodDescriptor({
    id: 'automation.heartbeat.run',
    title: 'Run Automation Heartbeat',
    description: 'Process automation jobs queued for the next heartbeat.',
    category: 'automation',
    scopes: ['write:automation'],
    http: { method: 'POST', path: '/api/automation/heartbeat' },
    events: [runtimeEventId('automation')],
    inputSchema: bodyEnvelopeSchema({ source: STRING_SCHEMA }),
    outputSchema: GENERIC_OBJECT_SCHEMA,
  }),
  methodDescriptor({
    id: 'deliveries.list',
    title: 'List Deliveries',
    description: 'Return delivery records and integration snapshot data.',
    category: 'deliveries',
    scopes: ['read:deliveries'],
    http: { method: 'GET', path: '/api/deliveries' },
    events: [runtimeEventId('deliveries')],
    inputSchema: EMPTY_OBJECT_SCHEMA,
    outputSchema: GENERIC_OBJECT_SCHEMA,
  }),
  methodDescriptor({
    id: 'deliveries.get',
    title: 'Get Delivery',
    description: 'Return a single delivery record.',
    category: 'deliveries',
    scopes: ['read:deliveries'],
    http: { method: 'GET', path: '/api/deliveries/{deliveryId}' },
    inputSchema: objectSchema({ deliveryId: STRING_SCHEMA }, ['deliveryId']),
    outputSchema: GENERIC_OBJECT_SCHEMA,
  }),
  methodDescriptor({
    id: 'schedules.list',
    title: 'List Schedules',
    description: 'Return legacy schedule records.',
    category: 'automation',
    scopes: ['read:automation'],
    http: { method: 'GET', path: '/schedules' },
    inputSchema: EMPTY_OBJECT_SCHEMA,
    outputSchema: GENERIC_OBJECT_SCHEMA,
  }),
  methodDescriptor({
    id: 'schedules.create',
    title: 'Create Schedule',
    description: 'Create a legacy schedule record.',
    category: 'automation',
    scopes: ['write:automation'],
    http: { method: 'POST', path: '/schedules' },
    inputSchema: GENERIC_OBJECT_SCHEMA,
    outputSchema: GENERIC_OBJECT_SCHEMA,
  }),
  methodDescriptor({
    id: 'schedules.delete',
    title: 'Delete Schedule',
    description: 'Delete a legacy schedule record.',
    category: 'automation',
    scopes: ['write:automation'],
    http: { method: 'DELETE', path: '/schedules/{scheduleId}' },
    inputSchema: objectSchema({ scheduleId: STRING_SCHEMA }, ['scheduleId']),
    outputSchema: GENERIC_OBJECT_SCHEMA,
    dangerous: true,
  }),
  methodDescriptor({
    id: 'schedules.enable',
    title: 'Enable Schedule',
    description: 'Enable a legacy schedule record.',
    category: 'automation',
    scopes: ['write:automation'],
    http: { method: 'POST', path: '/schedules/{scheduleId}/enable' },
    inputSchema: objectSchema({ scheduleId: STRING_SCHEMA }, ['scheduleId']),
    outputSchema: GENERIC_OBJECT_SCHEMA,
  }),
  methodDescriptor({
    id: 'schedules.disable',
    title: 'Disable Schedule',
    description: 'Disable a legacy schedule record.',
    category: 'automation',
    scopes: ['write:automation'],
    http: { method: 'POST', path: '/schedules/{scheduleId}/disable' },
    inputSchema: objectSchema({ scheduleId: STRING_SCHEMA }, ['scheduleId']),
    outputSchema: GENERIC_OBJECT_SCHEMA,
  }),
  methodDescriptor({
    id: 'schedules.run',
    title: 'Run Schedule Now',
    description: 'Trigger a legacy schedule immediately.',
    category: 'automation',
    scopes: ['write:automation'],
    http: { method: 'POST', path: '/schedules/{scheduleId}/run' },
    inputSchema: objectSchema({ scheduleId: STRING_SCHEMA }, ['scheduleId']),
    outputSchema: GENERIC_OBJECT_SCHEMA,
  }),
  methodDescriptor({
    id: 'routes.snapshot',
    title: 'Route Snapshot',
    description: 'Return the route and binding integration snapshot.',
    category: 'routes',
    scopes: ['read:routes'],
    http: { method: 'GET', path: '/api/routes' },
    events: [runtimeEventId('routes')],
    inputSchema: EMPTY_OBJECT_SCHEMA,
    outputSchema: GENERIC_OBJECT_SCHEMA,
  }),
  methodDescriptor({
    id: 'surfaces.list',
    title: 'List Surfaces',
    description: 'Return registered channel and control surfaces.',
    category: 'routes',
    scopes: ['read:routes'],
    http: { method: 'GET', path: '/api/surfaces' },
    events: [runtimeEventId('surfaces')],
    inputSchema: EMPTY_OBJECT_SCHEMA,
    outputSchema: listOutputSchema('surfaces'),
  }),
  methodDescriptor({
    id: 'routes.bindings.list',
    title: 'List Route Bindings',
    description: 'Return configured route bindings.',
    category: 'routes',
    scopes: ['read:routes'],
    http: { method: 'GET', path: '/api/routes/bindings' },
    events: [runtimeEventId('routes')],
    inputSchema: EMPTY_OBJECT_SCHEMA,
    outputSchema: listOutputSchema('bindings'),
  }),
  methodDescriptor({
    id: 'routes.bindings.create',
    title: 'Create Route Binding',
    description: 'Create or upsert a route binding.',
    category: 'routes',
    scopes: ['write:routes'],
    access: 'admin',
    http: { method: 'POST', path: '/api/routes/bindings' },
    events: [runtimeEventId('routes')],
    inputSchema: GENERIC_OBJECT_SCHEMA,
    outputSchema: GENERIC_OBJECT_SCHEMA,
  }),
  methodDescriptor({
    id: 'routes.bindings.patch',
    title: 'Patch Route Binding',
    description: 'Patch an existing route binding.',
    category: 'routes',
    scopes: ['write:routes'],
    access: 'admin',
    http: { method: 'PATCH', path: '/api/routes/bindings/{bindingId}' },
    events: [runtimeEventId('routes')],
    inputSchema: GENERIC_OBJECT_SCHEMA,
    outputSchema: GENERIC_OBJECT_SCHEMA,
  }),
  methodDescriptor({
    id: 'routes.bindings.delete',
    title: 'Delete Route Binding',
    description: 'Delete an existing route binding.',
    category: 'routes',
    scopes: ['write:routes'],
    access: 'admin',
    http: { method: 'DELETE', path: '/api/routes/bindings/{bindingId}' },
    events: [runtimeEventId('routes')],
    inputSchema: objectSchema({ bindingId: STRING_SCHEMA }, ['bindingId']),
    outputSchema: GENERIC_OBJECT_SCHEMA,
    dangerous: true,
  }),
  methodDescriptor({
    id: 'approvals.list',
    title: 'List Approvals',
    description: 'Return pending and historical approval records.',
    category: 'approvals',
    scopes: ['read:approvals'],
    http: { method: 'GET', path: '/api/approvals' },
    inputSchema: EMPTY_OBJECT_SCHEMA,
    outputSchema: GENERIC_OBJECT_SCHEMA,
  }),
  methodDescriptor({
    id: 'approvals.claim',
    title: 'Claim Approval',
    description: 'Claim a pending approval for operator handling.',
    category: 'approvals',
    scopes: ['write:approvals'],
    http: { method: 'POST', path: '/api/approvals/{approvalId}/claim' },
    inputSchema: objectSchema({ approvalId: STRING_SCHEMA }, ['approvalId']),
    outputSchema: GENERIC_OBJECT_SCHEMA,
  }),
  methodDescriptor({
    id: 'approvals.approve',
    title: 'Approve Approval',
    description: 'Approve a pending approval.',
    category: 'approvals',
    scopes: ['write:approvals'],
    http: { method: 'POST', path: '/api/approvals/{approvalId}/approve' },
    inputSchema: GENERIC_OBJECT_SCHEMA,
    outputSchema: GENERIC_OBJECT_SCHEMA,
  }),
  methodDescriptor({
    id: 'approvals.deny',
    title: 'Deny Approval',
    description: 'Deny a pending approval.',
    category: 'approvals',
    scopes: ['write:approvals'],
    http: { method: 'POST', path: '/api/approvals/{approvalId}/deny' },
    inputSchema: GENERIC_OBJECT_SCHEMA,
    outputSchema: GENERIC_OBJECT_SCHEMA,
  }),
  methodDescriptor({
    id: 'approvals.cancel',
    title: 'Cancel Approval',
    description: 'Cancel a pending approval.',
    category: 'approvals',
    scopes: ['write:approvals'],
    http: { method: 'POST', path: '/api/approvals/{approvalId}/cancel' },
    inputSchema: GENERIC_OBJECT_SCHEMA,
    outputSchema: GENERIC_OBJECT_SCHEMA,
  }),
  methodDescriptor({
    id: 'channels.accounts.list',
    title: 'List Channel Accounts',
    description: 'Return channel account lifecycle posture.',
    category: 'channels',
    scopes: ['read:channels'],
    http: { method: 'GET', path: '/api/channels/accounts' },
    inputSchema: EMPTY_OBJECT_SCHEMA,
    outputSchema: listOutputSchema('accounts'),
  }),
  methodDescriptor({
    id: 'channels.accounts.surface.list',
    title: 'List Channel Surface Accounts',
    description: 'Return account posture for a single channel surface.',
    category: 'channels',
    scopes: ['read:channels'],
    http: { method: 'GET', path: '/api/channels/accounts/{surface}' },
    inputSchema: objectSchema({ surface: STRING_SCHEMA }, ['surface']),
    outputSchema: listOutputSchema('accounts'),
  }),
  methodDescriptor({
    id: 'channels.accounts.get',
    title: 'Get Channel Account',
    description: 'Return a single channel account record.',
    category: 'channels',
    scopes: ['read:channels'],
    http: { method: 'GET', path: '/api/channels/accounts/{surface}/{accountId}' },
    inputSchema: objectSchema({
      surface: STRING_SCHEMA,
      accountId: STRING_SCHEMA,
    }, ['surface', 'accountId']),
    outputSchema: GENERIC_OBJECT_SCHEMA,
  }),
  methodDescriptor({
    id: 'channels.setup.get',
    title: 'Get Channel Setup Schema',
    description: 'Return the versioned setup schema, secret targets, and external steps for a channel surface.',
    category: 'channels',
    scopes: ['read:channels'],
    http: { method: 'GET', path: '/api/channels/setup/{surface}' },
    inputSchema: objectSchema({ surface: STRING_SCHEMA }, ['surface']),
    outputSchema: GENERIC_OBJECT_SCHEMA,
  }),
  methodDescriptor({
    id: 'channels.doctor.get',
    title: 'Get Channel Doctor Report',
    description: 'Return doctor checks and repair posture for a channel surface.',
    category: 'channels',
    scopes: ['read:channels'],
    http: { method: 'GET', path: '/api/channels/doctor/{surface}' },
    inputSchema: objectSchema({ surface: STRING_SCHEMA }, ['surface']),
    outputSchema: GENERIC_OBJECT_SCHEMA,
  }),
  methodDescriptor({
    id: 'channels.repairs.list',
    title: 'List Channel Repair Actions',
    description: 'Return repair actions exposed by a channel surface.',
    category: 'channels',
    scopes: ['read:channels'],
    http: { method: 'GET', path: '/api/channels/repair-actions/{surface}' },
    inputSchema: objectSchema({ surface: STRING_SCHEMA }, ['surface']),
    outputSchema: listOutputSchema('actions'),
  }),
  methodDescriptor({
    id: 'channels.lifecycle.get',
    title: 'Get Channel Lifecycle State',
    description: 'Return lifecycle migration posture for a channel surface.',
    category: 'channels',
    scopes: ['read:channels'],
    http: { method: 'GET', path: '/api/channels/lifecycle/{surface}' },
    inputSchema: objectSchema({ surface: STRING_SCHEMA }, ['surface']),
    outputSchema: GENERIC_OBJECT_SCHEMA,
  }),
  methodDescriptor({
    id: 'channels.lifecycle.migrate',
    title: 'Migrate Channel Lifecycle',
    description: 'Apply lifecycle migrations for a channel surface.',
    category: 'channels',
    scopes: ['write:channels'],
    access: 'admin',
    http: { method: 'POST', path: '/api/channels/lifecycle/{surface}/migrate' },
    inputSchema: GENERIC_OBJECT_SCHEMA,
    outputSchema: GENERIC_OBJECT_SCHEMA,
  }),
  methodDescriptor({
    id: 'channels.accounts.action.default',
    title: 'Run Channel Account Action',
    description: 'Run a lifecycle action on the default channel account for a surface.',
    category: 'channels',
    scopes: ['write:channels'],
    access: 'admin',
    http: { method: 'POST', path: '/api/channels/accounts/{surface}/actions/{action}' },
    inputSchema: GENERIC_OBJECT_SCHEMA,
    outputSchema: GENERIC_OBJECT_SCHEMA,
  }),
  methodDescriptor({
    id: 'channels.accounts.action.named',
    title: 'Run Named Channel Account Action',
    description: 'Run a lifecycle action on a specific channel account.',
    category: 'channels',
    scopes: ['write:channels'],
    access: 'admin',
    http: { method: 'POST', path: '/api/channels/accounts/{surface}/{accountId}/actions/{action}' },
    inputSchema: GENERIC_OBJECT_SCHEMA,
    outputSchema: GENERIC_OBJECT_SCHEMA,
  }),
  methodDescriptor({
    id: 'channels.capabilities.list',
    title: 'List Channel Capabilities',
    description: 'Return capability posture for all registered channel surfaces.',
    category: 'channels',
    scopes: ['read:channels'],
    http: { method: 'GET', path: '/api/channels/capabilities' },
    inputSchema: EMPTY_OBJECT_SCHEMA,
    outputSchema: listOutputSchema('capabilities'),
  }),
  methodDescriptor({
    id: 'channels.capabilities.surface.list',
    title: 'List Channel Surface Capabilities',
    description: 'Return capability posture for a single surface.',
    category: 'channels',
    scopes: ['read:channels'],
    http: { method: 'GET', path: '/api/channels/capabilities/{surface}' },
    inputSchema: objectSchema({ surface: STRING_SCHEMA }, ['surface']),
    outputSchema: listOutputSchema('capabilities'),
  }),
  methodDescriptor({
    id: 'channels.tools.list',
    title: 'List Channel Tools',
    description: 'Return operator tools registered by channel plugins.',
    category: 'channels',
    scopes: ['read:channels'],
    http: { method: 'GET', path: '/api/channels/tools' },
    inputSchema: EMPTY_OBJECT_SCHEMA,
    outputSchema: listOutputSchema('tools'),
  }),
  methodDescriptor({
    id: 'channels.tools.surface.list',
    title: 'List Channel Surface Tools',
    description: 'Return operator tools for a single channel surface.',
    category: 'channels',
    scopes: ['read:channels'],
    http: { method: 'GET', path: '/api/channels/tools/{surface}' },
    inputSchema: objectSchema({ surface: STRING_SCHEMA }, ['surface']),
    outputSchema: listOutputSchema('tools'),
  }),
  methodDescriptor({
    id: 'channels.tools.invoke',
    title: 'Run Channel Tool',
    description: 'Run a channel-owned operator tool.',
    category: 'channels',
    scopes: ['write:channels'],
    access: 'admin',
    http: { method: 'POST', path: '/api/channels/tools/{surface}/{toolId}' },
    inputSchema: GENERIC_OBJECT_SCHEMA,
    outputSchema: GENERIC_OBJECT_SCHEMA,
  }),
  methodDescriptor({
    id: 'channels.agent_tools.list',
    title: 'List Channel Agent Tools',
    description: 'Return LLM agent tools exposed through channel plugins.',
    category: 'channels',
    scopes: ['read:channels'],
    http: { method: 'GET', path: '/api/channels/agent-tools' },
    inputSchema: EMPTY_OBJECT_SCHEMA,
    outputSchema: listOutputSchema('tools'),
  }),
  methodDescriptor({
    id: 'channels.agent_tools.surface.list',
    title: 'List Channel Surface Agent Tools',
    description: 'Return LLM agent tools for a single channel surface.',
    category: 'channels',
    scopes: ['read:channels'],
    http: { method: 'GET', path: '/api/channels/agent-tools/{surface}' },
    inputSchema: objectSchema({ surface: STRING_SCHEMA }, ['surface']),
    outputSchema: listOutputSchema('tools'),
  }),
  methodDescriptor({
    id: 'channels.actions.list',
    title: 'List Channel Actions',
    description: 'Return operator actions registered by channel plugins.',
    category: 'channels',
    scopes: ['read:channels'],
    http: { method: 'GET', path: '/api/channels/actions' },
    inputSchema: EMPTY_OBJECT_SCHEMA,
    outputSchema: listOutputSchema('actions'),
  }),
  methodDescriptor({
    id: 'channels.actions.surface.list',
    title: 'List Channel Surface Actions',
    description: 'Return operator actions for a single channel surface.',
    category: 'channels',
    scopes: ['read:channels'],
    http: { method: 'GET', path: '/api/channels/actions/{surface}' },
    inputSchema: objectSchema({ surface: STRING_SCHEMA }, ['surface']),
    outputSchema: listOutputSchema('actions'),
  }),
  methodDescriptor({
    id: 'channels.actions.invoke',
    title: 'Run Channel Action',
    description: 'Run a channel-owned operator action.',
    category: 'channels',
    scopes: ['write:channels'],
    access: 'admin',
    http: { method: 'POST', path: '/api/channels/actions/{surface}/{actionId}' },
    inputSchema: GENERIC_OBJECT_SCHEMA,
    outputSchema: GENERIC_OBJECT_SCHEMA,
  }),
  methodDescriptor({
    id: 'channels.targets.resolve',
    title: 'Resolve Channel Target',
    description: 'Resolve a typed channel target for outbound delivery or routing.',
    category: 'channels',
    scopes: ['write:channels'],
    access: 'admin',
    http: { method: 'POST', path: '/api/channels/targets/{surface}/resolve' },
    inputSchema: GENERIC_OBJECT_SCHEMA,
    outputSchema: GENERIC_OBJECT_SCHEMA,
  }),
  methodDescriptor({
    id: 'channels.authorize',
    title: 'Authorize Channel Action',
    description: 'Evaluate channel authorization and availability for a requested action.',
    category: 'channels',
    scopes: ['write:channels'],
    access: 'admin',
    http: { method: 'POST', path: '/api/channels/authorize/{surface}' },
    inputSchema: GENERIC_OBJECT_SCHEMA,
    outputSchema: GENERIC_OBJECT_SCHEMA,
  }),
  methodDescriptor({
    id: 'channels.allowlist.resolve',
    title: 'Resolve Channel Allowlist',
    description: 'Resolve allowlist candidates into stable channel identities.',
    category: 'channels',
    scopes: ['write:channels'],
    access: 'admin',
    http: { method: 'POST', path: '/api/channels/allowlist/{surface}/resolve' },
    inputSchema: GENERIC_OBJECT_SCHEMA,
    outputSchema: GENERIC_OBJECT_SCHEMA,
  }),
  methodDescriptor({
    id: 'channels.allowlist.edit',
    title: 'Edit Channel Allowlist',
    description: 'Apply allowlist additions or removals for a channel surface.',
    category: 'channels',
    scopes: ['write:channels'],
    access: 'admin',
    http: { method: 'POST', path: '/api/channels/allowlist/{surface}/edit' },
    inputSchema: GENERIC_OBJECT_SCHEMA,
    outputSchema: GENERIC_OBJECT_SCHEMA,
  }),
  methodDescriptor({
    id: 'channels.policies.list',
    title: 'List Channel Policies',
    description: 'Return ingress policy configuration for channels.',
    category: 'channels',
    scopes: ['read:channels'],
    http: { method: 'GET', path: '/api/channels/policies' },
    inputSchema: EMPTY_OBJECT_SCHEMA,
    outputSchema: listOutputSchema('policies'),
  }),
  methodDescriptor({
    id: 'channels.policies.update',
    title: 'Update Channel Policy',
    description: 'Update ingress policy configuration for a channel surface.',
    category: 'channels',
    scopes: ['write:channels'],
    access: 'admin',
    http: { method: 'POST', path: '/api/channels/policies/{surface}' },
    inputSchema: GENERIC_OBJECT_SCHEMA,
    outputSchema: GENERIC_OBJECT_SCHEMA,
  }),
  methodDescriptor({
    id: 'channels.policies.audit',
    title: 'List Channel Policy Audit',
    description: 'Return channel ingress policy audit records.',
    category: 'channels',
    scopes: ['read:channels'],
    http: { method: 'GET', path: '/api/channels/policies/audit' },
    inputSchema: objectSchema({ limit: NUMBER_SCHEMA }),
    outputSchema: listOutputSchema('audit'),
  }),
  methodDescriptor({
    id: 'channels.status',
    title: 'Channel Status',
    description: 'Return status for channel plugins and provider-backed channels.',
    category: 'channels',
    scopes: ['read:channels'],
    http: { method: 'GET', path: '/api/channels/status' },
    inputSchema: EMPTY_OBJECT_SCHEMA,
    outputSchema: listOutputSchema('channels'),
  }),
  methodDescriptor({
    id: 'channels.directory.query',
    title: 'Query Channel Directory',
    description: 'Query a channel directory surface for users, groups, threads, or services.',
    category: 'channels',
    scopes: ['read:channels'],
    http: { method: 'GET', path: '/api/channels/directory/{surface}' },
    inputSchema: objectSchema({
      surface: STRING_SCHEMA,
      q: STRING_SCHEMA,
      scope: STRING_SCHEMA,
      groupId: STRING_SCHEMA,
      limit: NUMBER_SCHEMA,
      live: BOOLEAN_SCHEMA,
    }, ['surface']),
    outputSchema: listOutputSchema('entries'),
  }),
  methodDescriptor({
    id: 'watchers.list',
    title: 'List Watchers',
    description: 'Return configured watchers and their runtime posture.',
    category: 'watchers',
    scopes: ['read:watchers'],
    http: { method: 'GET', path: '/api/watchers' },
    events: [runtimeEventId('watchers')],
    inputSchema: EMPTY_OBJECT_SCHEMA,
    outputSchema: listOutputSchema('watchers'),
  }),
  methodDescriptor({
    id: 'watchers.create',
    title: 'Create Watcher',
    description: 'Register a new watcher.',
    category: 'watchers',
    scopes: ['write:watchers'],
    access: 'admin',
    http: { method: 'POST', path: '/api/watchers' },
    events: [runtimeEventId('watchers')],
    inputSchema: GENERIC_OBJECT_SCHEMA,
    outputSchema: GENERIC_OBJECT_SCHEMA,
  }),
  methodDescriptor({
    id: 'watchers.patch',
    title: 'Patch Watcher',
    description: 'Patch an existing watcher.',
    category: 'watchers',
    scopes: ['write:watchers'],
    access: 'admin',
    http: { method: 'PATCH', path: '/api/watchers/{watcherId}' },
    events: [runtimeEventId('watchers')],
    inputSchema: GENERIC_OBJECT_SCHEMA,
    outputSchema: GENERIC_OBJECT_SCHEMA,
  }),
  methodDescriptor({
    id: 'watchers.delete',
    title: 'Delete Watcher',
    description: 'Delete an existing watcher.',
    category: 'watchers',
    scopes: ['write:watchers'],
    access: 'admin',
    http: { method: 'DELETE', path: '/api/watchers/{watcherId}' },
    events: [runtimeEventId('watchers')],
    inputSchema: objectSchema({ watcherId: STRING_SCHEMA }, ['watcherId']),
    outputSchema: GENERIC_OBJECT_SCHEMA,
    dangerous: true,
  }),
  methodDescriptor({
    id: 'watchers.start',
    title: 'Start Watcher',
    description: 'Start a watcher instance.',
    category: 'watchers',
    scopes: ['write:watchers'],
    access: 'admin',
    http: { method: 'POST', path: '/api/watchers/{watcherId}/start' },
    events: [runtimeEventId('watchers')],
    inputSchema: objectSchema({ watcherId: STRING_SCHEMA }, ['watcherId']),
    outputSchema: GENERIC_OBJECT_SCHEMA,
  }),
  methodDescriptor({
    id: 'watchers.stop',
    title: 'Stop Watcher',
    description: 'Stop a watcher instance.',
    category: 'watchers',
    scopes: ['write:watchers'],
    access: 'admin',
    http: { method: 'POST', path: '/api/watchers/{watcherId}/stop' },
    events: [runtimeEventId('watchers')],
    inputSchema: objectSchema({ watcherId: STRING_SCHEMA }, ['watcherId']),
    outputSchema: GENERIC_OBJECT_SCHEMA,
  }),
  methodDescriptor({
    id: 'watchers.run',
    title: 'Run Watcher',
    description: 'Trigger a watcher immediately.',
    category: 'watchers',
    scopes: ['write:watchers'],
    access: 'admin',
    http: { method: 'POST', path: '/api/watchers/{watcherId}/run' },
    events: [runtimeEventId('watchers')],
    inputSchema: objectSchema({ watcherId: STRING_SCHEMA }, ['watcherId']),
    outputSchema: GENERIC_OBJECT_SCHEMA,
  }),
  methodDescriptor({
    id: 'services.status',
    title: 'Service Status',
    description: 'Return platform service installation and runtime posture.',
    category: 'services',
    scopes: ['read:services'],
    http: { method: 'GET', path: '/api/service/status' },
    inputSchema: EMPTY_OBJECT_SCHEMA,
    outputSchema: GENERIC_OBJECT_SCHEMA,
  }),
  methodDescriptor({
    id: 'services.install',
    title: 'Install Service',
    description: 'Install the GoodVibes platform service.',
    category: 'services',
    scopes: ['write:services'],
    access: 'admin',
    http: { method: 'POST', path: '/api/service/install' },
    inputSchema: EMPTY_OBJECT_SCHEMA,
    outputSchema: GENERIC_OBJECT_SCHEMA,
  }),
  methodDescriptor({
    id: 'services.start',
    title: 'Start Service',
    description: 'Start the GoodVibes platform service.',
    category: 'services',
    scopes: ['write:services'],
    access: 'admin',
    http: { method: 'POST', path: '/api/service/start' },
    inputSchema: EMPTY_OBJECT_SCHEMA,
    outputSchema: GENERIC_OBJECT_SCHEMA,
  }),
  methodDescriptor({
    id: 'services.stop',
    title: 'Stop Service',
    description: 'Stop the GoodVibes platform service.',
    category: 'services',
    scopes: ['write:services'],
    access: 'admin',
    http: { method: 'POST', path: '/api/service/stop' },
    inputSchema: EMPTY_OBJECT_SCHEMA,
    outputSchema: GENERIC_OBJECT_SCHEMA,
  }),
  methodDescriptor({
    id: 'services.restart',
    title: 'Restart Service',
    description: 'Restart the GoodVibes platform service.',
    category: 'services',
    scopes: ['write:services'],
    access: 'admin',
    http: { method: 'POST', path: '/api/service/restart' },
    inputSchema: EMPTY_OBJECT_SCHEMA,
    outputSchema: GENERIC_OBJECT_SCHEMA,
  }),
  methodDescriptor({
    id: 'services.uninstall',
    title: 'Uninstall Service',
    description: 'Uninstall the GoodVibes platform service.',
    category: 'services',
    scopes: ['write:services'],
    access: 'admin',
    http: { method: 'POST', path: '/api/service/uninstall' },
    inputSchema: EMPTY_OBJECT_SCHEMA,
    outputSchema: GENERIC_OBJECT_SCHEMA,
    dangerous: true,
  }),
  methodDescriptor({
    id: 'remote.snapshot',
    title: 'Remote Runtime Snapshot',
    description: 'Return distributed node/device runtime state.',
    category: 'remote',
    scopes: ['read:remote'],
    http: { method: 'GET', path: '/api/remote' },
    events: [runtimeEventId('control-plane')],
    inputSchema: EMPTY_OBJECT_SCHEMA,
    outputSchema: GENERIC_OBJECT_SCHEMA,
  }),
  methodDescriptor({
    id: 'remote.pair.requests.list',
    title: 'List Remote Pair Requests',
    description: 'Return pending remote pair requests.',
    category: 'remote',
    scopes: ['read:remote'],
    http: { method: 'GET', path: '/api/remote/pair/requests' },
    inputSchema: EMPTY_OBJECT_SCHEMA,
    outputSchema: listOutputSchema('requests'),
  }),
  methodDescriptor({
    id: 'remote.pair.requests.approve',
    title: 'Approve Remote Pair Request',
    description: 'Approve a pending remote pair request.',
    category: 'remote',
    scopes: ['write:remote'],
    access: 'admin',
    http: { method: 'POST', path: '/api/remote/pair/requests/{requestId}/approve' },
    inputSchema: GENERIC_OBJECT_SCHEMA,
    outputSchema: GENERIC_OBJECT_SCHEMA,
  }),
  methodDescriptor({
    id: 'remote.pair.requests.reject',
    title: 'Reject Remote Pair Request',
    description: 'Reject a pending remote pair request.',
    category: 'remote',
    scopes: ['write:remote'],
    access: 'admin',
    http: { method: 'POST', path: '/api/remote/pair/requests/{requestId}/reject' },
    inputSchema: GENERIC_OBJECT_SCHEMA,
    outputSchema: GENERIC_OBJECT_SCHEMA,
  }),
  methodDescriptor({
    id: 'remote.peers.list',
    title: 'List Remote Peers',
    description: 'Return known remote peers.',
    category: 'remote',
    scopes: ['read:remote'],
    http: { method: 'GET', path: '/api/remote/peers' },
    inputSchema: EMPTY_OBJECT_SCHEMA,
    outputSchema: listOutputSchema('peers'),
  }),
  methodDescriptor({
    id: 'remote.peers.token.rotate',
    title: 'Rotate Remote Peer Token',
    description: 'Rotate the active token for a remote peer.',
    category: 'remote',
    scopes: ['write:remote'],
    access: 'admin',
    http: { method: 'POST', path: '/api/remote/peers/{peerId}/token/rotate' },
    inputSchema: GENERIC_OBJECT_SCHEMA,
    outputSchema: GENERIC_OBJECT_SCHEMA,
  }),
  methodDescriptor({
    id: 'remote.peers.token.revoke',
    title: 'Revoke Remote Peer Token',
    description: 'Revoke the active token for a remote peer.',
    category: 'remote',
    scopes: ['write:remote'],
    access: 'admin',
    http: { method: 'POST', path: '/api/remote/peers/{peerId}/token/revoke' },
    inputSchema: GENERIC_OBJECT_SCHEMA,
    outputSchema: GENERIC_OBJECT_SCHEMA,
  }),
  methodDescriptor({
    id: 'remote.peers.disconnect',
    title: 'Disconnect Remote Peer',
    description: 'Disconnect a remote peer.',
    category: 'remote',
    scopes: ['write:remote'],
    access: 'admin',
    http: { method: 'POST', path: '/api/remote/peers/{peerId}/disconnect' },
    inputSchema: GENERIC_OBJECT_SCHEMA,
    outputSchema: GENERIC_OBJECT_SCHEMA,
  }),
  methodDescriptor({
    id: 'remote.peers.invoke',
    title: 'Invoke Remote Peer',
    description: 'Invoke a method on a connected remote peer.',
    category: 'remote',
    scopes: ['write:remote'],
    access: 'admin',
    http: { method: 'POST', path: '/api/remote/peers/{peerId}/invoke' },
    inputSchema: GENERIC_OBJECT_SCHEMA,
    outputSchema: GENERIC_OBJECT_SCHEMA,
  }),
  methodDescriptor({
    id: 'remote.work.list',
    title: 'List Remote Work',
    description: 'Return queued and leased remote work items.',
    category: 'remote',
    scopes: ['read:remote'],
    http: { method: 'GET', path: '/api/remote/work' },
    inputSchema: EMPTY_OBJECT_SCHEMA,
    outputSchema: listOutputSchema('work'),
  }),
  methodDescriptor({
    id: 'remote.work.cancel',
    title: 'Cancel Remote Work',
    description: 'Cancel a remote work item.',
    category: 'remote',
    scopes: ['write:remote'],
    access: 'admin',
    http: { method: 'POST', path: '/api/remote/work/{workId}/cancel' },
    inputSchema: GENERIC_OBJECT_SCHEMA,
    outputSchema: GENERIC_OBJECT_SCHEMA,
  }),
  methodDescriptor({
    id: 'remote.node_host.contract',
    title: 'Node Host Contract',
    description: 'Return the distributed node/device host API contract.',
    category: 'remote',
    scopes: ['read:remote'],
    http: { method: 'GET', path: '/api/remote/node-host/contract' },
    inputSchema: EMPTY_OBJECT_SCHEMA,
    outputSchema: entityOutputSchema('contract'),
    metadata: { aliasPaths: ['/api/remote/device/contract'] },
  }),
  methodDescriptor({
    id: 'health.snapshot',
    title: 'Health Snapshot',
    description: 'Return the health integration snapshot.',
    category: 'health',
    scopes: ['read:health'],
    http: { method: 'GET', path: '/api/health' },
    inputSchema: EMPTY_OBJECT_SCHEMA,
    outputSchema: GENERIC_OBJECT_SCHEMA,
  }),
  methodDescriptor({
    id: 'accounts.snapshot',
    title: 'Accounts Snapshot',
    description: 'Return provider and channel account posture.',
    category: 'accounts',
    scopes: ['read:accounts'],
    http: { method: 'GET', path: '/api/accounts' },
    inputSchema: EMPTY_OBJECT_SCHEMA,
    outputSchema: GENERIC_OBJECT_SCHEMA,
  }),
  methodDescriptor({
    id: 'providers.list',
    title: 'Providers List',
    description: 'Return runtime provider metadata, policy hooks, and priced model summaries.',
    category: 'providers',
    scopes: ['read:providers'],
    http: { method: 'GET', path: '/api/providers' },
    inputSchema: EMPTY_OBJECT_SCHEMA,
    outputSchema: listOutputSchema('providers'),
  }),
  methodDescriptor({
    id: 'providers.get',
    title: 'Provider Snapshot',
    description: 'Return runtime metadata for a single provider.',
    category: 'providers',
    scopes: ['read:providers'],
    http: { method: 'GET', path: '/api/providers/{providerId}' },
    inputSchema: objectSchema({ providerId: STRING_SCHEMA }, ['providerId']),
    outputSchema: GENERIC_OBJECT_SCHEMA,
  }),
  methodDescriptor({
    id: 'providers.usage.get',
    title: 'Provider Usage',
    description: 'Return usage and pricing posture for a single provider.',
    category: 'providers',
    scopes: ['read:providers'],
    http: { method: 'GET', path: '/api/providers/{providerId}/usage' },
    inputSchema: objectSchema({ providerId: STRING_SCHEMA }, ['providerId']),
    outputSchema: GENERIC_OBJECT_SCHEMA,
  }),
  methodDescriptor({
    id: 'settings.snapshot',
    title: 'Settings Snapshot',
    description: 'Return the settings integration snapshot.',
    category: 'settings',
    scopes: ['read:settings'],
    http: { method: 'GET', path: '/api/settings' },
    inputSchema: EMPTY_OBJECT_SCHEMA,
    outputSchema: GENERIC_OBJECT_SCHEMA,
  }),
  methodDescriptor({
    id: 'continuity.snapshot',
    title: 'Continuity Snapshot',
    description: 'Return the continuity integration snapshot.',
    category: 'continuity',
    scopes: ['read:continuity'],
    http: { method: 'GET', path: '/api/continuity' },
    inputSchema: EMPTY_OBJECT_SCHEMA,
    outputSchema: GENERIC_OBJECT_SCHEMA,
  }),
  methodDescriptor({
    id: 'worktrees.snapshot',
    title: 'Worktrees Snapshot',
    description: 'Return the worktree integration snapshot.',
    category: 'worktrees',
    scopes: ['read:worktrees'],
    http: { method: 'GET', path: '/api/worktrees' },
    inputSchema: EMPTY_OBJECT_SCHEMA,
    outputSchema: GENERIC_OBJECT_SCHEMA,
  }),
  methodDescriptor({
    id: 'intelligence.snapshot',
    title: 'Intelligence Snapshot',
    description: 'Return the intelligence integration snapshot.',
    category: 'intelligence',
    scopes: ['read:intelligence'],
    http: { method: 'GET', path: '/api/intelligence' },
    inputSchema: EMPTY_OBJECT_SCHEMA,
    outputSchema: GENERIC_OBJECT_SCHEMA,
  }),
  methodDescriptor({
    id: 'memory.doctor',
    title: 'Memory Doctor',
    description: 'Return sqlite-vec and memory embedding-provider diagnostics.',
    category: 'memory',
    scopes: ['read:memory'],
    http: { method: 'GET', path: '/api/memory/doctor' },
    inputSchema: EMPTY_OBJECT_SCHEMA,
    outputSchema: GENERIC_OBJECT_SCHEMA,
  }),
  methodDescriptor({
    id: 'memory.vector.stats',
    title: 'Memory Vector Stats',
    description: 'Return the current sqlite-vec vector-store posture.',
    category: 'memory',
    scopes: ['read:memory'],
    http: { method: 'GET', path: '/api/memory/vector' },
    inputSchema: EMPTY_OBJECT_SCHEMA,
    outputSchema: GENERIC_OBJECT_SCHEMA,
  }),
  methodDescriptor({
    id: 'memory.vector.rebuild',
    title: 'Rebuild Memory Vector Index',
    description: 'Rebuild the sqlite-vec vector index.',
    category: 'memory',
    scopes: ['write:memory'],
    access: 'admin',
    http: { method: 'POST', path: '/api/memory/vector/rebuild' },
    inputSchema: EMPTY_OBJECT_SCHEMA,
    outputSchema: GENERIC_OBJECT_SCHEMA,
  }),
  methodDescriptor({
    id: 'memory.embeddings.default.set',
    title: 'Set Default Memory Embedding Provider',
    description: 'Set the active default memory embedding provider.',
    category: 'memory',
    scopes: ['write:memory'],
    access: 'admin',
    http: { method: 'POST', path: '/api/memory/embeddings/default' },
    inputSchema: bodyEnvelopeSchema({ providerId: STRING_SCHEMA }, ['providerId']),
    outputSchema: GENERIC_OBJECT_SCHEMA,
  }),
  methodDescriptor({
    id: 'voice.status',
    title: 'Voice Status',
    description: 'Return configured voice provider posture and capabilities.',
    category: 'voice',
    scopes: ['read:voice'],
    http: { method: 'GET', path: '/api/voice' },
    inputSchema: EMPTY_OBJECT_SCHEMA,
    outputSchema: GENERIC_OBJECT_SCHEMA,
  }),
  methodDescriptor({
    id: 'voice.providers.list',
    title: 'List Voice Providers',
    description: 'Return registered voice providers.',
    category: 'voice',
    scopes: ['read:voice'],
    http: { method: 'GET', path: '/api/voice/providers' },
    inputSchema: EMPTY_OBJECT_SCHEMA,
    outputSchema: listOutputSchema('providers'),
  }),
  methodDescriptor({
    id: 'voice.voices.list',
    title: 'List Voices',
    description: 'Return registered voices for a voice provider.',
    category: 'voice',
    scopes: ['read:voice'],
    http: { method: 'GET', path: '/api/voice/voices' },
    inputSchema: objectSchema({ providerId: STRING_SCHEMA }),
    outputSchema: listOutputSchema('voices'),
  }),
  methodDescriptor({
    id: 'voice.tts',
    title: 'Run Text To Speech',
    description: 'Synthesize audio through a registered voice provider.',
    category: 'voice',
    scopes: ['write:voice'],
    http: { method: 'POST', path: '/api/voice/tts' },
    inputSchema: bodyEnvelopeSchema({ text: STRING_SCHEMA }, ['text']),
    outputSchema: GENERIC_OBJECT_SCHEMA,
  }),
  methodDescriptor({
    id: 'voice.stt',
    title: 'Run Speech To Text',
    description: 'Transcribe an audio artifact through a registered voice provider.',
    category: 'voice',
    scopes: ['write:voice'],
    http: { method: 'POST', path: '/api/voice/stt' },
    inputSchema: bodyEnvelopeSchema({ audio: GENERIC_OBJECT_SCHEMA }, ['audio']),
    outputSchema: GENERIC_OBJECT_SCHEMA,
  }),
  methodDescriptor({
    id: 'voice.realtime.session',
    title: 'Open Voice Realtime Session',
    description: 'Open a realtime voice session through a registered voice provider.',
    category: 'voice',
    scopes: ['write:voice'],
    http: { method: 'POST', path: '/api/voice/realtime/session' },
    inputSchema: GENERIC_OBJECT_SCHEMA,
    outputSchema: GENERIC_OBJECT_SCHEMA,
  }),
  methodDescriptor({
    id: 'web_search.providers.list',
    title: 'List Web Search Providers',
    description: 'Return registered web search provider capabilities.',
    category: 'web-search',
    scopes: ['read:web-search'],
    http: { method: 'GET', path: '/api/web-search/providers' },
    inputSchema: EMPTY_OBJECT_SCHEMA,
    outputSchema: listOutputSchema('providers'),
  }),
  methodDescriptor({
    id: 'web_search.query',
    title: 'Run Web Search',
    description: 'Execute a provider-backed web search and return normalized ranked results.',
    category: 'web-search',
    scopes: ['write:web-search'],
    http: { method: 'POST', path: '/api/web-search/query' },
    inputSchema: bodyEnvelopeSchema({ query: STRING_SCHEMA }, ['query']),
    outputSchema: GENERIC_OBJECT_SCHEMA,
  }),
  methodDescriptor({
    id: 'artifacts.list',
    title: 'List Artifacts',
    description: 'Return stored artifact metadata for files and attachments.',
    category: 'artifacts',
    scopes: ['read:artifacts'],
    http: { method: 'GET', path: '/api/artifacts' },
    inputSchema: EMPTY_OBJECT_SCHEMA,
    outputSchema: listOutputSchema('artifacts'),
  }),
  methodDescriptor({
    id: 'artifacts.create',
    title: 'Create Artifact',
    description: 'Store a file or attachment artifact for later delivery or analysis.',
    category: 'artifacts',
    scopes: ['write:artifacts'],
    http: { method: 'POST', path: '/api/artifacts' },
    inputSchema: GENERIC_OBJECT_SCHEMA,
    outputSchema: entityOutputSchema('artifact'),
  }),
  methodDescriptor({
    id: 'artifacts.get',
    title: 'Get Artifact',
    description: 'Return metadata for a stored artifact.',
    category: 'artifacts',
    scopes: ['read:artifacts'],
    http: { method: 'GET', path: '/api/artifacts/{artifactId}' },
    inputSchema: objectSchema({ artifactId: STRING_SCHEMA }, ['artifactId']),
    outputSchema: entityOutputSchema('artifact'),
  }),
  methodDescriptor({
    id: 'artifacts.content.get',
    title: 'Get Artifact Content',
    description: 'Return the raw content bytes for a stored artifact.',
    category: 'artifacts',
    scopes: ['read:artifacts'],
    transport: ['http'],
    http: { method: 'GET', path: '/api/artifacts/{artifactId}/content' },
    inputSchema: objectSchema({
      artifactId: STRING_SCHEMA,
      download: STRING_SCHEMA,
    }, ['artifactId']),
    outputSchema: objectSchema({
      contentType: STRING_SCHEMA,
      contentLength: NUMBER_SCHEMA,
    }, ['contentType', 'contentLength']),
    invokable: false,
    metadata: { responseKind: 'binary' },
  }),
  methodDescriptor({
    id: 'media.providers.list',
    title: 'List Media Providers',
    description: 'Return registered media provider capabilities.',
    category: 'media',
    scopes: ['read:media'],
    http: { method: 'GET', path: '/api/media/providers' },
    inputSchema: EMPTY_OBJECT_SCHEMA,
    outputSchema: listOutputSchema('providers'),
  }),
  methodDescriptor({
    id: 'media.analyze',
    title: 'Analyze Media Artifact',
    description: 'Analyze an artifact through a registered media provider.',
    category: 'media',
    scopes: ['write:media'],
    http: { method: 'POST', path: '/api/media/analyze' },
    inputSchema: GENERIC_OBJECT_SCHEMA,
    outputSchema: GENERIC_OBJECT_SCHEMA,
  }),
  methodDescriptor({
    id: 'media.transform',
    title: 'Transform Media Artifact',
    description: 'Transform an artifact through a registered media provider.',
    category: 'media',
    scopes: ['write:media'],
    http: { method: 'POST', path: '/api/media/transform' },
    inputSchema: GENERIC_OBJECT_SCHEMA,
    outputSchema: GENERIC_OBJECT_SCHEMA,
  }),
  methodDescriptor({
    id: 'media.generate',
    title: 'Generate Media Artifact',
    description: 'Generate a media artifact through a registered media provider.',
    category: 'media',
    scopes: ['write:media'],
    http: { method: 'POST', path: '/api/media/generate' },
    inputSchema: GENERIC_OBJECT_SCHEMA,
    outputSchema: GENERIC_OBJECT_SCHEMA,
  }),
  methodDescriptor({
    id: 'local_auth.status',
    title: 'Local Auth Status',
    description: 'Return local auth posture, users, and sessions.',
    category: 'auth',
    scopes: ['read:auth'],
    access: 'admin',
    http: { method: 'GET', path: '/api/local-auth' },
    inputSchema: EMPTY_OBJECT_SCHEMA,
    outputSchema: GENERIC_OBJECT_SCHEMA,
  }),
  methodDescriptor({
    id: 'local_auth.users.create',
    title: 'Create Local Auth User',
    description: 'Create a local auth user.',
    category: 'auth',
    scopes: ['write:auth'],
    access: 'admin',
    http: { method: 'POST', path: '/api/local-auth/users' },
    inputSchema: bodyEnvelopeSchema({
      username: STRING_SCHEMA,
      password: STRING_SCHEMA,
    }, ['username', 'password']),
    outputSchema: entityOutputSchema('user'),
  }),
  methodDescriptor({
    id: 'local_auth.users.delete',
    title: 'Delete Local Auth User',
    description: 'Delete a local auth user.',
    category: 'auth',
    scopes: ['write:auth'],
    access: 'admin',
    http: { method: 'DELETE', path: '/api/local-auth/users/{username}' },
    inputSchema: objectSchema({ username: STRING_SCHEMA }, ['username']),
    outputSchema: GENERIC_OBJECT_SCHEMA,
    dangerous: true,
  }),
  methodDescriptor({
    id: 'local_auth.users.password.rotate',
    title: 'Rotate Local Auth Password',
    description: 'Rotate a local auth user password.',
    category: 'auth',
    scopes: ['write:auth'],
    access: 'admin',
    http: { method: 'POST', path: '/api/local-auth/users/{username}/password' },
    inputSchema: bodyEnvelopeSchema({ password: STRING_SCHEMA }, ['password']),
    outputSchema: GENERIC_OBJECT_SCHEMA,
  }),
  methodDescriptor({
    id: 'local_auth.sessions.delete',
    title: 'Revoke Local Auth Session',
    description: 'Revoke a local auth session.',
    category: 'auth',
    scopes: ['write:auth'],
    access: 'admin',
    http: { method: 'DELETE', path: '/api/local-auth/sessions/{sessionId}' },
    inputSchema: objectSchema({ sessionId: STRING_SCHEMA }, ['sessionId']),
    outputSchema: GENERIC_OBJECT_SCHEMA,
    dangerous: true,
  }),
  methodDescriptor({
    id: 'local_auth.bootstrap.delete',
    title: 'Delete Bootstrap File',
    description: 'Delete the local-auth bootstrap credential file.',
    category: 'auth',
    scopes: ['write:auth'],
    access: 'admin',
    http: { method: 'DELETE', path: '/api/local-auth/bootstrap-file' },
    inputSchema: EMPTY_OBJECT_SCHEMA,
    outputSchema: GENERIC_OBJECT_SCHEMA,
    dangerous: true,
  }),
  methodDescriptor({
    id: 'panels.list',
    title: 'List Panels',
    description: 'Return integration panel descriptors.',
    category: 'panels',
    scopes: ['read:panels'],
    http: { method: 'GET', path: '/api/panels' },
    inputSchema: EMPTY_OBJECT_SCHEMA,
    outputSchema: listOutputSchema('panels'),
  }),
  methodDescriptor({
    id: 'panels.open',
    title: 'Open Panel',
    description: 'Request that a panel be opened in the current TUI session.',
    category: 'panels',
    scopes: ['write:panels'],
    http: { method: 'POST', path: '/api/panels/open' },
    inputSchema: bodyEnvelopeSchema({
      id: STRING_SCHEMA,
      pane: STRING_SCHEMA,
    }, ['id']),
    outputSchema: GENERIC_OBJECT_SCHEMA,
  }),
  methodDescriptor({
    id: 'config.get',
    title: 'Get Config',
    description: 'Return the resolved GoodVibes config snapshot.',
    category: 'config',
    scopes: ['read:config'],
    access: 'admin',
    http: { method: 'GET', path: '/config' },
    inputSchema: EMPTY_OBJECT_SCHEMA,
    outputSchema: GENERIC_OBJECT_SCHEMA,
  }),
  methodDescriptor({
    id: 'config.set',
    title: 'Set Config Value',
    description: 'Set a config value through the daemon API.',
    category: 'config',
    scopes: ['write:config'],
    access: 'admin',
    http: { method: 'POST', path: '/config' },
    inputSchema: bodyEnvelopeSchema({
      key: STRING_SCHEMA,
    }, ['key']),
    outputSchema: GENERIC_OBJECT_SCHEMA,
  }),
];

function normalizeDescriptor(descriptor: GatewayMethodDescriptor): GatewayMethodDescriptor {
  const id = descriptor.id.trim();
  if (!id) throw new Error('Gateway method id is required');
  return {
    ...descriptor,
    id,
    transport: [...new Set(descriptor.transport)],
    scopes: [...new Set(descriptor.scopes)],
    events: descriptor.events ? [...new Set(descriptor.events)] : undefined,
    invokable: descriptor.invokable ?? true,
  };
}

function normalizeEventDescriptor(descriptor: GatewayEventDescriptor): GatewayEventDescriptor {
  const id = descriptor.id.trim();
  if (!id) throw new Error('Gateway event id is required');
  return {
    ...descriptor,
    id,
    transport: [...new Set(descriptor.transport)],
    scopes: [...new Set(descriptor.scopes)],
    domains: descriptor.domains ? [...new Set(descriptor.domains)] : undefined,
    wireEvents: descriptor.wireEvents ? [...new Set(descriptor.wireEvents)] : undefined,
  };
}

function pathMatchesTemplate(template: string, pathname: string): boolean {
  const normalize = (value: string) => value.replace(/\/+$/, '') || '/';
  const templateParts = normalize(template).split('/');
  const pathParts = normalize(pathname).split('/');
  if (templateParts.length !== pathParts.length) return false;
  return templateParts.every((segment, index) => {
    if (segment.startsWith('{') && segment.endsWith('}')) return pathParts[index]!.length > 0;
    return segment === pathParts[index];
  });
}

export class GatewayMethodCatalog {
  private static active: GatewayMethodCatalog | null = null;
  private readonly methods = new Map<string, RegisteredGatewayMethod>();
  private readonly events = new Map<string, RegisteredGatewayEvent>();

  constructor(options: { readonly includeBuiltins?: boolean } = {}) {
    if (options.includeBuiltins !== false) {
      for (const descriptor of BUILTIN_GATEWAY_METHODS) {
        this.register(descriptor, undefined, { replace: true });
      }
      for (const descriptor of BUILTIN_GATEWAY_EVENTS) {
        this.registerEvent(descriptor, { replace: true });
      }
    }
    GatewayMethodCatalog.active = this;
  }

  static getActive(): GatewayMethodCatalog {
    if (!GatewayMethodCatalog.active) {
      GatewayMethodCatalog.active = new GatewayMethodCatalog();
    }
    return GatewayMethodCatalog.active;
  }

  static resetActiveForTesting(): void {
    GatewayMethodCatalog.active = null;
  }

  register(
    descriptor: GatewayMethodDescriptor,
    handler?: GatewayMethodHandler,
    options: { readonly replace?: boolean } = {},
  ): () => void {
    const normalized = normalizeDescriptor(descriptor);
    if (this.methods.has(normalized.id) && !options.replace) {
      throw new Error(`Gateway method already registered: ${normalized.id}`);
    }
    this.methods.set(normalized.id, { descriptor: normalized, handler });
    return () => {
      const current = this.methods.get(normalized.id);
      if (current && current.descriptor.pluginId === normalized.pluginId && current.descriptor.source === normalized.source) {
        this.unregister(normalized.id);
      }
    };
  }

  registerEvent(
    descriptor: GatewayEventDescriptor,
    options: { readonly replace?: boolean } = {},
  ): () => void {
    const normalized = normalizeEventDescriptor(descriptor);
    if (this.events.has(normalized.id) && !options.replace) {
      throw new Error(`Gateway event already registered: ${normalized.id}`);
    }
    this.events.set(normalized.id, { descriptor: normalized });
    return () => {
      const current = this.events.get(normalized.id);
      if (current && current.descriptor.pluginId === normalized.pluginId && current.descriptor.source === normalized.source) {
        this.unregisterEvent(normalized.id);
      }
    };
  }

  unregister(id: string): boolean {
    return this.methods.delete(id);
  }

  unregisterEvent(id: string): boolean {
    return this.events.delete(id);
  }

  clearPluginMethods(pluginId: string): void {
    for (const [id, entry] of this.methods.entries()) {
      if (entry.descriptor.pluginId === pluginId) {
        this.methods.delete(id);
      }
    }
    for (const [id, entry] of this.events.entries()) {
      if (entry.descriptor.pluginId === pluginId) {
        this.events.delete(id);
      }
    }
  }

  list(options: GatewayMethodListOptions = {}): GatewayMethodDescriptor[] {
    return [...this.methods.values()]
      .map((entry) => entry.descriptor)
      .filter((descriptor) => !options.category || descriptor.category === options.category)
      .filter((descriptor) => !options.source || descriptor.source === options.source)
      .filter((descriptor) => !options.pluginId || descriptor.pluginId === options.pluginId)
      .sort((a, b) => a.category.localeCompare(b.category) || a.id.localeCompare(b.id));
  }

  listEvents(options: GatewayEventListOptions = {}): GatewayEventDescriptor[] {
    return [...this.events.values()]
      .map((entry) => entry.descriptor)
      .filter((descriptor) => !options.category || descriptor.category === options.category)
      .filter((descriptor) => !options.source || descriptor.source === options.source)
      .filter((descriptor) => !options.pluginId || descriptor.pluginId === options.pluginId)
      .filter((descriptor) => !options.domain || descriptor.domains?.includes(options.domain))
      .sort((a, b) => a.category.localeCompare(b.category) || a.id.localeCompare(b.id));
  }

  get(id: string): GatewayMethodDescriptor | null {
    return this.methods.get(id)?.descriptor ?? null;
  }

  getEvent(id: string): GatewayEventDescriptor | null {
    return this.events.get(id)?.descriptor ?? null;
  }

  hasHandler(id: string): boolean {
    return typeof this.methods.get(id)?.handler === 'function';
  }

  findByHttpBinding(method: string, pathname: string): GatewayMethodDescriptor | null {
    const normalizedMethod = method.toUpperCase();
    for (const entry of this.methods.values()) {
      const binding = entry.descriptor.http;
      if (!binding || binding.method !== normalizedMethod) continue;
      if (pathMatchesTemplate(binding.path, pathname)) return entry.descriptor;
      const aliasPaths = Array.isArray(entry.descriptor.metadata?.aliasPaths)
        ? entry.descriptor.metadata.aliasPaths.filter((value): value is string => typeof value === 'string')
        : [];
      if (aliasPaths.some((candidate) => pathMatchesTemplate(candidate, pathname))) return entry.descriptor;
    }
    return null;
  }

  getAllScopes(options: { readonly includeWrite?: boolean } = {}): string[] {
    const scopes = new Set<string>();
    for (const descriptor of this.methods.values()) {
      for (const scope of descriptor.descriptor.scopes) {
        if (!options.includeWrite && !scope.startsWith('read:')) continue;
        scopes.add(scope);
      }
    }
    for (const descriptor of this.events.values()) {
      for (const scope of descriptor.descriptor.scopes) {
        if (!options.includeWrite && !scope.startsWith('read:')) continue;
        scopes.add(scope);
      }
    }
    return [...scopes].sort();
  }

  async invoke(id: string, invocation: GatewayMethodInvocation): Promise<unknown> {
    const entry = this.methods.get(id);
    if (!entry) throw new Error(`Unknown gateway method: ${id}`);
    if (!entry.handler) throw new Error(`Gateway method has no internal handler: ${id}`);
    return entry.handler(invocation);
  }
}

export function getGatewayMethodCatalog(): GatewayMethodCatalog {
  return GatewayMethodCatalog.getActive();
}
