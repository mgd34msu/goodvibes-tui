import type { ConfigManager } from '@pellux/goodvibes-sdk/platform/config';
import { resolveDaemonEnabled } from '@pellux/goodvibes-sdk/platform/config';
import type { OnboardingCheckMarkersState } from '../runtime/onboarding/index.ts';
import { resolveRuntimeEndpointBinding } from './endpoints.ts';
import { isNetworkFacing } from './network-posture.ts';
import type { GoodVibesCliOutputFormat } from './types.ts';
import type { CliServicePosture } from './service-posture.ts';
import { getProviderIdFromModel } from '../config/provider-model.ts';

export interface CliStatusOptions {
  readonly configManager: Pick<ConfigManager, 'get'>;
  readonly workingDirectory: string;
  readonly homeDirectory: string;
  readonly onboardingMarkers?: OnboardingCheckMarkersState;
  readonly auth?: CliAuthStatus;
  readonly service?: CliServicePosture;
  readonly doctor?: boolean;
  readonly outputFormat?: GoodVibesCliOutputFormat;
}

export interface CliAuthStatus {
  readonly userStorePath: string;
  readonly userStorePresent: boolean;
  readonly bootstrapCredentialPath: string;
  readonly bootstrapCredentialPresent: boolean;
  readonly operatorTokenPath: string;
  readonly operatorTokenPresent: boolean;
}

export interface CliDoctorFinding {
  readonly id: string;
  readonly area: 'auth' | 'network' | 'onboarding' | 'security' | 'service' | 'secrets';
  readonly severity: 'warning' | 'risk';
  readonly summary: string;
  readonly cause: string;
  readonly impact: string;
  readonly action: string;
}

export interface CliStatusSnapshot {
  readonly title: 'GoodVibes status' | 'GoodVibes doctor';
  readonly workingDirectory: string;
  readonly homeDirectory: string;
  readonly provider: {
    readonly provider: string;
    readonly model: string;
    readonly reasoning: string;
  };
  readonly auth: {
    readonly permissionMode: unknown;
    readonly permissionLabel: string;
    readonly secretPolicy: unknown;
    readonly secretPolicyLabel: string;
    readonly localUsers: CliAuthStatus | null;
  };
  readonly service: {
    readonly enabled: unknown;
    readonly autostart: unknown;
    readonly restartOnFailure: unknown;
    readonly lifecycle?: CliServicePosture;
  };
  readonly surfaces: {
    readonly controlPlane: ReturnType<typeof resolveRuntimeEndpointBinding> & { readonly enabled: unknown };
    readonly httpListener: ReturnType<typeof resolveRuntimeEndpointBinding> & { readonly enabled: unknown };
    readonly web: ReturnType<typeof resolveRuntimeEndpointBinding> & { readonly enabled: unknown };
  };
  readonly onboarding: {
    readonly checked: boolean;
    readonly scope: string;
    readonly updatedAt: number | null;
  };
  readonly findings: readonly CliDoctorFinding[];
}

function yesNo(value: unknown): string {
  return value === true ? 'yes' : 'no';
}

function permissionModeLabel(mode: unknown): string {
  if (mode === 'prompt') return 'Ask before powerful actions';
  if (mode === 'allow-all') return 'Allow everything';
  if (mode === 'custom') return 'Custom rules';
  return String(mode ?? 'unknown');
}

function secretPolicyLabel(policy: unknown): string {
  if (policy === 'preferred_secure') return 'Use secure storage when available';
  if (policy === 'require_secure') return 'Require secure storage';
  if (policy === 'plaintext_allowed') return 'Allow plaintext storage';
  return String(policy ?? 'unknown');
}

function bindLine(label: string, enabled: unknown, binding: { readonly hostMode: string; readonly host: string; readonly port: number }): string {
  return `  ${label}: ${yesNo(enabled)} (${binding.hostMode} ${binding.host}:${binding.port})`;
}

