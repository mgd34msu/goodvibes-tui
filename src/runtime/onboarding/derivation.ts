import { DEFAULT_CONFIG } from '../../config/index.ts';
import type {
  OnboardingAcknowledgementState,
  OnboardingAcknowledgementTarget,
  OnboardingNetworkMode,
  OnboardingReopenEditAcknowledgementState,
  OnboardingSnapshotState,
  OnboardingStep1CapabilityItem,
  OnboardingStepDerivationState,
} from './types.ts';

const PROVIDER_SECRET_ENV_ALIASES = {
  openai: ['OPENAI_API_KEY', 'OPENAI_KEY'],
  anthropic: ['ANTHROPIC_API_KEY', 'CLAUDE_API_KEY'],
  gemini: ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_GEMINI_API_KEY'],
  inceptionlabs: ['INCEPTION_API_KEY'],
  openrouter: ['OPENROUTER_API_KEY'],
  aihubmix: ['AIHUBMIX_API_KEY'],
  groq: ['GROQ_API_KEY'],
  cerebras: ['CEREBRAS_API_KEY'],
  mistral: ['MISTRAL_API_KEY'],
  'ollama-cloud': ['OLLAMA_CLOUD_API_KEY', 'OLLAMA_API_KEY'],
  huggingface: ['HF_API_KEY', 'HUGGINGFACE_API_KEY', 'HF_TOKEN'],
  nvidia: ['NVIDIA_API_KEY'],
  llm7: ['LLM7_API_KEY'],
  deepseek: ['DEEPSEEK_API_KEY'],
  fireworks: ['FIREWORKS_API_KEY'],
  'github-copilot': ['COPILOT_GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN'],
  'microsoft-foundry': ['AZURE_OPENAI_API_KEY'],
  minimax: ['MINIMAX_API_KEY'],
  moonshot: ['MOONSHOT_API_KEY'],
  qianfan: ['QIANFAN_API_KEY'],
  qwen: ['QWEN_API_KEY', 'DASHSCOPE_API_KEY', 'MODELSTUDIO_API_KEY'],
  sglang: ['SGLANG_API_KEY'],
  stepfun: ['STEPFUN_API_KEY'],
  together: ['TOGETHER_API_KEY'],
  venice: ['VENICE_API_KEY'],
  volcengine: ['VOLCANO_ENGINE_API_KEY'],
  xai: ['XAI_API_KEY'],
  xiaomi: ['XIAOMI_API_KEY'],
  zai: ['ZAI_API_KEY', 'Z_AI_API_KEY'],
  'cloudflare-ai-gateway': ['CLOUDFLARE_AI_GATEWAY_API_KEY'],
  'vercel-ai-gateway': ['AI_GATEWAY_API_KEY'],
  litellm: ['LITELLM_API_KEY'],
  'copilot-proxy': ['COPILOT_PROXY_API_KEY'],
} as const satisfies Record<string, readonly string[]>;

const SECRET_KEY_TO_PROVIDER_IDS = new Map<string, readonly string[]>(
  Object.entries(PROVIDER_SECRET_ENV_ALIASES).flatMap(([providerId, aliases]) => aliases.map((alias) => [alias, [providerId] as const])),
);

const INBOUND_EVENT_SURFACE_KINDS = new Set<string>([
  'bluebubbles',
  'discord',
  'google-chat',
  'googleChat',
  'imessage',
  'mattermost',
  'matrix',
  'msteams',
  'ntfy',
  'signal',
  'slack',
  'telegram',
  'webhook',
  'whatsapp',
]);

function isDeepEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((value, index) => isDeepEqual(value, right[index]));
  }

  if (
    typeof left === 'object' && left !== null
    && typeof right === 'object' && right !== null
    && !Array.isArray(left)
    && !Array.isArray(right)
  ) {
    const leftEntries = Object.entries(left);
    const rightEntries = Object.entries(right);
    if (leftEntries.length !== rightEntries.length) return false;

    return leftEntries.every(([key, value]) => isDeepEqual(value, (right as Record<string, unknown>)[key]));
  }

  return false;
}

function countPermissionToolOverrides(snapshot: OnboardingSnapshotState): number {
  return Object.entries(snapshot.config.permissions.tools).filter(([key, value]) => {
    if (value === undefined) return false;
    return value !== DEFAULT_CONFIG.permissions.tools[key as keyof typeof DEFAULT_CONFIG.permissions.tools];
  }).length;
}

