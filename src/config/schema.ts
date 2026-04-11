/**
 * Config schema definitions and metadata for goodvibes-tui.
 */

import { coreConfigDefaults, coreHeadConfigSettings, coreTailConfigSettings } from './schema-domain-core.ts';
import { runtimeConfigDefaults, runtimePrimaryConfigSettings, runtimeSecondaryConfigSettings } from './schema-domain-runtime.ts';
import { surfaceConfigDefaults, surfaceConfigSettings } from './schema-domain-surfaces.ts';

export type PermissionMode = 'prompt' | 'allow-all' | 'custom';
export type PermissionAction = 'allow' | 'prompt' | 'deny';
export type LineNumberMode = 'all' | 'code' | 'off';

/** Persisted feature flag override state stored in config file. */
export type PersistedFlagState = 'enabled' | 'disabled';

export interface PermissionsToolConfig {
  read?: PermissionAction;        // default: 'allow'
  write?: PermissionAction;       // default: 'prompt'
  edit?: PermissionAction;        // default: 'prompt'
  exec?: PermissionAction;        // default: 'prompt'
  find?: PermissionAction;        // default: 'allow'
  fetch?: PermissionAction;       // default: 'prompt'
  analyze?: PermissionAction;     // default: 'allow'
  inspect?: PermissionAction;     // default: 'allow'
  agent?: PermissionAction;       // default: 'prompt'
  state?: PermissionAction;       // default: 'allow'
  workflow?: PermissionAction;    // default: 'prompt'
  registry?: PermissionAction;    // default: 'allow'
  delegate?: PermissionAction;    // default: 'prompt'
  mcp?: PermissionAction;         // default: 'prompt'
}

export interface NotificationsConfig {
  webhookUrls: string[];
}

export interface AutomationConfig {
  enabled: boolean;
  maxConcurrentRuns: number;
  runHistoryLimit: number;
  defaultTimeoutMs: number;
  catchUpWindowMinutes: number;
  failureCooldownMs: number;
  deleteAfterRun: boolean;
}

export interface ControlPlaneConfig {
  enabled: boolean;
  host: string;
  port: number;
  baseUrl: string;
  streamMode: 'sse' | 'websocket' | 'both';
  allowRemote: boolean;
}

export interface WebConfig {
  enabled: boolean;
  host: string;
  port: number;
  publicBaseUrl: string;
  staticAssetsDir: string;
}

export interface SlackSurfaceConfig {
  enabled: boolean;
  signingSecret: string;
  botToken: string;
  appToken: string;
  defaultChannel: string;
  workspaceId: string;
  setupVersion: number;
}

export interface DiscordSurfaceConfig {
  enabled: boolean;
  publicKey: string;
  botToken: string;
  applicationId: string;
  defaultChannelId: string;
  guildId: string;
  setupVersion: number;
}

export interface NtfySurfaceConfig {
  enabled: boolean;
  baseUrl: string;
  topic: string;
  token: string;
  defaultPriority: number;
  setupVersion: number;
}

export interface WebhookSurfaceConfig {
  enabled: boolean;
  defaultTarget: string;
  timeoutMs: number;
  secret: string;
  setupVersion: number;
}

export interface TelegramSurfaceConfig {
  enabled: boolean;
  botToken: string;
  webhookSecret: string;
  defaultChatId: string;
  botUsername: string;
  mode: 'webhook' | 'polling';
  setupVersion: number;
}

export interface GoogleChatSurfaceConfig {
  enabled: boolean;
  webhookUrl: string;
  verificationToken: string;
  appId: string;
  spaceId: string;
  setupVersion: number;
}

export interface SignalSurfaceConfig {
  enabled: boolean;
  bridgeUrl: string;
  account: string;
  token: string;
  defaultRecipient: string;
  setupVersion: number;
}

export interface WhatsAppSurfaceConfig {
  enabled: boolean;
  provider: 'meta-cloud' | 'bridge';
  accessToken: string;
  verifyToken: string;
  phoneNumberId: string;
  businessAccountId: string;
  defaultRecipient: string;
  setupVersion: number;
}

export interface IMessageSurfaceConfig {
  enabled: boolean;
  bridgeUrl: string;
  account: string;
  token: string;
  defaultChatId: string;
  setupVersion: number;
}

export interface MSTeamsSurfaceConfig {
  enabled: boolean;
  appId: string;
  appPassword: string;
  tenantId: string;
  serviceUrl: string;
  botId: string;
  defaultConversationId: string;
  defaultChannelId: string;
  setupVersion: number;
}

export interface BlueBubblesSurfaceConfig {
  enabled: boolean;
  serverUrl: string;
  password: string;
  account: string;
  defaultChatGuid: string;
  setupVersion: number;
}

