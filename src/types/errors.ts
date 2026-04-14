/** HTTP status codes that indicate transient failures eligible for retry. Single source of truth. */
export const RETRYABLE_STATUS_CODES: readonly number[] = [429, 500, 503];

export type ErrorCategory =
  | 'authentication'
  | 'authorization'
  | 'billing'
  | 'rate_limit'
  | 'timeout'
  | 'network'
  | 'bad_request'
  | 'not_found'
  | 'permission'
  | 'tool'
  | 'config'
  | 'protocol'
  | 'service'
  | 'internal'
  | 'unknown';

export type ErrorSource =
  | 'provider'
  | 'tool'
  | 'transport'
  | 'config'
  | 'permission'
  | 'runtime'
  | 'render'
  | 'acp'
  | 'unknown';

export interface AppErrorOptions {
  readonly statusCode?: number;
  readonly category?: ErrorCategory;
  readonly guidance?: string;
  readonly detail?: string;
  readonly source?: ErrorSource;
  readonly provider?: string;
  readonly operation?: string;
  readonly phase?: string;
  readonly requestId?: string;
  readonly providerCode?: string;
  readonly providerType?: string;
  readonly retryAfterMs?: number;
  readonly rawMessage?: string;
}

export interface ProviderErrorOptions extends AppErrorOptions {
  readonly statusCode?: number;
}

function inferErrorCategory(message: string, statusCode?: number): ErrorCategory {
  const msg = message.toLowerCase();

  if (statusCode === 401) return 'authentication';
  if (statusCode === 402) return 'billing';
  if (statusCode === 403) return 'authorization';
  if (statusCode === 404) return 'not_found';
  if (statusCode === 408) return 'timeout';
  if (statusCode === 429) return 'rate_limit';
  if (statusCode === 400) return 'bad_request';
  if (statusCode !== undefined && statusCode >= 500) return 'service';

  if (/api[_\s-]?key|auth|token|credential|jwt|unauthoriz/.test(msg)) return 'authentication';
  if (/forbidden|access denied|not allowed|permission denied/.test(msg)) return 'authorization';
  if (/payment required|billing|credit|credits|quota|insufficient balance|depleted/.test(msg)) return 'billing';
  if (/rate.limit|too many requests|throttl/.test(msg)) return 'rate_limit';
  if (/timed?[\s_-]?out|etimedout|timeout|deadline exceeded/.test(msg)) return 'timeout';
  if (/econnrefused|enotfound|ehostunreach|econnreset|socket hang up|fetch failed|dns|tls|ssl|certificate/.test(msg)) return 'network';
  if (/not found|unknown model|no such model|unknown endpoint|unsupported model/.test(msg)) return 'not_found';
  if (/invalid request|bad request|invalid argument|malformed|schema|unsupported parameter/.test(msg)) return 'bad_request';
  if (/invalid json|parse|no response body|stream ended|unexpected eof|malformed response/.test(msg)) return 'protocol';

  return 'unknown';
}

function inferProviderGuidance(category: ErrorCategory, statusCode?: number): string | undefined {
  switch (category) {
    case 'rate_limit':
      return 'The provider rate limited this request. GoodVibes will retry automatically when the caller supports retries. If this keeps happening, wait, reduce request volume, or switch models/providers.';
    case 'authentication':
      return 'The provider rejected authentication. Possible causes include invalid or expired credentials, missing account/session state, account restrictions, or the wrong provider/endpoint receiving the request.';
    case 'authorization':
      return 'The provider rejected the request after authentication. Possible causes include missing model access, account permissions, policy restrictions, or provider routing to a service that does not expose this model.';
    case 'billing':
      return 'The provider reported a billing or quota problem. Check credits, subscription status, usage limits, or account entitlements.';
    case 'timeout':
      return 'The request timed out before the provider finished responding. Check network stability, provider latency, and request size.';
    case 'network':
      return 'The request did not complete over the network. Check connectivity, DNS, TLS certificates, base URL, or any local proxy/tunnel.';
    case 'bad_request':
      return 'The provider rejected the request shape. Check model id, parameters, message format, and tool schema.';
    case 'not_found':
      return 'The requested model or endpoint was not found. Check model id, provider selection, and API path.';
    case 'protocol':
      return 'The provider response was incomplete or malformed. Check upstream compatibility, streaming mode, and transport stability.';
    case 'service':
      return statusCode === 503
        ? 'The provider is temporarily unavailable. Retry shortly or switch providers if the issue persists.'
        : 'The provider returned a server-side failure. Retry shortly or switch providers if the issue persists.';
    default:
      return undefined;
  }
}

function inferRetryAfterMs(message: string, statusCode?: number, explicitRetryAfterMs?: number): number | undefined {
  if (explicitRetryAfterMs !== undefined) return explicitRetryAfterMs;
  if (statusCode !== 429) return undefined;
  const match = message.match(/retry[-_\s]?after[:=\s]+(\d+)/i);
  if (!match) return undefined;
  return parseInt(match[1], 10) * 1000;
}

/** Base class for all application errors. Provides a machine-readable code and recoverability hint. */
export class AppError extends Error {
  public readonly statusCode?: number;
  public readonly category?: ErrorCategory;
  public readonly guidance?: string;
  public readonly detail?: string;
  public readonly source?: ErrorSource;
  public readonly provider?: string;
  public readonly operation?: string;
  public readonly phase?: string;
  public readonly requestId?: string;
  public readonly providerCode?: string;
  public readonly providerType?: string;
  public readonly retryAfterMs?: number;
  public readonly rawMessage?: string;

