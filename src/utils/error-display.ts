import { AppError, ProviderError, type ErrorCategory, type ErrorSource, type ProviderErrorOptions } from '../types/errors.ts';
import type { StructuredDaemonErrorBody } from '../types/daemon-error-contract.ts';

const MAX_ERROR_LENGTH = 240;

const NETWORK_ERROR_PATTERNS: Array<{ pattern: RegExp; category: ErrorCategory; message: (provider?: string) => string }> = [
  {
    pattern: /ECONNREFUSED/i,
    category: 'network',
    message: (provider) => `Cannot connect to ${provider ?? 'the provider'}. Check whether the service is reachable.`,
  },
  {
    pattern: /ETIMEDOUT|ECONNABORTED|timed?[\s_-]?out/i,
    category: 'timeout',
    message: () => 'Connection timed out before the request completed.',
  },
  {
    pattern: /ENOTFOUND|EAI_AGAIN/i,
    category: 'network',
    message: (provider) => `DNS lookup failed for ${provider ?? 'the provider'}. Check the base URL and network.`,
  },
];

export interface NormalizedError {
  readonly name: string;
  readonly message: string;
  readonly summary: string;
  readonly hint?: string;
  readonly code?: string;
  readonly category: ErrorCategory;
  readonly source: ErrorSource;
  readonly recoverable: boolean;
  readonly statusCode?: number;
  readonly provider?: string;
  readonly operation?: string;
  readonly phase?: string;
  readonly requestId?: string;
  readonly providerCode?: string;
  readonly providerType?: string;
  readonly retryAfterMs?: number;
}

export interface ErrorNormalizationOptions {
  readonly provider?: string;
  readonly fallbackMessage?: string;
  readonly source?: ErrorSource;
}

export interface ProviderErrorNormalizationOptions extends ProviderErrorOptions {
  readonly fallbackMessage?: string;
}

function truncateMessage(msg: string): string {
  if (msg.length <= MAX_ERROR_LENGTH) return msg;
  return msg.slice(0, MAX_ERROR_LENGTH) + '\u2026';
}

function extractStringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function extractStructuredMessage(msg: string): string | undefined {
  const trimmed = msg.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return undefined;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!parsed || typeof parsed !== 'object') return undefined;
    const record = parsed as Record<string, unknown>;
    const nestedError = record.error && typeof record.error === 'object' ? record.error as Record<string, unknown> : undefined;
    const parts = [
      extractStringField(record, 'message'),
      nestedError ? extractStringField(nestedError, 'message') : undefined,
      nestedError ? extractStringField(nestedError, 'code') : undefined,
      nestedError ? extractStringField(nestedError, 'type') : undefined,
      extractStringField(record, 'code'),
      extractStringField(record, 'type'),
    ].filter((value): value is string => Boolean(value));
    return parts.length > 0 ? parts.join(', ') : undefined;
  } catch {
    return undefined;
  }
}