export interface MattermostSurfaceConfig {
  enabled: boolean;
  baseUrl: string;
  botToken: string;
  teamId: string;
  defaultChannelId: string;
  setupVersion: number;
}

export interface MatrixSurfaceConfig {
  enabled: boolean;
  homeserverUrl: string;
  accessToken: string;
  userId: string;
  defaultRoomId: string;
  setupVersion: number;
}

export interface SurfacesConfig {
  slack: SlackSurfaceConfig;
  discord: DiscordSurfaceConfig;
  ntfy: NtfySurfaceConfig;
  webhook: WebhookSurfaceConfig;
  telegram: TelegramSurfaceConfig;
  googleChat: GoogleChatSurfaceConfig;
  signal: SignalSurfaceConfig;
  whatsapp: WhatsAppSurfaceConfig;
  imessage: IMessageSurfaceConfig;
  msteams: MSTeamsSurfaceConfig;
  bluebubbles: BlueBubblesSurfaceConfig;
  mattermost: MattermostSurfaceConfig;
  matrix: MatrixSurfaceConfig;
}

export interface WatchersConfig {
  enabled: boolean;
  pollIntervalMs: number;
  heartbeatIntervalMs: number;
  recoveryWindowMinutes: number;
}

export interface ServiceConfig {
  enabled: boolean;
  autostart: boolean;
  restartOnFailure: boolean;
  platform: 'auto' | 'systemd' | 'launchd' | 'windows' | 'manual';
  serviceName: string;
  logPath: string;
}

export interface GoodVibesConfig {
  display: {
    stream: boolean;            // default: true
    lineNumbers: LineNumberMode; // default: 'off'
    collapseThreshold: number;  // default: 30
    theme: string;              // default: 'vaporwave'
    showThinking: boolean;      // default: false
    showReasoningSummary: boolean; // default: false
    showTokenSpeed: boolean;    // default: false
    showToolPreview: boolean;   // default: false
  };
  provider: {
    reasoningEffort: 'instant' | 'low' | 'medium' | 'high'; // default: 'medium'
    model: string;              // default: 'openrouter/free'
    provider: string;           // default: 'openrouter'
    embeddingProvider: string;  // default: 'hashed-local'
    systemPromptFile: string;   // default: ''
  };
  behavior: {
    autoApprove: boolean;       // default: false
    autoCompactThreshold: number; // default: 80
    staleContextWarnings: boolean; // default: true
    saveHistory: boolean;       // default: true
    notifyOnComplete: boolean;  // default: true
    suggestAlternativeOnProviderFail: boolean; // default: false
    hitlMode: 'quiet' | 'balanced' | 'operator'; // default: 'balanced'
    returnContextMode: 'off' | 'local' | 'assisted'; // default: 'off'
    guidanceMode: 'off' | 'minimal' | 'guided'; // default: 'minimal'
  };
  storage: {
    secretPolicy: 'plaintext_allowed' | 'preferred_secure' | 'require_secure'; // default: 'preferred_secure'
  };
  permissions: {
    mode: PermissionMode;       // default: 'prompt'
    tools: PermissionsToolConfig;
  };
  orchestration: {
    recursionEnabled: boolean;  // default: false — allow recursive agent spawning under bounded policy
    maxActiveAgents: number;    // default: 8 — total active agents across the orchestration tree
    maxDepth: number;           // default: 0 — 0=off, higher values allow deeper bounded recursion
  };
  sandbox: {
    replIsolation: 'shared-vm' | 'per-runtime-vm';
    mcpIsolation: 'disabled' | 'shared-vm' | 'hybrid' | 'per-server-vm';
    windowsMode: 'native-basic' | 'require-wsl';
    vmBackend: 'local' | 'qemu';
    qemuBinary: string;
    qemuImagePath: string;
    qemuExecWrapper: string;
    qemuGuestHost: string;
    qemuGuestPort: number;
    qemuGuestUser: string;
    qemuWorkspacePath: string;
    qemuSessionMode: 'attach' | 'launch-per-command';
  };
  ui: {
    voiceEnabled: boolean;
    systemMessages: 'panel' | 'conversation' | 'both';
    operationalMessages: 'panel' | 'conversation' | 'both';
    wrfcMessages: 'panel' | 'conversation' | 'both';
  };
  release: {
    channel: 'stable' | 'preview';
  };
  automation: AutomationConfig;
  controlPlane: ControlPlaneConfig;
  web: WebConfig;
  surfaces: SurfacesConfig;
  watchers: WatchersConfig;
  service: ServiceConfig;
  danger: {
    daemon: boolean;                // default: false — enable daemon mode
    httpListener: boolean;          // default: false — enable HTTP webhook listener
  };
  tools: {
    llmProvider: string;            // default: '' — provider for tool LLM calls (empty = use current)
    llmModel: string;               // default: '' — model for tool LLM calls (empty = fastest available)
    autoHeal: boolean;              // default: false — auto-fix syntax errors on write/edit
    defaultTokenBudget: number;     // default: 5000 — default token budget for read operations
    hooksFile: string;              // default: 'hooks.json' — hook configuration file name
  };
  wrfc: {
    scoreThreshold: number;
    maxFixAttempts: number;
    autoCommit: boolean;
    // NOTE: gates is an array of objects and does not fit the scalar-value dot-path config API.
    // Access via configManager.getCategory('wrfc').gates — not via ConfigKey/ConfigValue.
    gates: Array<{ name: string; command: string; enabled: boolean }>;
  };
  cache: {
    enabled: boolean;                    // default: true
    stableTtl: '5m' | '1h';          // default: '1h' (for stable content like system+tools)
    monitorHitRate: boolean;             // default: true
    hitRateWarningThreshold: number;     // default: 0.3
  };
  helper: {
    enabled: boolean;                    // default: false
    globalProvider: string;              // default: ''
    globalModel: string;                 // default: ''
    // Per-provider overrides accessed via configManager.getCategory('helper').providers
  };
  // NOTE: notifications.webhookUrls is an array and does not fit the scalar-value dot-path config API.
  // Access via configManager.getCategory('notifications') or mergeCategory('notifications', ...).
  notifications: NotificationsConfig;
  /** Persisted feature flag overrides keyed by flag id. */
  featureFlags: Record<string, PersistedFlagState>;
}