export function buildCliDoctorFindings(options: CliStatusOptions): readonly CliDoctorFinding[] {
  const config = options.configManager;
  const serviceEnabled = config.get('service.enabled') === true;
  const serviceAutostart = config.get('service.autostart') === true;
  const restartOnFailure = config.get('service.restartOnFailure') === true;
  const daemonEnabled = resolveDaemonEnabled(config);
  const listenerEnabled = config.get('danger.httpListener') === true;
  const webEnabled = config.get('web.enabled') === true;
  const controlPlaneEnabled = config.get('controlPlane.enabled') === true;
  const controlPlaneBinding = resolveRuntimeEndpointBinding(config, 'controlPlane');
  const httpListenerBinding = resolveRuntimeEndpointBinding(config, 'httpListener');
  const webBinding = resolveRuntimeEndpointBinding(config, 'web');
  const permissionMode = config.get('permissions.mode');
  const secretPolicy = config.get('storage.secretPolicy');
  const marker = options.onboardingMarkers?.effective;
  const serverBackedEnabled = daemonEnabled || controlPlaneEnabled || listenerEnabled || webEnabled;
  const networkFacingSurfaces = [
    ['control plane', controlPlaneEnabled, controlPlaneBinding],
    ['HTTP listener', listenerEnabled, httpListenerBinding],
    ['web surface', webEnabled, webBinding],
  ].filter(([, enabled, binding]) => isNetworkFacing(enabled, binding as typeof controlPlaneBinding));

  const findings: CliDoctorFinding[] = [];

  if (serverBackedEnabled && !serviceEnabled) {
    findings.push({
      id: 'service-disabled-for-server-surfaces',
      area: 'service',
      severity: 'warning',
      summary: 'Server-backed surfaces are enabled but service mode is off.',
      cause: 'One or more daemon, control-plane, listener, or web settings are enabled while service.enabled is false.',
      impact: 'The configured surfaces may not start automatically or survive restarts.',
      action: 'Enable service mode or disable the server-backed surfaces you do not want.',
    });
  }

  if (serviceEnabled && !serviceAutostart) {
    findings.push({
      id: 'service-autostart-disabled',
      area: 'service',
      severity: 'warning',
      summary: 'Service mode is enabled but autostart is off.',
      cause: 'service.enabled is true and service.autostart is false.',
      impact: 'GoodVibes may not start after login or reboot even though service mode is selected.',
      action: 'Enable service.autostart if the daemon/listener/web surfaces should stay available.',
    });
  }

  if (serviceEnabled && !restartOnFailure) {
    findings.push({
      id: 'service-restart-disabled',
      area: 'service',
      severity: 'warning',
      summary: 'Service restart-on-failure is off.',
      cause: 'service.enabled is true and service.restartOnFailure is false.',
      impact: 'A crashed daemon or listener may stay down until manually restarted.',
      action: 'Enable service.restartOnFailure for durable daemon/listener operation.',
    });
  }

  if (options.service) {
    for (const issue of options.service.issues) {
      if (findings.some((finding) => finding.summary === issue)) continue;
      findings.push({
        id: `service-lifecycle-${findings.length}`,
        area: 'service',
        severity: 'warning',
        summary: issue,
        cause: 'The service lifecycle inspection found a mismatch between configured service/surface state and observed host state.',
        impact: 'Daemon, control-plane, listener, or web availability may not match the configuration.',
        action: 'Run goodvibes service check and apply the suggested service install/start/configuration fix.',
      });
    }
  }

  if (!marker?.exists) {
    findings.push({
      id: 'onboarding-incomplete',
      area: 'onboarding',
      severity: 'warning',
      summary: 'Onboarding has not been shown for this user.',
      cause: 'No global user onboarding check marker was found.',
      impact: 'Important service, network, provider, auth, or permission choices may still be implicit defaults.',
      action: 'Run /onboarding in the TUI or goodvibes onboarding status to review setup state.',
    });
  }

  if (networkFacingSurfaces.length > 0 && options.auth?.userStorePresent !== true) {
    findings.push({
      id: 'network-surface-without-local-users',
      area: 'auth',
      severity: 'risk',
      summary: 'Network-facing surfaces are enabled before local users are configured.',
      cause: `${networkFacingSurfaces.map(([name]) => name).join(', ')} are LAN/custom-bound, but no local auth user store was found.`,
      impact: 'Remote access paths may be unusable or unsafe until local admin auth is configured.',
      action: 'Create/verify a local admin user before exposing GoodVibes on the network.',
    });
  }

  if (networkFacingSurfaces.length > 0 && options.auth?.bootstrapCredentialPresent === true) {
    findings.push({
      id: 'network-surface-with-bootstrap-credential',
      area: 'auth',
      severity: 'risk',
      summary: 'A bootstrap credential is still present while network-facing surfaces are enabled.',
      cause: `${networkFacingSurfaces.map(([name]) => name).join(', ')} are LAN/custom-bound and auth-bootstrap.txt exists.`,
      impact: 'Bootstrap credentials should be treated as temporary setup material, not long-lived network access credentials.',
      action: 'Replace bootstrap auth with a named admin user and retire the bootstrap credential.',
    });
  }

  if (permissionMode === 'allow-all') {
    findings.push({
      id: 'allow-all-permissions',
      area: 'security',
      severity: 'risk',
      summary: 'Allow everything permission mode is active.',
      cause: 'permissions.mode is allow-all.',
      impact: 'Powerful write, edit, network, and execution tools can run without a Human-in-the-Loop (HITL) approval prompt.',
      action: 'Use Ask before powerful actions or Custom rules unless this is an intentionally trusted environment.',
    });
  }

  if (secretPolicy === 'plaintext_allowed') {
    findings.push({
      id: 'plaintext-secrets-allowed',
      area: 'secrets',
      severity: 'risk',
      summary: 'Plaintext secret storage is allowed.',
      cause: 'storage.secretPolicy is plaintext_allowed.',
      impact: 'Provider keys and surface tokens may be stored without secure backend protection.',
      action: 'Use Require secure storage or Use secure storage when available for normal operation.',
    });
  }

  if (listenerEnabled && isNetworkFacing(listenerEnabled, httpListenerBinding)) {
    findings.push({
      id: 'network-http-listener-enabled',
      area: 'network',
      severity: 'warning',
      summary: 'The HTTP listener is reachable beyond loopback.',
      cause: `HTTP listener is enabled on ${httpListenerBinding.host}:${httpListenerBinding.port} with ${httpListenerBinding.hostMode} binding.`,
      impact: 'External tools and devices may be able to reach incoming event endpoints.',
      action: 'Keep listener secrets/signature checks configured for every enabled webhook surface.',
    });
  }

  return findings;
}

