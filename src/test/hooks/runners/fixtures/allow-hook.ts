import type { HookEvent, HookResult } from '../../../../../src/hooks/types.ts';

export default async function handler(_event: HookEvent): Promise<HookResult> {
  return { ok: true, decision: 'allow' };
}
