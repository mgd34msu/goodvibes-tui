/**
 * provider-optimizer-wiring — bind the provider optimizer to its capability
 * gate and seed its persisted routing mode at startup.
 *
 * Mirrors the SDK composition root's provider-optimizer-wiring module (which
 * the SDK does not export through a public seam) so this repo's composition
 * fork cannot drift from it silently: the optimizer is constructed dark, the
 * gate subscription flips it live, and provider.optimizerMode seeds the mode.
 */

import type { ConfigManager } from '@pellux/goodvibes-sdk/platform/config';
import type { ProviderOptimizer } from '@pellux/goodvibes-sdk/platform/providers';
import type { FeatureFlagManager } from '@/runtime/index.ts';

export function bindProviderOptimizerFeatureFlag(
  featureFlags: Pick<FeatureFlagManager, 'isEnabled' | 'subscribe'>,
  providerOptimizer: Pick<ProviderOptimizer, 'setEnabled'>,
): () => void {
  providerOptimizer.setEnabled(featureFlags.isEnabled('provider-optimizer'));
  return featureFlags.subscribe((flagId, state) => {
    if (flagId === 'provider-optimizer') {
      providerOptimizer.setEnabled(state === 'enabled');
    }
  });
}

/**
 * Apply the persistent provider-optimizer routing mode from config at startup.
 * provider.optimizerMode 'off' keeps the optimizer inactive (its gate derives
 * from the same key); this only seeds the mode/pin so an operator can persist
 * "auto" or a pinned model without re-issuing a /provider command each
 * session. Runtime pin/unpin/setMode still override for the live session.
 */
export function applyProviderOptimizerConfigMode(
  configManager: Pick<ConfigManager, 'get'>,
  providerOptimizer: Pick<ProviderOptimizer, 'setMode' | 'pin'>,
): void {
  const mode = configManager.get('provider.optimizerMode');
  if (mode === 'off') {
    providerOptimizer.setMode('manual'); // inert baseline while inactive
    return;
  }
  if (mode === 'pinned') {
    const pinned = configManager.get('provider.optimizerPinnedModel').trim();
    const sep = pinned.indexOf(':');
    if (sep > 0 && sep < pinned.length - 1) {
      providerOptimizer.pin(pinned.slice(0, sep), pinned.slice(sep + 1));
    } else {
      // Pinned mode requested without a valid provider-qualified model — stay manual.
      providerOptimizer.setMode('manual');
    }
  } else {
    providerOptimizer.setMode(mode);
  }
}
