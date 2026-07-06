/**
 * Linchpin helper that binds a typed host handler to an SDK-registered gateway
 * method descriptor BY ID.
 *
 * The SDK's `GatewayMethodCatalog` constructor auto-registers every builtin
 * descriptor (channels.* / email.* / calendar.* / ...) with `handler:undefined`.
 * The host attaches its implementation by looking up that canonical descriptor
 * via `catalog.get(id)` and re-registering it WITH the handler using
 * `{ replace: true }`. Only the handler slot changes; the SDK's id, schema,
 * access, scopes, and dangerous flags are preserved verbatim. No descriptor or
 * schema is ever authored here.
 */
import type {
  GatewayMethodCatalog,
  GatewayMethodInvocation,
  GatewayMethodInvocationContext,
} from './contracts.ts';
import { HandlerError, REQUIRE_CONFIRM } from './errors.ts';

/** Function returned by every registration; calling it removes the attached handler. */
export type Unregister = () => void;

/** Normalized, host-facing principal/auth context derived from the SDK invocation. */
export interface HandlerContextEnvelope {
  readonly principalId: string;
  readonly admin: boolean;
  readonly scopes: string[];
  readonly explicitUserRequest: boolean;
  readonly authToken: string;
}

/** Typed, host-facing shape of a single method invocation. */
export interface HandlerInvocation<TBody> {
  readonly body: TBody;
  readonly query: Record<string, string>;
  readonly context: HandlerContextEnvelope;
}

/** A host handler: receives the typed invocation, returns the method result. */
export type TypedHandler<TBody, TResult> = (
  input: HandlerInvocation<TBody>,
) => Promise<TResult>;

export interface RegisterHandlerOptions {
  /**
   * When true, the wrapper enforces a confirmation gate before the handler
   * runs: `body.confirm === true` AND `context.explicitUserRequest === true`.
   */
  readonly confirm?: boolean;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * Derive the host-facing context envelope from the raw SDK invocation context.
 * `explicitUserRequest` is carried in `context.metadata.explicitUserRequest`.
 */
export function normalizeContext(c: GatewayMethodInvocationContext): HandlerContextEnvelope {
  const metadata = c.metadata ?? {};
  return {
    principalId: c.principalId ?? '',
    admin: c.admin === true,
    scopes: c.scopes ? [...c.scopes] : [],
    explicitUserRequest: metadata.explicitUserRequest === true,
    authToken: c.authToken ?? '',
  };
}

function normalizeQuery(query: GatewayMethodInvocation['query']): Record<string, string> {
  const out: Record<string, string> = {};
  if (!query) return out;
  for (const [key, value] of Object.entries(query)) {
    if (typeof value === 'string') out[key] = value;
    else if (value != null) out[key] = String(value);
  }
  return out;
}

/**
 * Guard a confirmation-gated mutation. Throws `HandlerError(REQUIRE_CONFIRM, 403)`
 * unless the caller both set `body.confirm === true` and the request was an
 * explicit user request.
 */
export function assertConfirmed(
  body: unknown,
  ctx: { readonly explicitUserRequest: boolean },
): void {
  const confirmed =
    typeof body === 'object'
    && body !== null
    && (body as { confirm?: unknown }).confirm === true;
  if (!confirmed || ctx.explicitUserRequest !== true) {
    throw new HandlerError('explicit user confirmation required', REQUIRE_CONFIRM, 403);
  }
}

/**
 * Attach a typed handler to the SDK-registered descriptor identified by
 * `methodId`. Reuses the descriptor the catalog already holds and re-registers
 * it with the wrapped handler via `{ replace: true }`, flipping the builtin
 * method from HTTP-fallback to in-process execution.
 */
export function registerCatalogHandler<TBody, TResult>(
  catalog: GatewayMethodCatalog,
  methodId: string,
  handler: TypedHandler<TBody, TResult>,
  options?: RegisterHandlerOptions,
): Unregister {
  const descriptor = catalog.get(methodId);
  if (!descriptor) {
    // 'METHOD_NOT_FOUND' (not the old locally-coined 'UNKNOWN_METHOD') so this lines
    // up byte-for-byte with SDKErrorCodes.METHOD_NOT_FOUND — the code the SDK's own
    // uncataloged-method 404 now carries (method-catalog.ts's GatewayMethodCatalog
    // .invoke(), daemon/control-plane.ts's invokeGatewayMethodCall, and daemon-sdk's
    // control-routes.ts getGatewayMethod/invokeGatewayMethod). A literal string, not
    // an import of SDKErrorCodes: the pinned SDK (0.38.0) predates that constant, and
    // matching the value this way needs no SDK version bump to stay aligned.
    throw new HandlerError(`Unknown gateway method: ${methodId}`, 'METHOD_NOT_FOUND', 404);
  }

  const wrapped = async (inv: GatewayMethodInvocation): Promise<unknown> => {
    const context = normalizeContext(inv.context);
    const body = inv.body as TBody;
    if (options?.confirm) assertConfirmed(inv.body, context);
    try {
      return await handler({ body, query: normalizeQuery(inv.query), context });
    } catch (error) {
      if (error instanceof HandlerError) throw error;
      throw new HandlerError(errorMessage(error), 'HANDLER_FAILED', 500);
    }
  };

  return catalog.register(descriptor, wrapped, { replace: true });
}

/** A single id→handler binding for batch registration. */
export interface CatalogHandlerEntry {
  readonly id: string;
  readonly handler: TypedHandler<unknown, unknown>;
  readonly options?: RegisterHandlerOptions;
}

/**
 * Register many handlers at once. Returns a single `Unregister` that tears them
 * down in REVERSE registration order (best-effort: a failing teardown never
 * aborts the rest).
 */
export function registerCatalogHandlers(
  catalog: GatewayMethodCatalog,
  entries: readonly CatalogHandlerEntry[],
): Unregister {
  const teardowns: Unregister[] = [];
  for (const entry of entries) {
    teardowns.push(registerCatalogHandler(catalog, entry.id, entry.handler, entry.options));
  }
  return () => {
    for (let i = teardowns.length - 1; i >= 0; i -= 1) {
      try {
        teardowns[i]!();
      } catch {
        // best-effort teardown; continue unwinding the rest
      }
    }
  };
}
