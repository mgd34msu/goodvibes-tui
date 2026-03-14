import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { ConfigError } from './types/errors.ts';

/**
 * AppConfig - Centralized configuration for goodvibes-tui.
 * Load order: CLI args > env vars > local config file > global config file > defaults
 */
export interface AppConfig {
  provider: string;                   // default provider name
  model: string;                      // default model
  apiKeys: Record<string, string>;    // provider -> API key
  autoApprove: boolean;               // --no-worries-just-vibes
  workingDir: string;                 // cwd for tool execution
  systemPrompt?: string;              // optional system prompt
}

export { ConfigError };

/** Paths searched in priority order (last wins, then CLI args override all) */
const GLOBAL_CONFIG_PATH = join(homedir(), '.config', 'goodvibes', 'config.json');
const LOCAL_CONFIG_PATH = join(process.cwd(), 'goodvibes.config.json');

type PartialConfig = Partial<Omit<AppConfig, 'apiKeys'> & { apiKeys?: Record<string, string> }>;

function loadConfigFile(filePath: string): PartialConfig {
  if (!existsSync(filePath)) return {};
  try {
    const raw = readFileSync(filePath, 'utf-8');
    return JSON.parse(raw) as PartialConfig;
  } catch (err) {
    throw new ConfigError(`Failed to parse config file at ${filePath}: ${(err as Error).message}`);
  }
}

function parseCliArgs(): PartialConfig {
  const args = process.argv.slice(2);
  const result: PartialConfig = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--no-worries-just-vibes') {
      result.autoApprove = true;
    } else if (arg === '--provider' && args[i + 1]) {
      result.provider = args[++i];
    } else if (arg === '--model' && args[i + 1]) {
      result.model = args[++i];
    } else if (arg === '--system-prompt' && args[i + 1]) {
      result.systemPrompt = args[++i];
    } else if (arg === '--working-dir' && args[i + 1]) {
      result.workingDir = args[++i];
    }
  }

  return result;
}

function loadEnvApiKeys(): Record<string, string> {
  const keys: Record<string, string> = {};
  const mapping: Record<string, string> = {
    openai: 'OPENAI_API_KEY',
    anthropic: 'ANTHROPIC_API_KEY',
    gemini: 'GEMINI_API_KEY',
    inceptionlabs: 'INCEPTION_API_KEY',
  };

  for (const [provider, envVar] of Object.entries(mapping)) {
    const value = process.env[envVar];
    if (value) {
      keys[provider] = value;
    }
  }

  return keys;
}

const DEFAULTS: AppConfig = {
  provider: 'inceptionlabs',
  model: 'mercury-2',
  apiKeys: {},
  autoApprove: false,
  workingDir: process.cwd(),
};

function buildConfig(): AppConfig {
  const globalFile = loadConfigFile(GLOBAL_CONFIG_PATH);
  const localFile = loadConfigFile(LOCAL_CONFIG_PATH);
  const envKeys = loadEnvApiKeys();
  const cliArgs = parseCliArgs();

  // Merge in priority order: defaults < global file < local file < env keys < CLI args
  const merged: AppConfig = {
    ...DEFAULTS,
    ...globalFile,
    ...localFile,
    apiKeys: {
      ...DEFAULTS.apiKeys,
      ...globalFile.apiKeys,
      ...localFile.apiKeys,
      ...envKeys,
      ...cliArgs.apiKeys,
    },
    ...cliArgs,
  };

  return Object.freeze(merged);
}

/** Frozen, validated application config. Import this singleton everywhere. */
export const config: AppConfig = buildConfig();
