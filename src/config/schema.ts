/**
 * Config schema definitions and metadata for goodvibes-tui.
 */

export interface GoodVibesConfig {
  display: {
    stream: boolean;            // default: true
    lineNumbers: boolean;       // default: false
    collapseThreshold: number;  // default: 30
    theme: string;              // default: 'vaporwave'
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
  | 'provider.reasoningEffort'
  | 'provider.model'
  | 'provider.provider'
  | 'provider.systemPromptFile'
  | 'behavior.autoApprove'
  | 'behavior.autoCompactThreshold'
  | 'behavior.saveHistory';

/** Maps a ConfigKey to its value type. */
export type ConfigValue<K extends ConfigKey> =
  K extends 'display.stream' ? boolean :
  K extends 'display.lineNumbers' ? boolean :
  K extends 'display.collapseThreshold' ? number :
  K extends 'display.theme' ? string :
  K extends 'provider.reasoningEffort' ? 'instant' | 'low' | 'medium' | 'high' :
  K extends 'provider.model' ? string :
  K extends 'provider.provider' ? string :
  K extends 'provider.systemPromptFile' ? string :
  K extends 'behavior.autoApprove' ? boolean :
  K extends 'behavior.autoCompactThreshold' ? number :
  K extends 'behavior.saveHistory' ? boolean :
  never;

export const DEFAULT_CONFIG: GoodVibesConfig = {
  display: {
    stream: true,
    lineNumbers: false,
    collapseThreshold: 30,
    theme: 'vaporwave',
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
];
