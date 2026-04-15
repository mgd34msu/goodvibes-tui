import type { HookEvent, HookResult } from '@pellux/goodvibes-sdk/platform/hooks/types';

export default async function handler(_event: HookEvent): Promise<HookResult> {
  return { ok: true, decision: 'allow' };
}
