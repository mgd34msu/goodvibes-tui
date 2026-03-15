/**
 * Config schema definitions and metadata for goodvibes-tui.
 */

export type PermissionMode = 'prompt' | 'allow-all' | 'custom';
export type PermissionAction = 'allow' | 'prompt' | 'deny';

export interface PermissionsToolConfig {
  file_read: PermissionAction;   // default: 'allow'
  file_write: PermissionAction;  // default: 'prompt'
  file_edit: PermissionAction;   // default: 'prompt'
  shell_exec: PermissionAction;  // default: 'prompt'
  grep: PermissionAction;        // default: 'allow'
  list_dir: PermissionAction;    // default: 'allow'
  glob: PermissionAction;        // default: 'allow'
  delegate: PermissionAction;    // default: 'prompt'
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
    model: string;              // default: 'mercury-2'
    provider: string;           // default: 'inceptionlabs'
    systemPromptFile: string;   // default: ''
  };
  behavior: {
    autoApprove: boolean;       // default: false
    autoCompactThreshold: number; // default: 80
    saveHistory: boolean;       // default: true
    notifyOnComplete: boolean;  // default: true
  };
  permissions: {
    mode: PermissionMode;       // default: 'prompt'
    tools: PermissionsToolConfig;
  };
  danger: {
    agentRecursion: boolean;        // default: false — allow agents to spawn subagents
    maxGlobalAgents: number;        // default: 8 — total agents across all levels
    maxRecursionDepth: number;      // default: 0 — 0=off, 1=one level (max allowed)
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
  | 'permissions.mode'
  | 'permissions.tools.file_read'
  | 'permissions.tools.file_write'
  | 'permissions.tools.file_edit'
  | 'permissions.tools.shell_exec'
  | 'permissions.tools.grep'
  | 'permissions.tools.list_dir'
  | 'permissions.tools.glob'
  | 'permissions.tools.delegate'
  | 'danger.agentRecursion'
  | 'danger.maxGlobalAgents'
  | 'danger.maxRecursionDepth'
  | 'danger.daemon'
  | 'danger.httpListener'
  | 'tools.llmProvider'
  | 'tools.llmModel'
  | 'tools.autoHeal'
  | 'tools.defaultTokenBudget'
  | 'tools.hooksFile';

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
  K extends 'permissions.mode' ? PermissionMode :
  K extends 'permissions.tools.file_read' ? PermissionAction :
  K extends 'permissions.tools.file_write' ? PermissionAction :
  K extends 'permissions.tools.file_edit' ? PermissionAction :
  K extends 'permissions.tools.shell_exec' ? PermissionAction :
  K extends 'permissions.tools.grep' ? PermissionAction :
  K extends 'permissions.tools.list_dir' ? PermissionAction :
  K extends 'permissions.tools.glob' ? PermissionAction :
  K extends 'permissions.tools.delegate' ? PermissionAction :
  K extends 'danger.agentRecursion' ? boolean :
  K extends 'danger.maxGlobalAgents' ? number :
  K extends 'danger.maxRecursionDepth' ? number :
  K extends 'danger.daemon' ? boolean :
  K extends 'danger.httpListener' ? boolean :
  K extends 'tools.llmProvider' ? string :
  K extends 'tools.llmModel' ? string :
  K extends 'tools.autoHeal' ? boolean :
  K extends 'tools.defaultTokenBudget' ? number :
  K extends 'tools.hooksFile' ? string :
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
    model: 'mercury-2',
    provider: 'inceptionlabs',
    systemPromptFile: '',
  },
  behavior: {
    autoApprove: false,
    autoCompactThreshold: 80,
    saveHistory: true,
    notifyOnComplete: true,
  },
  permissions: {
    mode: 'prompt',
    tools: {
      file_read: 'allow',
      file_write: 'prompt',
      file_edit: 'prompt',
      shell_exec: 'prompt',
      grep: 'allow',
      list_dir: 'allow',
      glob: 'allow',
      delegate: 'prompt',
    },
  },
  danger: {
    agentRecursion: false,
    maxGlobalAgents: 8,
    maxRecursionDepth: 0,
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
    enumValues: ['instant', 'low', 'medium', 'high'],
  },
  {
    key: 'provider.model',
    type: 'string',
    default: 'mercury-2',
    description: 'Default LLM model ID',
  },
  {
    key: 'provider.provider',
    type: 'string',
    default: 'inceptionlabs',
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
    key: 'permissions.tools.file_read',
    type: 'enum',
    default: 'allow',
    description: 'Permission for file_read tool',
    enumValues: ['allow', 'prompt', 'deny'],
  },
  {
    key: 'permissions.tools.file_write',
    type: 'enum',
    default: 'prompt',
    description: 'Permission for file_write tool',
    enumValues: ['allow', 'prompt', 'deny'],
  },
  {
    key: 'permissions.tools.file_edit',
    type: 'enum',
    default: 'prompt',
    description: 'Permission for file_edit tool',
    enumValues: ['allow', 'prompt', 'deny'],
  },
  {
    key: 'permissions.tools.shell_exec',
    type: 'enum',
    default: 'prompt',
    description: 'Permission for shell_exec tool',
    enumValues: ['allow', 'prompt', 'deny'],
  },
  {
    key: 'permissions.tools.grep',
    type: 'enum',
    default: 'allow',
    description: 'Permission for grep tool',
    enumValues: ['allow', 'prompt', 'deny'],
  },
  {
    key: 'permissions.tools.list_dir',
    type: 'enum',
    default: 'allow',
    description: 'Permission for list_dir tool',
    enumValues: ['allow', 'prompt', 'deny'],
  },
  {
    key: 'permissions.tools.glob',
    type: 'enum',
    default: 'allow',
    description: 'Permission for glob tool',
    enumValues: ['allow', 'prompt', 'deny'],
  },
  {
    key: 'permissions.tools.delegate',
    type: 'enum',
    default: 'prompt',
    description: 'Permission for delegate/unknown tools',
    enumValues: ['allow', 'prompt', 'deny'],
  },
  {
    key: 'danger.agentRecursion',
    type: 'boolean',
    default: false,
    description: 'Allow agents to spawn subagents (dangerous: can cause runaway recursion)',
  },
  {
    key: 'danger.maxGlobalAgents',
    type: 'number',
    default: 8,
    description: 'Total concurrent agents allowed across all recursion levels',
    validate: (v) => typeof v === 'number' && v >= 1 && v <= 20,
  },
  {
    key: 'danger.maxRecursionDepth',
    type: 'number',
    default: 0,
    description: 'Maximum agent recursion depth: 0=disabled, 1=one level (maximum allowed)',
    validate: (v) => typeof v === 'number' && (v === 0 || v === 1),
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
];
