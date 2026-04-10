/**
 * Config schema definitions and metadata for goodvibes-tui.
 */

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
  'surfaces.imessage.token', 'surfaces.imessage.defaultChatId', 'watchers.enabled',
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

export const DEFAULT_CONFIG: GoodVibesConfig = {
  display: {
    stream: true,
    lineNumbers: 'off',
    collapseThreshold: 30,
    theme: 'vaporwave',
    showThinking: false,
    showReasoningSummary: false,
    showTokenSpeed: false,
    showToolPreview: false,
  },
  provider: {
    reasoningEffort: 'medium',
    model: 'openrouter/free',
    provider: 'openrouter',
    embeddingProvider: 'hashed-local',
    systemPromptFile: '',
  },
  behavior: {
    autoApprove: false,
    autoCompactThreshold: 80,
    staleContextWarnings: true,
    saveHistory: true,
    notifyOnComplete: true,
    suggestAlternativeOnProviderFail: false,
    hitlMode: 'balanced',
    returnContextMode: 'off',
    guidanceMode: 'minimal',
  },
  storage: {
    secretPolicy: 'preferred_secure',
  },
  permissions: {
    mode: 'prompt',
    tools: {
      read: 'allow',
      write: 'prompt',
      edit: 'prompt',
      exec: 'prompt',
      find: 'allow',
      fetch: 'prompt',
      analyze: 'allow',
      inspect: 'allow',
      agent: 'prompt',
      state: 'allow',
      workflow: 'prompt',
      registry: 'allow',
      delegate: 'prompt',
      mcp: 'prompt',
    },
  },
  orchestration: {
    recursionEnabled: false,
    maxActiveAgents: 8,
    maxDepth: 0,
  },
  sandbox: {
    replIsolation: 'shared-vm',
    mcpIsolation: 'disabled',
    windowsMode: 'native-basic',
    vmBackend: 'local',
    qemuBinary: 'qemu-system-x86_64',
    qemuImagePath: '',
    qemuExecWrapper: '',
    qemuGuestHost: '',
    qemuGuestPort: 2222,
    qemuGuestUser: 'goodvibes',
    qemuWorkspacePath: '/workspace',
    qemuSessionMode: 'attach',
  },
  ui: {
    voiceEnabled: false,
    systemMessages: 'panel',
    operationalMessages: 'panel',
    wrfcMessages: 'both',
  },
  release: {
    channel: 'stable',
  },
  automation: {
    enabled: false,
    maxConcurrentRuns: 4,
    runHistoryLimit: 100,
    defaultTimeoutMs: 15 * 60 * 1000,
    catchUpWindowMinutes: 30,
    failureCooldownMs: 5 * 60 * 1000,
    deleteAfterRun: false,
  },
  controlPlane: {
    enabled: false,
    host: '127.0.0.1',
    port: 3421,
    baseUrl: 'http://127.0.0.1:3421',
    streamMode: 'sse',
    allowRemote: false,
  },
  web: {
    enabled: false,
    host: '127.0.0.1',
    port: 3423,
    publicBaseUrl: 'http://127.0.0.1:3423',
    staticAssetsDir: 'dist/web',
  },
  surfaces: {
    slack: {
      enabled: false,
      signingSecret: '',
      botToken: '',
      appToken: '',
      defaultChannel: '',
      workspaceId: '',
      setupVersion: 0,
    },
    discord: {
      enabled: false,
      publicKey: '',
      botToken: '',
      applicationId: '',
      defaultChannelId: '',
      guildId: '',
      setupVersion: 0,
    },
    ntfy: {
      enabled: false,
      baseUrl: 'https://ntfy.sh',
      topic: '',
      token: '',
      defaultPriority: 3,
      setupVersion: 0,
    },
    webhook: {
      enabled: false,
      defaultTarget: '',
      timeoutMs: 10_000,
      secret: '',
      setupVersion: 0,
    },
    telegram: {
      enabled: false,
      botToken: '',
      webhookSecret: '',
      defaultChatId: '',
      botUsername: '',
      mode: 'webhook',
      setupVersion: 0,
    },
    googleChat: {
      enabled: false,
      webhookUrl: '',
      verificationToken: '',
      appId: '',
      spaceId: '',
      setupVersion: 0,
    },
    signal: {
      enabled: false,
      bridgeUrl: '',
      account: '',
      token: '',
      defaultRecipient: '',
      setupVersion: 0,
    },
    whatsapp: {
      enabled: false,
      provider: 'meta-cloud',
      accessToken: '',
      verifyToken: '',
      phoneNumberId: '',
      businessAccountId: '',
      defaultRecipient: '',
      setupVersion: 0,
    },
    imessage: {
      enabled: false,
      bridgeUrl: '',
      account: '',
      token: '',
      defaultChatId: '',
      setupVersion: 0,
    },
  },
  watchers: {
    enabled: false,
    pollIntervalMs: 60_000,
    heartbeatIntervalMs: 15_000,
    recoveryWindowMinutes: 10,
  },
  service: {
    enabled: false,
    autostart: false,
    restartOnFailure: true,
    platform: 'auto',
    serviceName: 'goodvibes',
    logPath: '',
  },
  danger: {
    daemon: false,
    httpListener: false,
  },
  tools: {
    llmProvider: '',
    llmModel: '',
    autoHeal: false,
    defaultTokenBudget: 5000,
    hooksFile: 'hooks.json',
  },
  wrfc: {
    scoreThreshold: 9.9,
    maxFixAttempts: 5,
    autoCommit: true,
    gates: [
      { name: 'typecheck', command: 'npx tsc --noEmit', enabled: true },
      { name: 'lint', command: 'npx eslint . --max-warnings 0', enabled: true },
      { name: 'build', command: 'npm run build', enabled: false },
    ],
  },
  cache: {
    enabled: true,
    stableTtl: '1h',
    monitorHitRate: true,
    hitRateWarningThreshold: 0.3,
  },
  helper: {
    enabled: false,
    globalProvider: '',
    globalModel: '',
  },
  notifications: {
    webhookUrls: [],
  },
  featureFlags: {},
};