export interface ConfigSetting {
  key: ConfigKey;
  type: 'boolean' | 'number' | 'string' | 'enum';
  default: unknown;
  description: string;
  enumValues?: string[];
  validate?: (value: unknown) => boolean;
}

/** Dot-path config keys for all settings. */
export type ConfigKey =
  | 'display.stream'
  | 'display.lineNumbers'
  | 'display.collapseThreshold'
  | 'display.theme'
  | 'display.showThinking'
  | 'display.showReasoningSummary'
  | 'display.showTokenSpeed'
  | 'display.showToolPreview'
  | 'provider.reasoningEffort'
  | 'provider.model'
  | 'provider.provider'
  | 'provider.embeddingProvider'
  | 'provider.systemPromptFile'
  | 'behavior.autoApprove'
  | 'behavior.autoCompactThreshold'
  | 'behavior.staleContextWarnings'
  | 'behavior.saveHistory'
  | 'behavior.notifyOnComplete'
  | 'behavior.suggestAlternativeOnProviderFail'
  | 'behavior.hitlMode'
  | 'behavior.returnContextMode'
  | 'behavior.guidanceMode'
  | 'storage.secretPolicy'
  | 'permissions.mode'
  | 'permissions.tools.read'
  | 'permissions.tools.write'
  | 'permissions.tools.edit'
  | 'permissions.tools.exec'
  | 'permissions.tools.find'
  | 'permissions.tools.fetch'
  | 'permissions.tools.analyze'
  | 'permissions.tools.inspect'
  | 'permissions.tools.agent'
  | 'permissions.tools.state'
  | 'permissions.tools.workflow'
  | 'permissions.tools.registry'
  | 'permissions.tools.delegate'
  | 'permissions.tools.mcp'
  | 'orchestration.recursionEnabled'
  | 'orchestration.maxActiveAgents'
  | 'orchestration.maxDepth'
  | 'sandbox.replIsolation'
  | 'sandbox.mcpIsolation'
  | 'sandbox.windowsMode'
  | 'sandbox.vmBackend'
  | 'sandbox.qemuBinary'
  | 'sandbox.qemuImagePath'
  | 'sandbox.qemuExecWrapper'
  | 'sandbox.qemuGuestHost'
  | 'sandbox.qemuGuestPort'
  | 'sandbox.qemuGuestUser'
  | 'sandbox.qemuWorkspacePath'
  | 'sandbox.qemuSessionMode'
  | 'ui.voiceEnabled'
  | 'ui.systemMessages'
  | 'ui.operationalMessages'
  | 'ui.wrfcMessages'
  | 'release.channel'
  | 'danger.daemon'
  | 'danger.httpListener'
  | 'tools.llmProvider'
  | 'tools.llmModel'
  | 'tools.autoHeal'
  | 'tools.defaultTokenBudget'
  | 'tools.hooksFile'
  | 'wrfc.scoreThreshold'
  | 'wrfc.maxFixAttempts'
  | 'wrfc.autoCommit'
  | 'cache.enabled'
  | 'cache.stableTtl'
  | 'cache.monitorHitRate'
  | 'cache.hitRateWarningThreshold'
  | 'helper.enabled'
  | 'helper.globalProvider'
  | 'helper.globalModel'
  | 'automation.enabled'
  | 'automation.maxConcurrentRuns'
  | 'automation.runHistoryLimit'
  | 'automation.defaultTimeoutMs'
  | 'automation.catchUpWindowMinutes'
  | 'automation.failureCooldownMs'
  | 'automation.deleteAfterRun'
  | 'controlPlane.enabled'
  | 'controlPlane.host'
  | 'controlPlane.port'
  | 'controlPlane.baseUrl'
  | 'controlPlane.streamMode'
  | 'controlPlane.allowRemote'
  | 'web.enabled'
  | 'web.host'
  | 'web.port'
  | 'web.publicBaseUrl'
  | 'web.staticAssetsDir'
  | 'surfaces.slack.enabled'
  | 'surfaces.slack.signingSecret'
  | 'surfaces.slack.botToken'
  | 'surfaces.slack.appToken'
  | 'surfaces.slack.defaultChannel'
  | 'surfaces.slack.workspaceId'
  | 'surfaces.discord.enabled'
  | 'surfaces.discord.publicKey'
  | 'surfaces.discord.botToken'
  | 'surfaces.discord.applicationId'
  | 'surfaces.discord.defaultChannelId'
  | 'surfaces.discord.guildId'
  | 'surfaces.ntfy.enabled'
  | 'surfaces.ntfy.baseUrl'
  | 'surfaces.ntfy.topic'
  | 'surfaces.ntfy.token'
  | 'surfaces.ntfy.defaultPriority'
  | 'surfaces.webhook.enabled'
  | 'surfaces.webhook.defaultTarget'
  | 'surfaces.webhook.timeoutMs'
  | 'surfaces.webhook.secret'
  | 'surfaces.telegram.enabled'
  | 'surfaces.telegram.botToken'
  | 'surfaces.telegram.webhookSecret'
  | 'surfaces.telegram.defaultChatId'
  | 'surfaces.telegram.botUsername'
  | 'surfaces.telegram.mode'
  | 'surfaces.googleChat.enabled'
  | 'surfaces.googleChat.webhookUrl'
  | 'surfaces.googleChat.verificationToken'
  | 'surfaces.googleChat.appId'
  | 'surfaces.googleChat.spaceId'
  | 'surfaces.signal.enabled'
  | 'surfaces.signal.bridgeUrl'
  | 'surfaces.signal.account'
  | 'surfaces.signal.token'
  | 'surfaces.signal.defaultRecipient'
  | 'surfaces.whatsapp.enabled'
  | 'surfaces.whatsapp.provider'
  | 'surfaces.whatsapp.accessToken'
  | 'surfaces.whatsapp.verifyToken'
  | 'surfaces.whatsapp.phoneNumberId'
  | 'surfaces.whatsapp.businessAccountId'
  | 'surfaces.whatsapp.defaultRecipient'
  | 'surfaces.imessage.enabled'
  | 'surfaces.imessage.bridgeUrl'
  | 'surfaces.imessage.account'
  | 'surfaces.imessage.token'
  | 'surfaces.imessage.defaultChatId'
  | 'surfaces.msteams.enabled'
  | 'surfaces.msteams.appId'
  | 'surfaces.msteams.appPassword'
  | 'surfaces.msteams.tenantId'
  | 'surfaces.msteams.serviceUrl'
  | 'surfaces.msteams.botId'
  | 'surfaces.msteams.defaultConversationId'
  | 'surfaces.msteams.defaultChannelId'
  | 'surfaces.bluebubbles.enabled'
  | 'surfaces.bluebubbles.serverUrl'
  | 'surfaces.bluebubbles.password'
  | 'surfaces.bluebubbles.account'
  | 'surfaces.bluebubbles.defaultChatGuid'
  | 'surfaces.mattermost.enabled'
  | 'surfaces.mattermost.baseUrl'
  | 'surfaces.mattermost.botToken'
  | 'surfaces.mattermost.teamId'
  | 'surfaces.mattermost.defaultChannelId'
  | 'surfaces.matrix.enabled'
  | 'surfaces.matrix.homeserverUrl'
  | 'surfaces.matrix.accessToken'
  | 'surfaces.matrix.userId'
  | 'surfaces.matrix.defaultRoomId'
  | 'watchers.enabled'
  | 'watchers.pollIntervalMs'
  | 'watchers.heartbeatIntervalMs'
  | 'watchers.recoveryWindowMinutes'
  | 'service.enabled'
  | 'service.autostart'
  | 'service.restartOnFailure'
  | 'service.platform'
  | 'service.serviceName'
  | 'service.logPath';

