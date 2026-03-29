import * as fs from 'fs';
import * as fsPromises from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import type { EventBus } from '../core/event-bus.ts';
import { OpenAICompatProvider } from './openai-compat.ts';
import { AnthropicCompatProvider } from './anthropic-compat.ts';
import type { LLMProvider } from './interface.ts';
import type { ModelDefinition } from './registry.ts';

/** Directory where custom provider JSON files are stored. */
const PROVIDERS_DIR = path.join(os.homedir(), '.goodvibes', 'tui', 'providers');

/** Debounce delay for file watcher (ms). */
const WATCH_DEBOUNCE_MS = 300;

/**
 * JSON schema for a custom provider configuration file.
 * Place a *.json file in ~/.goodvibes/tui/providers/ to define a custom provider.
 */
export interface CustomProviderConfig {
  /** Unique provider identifier, e.g. 'ollama' */
  name: string;
  /** Human-friendly display name, e.g. 'Ollama' */
  displayName: string;
  /**
   * API compatibility type.
   * - 'openai-compat': provider speaks the OpenAI Chat Completions API
   * - 'anthropic-compat': provider speaks the Anthropic Messages API (SSE streaming)
   */
  type: 'openai-compat' | 'anthropic-compat';
  /** Base URL for the API, e.g. 'http://localhost:11434/v1' */
  baseURL: string;
  /** Optional env var name whose value is used as the API key */
  apiKeyEnv?: string;
  /** Optional explicit API key (takes precedence over apiKeyEnv) */
  apiKey?: string;
  /** Optional extra HTTP headers sent with every request */
  defaultHeaders?: Record<string, string>;
  /** How to send reasoning params. Default: 'none' (don't send). */
  reasoningFormat?: 'mercury' | 'openrouter' | 'llamacpp' | 'none';
  /** List of models exposed by this provider */
  models: Array<{
    id: string;
    displayName: string;
    description?: string;
    contextWindow: number;
    selectable?: boolean;
    capabilities: {
      toolCalling: boolean;
      codeEditing: boolean;
      reasoning: boolean;
      multimodal: boolean;
    };
    reasoningEffort?: string[];
    /** Model capability tier — controls system prompt verbosity. */
    tier?: 'free' | 'standard' | 'premium';
  }>;
}

/** Result of loading all custom providers from disk. */
export interface LoadCustomProvidersResult {
  providers: Array<{ config: CustomProviderConfig; provider: LLMProvider }>;
  models: ModelDefinition[];
  warnings: string[];
}

/**
 * Resolve API key from config.
 * Priority: explicit apiKey > env var (apiKeyEnv) > empty string.
 */
function resolveApiKey(config: CustomProviderConfig): string {
  if (config.apiKey) return config.apiKey;
  if (config.apiKeyEnv) {
    const val = process.env[config.apiKeyEnv];
    if (val) return val;
  }
  return '';
}

/**
 * Validate a single parsed JSON object against the CustomProviderConfig schema.
 * Returns { valid, errors } — errors is empty when valid.
 */