function hasCustomizedProviderRouting(snapshot: OnboardingSnapshotState): boolean {
  return snapshot.providerRouting.primaryProviderId !== DEFAULT_CONFIG.provider.provider
    || snapshot.providerRouting.primaryModelId !== DEFAULT_CONFIG.provider.model
    || snapshot.providerRouting.primaryReasoningEffort !== DEFAULT_CONFIG.provider.reasoningEffort
    || snapshot.providerRouting.embeddingProviderId !== DEFAULT_CONFIG.provider.embeddingProvider
    || snapshot.providerRouting.systemPromptFile.trim() !== DEFAULT_CONFIG.provider.systemPromptFile.trim()
    || snapshot.providerRouting.helperEnabled !== DEFAULT_CONFIG.helper.enabled
    || snapshot.providerRouting.helperProviderId !== DEFAULT_CONFIG.helper.globalProvider
    || snapshot.providerRouting.helperModelId !== DEFAULT_CONFIG.helper.globalModel
    || snapshot.providerRouting.toolLlmEnabled !== DEFAULT_CONFIG.tools.llmEnabled
    || snapshot.providerRouting.toolProviderId !== DEFAULT_CONFIG.tools.llmProvider
    || snapshot.providerRouting.toolModelId !== DEFAULT_CONFIG.tools.llmModel;
}

function getProviderAccountSignalIds(snapshot: OnboardingSnapshotState): string[] {
  return (snapshot.providerAccounts?.providers ?? [])
    .filter((provider) => provider.activeRoute !== 'unconfigured' || provider.pendingLogin || provider.oauthReady)
    .map((provider) => provider.providerId);
}

function getServiceCredentialProviderIds(snapshot: OnboardingSnapshotState): string[] {
  return snapshot.services.services
    .filter((service) => service.hasPrimaryCredential || service.hasPasswordCredential)
    .map((service) => service.providerId);
}

function getSecretBackedProviderIds(snapshot: OnboardingSnapshotState): string[] {
  const providerIds = new Set<string>();

  for (const record of snapshot.secrets.records) {
    const matches = SECRET_KEY_TO_PROVIDER_IDS.get(record.key);
    if (!matches) continue;
    for (const providerId of matches) providerIds.add(providerId);
  }

  return [...providerIds].sort((left, right) => left.localeCompare(right));
}

function getConfiguredProviderSignalIds(snapshot: OnboardingSnapshotState): string[] {
  return [...new Set<string>([
    ...getProviderAccountSignalIds(snapshot),
    ...snapshot.services.oauthProviderIds,
    ...getServiceCredentialProviderIds(snapshot),
    ...snapshot.subscriptions.activeProviderIds,
    ...snapshot.subscriptions.pendingProviderIds,
    ...getSecretBackedProviderIds(snapshot),
  ])].sort((left, right) => left.localeCompare(right));
}

function hasConfiguredProviderState(snapshot: OnboardingSnapshotState): boolean {
  return getConfiguredProviderSignalIds(snapshot).length > 0;
}

function countConfiguredSurfaceKinds(snapshot: OnboardingSnapshotState): number {
  return new Set<string>([
    ...snapshot.surfaces.configuredEnabledKinds,
    ...snapshot.surfaces.records.filter((surface) => surface.enabled).map((surface) => surface.kind),
  ]).size;
}

function hasInboundEventSurface(snapshot: OnboardingSnapshotState): boolean {
  return snapshot.surfaces.configuredEnabledKinds.some((kind) => INBOUND_EVENT_SURFACE_KINDS.has(kind))
    || snapshot.surfaces.records.some((surface) => surface.enabled && INBOUND_EVENT_SURFACE_KINDS.has(surface.kind));
}

function hasCustomizedWorkspaceDefaults(snapshot: OnboardingSnapshotState): boolean {
  return !isDeepEqual(snapshot.config.behavior, DEFAULT_CONFIG.behavior)
    || !isDeepEqual(snapshot.config.display, DEFAULT_CONFIG.display);
}

function hasAnyServerEnabled(snapshot: OnboardingSnapshotState): boolean {
  return snapshot.bindSettings.daemonEnabled
    || snapshot.bindSettings.controlPlane.enabled
    || snapshot.bindSettings.httpListenerEnabled
    || snapshot.bindSettings.web.enabled;
}