  constructor(
    message: string,
    public readonly code: string,
    public readonly recoverable: boolean,
    options: AppErrorOptions = {},
  ) {
    super(message);
    this.name = this.constructor.name;
    this.statusCode = options.statusCode;
    this.category = options.category;
    this.guidance = options.guidance;
    this.detail = options.detail;
    this.source = options.source;
    this.provider = options.provider;
    this.operation = options.operation;
    this.phase = options.phase;
    this.requestId = options.requestId;
    this.providerCode = options.providerCode;
    this.providerType = options.providerType;
    this.retryAfterMs = options.retryAfterMs;
    this.rawMessage = options.rawMessage;
  }
}

/** Thrown when configuration is invalid or cannot be loaded. Non-recoverable. */
export class ConfigError extends AppError {
  constructor(message: string) {
    super(message, 'CONFIG_ERROR', false, {
      category: 'config',
      source: 'config',
    });
  }
}

/** Thrown when an LLM provider API call fails. Recoverable when statusCode is in RETRYABLE_STATUS_CODES. */
export class ProviderError extends AppError {
  constructor(message: string, statusCode?: number);
  constructor(message: string, options?: ProviderErrorOptions);
  constructor(message: string, statusCodeOrOptions?: number | ProviderErrorOptions, maybeOptions: ProviderErrorOptions = {}) {
    const options = typeof statusCodeOrOptions === 'number'
      ? { ...maybeOptions, statusCode: statusCodeOrOptions }
      : (statusCodeOrOptions ?? {});
    const statusCode = options.statusCode;
    const category = options.category ?? inferErrorCategory(message, statusCode);
    const retryAfterMs = inferRetryAfterMs(message, statusCode, options.retryAfterMs);
    const guidance = options.guidance ?? inferProviderGuidance(category, statusCode);

    super(message, 'PROVIDER_ERROR', statusCode !== undefined && RETRYABLE_STATUS_CODES.includes(statusCode), {
      ...options,
      statusCode,
      category,
      guidance,
      retryAfterMs,
      source: options.source ?? 'provider',
      rawMessage: options.rawMessage ?? message,
    });
  }
}

/** Thrown when a tool execution fails. Recoverable by default. */
export class ToolError extends AppError {
  constructor(message: string, public readonly toolName: string) {
    super(message, 'TOOL_ERROR', true, {
      category: 'tool',
      source: 'tool',
    });
  }
}

/** Thrown for ACP (Agent Control Protocol) errors. Recoverable by default. */
export class AcpError extends AppError {
  constructor(message: string) {
    super(message, 'ACP_ERROR', true, {
      source: 'acp',
    });
  }
}

/** Thrown when an operation is denied due to insufficient permissions. Non-recoverable. */
export class PermissionError extends AppError {
  constructor(message: string) {
    super(message, 'PERMISSION_DENIED', false, {
      category: 'permission',
      source: 'permission',
    });
  }
}

/** Thrown when the renderer encounters a failure. Recoverable by default. */
export class RenderError extends AppError {
  constructor(message: string) {
    super(message, 'RENDER_ERROR', true, {
      source: 'render',
    });
  }
}

/**
 * Returns true when the error indicates a rate limit or quota exhaustion.
 * Used by SyntheticProvider and AgentOrchestrator to decide whether to
 * back-off and retry vs. escalate the error.
 */
export function isRateLimitOrQuotaError(err: unknown): boolean {
  if (err instanceof ProviderError) {
    if (err.statusCode === 429 || err.statusCode === 402) return true;
    const msg = err.message.toLowerCase();
    return /rate.limit|too many requests|quota exceeded|throttl|depleted|credits/.test(msg);
  }
  if (err instanceof Error) {
    const msg = err.message.toLowerCase();
    return msg.includes('429') || msg.includes('402') || /rate.limit|too many requests|quota exceeded|depleted|credits/.test(msg);
  }
  return false;
}

/**
 * Returns true when the error indicates the model's context window was exceeded.
 * Covers OpenAI, Anthropic, and generic provider error messages.
 */
export function isContextSizeExceededError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  return (
    msg.includes('context_length_exceeded') ||
    msg.includes('context length exceeded') ||
    msg.includes('context size exceeded') ||
    msg.includes('context window exceeded') ||
    msg.includes('maximum context length') ||
    msg.includes('prompt is too long') ||
    msg.includes('input too long') ||
    msg.includes('tokens exceed') ||
    msg.includes('exceeds the model') ||
    (msg.includes('context') && msg.includes('exceed'))
  );
}

/**
 * Returns true when the error indicates the provider is non-transient
 * (auth failures, connection refused, host not found, timeout).
 * 500/503 are deliberately excluded — server errors are transient and
 * eligible for retry. Only permanent auth/billing failures are flagged here.
 * Used to trigger graceful degradation / alternative model suggestions.
 */
export function isNonTransientProviderFailure(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err instanceof ProviderError) {
    const NON_TRANSIENT_CODES = new Set([401, 402, 403]);
    if (err.statusCode !== undefined && NON_TRANSIENT_CODES.has(err.statusCode)) return true;
  }
  const msg = err.message.toLowerCase();
  return msg.includes('econnrefused') || msg.includes('enotfound') || msg.includes('timeout') || msg.includes('fetch failed');
}
