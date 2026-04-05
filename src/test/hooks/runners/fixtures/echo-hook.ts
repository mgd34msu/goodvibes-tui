import type { HookEvent, HookResult } from '../../../../../src/hooks/types.ts';

export default async function handler(event: HookEvent): Promise<HookResult> {
  return { ok: true, additionalContext: `session:${event.sessionId}` };
}
