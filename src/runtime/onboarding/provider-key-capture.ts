/**
 * Provider-agnostic key capture for onboarding.
 *
 * The onboarding wizard offers an API-key field for every provider the registry
 * knows accepts a key, derived from each provider's registration-time auth
 * state (describeAuthState), never a hardcoded vendor list. This module holds
 * the two shared pieces that keep the wizard step and the apply step in lockstep:
 *
 *  1. enrichProviderAccountsSnapshot, stamps each provider-account record with
 *     the secrets-store key it reads its API key from (its declared auth env
 *     var), read live from the provider registry.
 *  2. deriveProviderKeyCaptureTargets / providerKeyFieldId, the single source
 *     of truth for which providers get a key field and how those fields are
 *     named, used by both the field builder and the apply writer.
 */

import type { LLMProvider } from '@pellux/goodvibes-sdk/platform/providers';
import type {
  OnboardingProviderAccountRecord,
  OnboardingProviderAccountsSnapshot,
} from './types.ts';

/** Minimal provider lookup the enrichment needs (structural for testing). */
export interface ProviderKeyRegistryLike {
  tryGet(name: string): LLMProvider | undefined;
}

/** Read a provider's declared API-key env var, or undefined when it accepts none. */
export function readProviderApiKeyEnvVar(
  registry: ProviderKeyRegistryLike,
  providerId: string,
): string | undefined {
  let provider: LLMProvider | undefined;
  try {
    provider = registry.tryGet(providerId);
  } catch {
    provider = undefined;
  }
  const envVars = provider?.describeAuthState?.().authEnvVars;
  return envVars && envVars.length > 0 ? envVars[0] : undefined;
}

/**
 * Return an equivalent snapshot with each provider record stamped with the
 * secrets-store key it accepts an API key under (from live registration truth).
 * Records for keyless / subscription-only providers keep apiKeyEnvVar absent.
 */
export function enrichProviderAccountsSnapshot(
  snapshot: OnboardingProviderAccountsSnapshot,
  registry: ProviderKeyRegistryLike,
): OnboardingProviderAccountsSnapshot {
  return {
    ...snapshot,
    providers: snapshot.providers.map((record) => {
      const apiKeyEnvVar = readProviderApiKeyEnvVar(registry, record.providerId);
      return apiKeyEnvVar ? { ...record, apiKeyEnvVar } : record;
    }),
  };
}

/** A provider that onboarding can offer an API-key field for. */
export interface ProviderKeyCaptureTarget {
  readonly providerId: string;
  readonly apiKeyEnvVar: string;
  readonly configured: boolean;
}

/**
 * The providers onboarding offers an API-key field for: every registered
 * provider that declares an api-key route AND carries a resolved auth env var.
 * Ordered by provider id so the wizard renders deterministically.
 */
export function deriveProviderKeyCaptureTargets(
  providers: readonly OnboardingProviderAccountRecord[] | undefined,
): ProviderKeyCaptureTarget[] {
  if (!providers) return [];
  return providers
    .filter((record) => record.apiKeyEnvVar && record.availableRoutes.includes('api-key'))
    .map((record) => ({
      providerId: record.providerId,
      apiKeyEnvVar: record.apiKeyEnvVar as string,
      configured: record.configured,
    }))
    .sort((a, b) => a.providerId.localeCompare(b.providerId));
}

/** The wizard field id that captures a given provider's API key. */
export function providerKeyFieldId(providerId: string): string {
  return `providers.api-key.${providerId}`;
}

/** A subscription-capable provider and its current subscription posture. */
export interface SubscriptionStatusTarget {
  readonly providerId: string;
  readonly active: boolean;
  readonly pending: boolean;
}

/**
 * The providers onboarding shows a subscription-status row for: every provider
 * that declares a subscription route (registration truth), plus any provider
 * with an active or pending subscription session, so a live session is never
 * hidden just because its account record was absent. Ordered by provider id.
 */
export function deriveSubscriptionStatusTargets(
  providers: readonly OnboardingProviderAccountRecord[] | undefined,
  activeProviderIds: readonly string[],
  pendingProviderIds: readonly string[],
): SubscriptionStatusTarget[] {
  const active = new Set(activeProviderIds);
  const pending = new Set(pendingProviderIds);
  const ids = new Set<string>();
  for (const record of providers ?? []) {
    if (record.availableRoutes.includes('subscription')) ids.add(record.providerId);
  }
  for (const id of active) ids.add(id);
  for (const id of pending) ids.add(id);
  return [...ids]
    .sort((a, b) => a.localeCompare(b))
    .map((providerId) => ({ providerId, active: active.has(providerId), pending: pending.has(providerId) }));
}

/** The wizard field id of a provider's subscription-status row. */
export function subscriptionStatusFieldId(providerId: string): string {
  return `providers.subscription.${providerId}`;
}
