import type { HookEvent, HookResult } from '@pellux/goodvibes-sdk/platform/hooks';

export default async function handler(event: HookEvent): Promise<HookResult> {
  return { ok: true, additionalContext: `session:${event.sessionId}` };
}
