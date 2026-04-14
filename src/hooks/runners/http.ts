import type { HookDefinition, HookResult, HookEvent } from '../types.ts';
import { logger } from '../../utils/logger.ts';
import { summarizeError } from '../../utils/error-display.ts';

/**
 * HTTP hook runner.
 * POSTs the event JSON to the configured URL and parses the response as HookResult.
 */
export async function run(hook: HookDefinition, event: HookEvent): Promise<HookResult> {
  const url = hook.url;
  if (!url) {
    return { ok: false, error: 'http hook missing "url" field' };
  }

  const timeoutMs = (hook.timeout ?? 30) * 1000;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...hook.headers,
        },
        body: JSON.stringify(event),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      return {
        ok: false,
        error: `http hook received ${response.status} ${response.statusText}`,
      };
    }

    const text = await response.text();
    if (!text.trim()) {
      return { ok: true };
    }

    try {
      const result = JSON.parse(text) as HookResult;
      return { ...result, ok: result.ok ?? true };
    } catch {
      return { ok: true };
    }
  } catch (err) {
    const message = summarizeError(err);
    logger.error('http hook error', { url, error: message });
    return { ok: false, error: message };
  }
}
