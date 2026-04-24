import type { ConfigManager } from '@pellux/goodvibes-sdk/platform/config/manager';
import type { OnboardingCompletionMarkersState } from '../runtime/onboarding/index.ts';
import { resolveRuntimeEndpointBinding } from './endpoints.ts';

export interface CliStatusOptions {
  readonly configManager: Pick<ConfigManager, 'get'>;
  readonly workingDirectory: string;
  readonly homeDirectory: string;
  readonly onboardingMarkers?: OnboardingCompletionMarkersState;
  readonly auth?: CliAuthStatus;
  readonly doctor?: boolean;
}

export interface CliAuthStatus {
  readonly userStorePath: string;
  readonly userStorePresent: boolean;
  readonly bootstrapCredentialPath: string;
  readonly bootstrapCredentialPresent: boolean;
  readonly operatorTokenPath: string;
  readonly operatorTokenPresent: boolean;
}

function yesNo(value: unknown): string {
  return value === true ? 'yes' : 'no';
}

function bindLine(label: string, enabled: unknown, binding: { readonly hostMode: string; readonly host: string; readonly port: number }): string {
  return `  ${label}: ${yesNo(enabled)} (${binding.hostMode} ${binding.host}:${binding.port})`;
}

export function renderCliStatus(options: CliStatusOptions): string {
  const config = options.configManager;
  const serviceEnabled = config.get('service.enabled');
  const serviceAutostart = config.get('service.autostart');
  const restartOnFailure = config.get('service.restartOnFailure');
  const daemonEnabled = config.get('danger.daemon');
  const listenerEnabled = config.get('danger.httpListener');
  const webEnabled = config.get('web.enabled');
  const controlPlaneEnabled = config.get('controlPlane.enabled');
  const controlPlaneBinding = resolveRuntimeEndpointBinding(config, 'controlPlane');
  const httpListenerBinding = resolveRuntimeEndpointBinding(config, 'httpListener');
  const webBinding = resolveRuntimeEndpointBinding(config, 'web');
  const marker = options.onboardingMarkers?.effective;
  const warnings: string[] = [];

  if ((daemonEnabled || controlPlaneEnabled || listenerEnabled || webEnabled) && !serviceEnabled) {
    warnings.push('server-backed surfaces are enabled but service.enabled is off');
  }
  if (serviceEnabled && !serviceAutostart) warnings.push('service.enabled is on but service.autostart is off');
  if (serviceEnabled && !restartOnFailure) warnings.push('service.enabled is on but service.restartOnFailure is off');
  if (!marker?.payload) warnings.push('onboarding has not been completed for this user/project');

  const lines = [
    options.doctor ? 'GoodVibes doctor' : 'GoodVibes status',
    `  workingDir: ${options.workingDirectory}`,
    `  homeDir: ${options.homeDirectory}`,
    '',
    'Provider:',
    `  provider: ${String(config.get('provider.provider'))}`,
    `  model: ${String(config.get('provider.model'))}`,
    `  reasoning: ${String(config.get('provider.reasoningEffort'))}`,
    '',
    'Auth:',
    `  permissions: ${String(config.get('permissions.mode'))}`,
    `  secretPolicy: ${String(config.get('storage.secretPolicy'))}`,
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
    '',
    'Surfaces:',
    bindLine('controlPlane', controlPlaneEnabled, controlPlaneBinding),
    bindLine('httpListener', listenerEnabled, httpListenerBinding),
    bindLine('web', webEnabled, webBinding),
    '',
    'Onboarding:',
    `  completed: ${marker?.payload ? 'yes' : 'no'}`,
    `  scope: ${marker?.scope ?? 'none'}`,
    `  updatedAt: ${marker?.payload ? new Date(marker.payload.updatedAt).toISOString() : 'n/a'}`,
  ];

  if (options.doctor) {
    lines.push('', 'Warnings:');
    if (warnings.length === 0) lines.push('  none');
    else lines.push(...warnings.map((warning) => `  - ${warning}`));
  }

  return lines.join('\n');
}

export function renderOnboardingCliStatus(options: CliStatusOptions): string {
  const marker = options.onboardingMarkers?.effective;
  return [
    'GoodVibes onboarding status',
    `  completed: ${marker?.payload ? 'yes' : 'no'}`,
    `  scope: ${marker?.scope ?? 'none'}`,
    `  source: ${marker?.payload?.source ?? 'n/a'}`,
    `  mode: ${marker?.payload?.mode ?? 'n/a'}`,
    `  updatedAt: ${marker?.payload ? new Date(marker.payload.updatedAt).toISOString() : 'n/a'}`,
    `  workingDir: ${options.workingDirectory}`,
  ].join('\n');
}
