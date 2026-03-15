import type { HookDefinition, HookResult, HookEvent } from '../types.ts';
import { logger } from '../../utils/logger.ts';

/**
 * Agent hook runner — stub pending agent system integration.
 */
export async function run(_hook: HookDefinition, _event: HookEvent): Promise<HookResult> {
  logger.debug('Hook runner not yet implemented', { type: 'agent' });
  return { ok: false, error: 'Agent hook runner not yet implemented. This hook type will be available when the agent system is complete.' };
}