/** Set of all valid config keys for runtime validation. */
export const CONFIG_KEYS = new Set<string>([
  'display.stream', 'display.lineNumbers', 'display.collapseThreshold', 'display.theme',
  'display.showThinking', 'display.showReasoningSummary', 'display.showTokenSpeed',
  'display.showToolPreview', 'provider.reasoningEffort', 'provider.model',
  'provider.provider', 'provider.embeddingProvider', 'provider.systemPromptFile', 'behavior.autoApprove',
  'behavior.autoCompactThreshold', 'behavior.staleContextWarnings', 'behavior.saveHistory', 'behavior.notifyOnComplete',
  'behavior.suggestAlternativeOnProviderFail', 'behavior.hitlMode', 'behavior.returnContextMode', 'behavior.guidanceMode', 'storage.secretPolicy', 'permissions.mode',
  'permissions.tools.read', 'permissions.tools.write', 'permissions.tools.edit',
  'permissions.tools.exec', 'permissions.tools.find', 'permissions.tools.fetch',
  'permissions.tools.analyze', 'permissions.tools.inspect', 'permissions.tools.agent',
  'permissions.tools.state', 'permissions.tools.workflow', 'permissions.tools.registry',
  'permissions.tools.delegate', 'permissions.tools.mcp', 'orchestration.recursionEnabled', 'orchestration.maxActiveAgents',
  'orchestration.maxDepth', 'sandbox.replIsolation', 'sandbox.mcpIsolation', 'sandbox.windowsMode',
  'sandbox.vmBackend', 'sandbox.qemuBinary', 'sandbox.qemuImagePath', 'sandbox.qemuExecWrapper', 'sandbox.qemuGuestHost', 'sandbox.qemuGuestPort', 'sandbox.qemuGuestUser', 'sandbox.qemuWorkspacePath', 'sandbox.qemuSessionMode', 'ui.voiceEnabled', 'ui.systemMessages', 'ui.operationalMessages', 'ui.wrfcMessages', 'release.channel', 'danger.daemon', 'danger.httpListener',
  'tools.llmProvider', 'tools.llmModel', 'tools.autoHeal', 'tools.defaultTokenBudget',
  'tools.hooksFile', 'wrfc.scoreThreshold', 'wrfc.maxFixAttempts', 'wrfc.autoCommit',
  'cache.enabled', 'cache.stableTtl', 'cache.monitorHitRate', 'cache.hitRateWarningThreshold',
  'helper.enabled', 'helper.globalProvider', 'helper.globalModel',
  'automation.enabled', 'automation.maxConcurrentRuns', 'automation.runHistoryLimit',
  'automation.defaultTimeoutMs', 'automation.catchUpWindowMinutes',
  'automation.failureCooldownMs', 'automation.deleteAfterRun',
  'controlPlane.enabled', 'controlPlane.host', 'controlPlane.port', 'controlPlane.baseUrl',
  'controlPlane.streamMode', 'controlPlane.allowRemote', 'web.enabled', 'web.host',
  'web.port', 'web.publicBaseUrl', 'web.staticAssetsDir', 'surfaces.slack.enabled',
  'surfaces.slack.signingSecret', 'surfaces.slack.botToken', 'surfaces.slack.appToken',
  'surfaces.slack.defaultChannel', 'surfaces.slack.workspaceId',
  'surfaces.discord.enabled', 'surfaces.discord.publicKey', 'surfaces.discord.botToken',
  'surfaces.discord.applicationId', 'surfaces.discord.defaultChannelId',
  'surfaces.discord.guildId', 'surfaces.ntfy.enabled', 'surfaces.ntfy.baseUrl',
  'surfaces.ntfy.topic', 'surfaces.ntfy.token', 'surfaces.ntfy.defaultPriority',
  'surfaces.webhook.enabled', 'surfaces.webhook.defaultTarget',
  'surfaces.webhook.timeoutMs', 'surfaces.webhook.secret',
  'surfaces.telegram.enabled', 'surfaces.telegram.botToken', 'surfaces.telegram.webhookSecret',
  'surfaces.telegram.defaultChatId', 'surfaces.telegram.botUsername', 'surfaces.telegram.mode',
  'surfaces.googleChat.enabled', 'surfaces.googleChat.webhookUrl', 'surfaces.googleChat.verificationToken',
  'surfaces.googleChat.appId', 'surfaces.googleChat.spaceId',
  'surfaces.signal.enabled', 'surfaces.signal.bridgeUrl', 'surfaces.signal.account',
  'surfaces.signal.token', 'surfaces.signal.defaultRecipient',
  'surfaces.whatsapp.enabled', 'surfaces.whatsapp.provider', 'surfaces.whatsapp.accessToken',
  'surfaces.whatsapp.verifyToken', 'surfaces.whatsapp.phoneNumberId',
  'surfaces.whatsapp.businessAccountId', 'surfaces.whatsapp.defaultRecipient',
  'surfaces.imessage.enabled', 'surfaces.imessage.bridgeUrl', 'surfaces.imessage.account',
  'surfaces.imessage.token', 'surfaces.imessage.defaultChatId',
  'surfaces.msteams.enabled', 'surfaces.msteams.appId', 'surfaces.msteams.appPassword',
  'surfaces.msteams.tenantId', 'surfaces.msteams.serviceUrl', 'surfaces.msteams.botId',
  'surfaces.msteams.defaultConversationId', 'surfaces.msteams.defaultChannelId',
  'surfaces.bluebubbles.enabled', 'surfaces.bluebubbles.serverUrl', 'surfaces.bluebubbles.password',
  'surfaces.bluebubbles.account', 'surfaces.bluebubbles.defaultChatGuid',
  'surfaces.mattermost.enabled', 'surfaces.mattermost.baseUrl', 'surfaces.mattermost.botToken',
  'surfaces.mattermost.teamId', 'surfaces.mattermost.defaultChannelId',
  'surfaces.matrix.enabled', 'surfaces.matrix.homeserverUrl', 'surfaces.matrix.accessToken',
  'surfaces.matrix.userId', 'surfaces.matrix.defaultRoomId', 'watchers.enabled',
  'watchers.pollIntervalMs', 'watchers.heartbeatIntervalMs', 'watchers.recoveryWindowMinutes',
  'service.enabled', 'service.autostart', 'service.restartOnFailure', 'service.platform',
  'service.serviceName', 'service.logPath',
] as const satisfies ConfigKey[]);

