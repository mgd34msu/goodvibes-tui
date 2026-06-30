// Shared best-effort route resolution wrapper used by all adapters.
// Swallows resolver failures (routing is an optional, concurrently-wired
// surface) so a route lookup can never crash a provider poll.

import type { AdapterContext, InboundChannelItem } from '../provider-adapter.ts';
import { summarizeError } from '@pellux/goodvibes-sdk/platform/utils';

export async function resolveRouteId(
  ctx: AdapterContext,
  provider: string,
  fromDigest: string,
  kind: InboundChannelItem['kind'],
): Promise<string | undefined> {
  if (!ctx.resolveRouteId) return undefined;
  try {
    return (await ctx.resolveRouteId({ provider, fromDigest, kind })) ?? undefined;
  } catch (error) {
    ctx.logger.warn('route resolution failed', {
      provider,
      error: summarizeError(error),
    });
    return undefined;
  }
}