export function buildCliStatusSnapshot(options: CliStatusOptions): CliStatusSnapshot {
  const config = options.configManager;
  const controlPlaneBinding = resolveRuntimeEndpointBinding(config, 'controlPlane');
  const httpListenerBinding = resolveRuntimeEndpointBinding(config, 'httpListener');
  const webBinding = resolveRuntimeEndpointBinding(config, 'web');
  const marker = options.onboardingMarkers?.effective;
  const findings = buildCliDoctorFindings(options);
  return {
    title: options.doctor ? 'GoodVibes doctor' : 'GoodVibes status',
    workingDirectory: options.workingDirectory,
    homeDirectory: options.homeDirectory,
    provider: {
      provider: getProviderIdFromModel(config.get('provider.model')),
      model: String(config.get('provider.model')),
      reasoning: String(config.get('provider.reasoningEffort')),
    },
    auth: {
      permissionMode: config.get('permissions.mode'),
      permissionLabel: permissionModeLabel(config.get('permissions.mode')),
      secretPolicy: config.get('storage.secretPolicy'),
      secretPolicyLabel: secretPolicyLabel(config.get('storage.secretPolicy')),
      localUsers: options.auth ?? null,
    },
    service: {
      enabled: config.get('service.enabled'),
      autostart: config.get('service.autostart'),
      restartOnFailure: config.get('service.restartOnFailure'),
      ...(options.service ? { lifecycle: options.service } : {}),
    },
    surfaces: {
      controlPlane: { enabled: config.get('controlPlane.enabled'), ...controlPlaneBinding },
      httpListener: { enabled: config.get('danger.httpListener'), ...httpListenerBinding },
      web: { enabled: config.get('web.enabled'), ...webBinding },
    },
    onboarding: {
      checked: Boolean(marker?.exists),
      scope: marker?.scope ?? 'none',
      updatedAt: marker?.payload?.updatedAt ?? null,
    },
    findings,
  };
}

