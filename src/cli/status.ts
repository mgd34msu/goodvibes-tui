import type { ConfigManager } from '@pellux/goodvibes-sdk/platform/config';
import { resolveDaemonEnabled } from '@pellux/goodvibes-sdk/platform/config';
import type { OnboardingCheckMarkersState } from '../runtime/onboarding/index.ts';
import { formatRuntimeEndpointBinding, resolveRuntimeEndpointBinding } from '@pellux/goodvibes-terminal-shell';
import type { RuntimeEndpointBinding, RuntimeEndpointId } from '@pellux/goodvibes-terminal-shell';
import { classifyBindPosture, isNetworkFacing } from './network-posture.ts';
import type { GoodVibesCliOutputFormat } from '@pellux/goodvibes-terminal-shell';
import type { CliServicePosture } from './service-posture.ts';
import type { InstallSelfCheckFinding } from '../runtime/install-self-check.ts';
import { getProviderIdFromModel } from '../config/provider-model.ts';
import { describeConfiguredEffort } from '../providers/reasoning-effort-surface.ts';

export interface CliStatusOptions {
  readonly configManager: Pick<ConfigManager, 'get'>;
  readonly workingDirectory: string;
  readonly homeDirectory: string;
  readonly onboardingMarkers?: OnboardingCheckMarkersState;
  readonly auth?: CliAuthStatus;
  readonly service?: CliServicePosture;
  /** Findings from the install self-check (missing vendor binaries, broken daemon path), computed by the caller. */
  readonly install?: readonly InstallSelfCheckFinding[];
  readonly doctor?: boolean;
  readonly outputFormat?: GoodVibesCliOutputFormat;
  /** Per-workspace trust + registration posture, computed read-only by the caller. */
  readonly workspace?: CliWorkspaceStatus;
  /** Per-command exec sandbox availability, host-probed by the caller. */
  readonly sandbox?: CliSandboxStatus;
  /** Outbound relay reachability posture (config + feature-flag gate only — a one-shot CLI process has no live connection to inspect). */
  readonly relay?: CliRelayStatus;
}

/** Config-derived relay posture. No live socket check — see doctor's other surfaces for the same honesty bar. */
export interface CliRelayStatus {
  readonly configEnabled: boolean;
  readonly featureEnabled: boolean;
  readonly url: string;
  readonly rendezvousId: string;
  readonly requireStepUpForMutations: boolean;
}

/** Honest per-command exec sandbox posture for the report. */
export interface CliSandboxStatus {
  /** `sandbox.enabled` config switch. */
  readonly configEnabled: boolean;
  /** The graduation-gated `exec-sandbox` feature flag. */
  readonly featureEnabled: boolean;
  /** Host can actually provide a boundary (bubblewrap present and working). */
  readonly available: boolean;
  readonly backend: 'bubblewrap' | 'none';
  /** Host-probe diagnosis (why unavailable) or one-line availability summary. */
  readonly reason: string;
  /** Whether `--unshare-net` isolation is confirmed on this host, or unknown. */
  readonly networkIsolationGuaranteed: boolean;
}

/** Read-only snapshot of this workspace's trust gate and registration coverage. */
export interface CliWorkspaceStatus {
  /** TUI-local trust decision; 'undecided' when no choice is persisted yet. */
  readonly trustLevel: 'trusted' | 'restricted' | 'undecided';
  readonly trustGrandfathered: boolean;
  /** Coverage verdict from the shared workspace registry. */
  readonly registrationStatus: 'covered' | 'declined' | 'unknown';
  /** Normalized working directory resolved against the registry. */
  readonly registrationRoot: string;
  /** Nearest registered root covering this path, or null. */
  readonly registeredBy: string | null;
  /** Coverage inherited through the git worktree→main-repo link. */
  readonly viaWorktreeLink: boolean;
  /** True when the root is too broad to register ($HOME, filesystem root, ~/.goodvibes). */
  readonly registrationBroad: boolean;
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
  readonly area: 'auth' | 'network' | 'onboarding' | 'security' | 'service' | 'secrets' | 'install' | 'sandbox';
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
    /**
     * What the configured reasoning level actually becomes on the configured
     * model. The level alone is not the whole truth: a model that does not
     * offer it gets the next level down, and a model with no configurable
     * reasoning gets nothing sent at all.
     */
    readonly reasoningResolved: string;
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
  readonly workspace: CliWorkspaceStatus | null;
  readonly sandbox: CliSandboxStatus | null;
  readonly relay: CliRelayStatus | null;
  readonly exposure: readonly CliExposureSurface[];
  readonly findings: readonly CliDoctorFinding[];
}

