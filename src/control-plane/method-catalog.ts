export type GatewayMethodTransport = 'http' | 'ws' | 'internal';
export type GatewayMethodSource = 'builtin' | 'plugin';
export type GatewayMethodAccess = 'authenticated' | 'admin' | 'remote-peer';

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
  readonly metadata?: Record<string, unknown>;
}

export interface GatewayMethodInvocationContext {
  readonly principalId?: string;
  readonly principalKind?: 'user' | 'bot' | 'service' | 'token' | 'remote-peer';
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

export interface GatewayMethodListOptions {
  readonly category?: string;
  readonly source?: GatewayMethodSource;
  readonly pluginId?: string;
}

const BUILTIN_GATEWAY_METHODS: readonly GatewayMethodDescriptor[] = [
  {
    id: 'control.status',
    title: 'Daemon Status',
    description: 'Return daemon status and version.',
    category: 'control-plane',
    source: 'builtin',
    access: 'authenticated',
    transport: ['http', 'ws'],
    scopes: ['read:control-plane'],
    http: { method: 'GET', path: '/status' },
  },
  {
    id: 'control.snapshot',
    title: 'Control-Plane Snapshot',
    description: 'Return the current control-plane gateway snapshot.',
    category: 'control-plane',
    source: 'builtin',
    access: 'authenticated',
    transport: ['http', 'ws'],
    scopes: ['read:control-plane'],
    http: { method: 'GET', path: '/api/control-plane' },
    events: ['control-plane'],
  },
  {
    id: 'control.methods.list',
    title: 'List Gateway Methods',
    description: 'Return the gateway method catalog.',
    category: 'control-plane',
    source: 'builtin',
    access: 'authenticated',
    transport: ['http', 'ws'],
    scopes: ['read:control-plane'],
    http: { method: 'GET', path: '/api/control-plane/methods' },
  },
  {
    id: 'sessions.list',
    title: 'List Shared Sessions',
    description: 'Return shared-session integration state.',
    category: 'sessions',
    source: 'builtin',
    access: 'authenticated',
    transport: ['http', 'ws'],
    scopes: ['read:sessions'],
    http: { method: 'GET', path: '/api/session' },
  },
  {
    id: 'sessions.create',
    title: 'Create Shared Session',
    description: 'Create a shared session for a surface, route, or web client.',
    category: 'sessions',
    source: 'builtin',
    access: 'authenticated',
    transport: ['http', 'ws'],
    scopes: ['write:sessions'],
    http: { method: 'POST', path: '/api/sessions' },
  },
  {
    id: 'tasks.create',
    title: 'Create Task',
    description: 'Submit a task to the daemon or a shared session.',
    category: 'tasks',
    source: 'builtin',
    access: 'authenticated',
    transport: ['http', 'ws'],
    scopes: ['write:tasks'],
    http: { method: 'POST', path: '/task' },
  },
  {
    id: 'automation.jobs.list',
    title: 'List Automation Jobs',
    description: 'Return automation jobs and recent runs.',
    category: 'automation',
    source: 'builtin',
    access: 'authenticated',
    transport: ['http', 'ws'],
    scopes: ['read:automation'],
    http: { method: 'GET', path: '/api/automation/jobs' },
    events: ['automation'],
  },
  {
    id: 'automation.jobs.create',
    title: 'Create Automation Job',
    description: 'Create a durable automation job.',
    category: 'automation',
    source: 'builtin',
    access: 'authenticated',
    transport: ['http', 'ws'],
    scopes: ['write:automation'],
    http: { method: 'POST', path: '/api/automation/jobs' },
    events: ['automation'],
  },
  {
    id: 'automation.runs.list',
    title: 'List Automation Runs',
    description: 'Return automation run history.',
    category: 'automation',
    source: 'builtin',
    access: 'authenticated',
    transport: ['http', 'ws'],
    scopes: ['read:automation'],
    http: { method: 'GET', path: '/api/automation/runs' },
  },
  {
    id: 'automation.heartbeat',
    title: 'Run Automation Heartbeat',
    description: 'Process automation jobs queued for the next heartbeat.',
    category: 'automation',
    source: 'builtin',
    access: 'authenticated',
    transport: ['http', 'ws'],
    scopes: ['write:automation'],
    http: { method: 'POST', path: '/api/automation/heartbeat' },
    events: ['automation'],
  },
  {
    id: 'channels.status',
    title: 'Channel Status',
    description: 'Return status for channel plugins and provider-backed channels.',
    category: 'channels',
    source: 'builtin',
    access: 'authenticated',
    transport: ['http', 'ws'],
    scopes: ['read:channels'],
    http: { method: 'GET', path: '/api/channels/status' },
  },
  {
    id: 'channels.accounts.list',
    title: 'List Channel Accounts',
    description: 'Return channel account lifecycle posture.',
    category: 'channels',
    source: 'builtin',
    access: 'authenticated',
    transport: ['http', 'ws'],
    scopes: ['read:channels'],
    http: { method: 'GET', path: '/api/channels/accounts' },
  },
  {
    id: 'channels.policies.list',
    title: 'List Channel Policies',
    description: 'Return ingress policy configuration for channels.',
    category: 'channels',
    source: 'builtin',
    access: 'authenticated',
    transport: ['http', 'ws'],
    scopes: ['read:channels'],
    http: { method: 'GET', path: '/api/channels/policies' },
  },
  {
    id: 'voice.status',
    title: 'Voice Status',
    description: 'Return configured voice provider posture and capabilities.',
    category: 'voice',
    source: 'builtin',
    access: 'authenticated',
    transport: ['http', 'ws'],
    scopes: ['read:voice'],
    http: { method: 'GET', path: '/api/voice' },
  },
  {
    id: 'media.providers.list',
    title: 'List Media Providers',
    description: 'Return registered media provider capabilities.',
    category: 'media',
    source: 'builtin',
    access: 'authenticated',
    transport: ['http', 'ws'],
    scopes: ['read:media'],
    http: { method: 'GET', path: '/api/media/providers' },
  },
  {
    id: 'memory.doctor',
    title: 'Memory Doctor',
    description: 'Return sqlite-vec and memory embedding-provider diagnostics.',
    category: 'memory',
    source: 'builtin',
    access: 'authenticated',
    transport: ['http', 'ws'],
    scopes: ['read:memory'],
    http: { method: 'GET', path: '/api/memory/doctor' },
  },
  {
    id: 'remote.snapshot',
    title: 'Remote Runtime Snapshot',
    description: 'Return distributed node/device runtime state.',
    category: 'remote',
    source: 'builtin',
    access: 'authenticated',
    transport: ['http', 'ws'],
    scopes: ['read:remote'],
    http: { method: 'GET', path: '/api/remote' },
    events: ['remote'],
  },
  {
    id: 'remote.node_host.contract',
    title: 'Node Host Contract',
    description: 'Return the distributed node/device host API contract.',
    category: 'remote',
    source: 'builtin',
    access: 'authenticated',
    transport: ['http', 'ws'],
    scopes: ['read:remote'],
    http: { method: 'GET', path: '/api/remote/node-host/contract' },
  },
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
  };
}

export class GatewayMethodCatalog {
  private static active: GatewayMethodCatalog | null = null;
  private readonly methods = new Map<string, RegisteredGatewayMethod>();

  constructor(options: { readonly includeBuiltins?: boolean } = {}) {
    if (options.includeBuiltins !== false) {
      for (const descriptor of BUILTIN_GATEWAY_METHODS) {
        this.register(descriptor, undefined, { replace: true });
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

  unregister(id: string): boolean {
    return this.methods.delete(id);
  }

  clearPluginMethods(pluginId: string): void {
    for (const [id, entry] of this.methods.entries()) {
      if (entry.descriptor.pluginId === pluginId) {
        this.methods.delete(id);
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

  get(id: string): GatewayMethodDescriptor | null {
    return this.methods.get(id)?.descriptor ?? null;
  }

  hasHandler(id: string): boolean {
    return typeof this.methods.get(id)?.handler === 'function';
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
