/**
 * Config schema definitions and metadata for goodvibes-tui.
 */

export type PermissionMode = 'prompt' | 'allow-all' | 'custom';
export type PermissionAction = 'allow' | 'prompt' | 'deny';

export interface PermissionsToolConfig {
  // New tool names
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
  // Legacy tool names (backward compat)
  file_read?: PermissionAction;   // default: 'allow'
  file_write?: PermissionAction;  // default: 'prompt'
  file_edit?: PermissionAction;   // default: 'prompt'
  shell_exec?: PermissionAction;  // default: 'prompt'
  grep?: PermissionAction;        // default: 'allow'
  list_dir?: PermissionAction;    // default: 'allow'
  glob?: PermissionAction;        // default: 'allow'
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
  wrfc: {
    scoreThreshold: number;
    maxFixAttempts: number;
    autoCommit: boolean;
    // NOTE: gates is an array of objects and does not fit the scalar-value dot-path config API.
    // Access via configManager.getCategory('wrfc').gates — not via ConfigKey/ConfigValue.
    gates: Array<{ name: string; command: string; enabled: boolean }>;
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
  | 'permissions.tools.file_read'
  | 'permissions.tools.file_write'
  | 'permissions.tools.file_edit'
  | 'permissions.tools.shell_exec'
  | 'permissions.tools.grep'
  | 'permissions.tools.list_dir'
  | 'permissions.tools.glob'
  | 'danger.agentRecursion'
  | 'danger.maxGlobalAgents'
  | 'danger.maxRecursionDepth'
  | 'danger.daemon'
  | 'danger.httpListener'
  | 'tools.llmProvider'
  | 'tools.llmModel'
  | 'tools.autoHeal'
  | 'tools.defaultTokenBudget'
  | 'tools.hooksFile'
  | 'wrfc.scoreThreshold'
  | 'wrfc.maxFixAttempts'
  | 'wrfc.autoCommit';

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
  K extends 'permissions.tools.file_read' ? PermissionAction :
  K extends 'permissions.tools.file_write' ? PermissionAction :
  K extends 'permissions.tools.file_edit' ? PermissionAction :
  K extends 'permissions.tools.shell_exec' ? PermissionAction :
  K extends 'permissions.tools.grep' ? PermissionAction :
  K extends 'permissions.tools.list_dir' ? PermissionAction :
  K extends 'permissions.tools.glob' ? PermissionAction :
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
  K extends 'wrfc.scoreThreshold' ? number :
  K extends 'wrfc.maxFixAttempts' ? number :
  K extends 'wrfc.autoCommit' ? boolean :
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
      // New tool names
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
      // Legacy tool names (backward compat)
      file_read: 'allow',
      file_write: 'prompt',
      file_edit: 'prompt',
      shell_exec: 'prompt',
      grep: 'allow',
      list_dir: 'allow',
      glob: 'allow',
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
  wrfc: {
    scoreThreshold: 9.9,
    maxFixAttempts: 5,
    autoCommit: true,
    gates: [
      { name: 'typecheck', command: 'npx tsc --noEmit', enabled: true },
      { name: 'lint', command: 'npx eslint . --max-warnings 0', enabled: true },
      { name: 'test', command: 'npm test', enabled: true },
      { name: 'build', command: 'npm run build', enabled: false },
    ],
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
    key: 'permissions.tools.file_read',
    type: 'enum',
    default: 'allow',
    description: 'Permission for legacy file read operations (backward compat)',
    enumValues: ['allow', 'prompt', 'deny'],
  },
  {
    key: 'permissions.tools.file_write',
    type: 'enum',
    default: 'prompt',
    description: 'Permission for legacy file write operations (backward compat)',
    enumValues: ['allow', 'prompt', 'deny'],
  },
  {
    key: 'permissions.tools.file_edit',
    type: 'enum',
    default: 'prompt',
    description: 'Permission for legacy file edit operations (backward compat)',
    enumValues: ['allow', 'prompt', 'deny'],
  },
  {
    key: 'permissions.tools.shell_exec',
    type: 'enum',
    default: 'prompt',
    description: 'Permission for legacy shell execution (backward compat)',
    enumValues: ['allow', 'prompt', 'deny'],
  },
  {
    key: 'permissions.tools.grep',
    type: 'enum',
    default: 'allow',
    description: 'Permission for legacy grep/search operations (backward compat)',
    enumValues: ['allow', 'prompt', 'deny'],
  },
  {
    key: 'permissions.tools.list_dir',
    type: 'enum',
    default: 'allow',
    description: 'Permission for legacy directory listing (backward compat)',
    enumValues: ['allow', 'prompt', 'deny'],
  },
  {
    key: 'permissions.tools.glob',
    type: 'enum',
    default: 'allow',
    description: 'Permission for legacy glob pattern matching (backward compat)',
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
];
