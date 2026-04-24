import type { RuntimeEndpointBinding } from './endpoints.ts';

export type BindPostureKind = 'local' | 'local-network' | 'custom-network';

export interface BindPosture {
  readonly kind: BindPostureKind;
  readonly label: string;
  readonly networkFacing: boolean;
}

export function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  return normalized === 'localhost'
    || normalized === '::1'
    || normalized === '0:0:0:0:0:0:0:1'
    || normalized.startsWith('127.');
}

export function classifyBindPosture(binding: Pick<RuntimeEndpointBinding, 'hostMode' | 'host'>): BindPosture {
  if (binding.hostMode === 'local' || isLoopbackHost(binding.host)) {
    return {
      kind: 'local',
      label: 'Local only',
      networkFacing: false,
    };
  }
  if (binding.hostMode === 'network' || binding.host === '0.0.0.0' || binding.host === '::') {
    return {
      kind: 'local-network',
      label: 'Local Network',
      networkFacing: true,
    };
  }
  return {
    kind: 'custom-network',
    label: 'Custom network',
    networkFacing: true,
  };
}

export function isNetworkFacing(
  enabled: unknown,
  binding: Pick<RuntimeEndpointBinding, 'hostMode' | 'host'>,
): boolean {
  return enabled === true && classifyBindPosture(binding).networkFacing;
}