function hasBrowserAccess(snapshot: OnboardingSnapshotState): boolean {
  return snapshot.bindSettings.web.enabled;
}

function isLoopbackHost(host: string | null | undefined): boolean {
  const normalized = (host ?? '').trim().toLowerCase();
  if (normalized.length === 0) return false;
  return normalized === 'localhost'
    || normalized === '::1'
    || normalized === '[::1]'
    || normalized === '0:0:0:0:0:0:0:1'
    || /^127(?:\.\d{1,3}){3}$/.test(normalized);
}

function isRemoteBind(hostMode: string, host: string | null | undefined, allowRemote = false): boolean {
  if (hostMode === 'network') return true;
  if (hostMode === 'local') return allowRemote;
  if (hostMode === 'custom') return !isLoopbackHost(host);
  return false;
}

function hasRemoteDeviceAccess(snapshot: OnboardingSnapshotState): boolean {
  return (
    ((snapshot.bindSettings.daemonEnabled || snapshot.bindSettings.controlPlane.enabled)
      && isRemoteBind(
        snapshot.bindSettings.controlPlane.hostMode,
        snapshot.bindSettings.controlPlane.host,
        snapshot.bindSettings.controlPlane.allowRemote,
      ))
    || (snapshot.bindSettings.web.enabled && isRemoteBind(
      snapshot.bindSettings.web.hostMode,
      snapshot.bindSettings.web.host,
    ))
  );
}

function hasWebhookOrEventIngress(snapshot: OnboardingSnapshotState): boolean {
  return snapshot.bindSettings.httpListenerEnabled
    || hasInboundEventSurface(snapshot)
    || snapshot.services.services.some((service) => service.hasWebhookUrl || service.hasSigningSecret || service.hasPublicKey || service.hasAppToken);
}

function getProviderIdentityIds(snapshot: OnboardingSnapshotState): Set<string> {
  return new Set<string>([
    ...Object.keys(PROVIDER_SECRET_ENV_ALIASES),
    ...getConfiguredProviderSignalIds(snapshot),
    snapshot.providerRouting.primaryProviderId,
    snapshot.providerRouting.embeddingProviderId,
    snapshot.providerRouting.helperProviderId,
    snapshot.providerRouting.toolProviderId,
  ].filter((value) => value.trim().length > 0));
}

function getExternalIntegrationServiceIds(snapshot: OnboardingSnapshotState): string[] {
  const providerIdentityIds = getProviderIdentityIds(snapshot);

  return snapshot.services.services
    .filter((service) => !providerIdentityIds.has(service.providerId) && !providerIdentityIds.has(service.name))
    .map((service) => service.name);
}

function hasExternalIntegrations(snapshot: OnboardingSnapshotState): boolean {
  return getExternalIntegrationServiceIds(snapshot).length > 0
    || countConfiguredSurfaceKinds(snapshot) > 0;
}

function describeLocalTuiOnly(snapshot: OnboardingSnapshotState): string {
  if (!hasAnyServerEnabled(snapshot)) {
    return 'Use GoodVibes only in this terminal. No browser access, background service, HTTP listener, external app surface, or network setup.';
  }

  return 'Turn off browser access, background services, HTTP listeners, external app surfaces, and network setup.';
}

function describeBrowserAccess(snapshot: OnboardingSnapshotState): string {
  return snapshot.bindSettings.web.enabled
    ? 'Keep the background service and web UI enabled. Network reachability is controlled on the next screen.'
    : 'Run the background service and web UI. GoodVibes will use the local network by default; you can restrict or customize it next.';
}

function describeRemoteDeviceAccess(snapshot: OnboardingSnapshotState): string {
  return hasRemoteDeviceAccess(snapshot)
    ? 'Keep enabled GoodVibes services reachable from other devices on your LAN. Local authentication is required.'
    : 'Make enabled GoodVibes services reachable from other devices on your LAN. Local authentication is required.';
}

function describeWebhookIngress(snapshot: OnboardingSnapshotState): string {
  return hasWebhookOrEventIngress(snapshot)
    ? 'Keep the HTTP listener available for incoming webhooks, callbacks, and automation events.'
    : 'Turn on the HTTP listener for incoming webhooks, callbacks, and automation events.';
}

