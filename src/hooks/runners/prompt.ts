import type { HookDefinition, HookResult, HookEvent } from '../types.ts';
import { logger } from '../../utils/logger.ts';

/**
 * Prompt hook runner — stub pending LLM provider integration.
 * $ARGUMENTS in the prompt is replaced with event JSON.
 */
export async function run(_hook: HookDefinition, _event: HookEvent): Promise<HookResult> {
  logger.debug('Hook runner not yet implemented', { type: 'prompt' });
  return { ok: false, error: 'Prompt hook runner not yet implemented. This hook type will be available when the LLM provider integration is complete.' };
}
