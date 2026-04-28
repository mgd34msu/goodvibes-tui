import type { HostServiceStatus } from '@pellux/goodvibes-sdk/platform/runtime/bootstrap-services';

export interface OnboardingExternalServiceState {
  readonly daemonRunning?: boolean;
  readonly daemonPortInUse?: boolean;
  readonly httpListenerRunning?: boolean;
  readonly httpListenerPortInUse?: boolean;
  readonly daemonStatus?: HostServiceStatus;
  readonly httpListenerStatus?: HostServiceStatus;
}

export type OnboardingRuntimeEndpoint = 'daemon' | 'httpListener';

export function runtimePortDiagnostic(
  binding: { readonly label: string; readonly host: string; readonly port: number },
  portInUse: boolean | undefined,
  status?: HostServiceStatus,
): string {
  if (status) {
    const reason = status.reason ? ` ${status.reason}` : '';
    if (status.mode === 'blocked') {
      return `The configured endpoint ${status.baseUrl} is occupied but was not usable by this TUI instance.${reason}`;
    }
    if (status.mode === 'disabled') {
      return `The configured endpoint ${status.baseUrl} is disabled in the runtime service configuration.${reason}`;
    }
    if (status.mode === 'unavailable') {
      return `The configured endpoint ${status.baseUrl} is unavailable after startup or restart.${reason}`;
    }
    if (status.mode === 'external') {
      const version = status.version ? ` version ${status.version}` : '';
      return `An existing GoodVibes service was verified at ${status.baseUrl}${version}.`;
    }
    return `An embedded GoodVibes service is running at ${status.baseUrl}.`;
  }
  if (portInUse) {
    return `The configured port ${binding.host}:${binding.port} is occupied after restart; another GoodVibes process, an overlapping restart, or another service may still own it.`;
  }
  return `No process is listening on ${binding.host}:${binding.port} after restart.`;
}

export function getRuntimeEndpointStatus(
  state: OnboardingExternalServiceState | undefined,
  endpoint: OnboardingRuntimeEndpoint,
): HostServiceStatus | undefined {
  return endpoint === 'daemon' ? state?.daemonStatus : state?.httpListenerStatus;
}

export function isRuntimeEndpointActive(
  state: OnboardingExternalServiceState | undefined,
  endpoint: OnboardingRuntimeEndpoint,
): boolean {
  const status = getRuntimeEndpointStatus(state, endpoint);
  if (status) return status.mode === 'embedded' || status.mode === 'external';
  return endpoint === 'daemon'
    ? state?.daemonRunning === true
    : state?.httpListenerRunning === true;
}

export function isRuntimeEndpointOccupyingConfiguredPort(
  state: OnboardingExternalServiceState | undefined,
  endpoint: OnboardingRuntimeEndpoint,
): boolean {
  const status = getRuntimeEndpointStatus(state, endpoint);
  if (status) return status.mode === 'embedded' || status.mode === 'external' || status.mode === 'blocked';
  return endpoint === 'daemon'
    ? state?.daemonRunning === true || state?.daemonPortInUse === true
    : state?.httpListenerRunning === true || state?.httpListenerPortInUse === true;
}

export function formatRuntimeActiveSuccessMessage(
  endpoint: OnboardingRuntimeEndpoint,
  state: OnboardingExternalServiceState | undefined,
): string {
  const status = getRuntimeEndpointStatus(state, endpoint);
  const label = endpoint === 'daemon' ? 'GoodVibes daemon' : 'HTTP listener';
  if (status?.mode === 'external') {
    const version = status.version ? ` version ${status.version}` : '';
    return `${label} is already running as a verified external GoodVibes service at ${status.baseUrl}${version}.`;
  }
  if (status?.mode === 'embedded') {
    return `${label} is running as an embedded service at ${status.baseUrl}.`;
  }
  return endpoint === 'daemon'
    ? 'The GoodVibes daemon is running with the applied onboarding settings.'
    : 'The HTTP listener is running with the applied onboarding settings.';
}