function stripJson(msg: string): string {
  return msg
    .replace(/\{[^{}]{0,500}\}/g, ' ')
    .replace(/\[[^\[\]]{0,500}\]/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function cleanMessage(msg: string, fallbackMessage?: string): string {
  const structured = extractStructuredMessage(msg);
  if (structured) return truncateMessage(structured);
  const stripped = stripJson(msg);
  if (stripped.length > 0) return truncateMessage(stripped);
  if (msg.trim().length > 0) return truncateMessage(msg.trim());
  return fallbackMessage ?? 'Unexpected error';
}

function inferCategory(message: string, statusCode?: number): ErrorCategory {
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
  if (/forbidden|access denied|permission denied|not allowed/.test(msg)) return 'authorization';
  if (/billing|payment required|credits?|quota|depleted|insufficient balance/.test(msg)) return 'billing';
  if (/rate.limit|too many requests|throttl/.test(msg)) return 'rate_limit';
  if (/timed?[\s_-]?out|etimedout|deadline exceeded/.test(msg)) return 'timeout';
  if (/econnrefused|enotfound|ehostunreach|econnreset|socket hang up|fetch failed|dns|tls|ssl|certificate/.test(msg)) return 'network';
  if (/not found|unknown model|no such model|unsupported model|unknown endpoint/.test(msg)) return 'not_found';
  if (/invalid request|bad request|invalid argument|schema|malformed|unsupported parameter/.test(msg)) return 'bad_request';
  if (/invalid json|parse|no response body|unexpected eof|stream ended|malformed response/.test(msg)) return 'protocol';
  return 'unknown';
}

function inferHint(category: ErrorCategory, statusCode?: number): string | undefined {
  switch (category) {
    case 'rate_limit':
      return 'The caller may retry automatically. If this persists, wait, lower request volume, or switch models/providers.';
    case 'authentication':
      return 'Possible causes: invalid or expired credentials, missing subscription/session state, account restrictions, or the wrong provider/endpoint receiving the request.';
    case 'authorization':
      return 'Possible causes: missing model access, account permissions, safety/policy restrictions, or provider routing to a service that does not expose this model.';
    case 'billing':
      return 'Check credits, subscription status, usage limits, or account entitlements.';
    case 'timeout':
      return 'Check network stability, provider latency, and request size.';
    case 'network':
      return 'Check connectivity, DNS, TLS certificates, base URL, or any local proxy/tunnel.';
    case 'bad_request':
      return 'Check model id, parameters, message format, and tool schema.';
    case 'not_found':
      return 'Check model id, provider selection, and API path.';
    case 'protocol':
      return 'Check upstream compatibility, streaming mode, and transport stability.';
    case 'service':
      return statusCode === 503
        ? 'The provider is temporarily unavailable. Retry shortly or switch providers if the issue persists.'
        : 'The provider returned a server-side failure. Retry shortly or switch providers if the issue persists.';
    default:
      return undefined;
  }
}

function inferSource(error: unknown, override?: ErrorSource): ErrorSource {
  if (override) return override;
  if (error instanceof AppError && error.source) return error.source;
  if (error instanceof Error && error.name === 'TypeError' && /fetch/i.test(error.message)) return 'transport';
  return 'unknown';
}

function buildSummary(
  message: string,
  metadata: {
    readonly requestId?: string;
    readonly providerCode?: string;
    readonly phase?: string;
  },
): string {
  const tags: string[] = [];
  if (metadata.phase && !message.toLowerCase().includes(metadata.phase.toLowerCase())) tags.push(`phase=${metadata.phase}`);
  if (metadata.providerCode && !message.includes(metadata.providerCode)) tags.push(`code=${metadata.providerCode}`);
  if (metadata.requestId && !message.includes(metadata.requestId)) tags.push(`request_id=${metadata.requestId}`);
  return tags.length > 0 ? `${message} (${tags.join(', ')})` : message;
}

function getNetworkErrorMessage(message: string, provider?: string): { category: ErrorCategory; summary: string } | undefined {
  for (const entry of NETWORK_ERROR_PATTERNS) {
    if (entry.pattern.test(message)) {
      return {
        category: entry.category,
        summary: entry.message(provider),
      };
    }
  }
  return undefined;
}

function extractErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object') {
    const message = extractStringField(error as Record<string, unknown>, 'message');
    if (message) return message;
  }
  return String(error);
}

export function normalizeError(error: unknown, options: ErrorNormalizationOptions = {}): NormalizedError {
  const rawMessage = extractErrorMessage(error);
  const statusCode = error instanceof AppError
    ? error.statusCode
    : error && typeof error === 'object' && 'statusCode' in error && typeof (error as { statusCode?: unknown }).statusCode === 'number'
      ? (error as { statusCode: number }).statusCode
      : error && typeof error === 'object' && 'status' in error && typeof (error as { status?: unknown }).status === 'number'
        ? (error as { status: number }).status
        : undefined;

  const provider = options.provider ?? (error instanceof AppError ? error.provider : undefined);
  const cleanedMessage = cleanMessage(rawMessage, options.fallbackMessage);
  const network = getNetworkErrorMessage(rawMessage, provider);
  const category = error instanceof AppError && error.category
    ? error.category
    : network?.category ?? inferCategory(cleanedMessage, statusCode);
  const source = inferSource(error, options.source);
  const summary = buildSummary(network?.summary ?? cleanedMessage, {
    requestId: error instanceof AppError ? error.requestId : undefined,
    providerCode: error instanceof AppError ? error.providerCode : undefined,
    phase: error instanceof AppError ? error.phase : undefined,
  });
  const hint = error instanceof AppError && error.guidance
    ? error.guidance
    : inferHint(category, statusCode);

  return {
    name: error instanceof Error ? error.name : 'Error',
    message: cleanedMessage,
    summary,
    ...(hint ? { hint } : {}),
    ...(error instanceof AppError ? { code: error.code } : {}),
    category,
    source,
    recoverable: error instanceof AppError ? error.recoverable : false,
    ...(statusCode !== undefined ? { statusCode } : {}),
    ...(provider ? { provider } : {}),
    ...(error instanceof AppError && error.operation ? { operation: error.operation } : {}),
    ...(error instanceof AppError && error.phase ? { phase: error.phase } : {}),
    ...(error instanceof AppError && error.requestId ? { requestId: error.requestId } : {}),
    ...(error instanceof AppError && error.providerCode ? { providerCode: error.providerCode } : {}),
    ...(error instanceof AppError && error.providerType ? { providerType: error.providerType } : {}),
    ...(error instanceof AppError && error.retryAfterMs !== undefined ? { retryAfterMs: error.retryAfterMs } : {}),
  };
}

