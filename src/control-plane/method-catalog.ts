import {
  builtinGatewayAdminMethodDescriptors,
} from './method-catalog-admin.ts';
import {
  builtinGatewayChannelMethodDescriptors,
} from './method-catalog-channels.ts';
import {
  builtinGatewayControlMethodDescriptors,
} from './method-catalog-control.ts';
import {
  builtinGatewayEventDescriptors,
} from './method-catalog-events.ts';
import {
  builtinGatewayKnowledgeMethodDescriptors,
} from './method-catalog-knowledge.ts';
import type {
  GatewayEventDescriptor,
  GatewayEventListOptions,
  GatewayMethodDescriptor,
  GatewayMethodHandler,
  GatewayMethodInvocation,
  GatewayMethodListOptions,
} from './method-catalog-shared.ts';
import {
  builtinGatewayRuntimeMethodDescriptors,
} from './method-catalog-runtime.ts';

export type {
  GatewayEventDescriptor,
  GatewayEventListOptions,
  GatewayEventTransport,
  GatewayHttpBinding,
  GatewayMethodAccess,
  GatewayMethodDescriptor,
  GatewayMethodHandler,
  GatewayMethodInvocation,
  GatewayMethodInvocationContext,
  GatewayMethodListOptions,
  GatewayMethodSource,
  GatewayMethodTransport,
} from './method-catalog-shared.ts';

interface RegisteredGatewayMethod {
  readonly descriptor: GatewayMethodDescriptor;
  readonly handler?: GatewayMethodHandler;
}

interface RegisteredGatewayEvent {
  readonly descriptor: GatewayEventDescriptor;
}

const BUILTIN_GATEWAY_EVENTS: readonly GatewayEventDescriptor[] = builtinGatewayEventDescriptors;

const BUILTIN_GATEWAY_METHODS: readonly GatewayMethodDescriptor[] = [
  ...builtinGatewayControlMethodDescriptors,
  ...builtinGatewayChannelMethodDescriptors,
  ...builtinGatewayRuntimeMethodDescriptors,
  ...builtinGatewayKnowledgeMethodDescriptors,
  ...builtinGatewayAdminMethodDescriptors,
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
