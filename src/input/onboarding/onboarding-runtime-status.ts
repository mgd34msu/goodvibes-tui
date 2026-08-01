import type { HostServiceStatus } from '@/runtime/index.ts';

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
    if (status.mode === 'incompatible') {
      // A GoodVibes daemon IS on the port, but it speaks an incompatible wire
      // version, so this TUI neither adopted it nor started a competing daemon.
      // status.reason already names the port and both versions (SDK side).
      const version = status.version ? ` version ${status.version}` : '';
      return `A GoodVibes service${version} is running at ${status.baseUrl} but is not wire-compatible with this TUI, so it was not adopted.${reason}`;
    }
    if (status.mode === 'external') {
      const version = status.version ? ` version ${status.version}` : '';
      return `An existing GoodVibes service was verified at ${status.baseUrl}${version}.`;
    }
    // The only mode left after every named branch above is 'embedded', and this
    // function reads either endpoint's status (see getRuntimeEndpointStatus):
    // the daemon status can never carry it in this product (adoptOnly is
    // hardcoded — see bootstrap.ts), but the HTTP listener's status legitimately
    // does, since the SDK always reports its in-process listener as 'embedded'.
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
  // This helper serves both endpoints (see handler-onboarding.ts's daemon and
  // httpListener calls), so the 'embedded' arm stays live for httpListener even
  // though a daemon status here is never 'embedded' in this product (adoptOnly
  // is hardcoded — see bootstrap.ts). Dropping the arm would mark a running
  // HTTP listener as inactive.
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
  // 'incompatible' means a GoodVibes daemon holds the configured port (we just
  // did not adopt it) — the port IS occupied, so report it as such. As with
  // isRuntimeEndpointActive above, 'embedded' stays live here for httpListener
  // (daemon status never carries it in this product).
  if (status) return status.mode === 'embedded' || status.mode === 'external' || status.mode === 'blocked' || status.mode === 'incompatible';
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
  // Reachable for httpListener (the SDK always reports its in-process listener
  // as 'embedded'); a daemon status never carries this mode in this product.
  if (status?.mode === 'embedded') {
    return `${label} is running as an embedded service at ${status.baseUrl}.`;
  }
  return endpoint === 'daemon'
    ? 'The GoodVibes daemon is running with the applied onboarding settings.'
    : 'The HTTP listener is running with the applied onboarding settings.';
}
