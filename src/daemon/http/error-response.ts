import { buildErrorResponseBody, summarizeError, type ErrorNormalizationOptions } from '../../utils/error-display.ts';

export interface JsonErrorResponseOptions extends ErrorNormalizationOptions {
  readonly status?: number;
}

export function jsonErrorResponse(error: unknown, options: JsonErrorResponseOptions = {}): Response {
  const body = buildErrorResponseBody(error, options);
  const status = options.status
    ?? (typeof body.status === 'number' ? body.status : undefined)
    ?? 500;
  return Response.json(body, { status });
}

export function summarizeErrorForRecord(error: unknown, options: ErrorNormalizationOptions = {}): string {
  return summarizeError(error, options);
}