export function renderCliStatus(options: CliStatusOptions): string {
  const config = options.configManager;
  const snapshot = buildCliStatusSnapshot(options);
  const serviceEnabled = snapshot.service.enabled;
  const serviceAutostart = snapshot.service.autostart;
  const restartOnFailure = snapshot.service.restartOnFailure;
  const controlPlaneEnabled = snapshot.surfaces.controlPlane.enabled;
  const listenerEnabled = snapshot.surfaces.httpListener.enabled;
  const webEnabled = snapshot.surfaces.web.enabled;
  const controlPlaneBinding = snapshot.surfaces.controlPlane;
  const httpListenerBinding = snapshot.surfaces.httpListener;
  const webBinding = snapshot.surfaces.web;
  const marker = options.onboardingMarkers?.effective;
  const findings = snapshot.findings;

  if (options.outputFormat === 'json') return JSON.stringify(snapshot, null, 2);

  const lines = [
    snapshot.title,
    `  workingDir: ${options.workingDirectory}`,
    `  homeDir: ${options.homeDirectory}`,
    '',
    'Provider:',
    `  provider: ${getProviderIdFromModel(config.get('provider.model'))}`,
    `  model: ${String(config.get('provider.model'))}`,
    `  reasoning: ${String(config.get('provider.reasoningEffort'))}`,
    '',
    'Auth:',
    `  permissions: ${permissionModeLabel(config.get('permissions.mode'))} (${String(config.get('permissions.mode'))})`,
    `  secretPolicy: ${secretPolicyLabel(config.get('storage.secretPolicy'))} (${String(config.get('storage.secretPolicy'))})`,
    options.auth
      ? `  localUsers: ${options.auth.userStorePresent ? 'present' : 'missing'} (${options.auth.userStorePath})`
      : '  localUsers: unknown',
    options.auth
      ? `  bootstrapCredential: ${options.auth.bootstrapCredentialPresent ? 'present' : 'missing'} (${options.auth.bootstrapCredentialPath})`
      : '  bootstrapCredential: unknown',
    options.auth
      ? `  operatorTokens: ${options.auth.operatorTokenPresent ? 'present' : 'missing'} (${options.auth.operatorTokenPath})`
      : '  operatorTokens: unknown',
    '',
    'Service:',
    `  enabled: ${yesNo(serviceEnabled)}`,
    `  autostart: ${yesNo(serviceAutostart)}`,
    `  restartOnFailure: ${yesNo(restartOnFailure)}`,
    ...(options.service ? [
      `  platform: ${options.service.managed.platform}`,
      `  installed: ${yesNo(options.service.managed.installed)}`,
      `  running: ${yesNo(options.service.managed.running)}`,
      `  pid: ${options.service.managed.pid ?? 'n/a'}`,
      `  definition: ${options.service.managed.path}`,
      `  log: ${options.service.log.path ?? 'n/a'} (${options.service.log.exists ? 'present' : 'missing'})`,
    ] : []),
    '',
    'Surfaces:',
    bindLine('controlPlane', controlPlaneEnabled, controlPlaneBinding),
    bindLine('httpListener', listenerEnabled, httpListenerBinding),
    bindLine('web', webEnabled, webBinding),
    '',
    'Onboarding:',
    `  checked: ${marker?.exists ? 'yes' : 'no'}`,
    `  scope: ${marker?.scope ?? 'none'}`,
    `  updatedAt: ${marker?.payload ? new Date(marker.payload.updatedAt).toISOString() : 'n/a'}`,
  ];

  if (options.doctor) {
    lines.push('', 'Warnings:');
    if (findings.length === 0) {
      lines.push('  none');
    } else {
      for (const finding of findings) {
        lines.push(
          `  - [${finding.severity}:${finding.area}:${finding.id}] ${finding.summary}`,
          `    cause: ${finding.cause}`,
          `    impact: ${finding.impact}`,
          `    action: ${finding.action}`,
        );
      }
    }
  }

  return lines.join('\n');
}

export function renderOnboardingCliStatus(options: CliStatusOptions): string {
  const marker = options.onboardingMarkers?.effective;
  return [
    'GoodVibes onboarding status',
    `  checked: ${marker?.exists ? 'yes' : 'no'}`,
    `  scope: ${marker?.scope ?? 'none'}`,
    `  source: ${marker?.payload?.source ?? 'n/a'}`,
    `  mode: ${marker?.payload?.mode ?? 'n/a'}`,
    `  updatedAt: ${marker?.payload ? new Date(marker.payload.updatedAt).toISOString() : 'n/a'}`,
    `  workingDir: ${options.workingDirectory}`,
  ].join('\n');
}
