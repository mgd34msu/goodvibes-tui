import { getBuiltinSubscriptionProvider } from './subscription-providers.ts';
import type { SubscriptionManager } from '@pellux/goodvibes-sdk/platform/config/subscriptions';
import { refreshOpenAICodexToken } from '@pellux/goodvibes-sdk/platform/config/openai-codex-auth';

export async function resolveSubscriptionAccessToken(
  provider: string,
  manager: Pick<SubscriptionManager, 'get' | 'saveSubscription' | 'resolveAccessToken'>,
): Promise<string | null> {
  if (provider === 'openai') {
    const existing = manager.get('openai');
    if (!existing) return null;
    if (typeof existing.expiresAt === 'number' && Date.now() + 60_000 >= existing.expiresAt) {
      if (!existing.refreshToken) return existing.accessToken;
      const refreshed = await refreshOpenAICodexToken(existing.refreshToken);
      manager.saveSubscription({
        ...existing,
        accessToken: refreshed.accessToken,
        refreshToken: refreshed.refreshToken,
        tokenType: refreshed.tokenType,
        expiresAt: refreshed.expiresAt,
        ...(refreshed.scopes ? { scopes: refreshed.scopes } : existing.scopes ? { scopes: existing.scopes } : {}),
        updatedAt: Date.now(),
      });
      return refreshed.accessToken;
    }
    return existing.accessToken;
  }
  const builtin = getBuiltinSubscriptionProvider(provider);
  if (!builtin) return null;
  return manager.resolveAccessToken(provider, builtin.oauth);
}