function describeExternalIntegrations(snapshot: OnboardingSnapshotState): string {
  const integrationCount = new Set<string>([
    ...getExternalIntegrationServiceIds(snapshot),
    ...snapshot.surfaces.configuredEnabledKinds,
    ...snapshot.surfaces.records.filter((surface) => surface.enabled).map((surface) => surface.kind),
  ]).size;

  if (integrationCount === 0) {
    return 'Enable setup screens for Slack, Discord, Telegram, Teams, Matrix, and other app surfaces you choose.';
  }

  return `Review and configure ${integrationCount} detected external app, service, or surface integration signal(s).`;
}

function getAcknowledgementAccepted(
  snapshot: OnboardingSnapshotState,
  target: OnboardingAcknowledgementTarget,
): boolean {
  return snapshot.acknowledgements.accepted[target] === true;
}

function buildNotNeededAcknowledgement(
  snapshot: OnboardingSnapshotState,
  target: OnboardingAcknowledgementTarget,
  detail: string,
): OnboardingAcknowledgementState {
  return {
    required: false,
    accepted: getAcknowledgementAccepted(snapshot, target),
    reason: 'not-needed',
    detail,
  };
}

function buildRequiredAcknowledgement(
  snapshot: OnboardingSnapshotState,
  target: OnboardingAcknowledgementTarget,
  reason: Exclude<OnboardingAcknowledgementState['reason'], 'not-needed'>,
  detail: string,
): OnboardingAcknowledgementState {
  return {
    required: true,
    accepted: getAcknowledgementAccepted(snapshot, target),
    reason,
    detail,
  };
}

export function deriveStep1Capabilities(
  snapshot: OnboardingSnapshotState,
): readonly OnboardingStep1CapabilityItem[] {
  return [
    {
      id: 'local-tui-only',
      label: 'Local TUI Only (No Servers)',
      selected: !hasAnyServerEnabled(snapshot),
      detail: describeLocalTuiOnly(snapshot),
    },
    {
      id: 'browser-access',
      label: 'Open GoodVibes in a Browser',
      selected: hasBrowserAccess(snapshot),
      detail: describeBrowserAccess(snapshot),
    },
    {
      id: 'network-access',
      label: 'Let other devices use GoodVibes',
      selected: hasRemoteDeviceAccess(snapshot),
      detail: describeRemoteDeviceAccess(snapshot),
    },
    {
      id: 'webhook-events',
      label: 'Receive webhooks or events from other tools',
      selected: hasWebhookOrEventIngress(snapshot),
      detail: describeWebhookIngress(snapshot),
    },
    {
      id: 'external-integrations',
      label: 'Connect GoodVibes to external apps and services',
      selected: hasExternalIntegrations(snapshot),
      detail: describeExternalIntegrations(snapshot),
    },
  ];
}

export function deriveStep1CapabilityFlags(
  snapshot: OnboardingSnapshotState,
): {
  readonly providers: boolean;
  readonly services: boolean;
  readonly subscriptions: boolean;
  readonly auth: boolean;
  readonly controlPlane: boolean;
  readonly httpListener: boolean;
  readonly web: boolean;
  readonly surfaces: boolean;
} {
  return {
    providers: hasConfiguredProviderState(snapshot) || hasCustomizedProviderRouting(snapshot),
    services: snapshot.services.total > 0,
    subscriptions: snapshot.subscriptions.active.length > 0 || snapshot.subscriptions.pending.length > 0,
    auth: snapshot.auth.snapshot.userCount > 0
      || snapshot.auth.snapshot.sessionCount > 0
      || snapshot.auth.snapshot.bootstrapCredentialPresent,
    controlPlane: snapshot.bindSettings.daemonEnabled || snapshot.bindSettings.controlPlane.enabled,
    httpListener: snapshot.bindSettings.httpListenerEnabled,
    web: snapshot.bindSettings.web.enabled,
    surfaces: countConfiguredSurfaceKinds(snapshot) > 0,
  };
}