export const CONFIG_SCHEMA: ConfigSetting[] = [
  {
    key: 'display.stream',
    type: 'boolean',
    default: true,
    description: 'Stream LLM tokens as they arrive',
  },
  {
    key: 'display.lineNumbers',
    type: 'enum',
    default: 'off',
    description: 'Show line numbers for all assistant output, code blocks only, or not at all',
    enumValues: ['all', 'code', 'off'],
  },
  {
    key: 'display.collapseThreshold',
    type: 'number',
    default: 30,
    description: 'Line count threshold for collapsing tool output',
    validate: (v) => typeof v === 'number' && v >= 1 && v <= 1000,
  },
  {
    key: 'display.theme',
    type: 'string',
    default: 'vaporwave',
    description: 'Color theme name',
  },
  {
    key: 'display.showThinking',
    type: 'boolean',
    default: false,
    description: 'Show reasoning/thinking content in a dimmed block above assistant responses',
  },
  {
    key: 'display.showReasoningSummary',
    type: 'boolean',
    default: false,
    description: 'Show reasoning summary (Mercury-2) in a dimmed block above assistant responses',
  },
  {
    key: 'display.showTokenSpeed',
    type: 'boolean',
    default: false,
    description: 'Show streaming tokens/sec counter during generation',
  },
  {
    key: 'display.showToolPreview',
    type: 'boolean',
    default: false,
    description: 'Show partial tool call preview while streaming',
  },
  {
    key: 'provider.reasoningEffort',
    type: 'enum',
    default: 'medium',
    description: 'Reasoning effort level for models that support it',
    enumValues: ['instant', 'low', 'medium', 'high'], // Note: per-model levels may differ; /effort command uses model-specific list
  },
  {
    key: 'provider.model',
    type: 'string',
    default: 'openrouter/free',
    description: 'Default LLM model ID',
  },
  {
    key: 'provider.provider',
    type: 'string',
    default: 'openrouter',
    description: 'Default provider name',
  },
  {
    key: 'provider.embeddingProvider',
    type: 'string',
    default: 'hashed-local',
    description: 'Default memory embedding provider',
  },
  {
    key: 'provider.systemPromptFile',
    type: 'string',
    default: '',
    description: 'Path to a file containing the system prompt (empty = none)',
  },
  {
    key: 'behavior.autoApprove',
    type: 'boolean',
    default: false,
    description: 'Auto-approve all tool permission requests (--no-worries-just-vibes)',
  },
  {
    key: 'behavior.autoCompactThreshold',
    type: 'number',
    default: 80,
    description: 'Compact conversation when context usage exceeds this percentage',
    validate: (v) => typeof v === 'number' && v >= 10 && v <= 100,
  },
  {
    key: 'behavior.staleContextWarnings',
    type: 'boolean',
    default: true,
    description: 'Emit proactive context-pressure warnings before compaction is required',
  },
  {
    key: 'behavior.saveHistory',
    type: 'boolean',
    default: true,
    description: 'Persist conversation history to disk',
  },
  {
    key: 'behavior.notifyOnComplete',
    type: 'boolean',
    default: true,
    description: 'Emit terminal bell and desktop notification when a long turn completes',
  },
  {
    key: 'behavior.returnContextMode',
    type: 'enum',
    default: 'off',
    description: 'Resume summary mode: off, local deterministic summary, or helper-assisted summary',
    enumValues: ['off', 'local', 'assisted'],
  },
  {
    key: 'behavior.guidanceMode',
    type: 'enum',
    default: 'minimal',
    description: 'Operational guidance mode: off, minimal, or guided',
    enumValues: ['off', 'minimal', 'guided'],
  },
  {
    key: 'storage.secretPolicy',
    type: 'enum',
    default: 'preferred_secure',
    description: 'Secret persistence policy: plaintext allowed, preferred secure, or require secure',
    enumValues: ['plaintext_allowed', 'preferred_secure', 'require_secure'],
  },
  {
    key: 'permissions.mode',
    type: 'enum',
    default: 'prompt',
    description: 'Permission approval mode: prompt (default), allow-all, or custom',
    enumValues: ['prompt', 'allow-all', 'custom'],
  },
  {
    key: 'permissions.tools.read',
    type: 'enum',
    default: 'allow',
    description: 'Permission for file read operations (read, find, analyze)',
    enumValues: ['allow', 'prompt', 'deny'],
  },
  {
    key: 'permissions.tools.write',
    type: 'enum',
    default: 'prompt',
    description: 'Permission for file write operations',
    enumValues: ['allow', 'prompt', 'deny'],
  },
  {
    key: 'permissions.tools.edit',
    type: 'enum',
    default: 'prompt',
    description: 'Permission for file edit/patch operations',
    enumValues: ['allow', 'prompt', 'deny'],
  },
  {
    key: 'permissions.tools.exec',
    type: 'enum',
    default: 'prompt',
    description: 'Permission for shell command execution',
    enumValues: ['allow', 'prompt', 'deny'],
  },
  {
    key: 'permissions.tools.find',
    type: 'enum',
    default: 'allow',
    description: 'Permission for file/directory search operations',
    enumValues: ['allow', 'prompt', 'deny'],
  },
  {
    key: 'permissions.tools.fetch',
    type: 'enum',
    default: 'prompt',
    description: 'Permission for outbound network fetch requests (custom mode only)',
    enumValues: ['allow', 'prompt', 'deny'],
  },
  {
    key: 'permissions.tools.analyze',
    type: 'enum',
    default: 'allow',
    description: 'Permission for code/project analysis operations',
    enumValues: ['allow', 'prompt', 'deny'],
  },
  {
    key: 'permissions.tools.inspect',
    type: 'enum',
    default: 'allow',
    description: 'Permission for inspecting runtime state and objects',
    enumValues: ['allow', 'prompt', 'deny'],
  },
  {
    key: 'permissions.tools.agent',
    type: 'enum',
    default: 'prompt',
    description: 'Permission for spawning subagents or delegating tasks',
    enumValues: ['allow', 'prompt', 'deny'],
  },
  {
    key: 'permissions.tools.state',
    type: 'enum',
    default: 'allow',
    description: 'Permission for reading runtime/session state',
    enumValues: ['allow', 'prompt', 'deny'],
  },
  {
    key: 'permissions.tools.workflow',
    type: 'enum',
    default: 'prompt',
    description: 'Permission for executing multi-step workflow automation',
    enumValues: ['allow', 'prompt', 'deny'],
  },
  {
    key: 'permissions.tools.registry',
    type: 'enum',
    default: 'allow',
    description: 'Permission for querying the tool/skill registry',
    enumValues: ['allow', 'prompt', 'deny'],
  },
  {
    key: 'permissions.tools.mcp',
    type: 'enum',
    default: 'prompt',
    description: 'Permission for MCP tool calls (external server tools)',
    enumValues: ['allow', 'prompt', 'deny'],
  },
  {
    key: 'permissions.tools.delegate',
    type: 'enum',
    default: 'prompt',
    description: 'Permission for unknown or unregistered tools (safe default: prompt)',
    enumValues: ['allow', 'prompt', 'deny'],
  },
  {
    key: 'orchestration.recursionEnabled',
    type: 'boolean',
    default: false,
    description: 'Allow recursive agent orchestration under bounded policy controls',
  },
  {
    key: 'orchestration.maxActiveAgents',
    type: 'number',
    default: 8,
    description: 'Total active agents allowed across the orchestration tree',
    validate: (v) => typeof v === 'number' && v >= 1 && v <= 20,
  },
  {
    key: 'orchestration.maxDepth',
    type: 'number',
    default: 0,
    description: 'Maximum recursive orchestration depth: 0=disabled, higher values allow deeper bounded recursion',
    validate: (v) => typeof v === 'number' && v >= 0 && v <= 5,
  },
  {
    key: 'sandbox.replIsolation',
    type: 'enum',
    default: 'shared-vm',
    description: 'Preferred isolation mode for evaluation runtimes once virtualization is enabled',
    enumValues: ['shared-vm', 'per-runtime-vm'],
  },
  {
    key: 'sandbox.mcpIsolation',
    type: 'enum',
    default: 'disabled',
    description: 'Preferred isolation mode for MCP servers once virtualization is enabled',
    enumValues: ['disabled', 'shared-vm', 'hybrid', 'per-server-vm'],
  },
  {
    key: 'sandbox.windowsMode',
    type: 'enum',
    default: 'native-basic',
    description: 'Windows host posture: native basic mode or require WSL before enabling virtualized sandboxing',
    enumValues: ['native-basic', 'require-wsl'],
  },
  {
    key: 'sandbox.vmBackend',
    type: 'enum',
    default: 'local',
    description: 'Sandbox backend: local host execution by default, or QEMU for virtualized isolation',
    enumValues: ['local', 'qemu'],
  },
  {
    key: 'sandbox.qemuBinary',
    type: 'string',
    default: 'qemu-system-x86_64',
    description: 'QEMU system binary to use when vmBackend=qemu',
  },
  {
    key: 'sandbox.qemuImagePath',
    type: 'string',
    default: '',
    description: 'Disk image path for QEMU-backed sandbox sessions; when empty, QEMU sessions remain planned-only',
  },
  {
    key: 'sandbox.qemuExecWrapper',
    type: 'string',
    default: '',
    description: 'Host-side wrapper/bridge used to execute guest commands inside a configured QEMU sandbox',
  },
  {
    key: 'sandbox.qemuGuestHost',
    type: 'string',
    default: '',
    description: 'Optional guest host/IP used by the QEMU wrapper for real guest command transport',
  },
  {
    key: 'sandbox.qemuGuestPort',
    type: 'number',
    default: 2222,
    description: 'Optional guest SSH port used by the QEMU wrapper for real guest command transport',
    validate: (v) => typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 65535,
  },
  {
    key: 'sandbox.qemuGuestUser',
    type: 'string',
    default: 'goodvibes',
    description: 'Optional guest username used by the QEMU wrapper for real guest command transport',
  },
  {
    key: 'sandbox.qemuWorkspacePath',
    type: 'string',
    default: '/workspace',
    description: 'Guest workspace path used by the QEMU wrapper when executing commands inside the guest',
  },
  {
    key: 'sandbox.qemuSessionMode',
    type: 'enum',
    enumValues: ['attach', 'launch-per-command'],
    default: 'attach',
    description: 'Whether the QEMU wrapper attaches to an already running guest or launches a guest per command',
  },
  {
    key: 'ui.voiceEnabled',
    type: 'boolean',
    default: false,
    description: 'Enable the optional local-first voice control surface',
  },
  {
    key: 'ui.systemMessages',
    type: 'enum',
    default: 'panel',
    description: 'Where operational system messages render by default: panel, conversation, or both',
    enumValues: ['panel', 'conversation', 'both'],
  },
  {
    key: 'ui.operationalMessages',
    type: 'enum',
    default: 'panel',
    description: 'Where tool, agent, MCP, plugin, and other operational activity messages render by default: panel, conversation, or both',
    enumValues: ['panel', 'conversation', 'both'],
  },
  {
    key: 'ui.wrfcMessages',
    type: 'enum',
    default: 'both',
    description: 'Where WRFC lifecycle updates render by default: panel, conversation, or both',
    enumValues: ['panel', 'conversation', 'both'],
  },
  {
    key: 'release.channel',
    type: 'enum',
    default: 'stable',
    description: 'Preferred release channel for install/update flows',
    enumValues: ['stable', 'preview'],
  },
  {
    key: 'automation.enabled',
    type: 'boolean',
    default: false,
    description: 'Enable the automation subsystem',
  },
  {
    key: 'automation.maxConcurrentRuns',
    type: 'number',
    default: 4,
    description: 'Maximum automation runs that may execute concurrently',
    validate: (v) => typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 64,
  },
  {
    key: 'automation.runHistoryLimit',
    type: 'number',
    default: 100,
    description: 'Maximum run history entries retained per automation job',
    validate: (v) => typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 5000,
  },
  {
    key: 'automation.defaultTimeoutMs',
    type: 'number',
    default: 15 * 60 * 1000,
    description: 'Default execution timeout for automation runs in milliseconds',
    validate: (v) => typeof v === 'number' && Number.isInteger(v) && v >= 1_000 && v <= 24 * 60 * 60 * 1000,
  },
  {
    key: 'automation.catchUpWindowMinutes',
    type: 'number',
    default: 30,
    description: 'How long after startup the engine should catch up missed runs',
    validate: (v) => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 24 * 60,
  },
  {
    key: 'automation.failureCooldownMs',
    type: 'number',
    default: 5 * 60 * 1000,
    description: 'Cooldown applied after a failed automation run before retrying',
    validate: (v) => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 24 * 60 * 60 * 1000,
  },
  {
    key: 'automation.deleteAfterRun',
    type: 'boolean',
    default: false,
    description: 'Delete one-shot automation jobs after their first successful run',
  },
  {
    key: 'controlPlane.enabled',
    type: 'boolean',
    default: false,
    description: 'Enable the shared gateway/control-plane service',
  },
  {
    key: 'controlPlane.host',
    type: 'string',
    default: '127.0.0.1',
    description: 'Bind host for the control-plane HTTP server',
  },
  {
    key: 'controlPlane.port',
    type: 'number',
    default: 3421,
    description: 'Bind port for the control-plane HTTP server',
    validate: (v) => typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 65535,
  },
  {
    key: 'controlPlane.baseUrl',
    type: 'string',
    default: 'http://127.0.0.1:3421',
    description: 'Public base URL used by route bindings and link generation',
  },
  {
    key: 'controlPlane.streamMode',
    type: 'enum',
    default: 'sse',
    description: 'Live update stream mode for control-plane clients',
    enumValues: ['sse', 'websocket', 'both'],
  },
  {
    key: 'controlPlane.allowRemote',
    type: 'boolean',
    default: false,
    description: 'Allow remote clients to connect to the control plane',
  },
  {
    key: 'web.enabled',
    type: 'boolean',
    default: false,
    description: 'Enable the browser-based operator surface',
  },
  {
    key: 'web.host',
    type: 'string',
    default: '127.0.0.1',
    description: 'Bind host for the web surface',
  },
  {
    key: 'web.port',
    type: 'number',
    default: 3423,
    description: 'Bind port for the web surface',
    validate: (v) => typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 65535,
  },
  {
    key: 'web.publicBaseUrl',
    type: 'string',
    default: 'http://127.0.0.1:3423',
    description: 'Public base URL for web links and ntfy/notification deep links',
  },
  {
    key: 'web.staticAssetsDir',
    type: 'string',
    default: 'dist/web',
    description: 'Static asset directory for the embedded web surface',
  },
  {
    key: 'surfaces.slack.enabled',
    type: 'boolean',
    default: false,
    description: 'Enable the Slack surface adapter',
  },
  {
    key: 'surfaces.slack.signingSecret',
    type: 'string',
    default: '',
    description: 'Slack signing secret used to verify inbound requests',
  },
  {
    key: 'surfaces.slack.botToken',
    type: 'string',
    default: '',
    description: 'Slack bot token used for outbound replies and thread updates',
  },
  {
    key: 'surfaces.slack.appToken',
    type: 'string',
    default: '',
    description: 'Slack app-level token used for advanced client flows',
  },
  {
    key: 'surfaces.slack.defaultChannel',
    type: 'string',
    default: '',
    description: 'Default Slack channel for notifications and replies',
  },
  {
    key: 'surfaces.slack.workspaceId',
    type: 'string',
    default: '',
    description: 'Slack workspace identifier for route binding',
  },
  {
    key: 'surfaces.discord.enabled',
    type: 'boolean',
    default: false,
    description: 'Enable the Discord surface adapter',
  },
  {
    key: 'surfaces.discord.publicKey',
    type: 'string',
    default: '',
    description: 'Discord application public key used to verify interactions',
  },
  {
    key: 'surfaces.discord.botToken',
    type: 'string',
    default: '',
    description: 'Discord bot token used for outbound replies',
  },
  {
    key: 'surfaces.discord.applicationId',
    type: 'string',
    default: '',
    description: 'Discord application ID used for interaction responses',
  },
  {
    key: 'surfaces.discord.defaultChannelId',
    type: 'string',
    default: '',
    description: 'Default Discord channel for notifications and replies',
  },
  {
    key: 'surfaces.discord.guildId',
    type: 'string',
    default: '',
    description: 'Discord guild identifier for route binding',
  },
  {
    key: 'surfaces.ntfy.enabled',
    type: 'boolean',
    default: false,
    description: 'Enable the ntfy notification surface',
  },
  {
    key: 'surfaces.ntfy.baseUrl',
    type: 'string',
    default: 'https://ntfy.sh',
    description: 'Base URL for ntfy delivery',
  },
  {
    key: 'surfaces.ntfy.topic',
    type: 'string',
    default: '',
    description: 'Default ntfy topic for notifications',
  },
  {
    key: 'surfaces.ntfy.token',
    type: 'string',
    default: '',
    description: 'ntfy access token used for authenticated delivery',
  },
  {
    key: 'surfaces.ntfy.defaultPriority',
    type: 'number',
    default: 3,
    description: 'Default ntfy priority (1-5)',
    validate: (v) => typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 5,
  },
  {
    key: 'surfaces.webhook.enabled',
    type: 'boolean',
    default: false,
    description: 'Enable the generic webhook surface',
  },
  {
    key: 'surfaces.webhook.defaultTarget',
    type: 'string',
    default: '',
    description: 'Default outbound webhook target URL',
  },
  {
    key: 'surfaces.webhook.timeoutMs',
    type: 'number',
    default: 10_000,
    description: 'Outbound webhook timeout in milliseconds',
    validate: (v) => typeof v === 'number' && Number.isInteger(v) && v >= 1_000 && v <= 60_000,
  },
  {
    key: 'surfaces.webhook.secret',
    type: 'string',
    default: '',
    description: 'Shared secret used to sign or verify webhook payloads',
  },
  {
    key: 'surfaces.telegram.enabled',
    type: 'boolean',
    default: false,
    description: 'Enable the Telegram surface contract',
  },
  {
    key: 'surfaces.telegram.botToken',
    type: 'string',
    default: '',
    description: 'Telegram bot token used for bot setup and delivery',
  },
  {
    key: 'surfaces.telegram.webhookSecret',
    type: 'string',
    default: '',
    description: 'Telegram webhook secret token used to verify inbound callbacks',
  },
  {
    key: 'surfaces.telegram.defaultChatId',
    type: 'string',
    default: '',
    description: 'Default Telegram chat, group, or channel id for delivery',
  },
  {
    key: 'surfaces.telegram.botUsername',
    type: 'string',
    default: '',
    description: 'Telegram bot username used for targeting and setup hints',
  },
  {
    key: 'surfaces.telegram.mode',
    type: 'enum',
    default: 'webhook',
    description: 'Telegram ingress mode: webhook or polling',
    enumValues: ['webhook', 'polling'],
  },
  {
    key: 'surfaces.googleChat.enabled',
    type: 'boolean',
    default: false,
    description: 'Enable the Google Chat surface contract',
  },
  {
    key: 'surfaces.googleChat.webhookUrl',
    type: 'string',
    default: '',
    description: 'Google Chat outbound webhook or app callback URL',
  },
  {
    key: 'surfaces.googleChat.verificationToken',
    type: 'string',
    default: '',
    description: 'Google Chat verification token or shared secret',
  },
  {
    key: 'surfaces.googleChat.appId',
    type: 'string',
    default: '',
    description: 'Google Chat app identifier used for setup and diagnostics',
  },
  {
    key: 'surfaces.googleChat.spaceId',
    type: 'string',
    default: '',
    description: 'Default Google Chat space identifier for routing',
  },
  {
    key: 'surfaces.signal.enabled',
    type: 'boolean',
    default: false,
    description: 'Enable the Signal bridge surface contract',
  },
  {
    key: 'surfaces.signal.bridgeUrl',
    type: 'string',
    default: '',
    description: 'Signal bridge base URL used for health checks and delivery',
  },
  {
    key: 'surfaces.signal.account',
    type: 'string',
    default: '',
    description: 'Signal account or device identifier paired with the bridge',
  },
  {
    key: 'surfaces.signal.token',
    type: 'string',
    default: '',
    description: 'Signal bridge access token',
  },
  {
    key: 'surfaces.signal.defaultRecipient',
    type: 'string',
    default: '',
    description: 'Default Signal recipient or group identifier for routing',
  },
  {
    key: 'surfaces.whatsapp.enabled',
    type: 'boolean',
    default: false,
    description: 'Enable the WhatsApp surface contract',
  },
  {
    key: 'surfaces.whatsapp.provider',
    type: 'enum',
    default: 'meta-cloud',
    description: 'WhatsApp provider mode: Meta Cloud API or bridge',
    enumValues: ['meta-cloud', 'bridge'],
  },
  {
    key: 'surfaces.whatsapp.accessToken',
    type: 'string',
    default: '',
    description: 'WhatsApp provider access token',
  },
  {
    key: 'surfaces.whatsapp.verifyToken',
    type: 'string',
    default: '',
    description: 'WhatsApp webhook verify token or shared secret',
  },
  {
    key: 'surfaces.whatsapp.phoneNumberId',
    type: 'string',
    default: '',
    description: 'WhatsApp phone number id used for provider setup',
  },
  {
    key: 'surfaces.whatsapp.businessAccountId',
    type: 'string',
    default: '',
    description: 'WhatsApp business account id used for provider setup',
  },
  {
    key: 'surfaces.whatsapp.defaultRecipient',
    type: 'string',
    default: '',
    description: 'Default WhatsApp recipient or chat id for routing',
  },
  {
    key: 'surfaces.imessage.enabled',
    type: 'boolean',
    default: false,
    description: 'Enable the iMessage bridge surface contract',
  },
  {
    key: 'surfaces.imessage.bridgeUrl',
    type: 'string',
    default: '',
    description: 'iMessage bridge base URL used for health checks and delivery',
  },
  {
    key: 'surfaces.imessage.account',
    type: 'string',
    default: '',
    description: 'iMessage account identifier used by the bridge',
  },
  {
    key: 'surfaces.imessage.token',
    type: 'string',
    default: '',
    description: 'iMessage bridge access token',
  },
  {
    key: 'surfaces.imessage.defaultChatId',
    type: 'string',
    default: '',
    description: 'Default iMessage chat id for routing',
  },
  {
    key: 'watchers.enabled',
    type: 'boolean',
    default: false,
    description: 'Enable managed watcher/listener services',
  },
  {
    key: 'watchers.pollIntervalMs',
    type: 'number',
    default: 60_000,
    description: 'Polling interval for watcher sources in milliseconds',
    validate: (v) => typeof v === 'number' && Number.isInteger(v) && v >= 1_000 && v <= 24 * 60 * 60 * 1000,
  },
  {
    key: 'watchers.heartbeatIntervalMs',
    type: 'number',
    default: 15_000,
    description: 'Heartbeat interval for watcher services in milliseconds',
    validate: (v) => typeof v === 'number' && Number.isInteger(v) && v >= 1_000 && v <= 60 * 60 * 1000,
  },
  {
    key: 'watchers.recoveryWindowMinutes',
    type: 'number',
    default: 10,
    description: 'Recovery window for watcher restart and missed-event catch-up',
    validate: (v) => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 24 * 60,
  },
  {
    key: 'service.enabled',
    type: 'boolean',
    default: false,
    description: 'Enable service-install and daemon-management features',
  },
  {
    key: 'service.autostart',
    type: 'boolean',
    default: false,
    description: 'Start Goodvibes automatically when the host boots or logs in',
  },
  {
    key: 'service.restartOnFailure',
    type: 'boolean',
    default: true,
    description: 'Restart the service automatically after failure',
  },
  {
    key: 'service.platform',
    type: 'enum',
    default: 'auto',
    description: 'Target service manager platform',
    enumValues: ['auto', 'systemd', 'launchd', 'windows', 'manual'],
  },
  {
    key: 'service.serviceName',
    type: 'string',
    default: 'goodvibes',
    description: 'Service name used for host integration and install scripts',
  },
  {
    key: 'service.logPath',
    type: 'string',
    default: '',
    description: 'File path for daemon/service logs (empty = platform default under .goodvibes/tui/service/)',
  },
  {
    key: 'danger.daemon',
    type: 'boolean',
    default: false,
    description: 'Enable daemon mode (runs goodvibes-tui as a background service)',
  },
  {
    key: 'danger.httpListener',
    type: 'boolean',
    default: false,
    description: 'Enable HTTP webhook listener for receiving external events',
  },
  {
    key: 'tools.llmProvider',
    type: 'string',
    default: '',
    description: 'Provider for tool LLM calls (empty = use currently selected provider)',
  },
  {
    key: 'tools.llmModel',
    type: 'string',
    default: '',
    description: 'Model for tool LLM calls (empty = fastest available for the provider)',
  },
  {
    key: 'tools.autoHeal',
    type: 'boolean',
    default: false,
    description: 'Automatically fix syntax errors on precision write/edit operations',
  },
  {
    key: 'tools.defaultTokenBudget',
    type: 'number',
    default: 5000,
    description: 'Default token budget for precision read operations',
    validate: (v) => typeof v === 'number' && v >= 100 && v <= 100000,
  },
  {
    key: 'tools.hooksFile',
    type: 'string',
    default: 'hooks.json',
    description: 'Hook configuration file name (relative to .goodvibes/tui/)',
  },
  {
    key: 'wrfc.scoreThreshold',
    type: 'number',
    default: 9.9,
    description: 'Minimum review score to pass WRFC (0-10)',
    validate: (v) => typeof v === 'number' && v >= 0 && v <= 10,
  },
  {
    key: 'wrfc.maxFixAttempts',
    type: 'number',
    default: 5,
    description: 'Maximum gate retry depth before aborting WRFC chain',
    validate: (v) => typeof v === 'number' && v >= 1 && v <= 20,
  },
  {
    key: 'wrfc.autoCommit',
    type: 'boolean',
    default: true,
    description: 'Auto-commit when WRFC chain passes review and quality gates',
  },
  {
    key: 'cache.enabled',
    type: 'boolean',
    default: true,
    description: 'Enable prompt caching for eligible providers (Anthropic)',
  },
  {
    key: 'cache.stableTtl',
    type: 'enum',
    default: '1h',
    description: 'Cache TTL for stable content (system prompt + tools): 5m (ephemeral) or 1h (persistent)',
    enumValues: ['5m', '1h'],
  },
  {
    key: 'cache.monitorHitRate',
    type: 'boolean',
    default: true,
    description: 'Monitor cache hit rate and warn when below threshold',
  },
  {
    key: 'cache.hitRateWarningThreshold',
    type: 'number',
    default: 0.3,
    description: 'Warn when cache hit rate falls below this fraction (0.0–1.0)',
    validate: (v) => typeof v === 'number' && v >= 0 && v <= 1,
  },
  {
    key: 'helper.enabled',
    type: 'boolean',
    default: false,
    description: 'Enable helper model routing for grunt-work tasks',
  },
  {
    key: 'helper.globalProvider',
    type: 'string',
    default: '',
    description: 'Provider for the global helper model (empty = disabled)',
  },
  {
    key: 'helper.globalModel',
    type: 'string',
    default: '',
    description: 'Model ID for the global helper model (empty = disabled)',
  },
  {
    key: 'behavior.suggestAlternativeOnProviderFail',
    type: 'boolean',
    default: false,
    description: 'Show alternative model suggestion when current provider fails non-transiently',
  },
  {
    key: 'behavior.hitlMode',
    type: 'enum',
    default: 'balanced',
    description: 'HITL UX mode: controls notification verbosity and burst batching (quiet/balanced/operator)',
    enumValues: ['quiet', 'balanced', 'operator'],
  },
];