export function validateCustomProvider(data: unknown): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return { valid: false, errors: ['Root value must be a JSON object'] };
  }

  const obj = data as Record<string, unknown>;

  if (typeof obj['name'] !== 'string' || obj['name'].trim() === '') {
    errors.push('"name" must be a non-empty string');
  }

  if (typeof obj['displayName'] !== 'string' || obj['displayName'].trim() === '') {
    errors.push('"displayName" must be a non-empty string');
  }

  if (obj['type'] !== 'openai-compat' && obj['type'] !== 'anthropic-compat') {
    errors.push('"type" must be "openai-compat" or "anthropic-compat"');
  }

  if (typeof obj['baseURL'] !== 'string' || obj['baseURL'].trim() === '') {
    errors.push('"baseURL" must be a non-empty string');
  }

  if (obj['reasoningFormat'] !== undefined) {
    if (!['mercury', 'openrouter', 'llamacpp', 'none'].includes(obj['reasoningFormat'] as string)) {
      errors.push('"reasoningFormat" must be "mercury", "openrouter", "llamacpp", or "none"');
    }
  }

  if (!Array.isArray(obj['models']) || (obj['models'] as unknown[]).length === 0) {
    errors.push('"models" must be a non-empty array');
  } else {
    const models = obj['models'] as unknown[];
    models.forEach((m, i) => {
      if (typeof m !== 'object' || m === null || Array.isArray(m)) {
        errors.push(`models[${i}]: must be an object`);
        return;
      }
      const model = m as Record<string, unknown>;
      if (typeof model['id'] !== 'string' || model['id'].trim() === '') {
        errors.push(`models[${i}]: "id" must be a non-empty string`);
      }
      if (typeof model['displayName'] !== 'string' || model['displayName'].trim() === '') {
        errors.push(`models[${i}]: "displayName" must be a non-empty string`);
      }
      if (typeof model['contextWindow'] !== 'number' || model['contextWindow'] <= 0) {
        errors.push(`models[${i}]: "contextWindow" must be a positive number`);
      }
      if (typeof model['capabilities'] !== 'object' || model['capabilities'] === null) {
        errors.push(`models[${i}]: "capabilities" must be an object`);
      } else {
        const caps = model['capabilities'] as Record<string, unknown>;
        for (const cap of ['toolCalling', 'codeEditing', 'reasoning', 'multimodal']) {
          if (typeof caps[cap] !== 'boolean') {
            errors.push(`models[${i}]: capabilities.${cap} must be a boolean`);
          }
        }
      }
    });
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Ensure the providers directory exists, creating it if necessary.
 */
async function ensureProvidersDir(): Promise<void> {
  try {
    await fsPromises.mkdir(PROVIDERS_DIR, { recursive: true });
  } catch (err) {
    throw new Error(
      `[custom-loader] Failed to create providers directory '${PROVIDERS_DIR}': ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

/**
 * Load all custom providers from ~/.goodvibes/tui/providers/*.json.
 * Auto-creates the directory if it does not exist.
 * Invalid files are skipped with a warning rather than failing the whole load.
 */
export async function loadCustomProviders(): Promise<LoadCustomProvidersResult> {
  const warnings: string[] = [];
  const providers: Array<{ config: CustomProviderConfig; provider: LLMProvider }> = [];
  const models: ModelDefinition[] = [];

  await ensureProvidersDir();

  let entries: string[];
  try {
    const dirents = await fsPromises.readdir(PROVIDERS_DIR, { withFileTypes: true });
    entries = dirents
      .filter((d) => d.isFile() && d.name.endsWith('.json'))
      .map((d) => d.name);
  } catch (err) {
    warnings.push(
      `[custom-loader] Could not read providers directory: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return { providers, models, warnings };
  }

  for (const filename of entries) {
    const filepath = path.join(PROVIDERS_DIR, filename);
    let raw: string;
    try {
      raw = await fsPromises.readFile(filepath, 'utf-8');
    } catch (err) {
      warnings.push(
        `[custom-loader] Could not read '${filename}': ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      warnings.push(
        `[custom-loader] Invalid JSON in '${filename}': ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      continue;
    }

    const { valid, errors } = validateCustomProvider(parsed);
    if (!valid) {
      warnings.push(
        `[custom-loader] Skipping '${filename}' — validation errors:\n  ${errors.join('\n  ')}`,
      );
      continue;
    }

    const cfg = parsed as CustomProviderConfig;

    const apiKey = resolveApiKey(cfg);
    const modelIds = cfg.models.map((m) => m.id);

    let provider: LLMProvider;
    try {
      if (cfg.type === 'anthropic-compat') {
        provider = new AnthropicCompatProvider({
          name: cfg.name,
          baseURL: cfg.baseURL,
          apiKey,
          defaultModel: modelIds[0]!,
          models: modelIds,
          ...(cfg.defaultHeaders ? { defaultHeaders: cfg.defaultHeaders } : {}),
        });
      } else {
        provider = new OpenAICompatProvider({
          name: cfg.name,
          baseURL: cfg.baseURL,
          apiKey,
          defaultModel: modelIds[0]!,
          models: modelIds,
          ...(cfg.defaultHeaders ? { defaultHeaders: cfg.defaultHeaders } : {}),
          reasoningFormat: cfg.reasoningFormat ?? 'none',
        });
      }
    } catch (err) {
      warnings.push(
        `[custom-loader] Failed to instantiate provider from '${filename}': ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      continue;
    }

    const modelDefs: ModelDefinition[] = cfg.models.map((m) => ({
      id: m.id,
      provider: cfg.name,
      registryKey: `${cfg.name}:${m.id}`,
      displayName: m.displayName,
      description: m.description ?? '',
      contextWindow: m.contextWindow,
      selectable: m.selectable ?? true,
      capabilities: {
        toolCalling: m.capabilities.toolCalling,
        codeEditing: m.capabilities.codeEditing,
        reasoning: m.capabilities.reasoning,
        multimodal: m.capabilities.multimodal,
      },
      ...(m.reasoningEffort ? { reasoningEffort: m.reasoningEffort } : {}),
      ...(m.tier ? { tier: m.tier } : {}),
    }));

    providers.push({ config: cfg, provider });
    models.push(...modelDefs);
  }

  return { providers, models, warnings };
}

/**
 * Start watching ~/.goodvibes/tui/providers/ for file changes.
 * Debounces rapid events by 300ms before invoking the onChange callback.
 * Emits 'providers:warning' on the bus if the watcher cannot be started.
 * Returns a handle with a `close()` method to stop watching.
 */
export function watchCustomProviders(
  bus: EventBus,
  onChange: () => void,
): { close: () => void } {
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let watcher: fs.FSWatcher | null = null;

  const startWatch = () => {
    try {
      // Note: fs.watch() may miss atomic renames (e.g. editor save-via-rename) on
      // some Linux filesystems. If that becomes a problem, consider replacing this
      // with the 'chokidar' library which uses inotify directly.
      watcher = fs.watch(
        PROVIDERS_DIR,
        { persistent: false }, // Don't keep the Node process alive just for this watcher
        (_eventType, _filename) => {
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          debounceTimer = null;
          onChange();
        }, WATCH_DEBOUNCE_MS);
      });

      watcher.on('error', (err) => {
        bus.emit('providers:warning', {
          message: `[custom-loader] Watcher error: ${err.message}`,
        });
      });
    } catch (err) {
      bus.emit('providers:warning', {
        message: `[custom-loader] Could not watch providers directory: ${
          err instanceof Error ? err.message : String(err)
        }`,
      });
    }
  };

  // Ensure the directory exists before starting the watcher
  fsPromises
    .mkdir(PROVIDERS_DIR, { recursive: true })
    .then(() => startWatch())
    .catch((err) => {
      bus.emit('providers:warning', {
        message: `[custom-loader] Could not create/watch providers directory: ${
          err instanceof Error ? err.message : String(err)
        }`,
      });
    });

  return {
    close() {
      if (debounceTimer) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
      }
      if (watcher) {
        watcher.close();
        watcher = null;
      }
    },
  };
}
