/**
 * Per-language configuration for CodeIntelligence.
 *
 * Config is loaded from (in priority order, higher overrides lower):
 *   1. .goodvibes/tui/languages/{langId}.json  (project-level)
 *   2. ~/.goodvibes/tui/languages/{langId}.json (user-level)
 *   3. Built-in defaults (this file)
 */
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { logger } from '../utils/logger.ts';
import type { ShellPathService } from '../runtime/shell-paths.ts';
import { summarizeError } from '../utils/error-display.ts';

export interface LanguageConfig {
  lsp?: {
    command: string;
    args: string[];
    initializationOptions?: Record<string, unknown>;
  };
  /** Grammar ID passed to the tree-sitter service (usually the same as langId). */
  treeSitter?: string;
  formatter?: { command: string; args: string[] };
  linter?: { command: string; args: string[] };
}

export type IntelligenceRoots = Pick<ShellPathService, 'workingDirectory' | 'homeDirectory'>;

// ---------------------------------------------------------------------------
// Default configurations
// ---------------------------------------------------------------------------

/**
 * Built-in defaults for common languages.
 * These are used when no user or project override exists.
 */
export function getDefaultConfigs(): Map<string, LanguageConfig> {
  const defaults = new Map<string, LanguageConfig>();

  defaults.set('typescript', {
    lsp: { command: 'typescript-language-server', args: ['--stdio'] },
    treeSitter: 'typescript',
  });

  defaults.set('tsx', {
    lsp: { command: 'typescript-language-server', args: ['--stdio'] },
    treeSitter: 'tsx',
  });

  defaults.set('javascript', {
    lsp: { command: 'typescript-language-server', args: ['--stdio'] },
    treeSitter: 'javascript',
  });

  defaults.set('python', {
    lsp: { command: 'pyright-langserver', args: ['--stdio'] },
    treeSitter: 'python',
  });

  defaults.set('rust', {
    lsp: { command: 'rust-analyzer', args: [] },
    treeSitter: 'rust',
  });

  defaults.set('go', {
    lsp: { command: 'gopls', args: ['serve'] },
    treeSitter: 'go',
  });

  defaults.set('bash', {
    lsp: { command: 'bash-language-server', args: ['start'] },
    treeSitter: 'bash',
  });

  defaults.set('css', {
    lsp: { command: 'vscode-css-language-server', args: ['--stdio'] },
    treeSitter: 'css',
  });

  defaults.set('html', {
    lsp: { command: 'vscode-html-language-server', args: ['--stdio'] },
    treeSitter: 'html',
  });

  defaults.set('json', {
    lsp: { command: 'vscode-json-language-server', args: ['--stdio'] },
    treeSitter: 'json',
  });

  return defaults;
}

// ---------------------------------------------------------------------------
// Config loading
// ---------------------------------------------------------------------------

/**
 * Read a JSON config file from disk, returning null on any error.
 */
function readConfigFile(filePath: string): LanguageConfig | null {
  try {
    if (!existsSync(filePath)) return null;
    const raw = readFileSync(filePath, 'utf-8');
    return JSON.parse(raw) as LanguageConfig;
  } catch (err) {
    logger.debug('config: failed to read language config', {
      filePath,
      error: summarizeError(err),
    });
    return null;
  }
}

/**
 * Load all language configs, merging defaults with user and project overrides.
 * Project-level configs override user-level, which override defaults.
 */
export function loadLanguageConfigs(roots: IntelligenceRoots): Map<string, LanguageConfig> {
  const result = getDefaultConfigs();

  const userDir = join(roots.homeDirectory, '.goodvibes', 'tui', 'languages');
  const projectDir = join(roots.workingDirectory, '.goodvibes', 'tui', 'languages');

  // Collect all known language IDs (from defaults + scan would go here).
  // For now we apply overrides only for IDs we already know about.
  for (const [langId, defaultCfg] of result.entries()) {
    // User-level override
    const userCfg = readConfigFile(join(userDir, `${langId}.json`));
    // Project-level override
    const projectCfg = readConfigFile(join(projectDir, `${langId}.json`));

    // Merge: defaults < user < project
    const merged: LanguageConfig = {
      ...defaultCfg,
      ...(userCfg ?? {}),
      ...(projectCfg ?? {}),
    };
    result.set(langId, merged);
  }

  return result;
}

/**
 * Get config for a specific language ID.
 * Loads configs on demand.
 */
export function getLanguageConfig(langId: string, roots: IntelligenceRoots): LanguageConfig | null {
  return loadLanguageConfigs(roots).get(langId) ?? null;
}
