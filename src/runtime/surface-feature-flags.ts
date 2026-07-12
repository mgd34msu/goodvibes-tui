/**
 * surface-feature-flags — which platform capabilities a surface/server setup
 * needs, and how to switch them on through their real domain settings keys.
 *
 * Capabilities are configured through first-class domain settings (see
 * feature-settings.ts); enabling a surface writes keys like
 * `controlPlane.gateway` or `surfaces.slack.enabled`, never a separate
 * enablement namespace.
 */

import type { ConfigManager } from '../config/index.ts';
import { surfaceFeatureGateId } from '@/runtime/index.ts';
import { featureEnablementWrite, isFeatureConfigEnabled } from './feature-settings.ts';

export const CONTROL_PLANE_FEATURE_FLAG = 'control-plane-gateway';
export const ROUTE_BINDING_FEATURE_FLAG = 'route-binding';
export const DELIVERY_ENGINE_FEATURE_FLAG = 'delivery-engine';
export const SERVICE_MANAGEMENT_FEATURE_FLAG = 'service-management';

const CORE_CHANNEL_FEATURE_FLAGS = [
  CONTROL_PLANE_FEATURE_FLAG,
  ROUTE_BINDING_FEATURE_FLAG,
  DELIVERY_ENGINE_FEATURE_FLAG,
] as const;

export function getSurfaceFeatureFlag(surfaceId: string): string | null {
  return surfaceFeatureGateId(surfaceId);
}

export function getServerSurfaceFeatureFlags(options: {
  readonly serverBacked?: boolean;
  readonly web?: boolean;
  readonly externalSurfaces?: readonly string[];
}): readonly string[] {
  const flags = new Set<string>();
  const hasExternalSurfaces = (options.externalSurfaces?.length ?? 0) > 0;

  if (options.serverBacked || options.web || hasExternalSurfaces) {
    flags.add(CONTROL_PLANE_FEATURE_FLAG);
    flags.add(SERVICE_MANAGEMENT_FEATURE_FLAG);
  }
  if (options.web) {
    const webFlag = getSurfaceFeatureFlag('web');
    if (webFlag) flags.add(webFlag);
  }

  if (hasExternalSurfaces) {
    for (const flag of CORE_CHANNEL_FEATURE_FLAGS) flags.add(flag);
    for (const surfaceId of options.externalSurfaces ?? []) {
      const surfaceFlag = getSurfaceFeatureFlag(surfaceId);
      if (surfaceFlag) flags.add(surfaceFlag);
    }
  }

  return [...flags].sort((left, right) => left.localeCompare(right));
}

/** Whether the live config has the capability on, derived from its domain settings key. */
export function isFeatureFlagEnabled(config: Pick<ConfigManager, 'get'>, flagId: string): boolean {
  return isFeatureConfigEnabled(config, flagId);
}

export function getMissingSurfaceFeatureFlags(config: Pick<ConfigManager, 'get'>, surfaceId: string): readonly string[] {
  const required = surfaceId === 'web'
    ? getServerSurfaceFeatureFlags({ web: true })
    : getServerSurfaceFeatureFlags({ externalSurfaces: [surfaceId] });
  return required.filter((flagId) => !isFeatureFlagEnabled(config, flagId));
}

/** Switch each capability on by writing its real enablement settings key. */
export function enableFeatureFlags(config: Pick<ConfigManager, 'setDynamic'>, flagIds: readonly string[]): void {
  for (const flagId of flagIds) {
    const write = featureEnablementWrite(flagId, true);
    if (write) config.setDynamic(write.key, write.value);
  }
}