/** Type guard: returns true if key is a valid ConfigKey. */
export function isValidConfigKey(key: string): key is ConfigKey {
  return CONFIG_KEYS.has(key);
}

/** Maps a ConfigKey to its value type. */
export type ConfigValue<K extends ConfigKey> =
  K extends 'display.stream' ? boolean :
  K extends 'display.lineNumbers' ? LineNumberMode :
  K extends 'display.collapseThreshold' ? number :
  K extends 'display.theme' ? string :
  K extends 'display.showThinking' ? boolean :
  K extends 'display.showReasoningSummary' ? boolean :
  K extends 'display.showTokenSpeed' ? boolean :
  K extends 'display.showToolPreview' ? boolean :
  K extends 'provider.reasoningEffort' ? 'instant' | 'low' | 'medium' | 'high' :
  K extends 'provider.model' ? string :
  K extends 'provider.provider' ? string :
  K extends 'provider.embeddingProvider' ? string :
  K extends 'provider.systemPromptFile' ? string :
  K extends 'behavior.autoApprove' ? boolean :
  K extends 'behavior.autoCompactThreshold' ? number :
  K extends 'behavior.staleContextWarnings' ? boolean :
  K extends 'behavior.saveHistory' ? boolean :
  K extends 'behavior.notifyOnComplete' ? boolean :
  K extends 'behavior.suggestAlternativeOnProviderFail' ? boolean :
  K extends 'behavior.hitlMode' ? 'quiet' | 'balanced' | 'operator' :
  K extends 'behavior.returnContextMode' ? 'off' | 'local' | 'assisted' :
  K extends 'behavior.guidanceMode' ? 'off' | 'minimal' | 'guided' :
  K extends 'storage.secretPolicy' ? 'plaintext_allowed' | 'preferred_secure' | 'require_secure' :
  K extends 'permissions.mode' ? PermissionMode :
  K extends 'permissions.tools.read' ? PermissionAction :
  K extends 'permissions.tools.write' ? PermissionAction :
  K extends 'permissions.tools.edit' ? PermissionAction :
  K extends 'permissions.tools.exec' ? PermissionAction :
  K extends 'permissions.tools.find' ? PermissionAction :
  K extends 'permissions.tools.fetch' ? PermissionAction :
  K extends 'permissions.tools.analyze' ? PermissionAction :
  K extends 'permissions.tools.inspect' ? PermissionAction :
  K extends 'permissions.tools.agent' ? PermissionAction :
  K extends 'permissions.tools.state' ? PermissionAction :
  K extends 'permissions.tools.workflow' ? PermissionAction :
  K extends 'permissions.tools.registry' ? PermissionAction :
  K extends 'permissions.tools.delegate' ? PermissionAction :
  K extends 'permissions.tools.mcp' ? PermissionAction :
  K extends 'orchestration.recursionEnabled' ? boolean :
  K extends 'orchestration.maxActiveAgents' ? number :
  K extends 'orchestration.maxDepth' ? number :
  K extends 'sandbox.replIsolation' ? 'shared-vm' | 'per-runtime-vm' :
  K extends 'sandbox.mcpIsolation' ? 'disabled' | 'shared-vm' | 'hybrid' | 'per-server-vm' :
  K extends 'sandbox.windowsMode' ? 'native-basic' | 'require-wsl' :
  K extends 'sandbox.vmBackend' ? 'local' | 'qemu' :
  K extends 'sandbox.qemuBinary' ? string :
  K extends 'sandbox.qemuImagePath' ? string :
  K extends 'sandbox.qemuExecWrapper' ? string :
  K extends 'sandbox.qemuGuestHost' ? string :
  K extends 'sandbox.qemuGuestPort' ? number :
  K extends 'sandbox.qemuGuestUser' ? string :
  K extends 'sandbox.qemuWorkspacePath' ? string :
  K extends 'sandbox.qemuSessionMode' ? 'attach' | 'launch-per-command' :
  K extends 'ui.voiceEnabled' ? boolean :
  K extends 'ui.systemMessages' ? 'panel' | 'conversation' | 'both' :
  K extends 'ui.operationalMessages' ? 'panel' | 'conversation' | 'both' :
  K extends 'ui.wrfcMessages' ? 'panel' | 'conversation' | 'both' :
  K extends 'release.channel' ? 'stable' | 'preview' :
  K extends 'danger.daemon' ? boolean :
  K extends 'danger.httpListener' ? boolean :
  K extends 'tools.llmProvider' ? string :
  K extends 'tools.llmModel' ? string :
  K extends 'tools.autoHeal' ? boolean :
  K extends 'tools.defaultTokenBudget' ? number :
  K extends 'tools.hooksFile' ? string :
  K extends 'wrfc.scoreThreshold' ? number :
  K extends 'wrfc.maxFixAttempts' ? number :
  K extends 'wrfc.autoCommit' ? boolean :
  K extends 'cache.enabled' ? boolean :
  K extends 'cache.stableTtl' ? '5m' | '1h' :
  K extends 'cache.monitorHitRate' ? boolean :
  K extends 'cache.hitRateWarningThreshold' ? number :
  K extends 'helper.enabled' ? boolean :
  K extends 'helper.globalProvider' ? string :
  K extends 'helper.globalModel' ? string :
  K extends 'automation.enabled' ? boolean :
  K extends 'automation.maxConcurrentRuns' ? number :
  K extends 'automation.runHistoryLimit' ? number :
  K extends 'automation.defaultTimeoutMs' ? number :
  K extends 'automation.catchUpWindowMinutes' ? number :
  K extends 'automation.failureCooldownMs' ? number :
  K extends 'automation.deleteAfterRun' ? boolean :
  K extends 'controlPlane.enabled' ? boolean :
  K extends 'controlPlane.host' ? string :
  K extends 'controlPlane.port' ? number :
  K extends 'controlPlane.baseUrl' ? string :
  K extends 'controlPlane.streamMode' ? 'sse' | 'websocket' | 'both' :
  K extends 'controlPlane.allowRemote' ? boolean :
  K extends 'web.enabled' ? boolean :
  K extends 'web.host' ? string :
  K extends 'web.port' ? number :
  K extends 'web.publicBaseUrl' ? string :
  K extends 'web.staticAssetsDir' ? string :
  K extends 'surfaces.slack.enabled' ? boolean :
  K extends 'surfaces.slack.signingSecret' ? string :
  K extends 'surfaces.slack.botToken' ? string :
  K extends 'surfaces.slack.appToken' ? string :
  K extends 'surfaces.slack.defaultChannel' ? string :
  K extends 'surfaces.slack.workspaceId' ? string :
  K extends 'surfaces.discord.enabled' ? boolean :
  K extends 'surfaces.discord.publicKey' ? string :
  K extends 'surfaces.discord.botToken' ? string :
  K extends 'surfaces.discord.applicationId' ? string :
  K extends 'surfaces.discord.defaultChannelId' ? string :
  K extends 'surfaces.discord.guildId' ? string :
  K extends 'surfaces.ntfy.enabled' ? boolean :
  K extends 'surfaces.ntfy.baseUrl' ? string :
  K extends 'surfaces.ntfy.topic' ? string :
  K extends 'surfaces.ntfy.token' ? string :
  K extends 'surfaces.ntfy.defaultPriority' ? number :
  K extends 'surfaces.webhook.enabled' ? boolean :
  K extends 'surfaces.webhook.defaultTarget' ? string :
  K extends 'surfaces.webhook.timeoutMs' ? number :
  K extends 'surfaces.webhook.secret' ? string :
  K extends 'surfaces.telegram.enabled' ? boolean :
  K extends 'surfaces.telegram.botToken' ? string :
  K extends 'surfaces.telegram.webhookSecret' ? string :
  K extends 'surfaces.telegram.defaultChatId' ? string :
  K extends 'surfaces.telegram.botUsername' ? string :
  K extends 'surfaces.telegram.mode' ? 'webhook' | 'polling' :
  K extends 'surfaces.googleChat.enabled' ? boolean :
  K extends 'surfaces.googleChat.webhookUrl' ? string :
  K extends 'surfaces.googleChat.verificationToken' ? string :
  K extends 'surfaces.googleChat.appId' ? string :
  K extends 'surfaces.googleChat.spaceId' ? string :
  K extends 'surfaces.signal.enabled' ? boolean :
  K extends 'surfaces.signal.bridgeUrl' ? string :
  K extends 'surfaces.signal.account' ? string :
  K extends 'surfaces.signal.token' ? string :
  K extends 'surfaces.signal.defaultRecipient' ? string :
  K extends 'surfaces.whatsapp.enabled' ? boolean :
  K extends 'surfaces.whatsapp.provider' ? 'meta-cloud' | 'bridge' :
  K extends 'surfaces.whatsapp.accessToken' ? string :
  K extends 'surfaces.whatsapp.verifyToken' ? string :
  K extends 'surfaces.whatsapp.phoneNumberId' ? string :
  K extends 'surfaces.whatsapp.businessAccountId' ? string :
  K extends 'surfaces.whatsapp.defaultRecipient' ? string :
  K extends 'surfaces.imessage.enabled' ? boolean :
  K extends 'surfaces.imessage.bridgeUrl' ? string :
  K extends 'surfaces.imessage.account' ? string :
  K extends 'surfaces.imessage.token' ? string :
  K extends 'surfaces.imessage.defaultChatId' ? string :
  K extends 'surfaces.msteams.enabled' ? boolean :
  K extends 'surfaces.msteams.appId' ? string :
  K extends 'surfaces.msteams.appPassword' ? string :
  K extends 'surfaces.msteams.tenantId' ? string :
  K extends 'surfaces.msteams.serviceUrl' ? string :
  K extends 'surfaces.msteams.botId' ? string :
  K extends 'surfaces.msteams.defaultConversationId' ? string :
  K extends 'surfaces.msteams.defaultChannelId' ? string :
  K extends 'surfaces.bluebubbles.enabled' ? boolean :
  K extends 'surfaces.bluebubbles.serverUrl' ? string :
  K extends 'surfaces.bluebubbles.password' ? string :
  K extends 'surfaces.bluebubbles.account' ? string :
  K extends 'surfaces.bluebubbles.defaultChatGuid' ? string :
  K extends 'surfaces.mattermost.enabled' ? boolean :
  K extends 'surfaces.mattermost.baseUrl' ? string :
  K extends 'surfaces.mattermost.botToken' ? string :
  K extends 'surfaces.mattermost.teamId' ? string :
  K extends 'surfaces.mattermost.defaultChannelId' ? string :
  K extends 'surfaces.matrix.enabled' ? boolean :
  K extends 'surfaces.matrix.homeserverUrl' ? string :
  K extends 'surfaces.matrix.accessToken' ? string :
  K extends 'surfaces.matrix.userId' ? string :
  K extends 'surfaces.matrix.defaultRoomId' ? string :
  K extends 'watchers.enabled' ? boolean :
  K extends 'watchers.pollIntervalMs' ? number :
  K extends 'watchers.heartbeatIntervalMs' ? number :
  K extends 'watchers.recoveryWindowMinutes' ? number :
  K extends 'service.enabled' ? boolean :
  K extends 'service.autostart' ? boolean :
  K extends 'service.restartOnFailure' ? boolean :
  K extends 'service.platform' ? 'auto' | 'systemd' | 'launchd' | 'windows' | 'manual' :
  K extends 'service.serviceName' ? string :
  K extends 'service.logPath' ? string :
  never;

