import { createHmac, timingSafeEqual } from 'node:crypto';

export const DEFAULT_WEBHOOK_MAX_BYTES = 1_000_000;

function ignoreCancelError(): void {
  // Best-effort cancellation only.
}

export function constantTimeEquals(expected: string, provided: string): boolean {
  if (!expected || !provided || expected.length !== provided.length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(provided));
}

export function readBearerOrHeaderToken(req: Request, headerName: string): string {
  return (
    req.headers.get(headerName)
    ?? req.headers.get('authorization')?.replace(/^Bearer\s+/i, '')
    ?? ''
  ).trim();
}

export function parseJsonRecord(rawBody: string): Record<string, unknown> | Response {
  try {
    const parsed = JSON.parse(rawBody) as unknown;
    return typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : {};
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
}

export async function readTextBodyWithinLimit(
  req: Request,
  maxBytes = DEFAULT_WEBHOOK_MAX_BYTES,
): Promise<string | Response> {
  const contentLength = parseInt(req.headers.get('content-length') ?? '0', 10);
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    return Response.json({ error: 'Payload too large' }, { status: 413 });
  }

  if (!req.body) return '';
  const reader = req.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let body = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel('Payload too large').catch(ignoreCancelError);
        return Response.json({ error: 'Payload too large' }, { status: 413 });
      }
      body += decoder.decode(value, { stream: true });
    }
    body += decoder.decode();
    return body;
  } finally {
    reader.releaseLock();
  }
}

export function verifySha256HmacSignature(
  rawBody: string,
  secret: string,
  signatureHeader: string,
  prefix = 'sha256=',
): boolean {
  if (!secret || !signatureHeader.startsWith(prefix)) return false;
  const expected = `${prefix}${createHmac('sha256', secret).update(rawBody).digest('hex')}`;
  return constantTimeEquals(expected, signatureHeader);
}
