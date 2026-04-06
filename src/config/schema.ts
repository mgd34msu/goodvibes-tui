/**
 * Config schema definitions and metadata for goodvibes-tui.
 */

export type PermissionMode = 'prompt' | 'allow-all' | 'custom';
export type PermissionAction = 'allow' | 'prompt' | 'deny';

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

export interface GoodVibesConfig {
  display: {
    stream: boolean;            // default: true
    lineNumbers: boolean;       // default: false
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
    systemPromptFile: string;   // default: ''
  };
  behavior: {
    autoApprove: boolean;       // default: false
    autoCompactThreshold: number; // default: 80
    saveHistory: boolean;       // default: true
    notifyOnComplete: boolean;  // default: true
    suggestAlternativeOnProviderFail: boolean; // default: false
    hitlMode: 'quiet' | 'balanced' | 'operator'; // default: 'balanced'
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
  | 'provider.systemPromptFile'
  | 'behavior.autoApprove'
  | 'behavior.autoCompactThreshold'
  | 'behavior.saveHistory'
  | 'behavior.notifyOnComplete'
  | 'behavior.suggestAlternativeOnProviderFail'
  | 'behavior.hitlMode'
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
  | 'helper.globalModel';

/** Set of all valid config keys for runtime validation. */
export const CONFIG_KEYS = new Set<string>([
  'display.stream', 'display.lineNumbers', 'display.collapseThreshold', 'display.theme',
  'display.showThinking', 'display.showReasoningSummary', 'display.showTokenSpeed',
  'display.showToolPreview', 'provider.reasoningEffort', 'provider.model',
  'provider.provider', 'provider.systemPromptFile', 'behavior.autoApprove',
  'behavior.autoCompactThreshold', 'behavior.saveHistory', 'behavior.notifyOnComplete',
  'behavior.suggestAlternativeOnProviderFail', 'behavior.hitlMode', 'permissions.mode',
  'permissions.tools.read', 'permissions.tools.write', 'permissions.tools.edit',
  'permissions.tools.exec', 'permissions.tools.find', 'permissions.tools.fetch',
  'permissions.tools.analyze', 'permissions.tools.inspect', 'permissions.tools.agent',
  'permissions.tools.state', 'permissions.tools.workflow', 'permissions.tools.registry',
  'permissions.tools.delegate', 'permissions.tools.mcp', 'orchestration.recursionEnabled', 'orchestration.maxActiveAgents',
  'orchestration.maxDepth', 'danger.daemon', 'danger.httpListener',
  'tools.llmProvider', 'tools.llmModel', 'tools.autoHeal', 'tools.defaultTokenBudget',
  'tools.hooksFile', 'wrfc.scoreThreshold', 'wrfc.maxFixAttempts', 'wrfc.autoCommit',
  'cache.enabled', 'cache.stableTtl', 'cache.monitorHitRate', 'cache.hitRateWarningThreshold',
  'helper.enabled', 'helper.globalProvider', 'helper.globalModel',
] as const satisfies ConfigKey[]);

/** Type guard: returns true if key is a valid ConfigKey. */
export function isValidConfigKey(key: string): key is ConfigKey {
  return CONFIG_KEYS.has(key);
}

/** Maps a ConfigKey to its value type. */
export type ConfigValue<K extends ConfigKey> =
  K extends 'display.stream' ? boolean :
  K extends 'display.lineNumbers' ? boolean :
  K extends 'display.collapseThreshold' ? number :
  K extends 'display.theme' ? string :
  K extends 'display.showThinking' ? boolean :
  K extends 'display.showReasoningSummary' ? boolean :
  K extends 'display.showTokenSpeed' ? boolean :
  K extends 'display.showToolPreview' ? boolean :
  K extends 'provider.reasoningEffort' ? 'instant' | 'low' | 'medium' | 'high' :
  K extends 'provider.model' ? string :
  K extends 'provider.provider' ? string :
  K extends 'provider.systemPromptFile' ? string :
  K extends 'behavior.autoApprove' ? boolean :
  K extends 'behavior.autoCompactThreshold' ? number :
  K extends 'behavior.saveHistory' ? boolean :
  K extends 'behavior.notifyOnComplete' ? boolean :
  K extends 'behavior.suggestAlternativeOnProviderFail' ? boolean :
  K extends 'behavior.hitlMode' ? 'quiet' | 'balanced' | 'operator' :
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
  never;

export const DEFAULT_CONFIG: GoodVibesConfig = {
  display: {
    stream: true,
    lineNumbers: false,
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
    systemPromptFile: '',
  },
  behavior: {
    autoApprove: false,
    autoCompactThreshold: 80,
    saveHistory: true,
    notifyOnComplete: true,
    suggestAlternativeOnProviderFail: false,
    hitlMode: 'balanced',
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
    type: 'boolean',
    default: false,
    description: 'Show line numbers in code blocks',
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
