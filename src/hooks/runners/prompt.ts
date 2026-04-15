import type { HookDefinition, HookResult, HookEvent } from '@pellux/goodvibes-sdk/platform/hooks/types';
import { logger } from '@pellux/goodvibes-sdk/platform/utils/logger';
import type { ToolLLM } from '../../config/tool-llm.ts';
import { summarizeError } from '@pellux/goodvibes-sdk/platform/utils/error-display';

/**
 * Prompt hook runner — sends event data to an LLM via ToolLLM.
 *
 * The hook definition's `prompt` field is a template string.
 * `$ARGUMENTS` is replaced with the JSON-serialised event before
 * the prompt is sent.  The LLM response is parsed as a HookResult
 * JSON object.  If the response is not valid JSON (or is empty)
 * the hook returns `{ ok: true }` (fire-and-forget semantics).
 */
export async function run(
  hook: HookDefinition,
  event: HookEvent,
  toolLLM: Pick<ToolLLM, 'chat'> | null,
): Promise<HookResult> {
  if (!toolLLM) {
    return { ok: false, error: 'prompt hook runner is not configured in this runtime' };
  }
  const promptTemplate = hook.prompt;
  if (!promptTemplate) {
    return { ok: false, error: 'prompt hook missing "prompt" field' };
  }

  const resolvedPrompt = promptTemplate.replaceAll('$ARGUMENTS', JSON.stringify(event));
  const timeoutMs = (hook.timeout ?? 30) * 1000;

  logger.debug('prompt hook: sending to LLM', {
    event: event.path,
    timeoutMs,
  });

  let timerId: ReturnType<typeof setTimeout> | undefined;

  try {
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timerId = setTimeout(() => {
        reject(new Error(`prompt hook timed out after ${hook.timeout ?? 30}s`));
      }, timeoutMs);
    });

    let response: string;
    try {
      response = await Promise.race([toolLLM.chat(resolvedPrompt), timeoutPromise]);
    } finally {
      clearTimeout(timerId);
    }

    const trimmed = response.trim();
    if (!trimmed) {
      return { ok: true };
    }

    try {
      const result = JSON.parse(trimmed) as HookResult;
      return { ...result, ok: result.ok ?? true };
    } catch {
      // Non-JSON LLM output — fire-and-forget semantics
      return { ok: true };
    }
  } catch (err) {
    const message = summarizeError(err);
    logger.error('prompt hook error', { event: event.path, error: message });
    return { ok: false, error: message };
  }
}