export function deriveStep1_5NetworkMode(
  bindSettings: Pick<OnboardingSnapshotState, 'bindSettings'>['bindSettings'],
): OnboardingNetworkMode {
  const activeModes: string[] = [];
  const hasNetworkFacingSurface = bindSettings.httpListenerEnabled || bindSettings.web.enabled;

  if (
    (bindSettings.daemonEnabled || bindSettings.controlPlane.enabled)
    && (!hasNetworkFacingSurface || bindSettings.controlPlane.hostMode !== 'local')
  ) {
    activeModes.push(bindSettings.controlPlane.hostMode);
  }

  if (bindSettings.httpListenerEnabled) {
    activeModes.push(bindSettings.httpListener.hostMode);
  }

  if (bindSettings.web.enabled) {
    activeModes.push(bindSettings.web.hostMode);
  }

  return activeModes.some((mode) => mode !== 'network') ? 'custom' : 'local-network-default';
}

export function deriveReopenEditAcknowledgementState(
  snapshot: OnboardingSnapshotState,
): OnboardingReopenEditAcknowledgementState {
  const providerAccounts = snapshot.providerAccounts?.providers ?? [];
  const providerPendingCount = providerAccounts.filter((provider) => provider.pendingLogin).length;
  const providerConfiguredCount = providerAccounts.filter((provider) => provider.activeRoute !== 'unconfigured' || provider.oauthReady).length;
  const providerRoutingCustomized = hasCustomizedProviderRouting(snapshot);
  const providerSignalCount = getConfiguredProviderSignalIds(snapshot).length;

  const subscriptionsPendingCount = snapshot.subscriptions.pending.length;
  const subscriptionsActiveCount = snapshot.subscriptions.active.length;

  const authUserCount = snapshot.auth.snapshot.userCount;
  const authSessionCount = snapshot.auth.snapshot.sessionCount;
  const bootstrapCredentialPresent = snapshot.auth.snapshot.bootstrapCredentialPresent;

  const providers = providerPendingCount > 0
    ? buildRequiredAcknowledgement(
        snapshot,
        'providers',
        'pending-login',
        `${providerPendingCount} provider login(s) are still pending completion.`,
      )
    : providerConfiguredCount > 0 || providerSignalCount > 0
      ? buildRequiredAcknowledgement(
          snapshot,
          'providers',
          'configured-routing',
          `${Math.max(providerConfiguredCount, providerSignalCount, 1)} provider auth path(s) are already configured.`,
        )
      : providerRoutingCustomized
        ? buildRequiredAcknowledgement(
            snapshot,
            'providers',
            'customized-config',
            'Provider routing already differs from the default shell configuration.',
          )
        : buildNotNeededAcknowledgement(snapshot, 'providers', 'No existing provider routing needs confirmation.');

  const subscriptions = subscriptionsPendingCount > 0
    ? buildRequiredAcknowledgement(
        snapshot,
        'subscriptions',
        'pending-login',
        `${subscriptionsPendingCount} subscription login(s) are pending completion.`,
      )
    : subscriptionsActiveCount > 0
      ? buildRequiredAcknowledgement(
          snapshot,
          'subscriptions',
          'subscription-state',
          `${subscriptionsActiveCount} stored subscription session(s) already exist.`,
        )
      : buildNotNeededAcknowledgement(snapshot, 'subscriptions', 'No stored subscription sessions need confirmation.');

  const auth = bootstrapCredentialPresent
    ? buildRequiredAcknowledgement(
        snapshot,
        'auth',
        'bootstrap-credential',
        'The local auth bootstrap credential file is still present.',
      )
    : authSessionCount > 0
      ? buildRequiredAcknowledgement(
          snapshot,
          'auth',
          'active-sessions',
          `${authSessionCount} local auth session(s) are currently active.`,
        )
      : authUserCount > 0
        ? buildRequiredAcknowledgement(
            snapshot,
            'auth',
            'auth-state',
            `${authUserCount} local auth user(s) are already configured.`,
          )
        : buildNotNeededAcknowledgement(snapshot, 'auth', 'No local auth state needs confirmation.');

  return {
    providers,
    subscriptions,
    auth,
  };
}

export function deriveOnboardingStepState(
  snapshot: OnboardingSnapshotState,
): OnboardingStepDerivationState {
  return {
    step1Capabilities: deriveStep1Capabilities(snapshot),
    step1_5NetworkMode: deriveStep1_5NetworkMode(snapshot.bindSettings),
    reopenEditAcknowledgements: deriveReopenEditAcknowledgementState(snapshot),
  };
}