export function summarizeError(error: unknown, options: ErrorNormalizationOptions = {}): string {
  return normalizeError(error, options).summary;
}

export function formatError(error: unknown, options: ErrorNormalizationOptions = {}): string {
  const normalized = normalizeError(error, options);
  const lines = [normalized.summary];
  if (normalized.hint) {
    lines.push(`  Hint: ${normalized.hint}`);
  }
  if (normalized.retryAfterMs !== undefined) {
    lines.push(`  Retry in ${Math.ceil(normalized.retryAfterMs / 1000)}s`);
  }
  return lines.join('\n');
}

export function buildErrorResponseBody(error: unknown, options: ErrorNormalizationOptions = {}): StructuredDaemonErrorBody {
  const normalized = normalizeError(error, options);
  return {
    error: normalized.summary,
    ...(normalized.hint ? { hint: normalized.hint } : {}),
    ...(normalized.code ? { code: normalized.code } : {}),
    category: normalized.category,
    source: normalized.source,
    recoverable: normalized.recoverable,
    ...(normalized.statusCode !== undefined ? { status: normalized.statusCode } : {}),
    ...(normalized.provider ? { provider: normalized.provider } : {}),
    ...(normalized.operation ? { operation: normalized.operation } : {}),
    ...(normalized.phase ? { phase: normalized.phase } : {}),
    ...(normalized.requestId ? { requestId: normalized.requestId } : {}),
    ...(normalized.providerCode ? { providerCode: normalized.providerCode } : {}),
    ...(normalized.providerType ? { providerType: normalized.providerType } : {}),
    ...(normalized.retryAfterMs !== undefined ? { retryAfterMs: normalized.retryAfterMs } : {}),
  };
}

export function toProviderError(error: unknown, options: ProviderErrorNormalizationOptions = {}): ProviderError {
  if (error instanceof ProviderError) {
    return new ProviderError(error.message, {
      statusCode: error.statusCode ?? options.statusCode,
      category: error.category ?? options.category,
      guidance: error.guidance ?? options.guidance,
      detail: error.detail ?? options.detail,
      source: 'provider',
      provider: error.provider ?? options.provider,
      operation: error.operation ?? options.operation,
      phase: error.phase ?? options.phase,
      requestId: error.requestId ?? options.requestId,
      providerCode: error.providerCode ?? options.providerCode,
      providerType: error.providerType ?? options.providerType,
      retryAfterMs: error.retryAfterMs ?? options.retryAfterMs,
      rawMessage: error.rawMessage ?? options.rawMessage ?? error.message,
    });
  }

  const normalized = normalizeError(error, {
    provider: options.provider,
    fallbackMessage: options.fallbackMessage,
    source: 'provider',
  });

  return new ProviderError(normalized.message, {
    ...(options.statusCode !== undefined || normalized.statusCode !== undefined
      ? { statusCode: options.statusCode ?? normalized.statusCode }
      : {}),
    ...(options.category
      ? { category: options.category }
      : normalized.category !== 'unknown'
        ? { category: normalized.category }
        : {}),
    ...(options.guidance
      ? { guidance: options.guidance }
      : normalized.hint
        ? { guidance: normalized.hint }
        : {}),
    ...(options.detail ? { detail: options.detail } : {}),
    source: 'provider',
    ...(options.provider ?? normalized.provider ? { provider: options.provider ?? normalized.provider } : {}),
    ...(options.operation ? { operation: options.operation } : {}),
    ...(options.phase ? { phase: options.phase } : {}),
    ...(options.requestId ?? normalized.requestId ? { requestId: options.requestId ?? normalized.requestId } : {}),
    ...(options.providerCode ?? normalized.providerCode ? { providerCode: options.providerCode ?? normalized.providerCode } : {}),
    ...(options.providerType ?? normalized.providerType ? { providerType: options.providerType ?? normalized.providerType } : {}),
    ...(options.retryAfterMs ?? normalized.retryAfterMs !== undefined
      ? { retryAfterMs: options.retryAfterMs ?? normalized.retryAfterMs }
      : {}),
    ...(options.rawMessage
      ? { rawMessage: options.rawMessage }
      : typeof error === 'string'
        ? { rawMessage: error }
        : error instanceof Error
          ? { rawMessage: error.message }
          : {}),
  });
}

export function formatProviderError(error: ProviderError, provider?: string): string {
  return formatError(error, { provider, source: 'provider' });
}
