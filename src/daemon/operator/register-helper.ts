import type {
  GatewayMethodAccess,
  GatewayMethodDescriptor,
  GatewayMethodInvocation,
  GatewayMethodSource,
  GatewayMethodTransport,
} from '@pellux/goodvibes-sdk/platform/control-plane';
import type {
  CatalogMethodDescriptor,
  OperatorAccess,
  OperatorContext,
  OperatorHandler,
  OperatorInvocation,
  OperatorMethodDescriptor,
  OperatorTransport,
  Unregister,
} from './types.ts';
import { OperatorError, REQUIRE_CONFIRM } from './types.ts';

const CATALOG_TRANSPORTS = new Set<GatewayMethodTransport>(['http', 'ws', 'internal']);

function mapAccess(access: OperatorAccess): GatewayMethodAccess {
  // The SDK has no 'operator' access tier; map it to 'admin'.
  return access === 'operator' ? 'admin' : access;
}

function mapSource(source: string | undefined, pluginId: string | undefined): GatewayMethodSource {
  // The SDK accepts only 'builtin' | 'plugin'. Daemon-owned methods register as
  // 'builtin' unless they carry a pluginId.
  if (source === 'plugin' || pluginId !== undefined) return 'plugin';
  return 'builtin';
}

function mapTransport(transport: OperatorTransport[] | undefined): GatewayMethodTransport[] {
  const candidates = transport ?? ['ws', 'internal'];
  return candidates.filter((t): t is GatewayMethodTransport => CATALOG_TRANSPORTS.has(t as GatewayMethodTransport));
}

function toCatalogDescriptor(descriptor: OperatorMethodDescriptor): CatalogMethodDescriptor {
  // Strip non-catalog fields (effect, confirm). Only the SDK-recognized fields
  // are forwarded to catalog.register().
  return {
    id: descriptor.id,
    title: descriptor.title,
    description: descriptor.description,
    category: descriptor.category,
    source: mapSource(descriptor.source, descriptor.pluginId),
    access: mapAccess(descriptor.access),
    transport: mapTransport(descriptor.transport),
    scopes: descriptor.scopes,
    ...(descriptor.pluginId !== undefined ? { pluginId: descriptor.pluginId } : {}),
    ...(descriptor.inputSchema !== undefined ? { inputSchema: descriptor.inputSchema } : {}),
    ...(descriptor.outputSchema !== undefined ? { outputSchema: descriptor.outputSchema } : {}),
  };
}

function hasConfirmFlag(body: unknown): boolean {
  return (
    typeof body === 'object'
    && body !== null
    && (body as { confirm?: unknown }).confirm === true
  );
}

function explicitUserRequestFlag(metadata: Record<string, unknown> | undefined): boolean {
  return metadata?.explicitUserRequest === true;
}

/**
 * Assert that an invocation carries an explicit, confirmed user request.
 * Throws OperatorError(REQUIRE_CONFIRM, 403) when not confirmed.
 */
export function assertConfirmed(input: {
  body: unknown;
  context: { explicitUserRequest?: boolean };
}): void {
  if (!hasConfirmFlag(input.body) || input.context.explicitUserRequest !== true) {
    throw new OperatorError(
      'This operation requires explicit user confirmation.',
      REQUIRE_CONFIRM,
      403,
    );
  }
}

/**
 * Declare one operator method: applies defaults, wraps the handler with a
 * confirm-guard + error mapping, and registers it against the real catalog.
 * Returns the catalog's unregister function.
 */
export function declareOperatorMethod<TBody, TResult>(
  ctx: OperatorContext,
  descriptor: OperatorMethodDescriptor,
  handler: OperatorHandler<TBody, TResult>,
): Unregister {
  const catalogDescriptor = toCatalogDescriptor(descriptor);
  const requiresConfirm = descriptor.confirm === true;

  const wrappedHandler = async (input: GatewayMethodInvocation): Promise<unknown> => {
    // Normalize the SDK invocation context into the operator-facing shape.
    const explicitUserRequest = explicitUserRequestFlag(input.context.metadata);
    const operatorContext = {
      principalId: input.context.principalId ?? '',
      explicitUserRequest,
    };
    try {
      if (requiresConfirm) {
        assertConfirmed({ body: input.body, context: operatorContext });
      }
      const invocation: OperatorInvocation<TBody> = {
        body: input.body as TBody,
        context: operatorContext,
      };
      return await handler(invocation);
    } catch (error) {
      if (error instanceof OperatorError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      throw new OperatorError(message, 'OPERATOR_HANDLER_FAILED', 500);
    }
  };

  // CatalogMethodDescriptor is structurally a GatewayMethodDescriptor.
  return ctx.catalog.register(catalogDescriptor as GatewayMethodDescriptor, wrappedHandler);
}

/**
 * Register many methods at once. Returns a single Unregister that tears them all
 * down (invoking each individual unregister fn in reverse registration order).
 */
export function declareOperatorMethods(
  ctx: OperatorContext,
  entries: Array<{
    descriptor: OperatorMethodDescriptor;
    handler: OperatorHandler<unknown, unknown>;
  }>,
): Unregister {
  const unregisters: Unregister[] = [];
  for (const entry of entries) {
    unregisters.push(declareOperatorMethod(ctx, entry.descriptor, entry.handler));
  }
  return () => {
    for (let i = unregisters.length - 1; i >= 0; i -= 1) {
      try {
        unregisters[i]?.();
      } catch {
        // Best-effort teardown: continue unregistering the rest.
      }
    }
  };
}