/**
 * Per-surface exposure report row: what a network surface binds to, how it
 * authenticates callers, and what cross-origin allowlist (if any) applies.
 * A plain report — it changes no behavior and writes no config.
 */
export interface CliExposureSurface {
  readonly id: RuntimeEndpointId;
  readonly label: string;
  readonly enabled: boolean;
  /** Bind envelope, e.g. "network 0.0.0.0:3421". */
  readonly bind: string;
  /** Reachability posture label, e.g. "Local only" / "Local Network" / "Custom network". */
  readonly reach: string;
  readonly networkFacing: boolean;
  /** How callers authenticate against this surface when it is network-facing. */
  readonly authMode: string;
  /** Browser-origin allowlist state. Only the control plane has one; others report n/a. */
  readonly originAllowlist: string;
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

function bindLine(label: string, enabled: unknown, binding: RuntimeEndpointBinding): string {
  return `  ${label}: ${yesNo(enabled)} (${formatRuntimeEndpointBinding(binding)})`;
}

/** Describe registration coverage for the Workspace status section. */
function registrationLine(workspace: CliWorkspaceStatus): string {
  switch (workspace.registrationStatus) {
    case 'covered':
      return workspace.viaWorktreeLink
        ? `registered (via worktree link to ${workspace.registeredBy})`
        : `registered (covered by ${workspace.registeredBy})`;
    case 'declined':
      return 'not registered (declined for this directory)';
    case 'unknown':
      return workspace.registrationBroad
        ? 'not registered (root too broad to register)'
        : 'not registered (never asked)';
  }
}

/** The `Workspace:` block showing the TUI-local trust gate and shared-registry coverage. */
function renderWorkspaceSection(workspace: CliWorkspaceStatus | null): string[] {
  if (!workspace) return [];
  return [
    'Workspace:',
    `  trust: ${workspace.trustLevel}${workspace.trustGrandfathered ? ' (grandfathered)' : ''}`,
    `  registration: ${registrationLine(workspace)}`,
    `  root: ${workspace.registrationRoot}`,
    '',
  ];
}

/** The `Exec sandbox:` block — honest host-probed availability of the per-command boundary. */
function renderSandboxSection(sandbox: CliSandboxStatus | null): string[] {
  if (!sandbox) return [];
  const active = sandbox.configEnabled && sandbox.featureEnabled && sandbox.available;
  const network = !sandbox.available
    ? 'n/a'
    : sandbox.networkIsolationGuaranteed
      ? 'isolation confirmed'
      : 'isolation unknown';
  return [
    'Exec sandbox:',
    `  active: ${active ? 'yes' : 'no'}`,
    `  configEnabled: ${yesNo(sandbox.configEnabled)}`,
    `  featureEnabled: ${yesNo(sandbox.featureEnabled)}`,
    `  backend: ${sandbox.backend}`,
    `  available: ${yesNo(sandbox.available)}`,
    `  network: ${network}`,
    `  detail: ${sandbox.reason}`,
    '',
  ];
}

/**
 * The `Relay:` block — config + feature-flag gate only. The live registration
 * state lives in the running daemon's memory and no verb exposes it, so no
 * client reads it: this CLI reports the gate, and `/relay status` in the
 * terminal app reports the same gate plus an honest "not readable here" for the
 * live half. "active" means the gate that lets a running daemon register.
 */
function renderRelaySection(relay: CliRelayStatus | null): string[] {
  if (!relay) return [];
  const active = relay.configEnabled && relay.featureEnabled;
  return [
    'Relay:',
    `  active: ${active ? 'yes (a running daemon will register)' : 'no'}`,
    `  configEnabled (relay.enabled): ${yesNo(relay.configEnabled)}`,
    `  featureEnabled (relay-connect flag): ${yesNo(relay.featureEnabled)}`,
    `  url: ${relay.url || '(not set)'}`,
    `  rendezvousId: ${relay.rendezvousId || '(not yet minted)'}`,
    `  requireStepUpForMutations: ${yesNo(relay.requireStepUpForMutations)}`,
    '  Threat model: the relay operator sees only ciphertext and connection metadata — self-host your own relay for full control.',
    '',
  ];
}

/**
 * How callers authenticate against a surface, derived from the auth material
 * the CLI already inspects. A loopback surface trusts the local host; a
 * network-facing surface is authenticated by a local user store and/or an
 * operator token, and reports "none configured" when neither exists.
 */
function surfaceAuthMode(networkFacing: boolean, auth: CliAuthStatus | undefined): string {
  if (!networkFacing) return 'loopback (host-local trust)';
  if (!auth) return 'unknown';
  const parts: string[] = [];
  if (auth.userStorePresent) parts.push('local users');
  if (auth.operatorTokenPresent) parts.push('operator token');
  if (parts.length === 0) return 'none configured';
  return parts.join(' + ');
}

/** Comma-separated CORS origins, trimmed and emptied of blanks. */
function parseAllowedOrigins(raw: unknown): string[] {
  return String(raw ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
}

/**
 * The only browser-origin allowlist in this codebase belongs to the control
 * plane (controlPlane.cors.*). httpListener and web have no origin allowlist
 * concept, so this returns an honest n/a for them.
 */
function surfaceOriginAllowlist(id: RuntimeEndpointId, config: Pick<ConfigManager, 'get'>): string {
  if (id !== 'controlPlane') return 'n/a (no origin allowlist for this surface)';
  if (config.get('controlPlane.cors.enabled') !== true) return 'CORS off (same-origin only)';
  const origins = parseAllowedOrigins(config.get('controlPlane.cors.allowedOrigins'));
  if (origins.length === 0) return 'CORS on, empty allowlist (refuses all cross-origin)';
  if (origins.includes('*')) return `CORS on, WILDCARD any-origin (${origins.join(', ')})`;
  return `CORS on, allowlist: ${origins.join(', ')}`;
}

const EXPOSURE_SURFACES: readonly { readonly id: RuntimeEndpointId; readonly label: string; readonly enabledKey: string }[] = [
  { id: 'controlPlane', label: 'controlPlane', enabledKey: 'controlPlane.enabled' },
  { id: 'httpListener', label: 'httpListener', enabledKey: 'danger.httpListener' },
  { id: 'web', label: 'web', enabledKey: 'web.enabled' },
];

/**
 * Build the per-surface exposure report (bind address, auth mode, origin
 * allowlist) for every network surface. Pure over the status options — a
 * report only, no behavior change.
 */
export function buildCliExposureReport(options: CliStatusOptions): readonly CliExposureSurface[] {
  const config = options.configManager;
  return EXPOSURE_SURFACES.map((surface): CliExposureSurface => {
    const enabled = config.get(surface.enabledKey as never) === true;
    const binding = resolveRuntimeEndpointBinding(config, surface.id);
    const networkFacing = isNetworkFacing(enabled, binding);
    return {
      id: surface.id,
      label: surface.label,
      enabled,
      bind: formatRuntimeEndpointBinding(binding),
      reach: binding.recognized ? classifyBindPosture(binding).label : 'Unknown (unrecognized host mode)',
      networkFacing,
      authMode: surfaceAuthMode(networkFacing, options.auth),
      originAllowlist: surfaceOriginAllowlist(surface.id, config),
    };
  });
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

  // An unrecognized hostMode has NO binding the SDK can produce (its bind
  // resolver has no default case — the daemon throws before binding), so it
  // is surfaced as a doctor finding on every endpoint that carries one,
  // instead of the fallback loopback binding being presented as fact.
  for (const [endpointId, endpointLabel, endpointBinding] of [
    ['controlPlane', 'control plane', controlPlaneBinding],
    ['httpListener', 'HTTP listener', httpListenerBinding],
    ['web', 'web surface', webBinding],
  ] as const) {
    if (endpointBinding.recognized) continue;
    findings.push({
      id: `unrecognized-host-mode-${endpointId}`,
      area: 'service',
      severity: 'warning',
      summary: `${endpointLabel} hostMode '${endpointBinding.hostMode}' is not a recognized mode.`,
      cause: `${endpointId}.hostMode is set to '${endpointBinding.hostMode}', but only local|network|custom are recognized.`,
      impact: 'The daemon cannot resolve a binding for this endpoint and will fail to start it; displays cannot show a real bind address.',
      action: `Set ${endpointId}.hostMode to local, network, or custom.`,
    });
  }

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

  if (isNetworkFacing(controlPlaneEnabled, controlPlaneBinding)
    && config.get('controlPlane.cors.enabled') === true
    && parseAllowedOrigins(config.get('controlPlane.cors.allowedOrigins')).includes('*')) {
    findings.push({
      id: 'control-plane-cors-wildcard-origin',
      area: 'network',
      severity: 'risk',
      summary: 'The control plane accepts cross-origin requests from any origin.',
      cause: `controlPlane is ${controlPlaneBinding.hostMode}-bound on ${controlPlaneBinding.host}:${controlPlaneBinding.port}, controlPlane.cors.enabled is true, and controlPlane.cors.allowedOrigins contains a wildcard "*".`,
      impact: 'Any website a signed-in operator visits could make credentialed cross-origin calls to the control plane.',
      action: 'Replace the wildcard with an explicit list of trusted browser origins in controlPlane.cors.allowedOrigins.',
    });
  }

  if (options.install) {
    for (const finding of options.install) {
      findings.push({
        id: `install-${finding.id}`,
        area: 'install',
        severity: 'warning',
        summary: finding.summary,
        cause: finding.detail,
        impact: 'The daemon and any background surfaces (control plane, listener, web) may fail to start until the install is repaired.',
        action: `Repair this install by running: ${finding.repairCommand}`,
      });
    }
  }

  // Exec sandbox requested but the host cannot provide a boundary: the exec tool
  // silently runs unsandboxed and the approval flow keeps prompting. Flag it so
  // the operator knows the boundary they turned on is not in force.
  if (options.sandbox && options.sandbox.configEnabled && options.sandbox.featureEnabled && !options.sandbox.available) {
    findings.push({
      id: 'exec-sandbox-unavailable',
      area: 'sandbox',
      severity: 'warning',
      summary: 'The per-command exec sandbox is enabled but unavailable on this host.',
      cause: options.sandbox.reason,
      impact: 'Exec commands run unsandboxed and boundary-safe commands still prompt instead of auto-allowing.',
      action: 'Install bubblewrap (bwrap) on Linux, or disable sandbox.enabled to stop requesting a boundary this host cannot provide.',
    });
  }

  return findings;
}

/**
 * The doctor command's exit code. Advisory findings (`severity: 'warning'`)
 * are notes on an otherwise-usable install and must never make a healthy
 * install report failure — only a must-fix (`severity: 'risk'`) finding
 * exits non-zero. `strict` (for CI) flips warnings to failures too, so a
 * pipeline can require a fully clean report instead of just "usable".
 */
export function resolveDoctorExitCode(findings: readonly CliDoctorFinding[], strict = false): number {
  if (findings.some((finding) => finding.severity === 'risk')) return 1;
  if (strict && findings.length > 0) return 1;
  return 0;
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
      reasoningResolved: describeConfiguredEffort(
        String(config.get('provider.model') ?? ''),
        String(config.get('provider.reasoningEffort') ?? ''),
      ),
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
    workspace: options.workspace ?? null,
    sandbox: options.sandbox ?? null,
    relay: options.relay ?? null,
    exposure: buildCliExposureReport(options),
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
    `  reasoning (on this model): ${describeConfiguredEffort(
      String(config.get('provider.model') ?? ''),
      String(config.get('provider.reasoningEffort') ?? ''),
    )}`,
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
    '',
    ...renderWorkspaceSection(snapshot.workspace),
    ...renderSandboxSection(snapshot.sandbox),
    ...renderRelaySection(snapshot.relay),
    'Exposure (report only — no changes made):',
    ...snapshot.exposure.flatMap((surface) => [
      `  ${surface.label}: ${yesNo(surface.enabled)} · ${surface.reach}${surface.networkFacing ? ' · network-facing' : ''}`,
      `    bind: ${surface.bind}`,
      `    auth: ${surface.authMode}`,
      `    originAllowlist: ${surface.originAllowlist}`,
    ]),
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
