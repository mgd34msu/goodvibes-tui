// Deliberately per-repo test scaffolding, byte-identical to the sibling product's copy by design: it binds to this repo's own working tree, source layout and Bun test lifecycle, so a shared home would mean inventing a test-only published package rather than hoisting anything.
import type { HookEvent, HookResult } from '@pellux/goodvibes-sdk/platform/hooks';

export default async function handler(_event: HookEvent): Promise<HookResult> {
  return { ok: true, decision: 'allow' };
}
