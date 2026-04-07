import { getBuiltinSubscriptionProvider } from './subscription-providers.ts';
import { getSubscriptionManager } from './subscriptions.ts';
import { refreshOpenAICodexToken } from './openai-codex-auth.ts';

export async function resolveSubscriptionAccessToken(provider: string): Promise<string | null> {
  if (provider === 'openai') {
    const manager = getSubscriptionManager();
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
  return getSubscriptionManager().resolveAccessToken(provider, builtin.oauth);
}