export const DEFAULT_CONFIG = {
  display: coreConfigDefaults.display,
  provider: coreConfigDefaults.provider,
  behavior: coreConfigDefaults.behavior,
  storage: coreConfigDefaults.storage,
  permissions: coreConfigDefaults.permissions,
  orchestration: coreConfigDefaults.orchestration,
  sandbox: coreConfigDefaults.sandbox,
  ui: coreConfigDefaults.ui,
  release: coreConfigDefaults.release,
  automation: runtimeConfigDefaults.automation,
  controlPlane: runtimeConfigDefaults.controlPlane,
  web: runtimeConfigDefaults.web,
  surfaces: surfaceConfigDefaults as SurfacesConfig,
  watchers: runtimeConfigDefaults.watchers,
  service: runtimeConfigDefaults.service,
  danger: coreConfigDefaults.danger,
  tools: coreConfigDefaults.tools,
  wrfc: coreConfigDefaults.wrfc,
  cache: coreConfigDefaults.cache,
  helper: coreConfigDefaults.helper,
  notifications: coreConfigDefaults.notifications,
  featureFlags: coreConfigDefaults.featureFlags,
} as GoodVibesConfig;

export const CONFIG_SCHEMA: ConfigSetting[] = [
  ...coreHeadConfigSettings,
  ...runtimePrimaryConfigSettings,
  ...surfaceConfigSettings,
  ...runtimeSecondaryConfigSettings,
  ...coreTailConfigSettings,
] as ConfigSetting[];
