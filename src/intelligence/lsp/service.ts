import { existsSync } from 'fs';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { logger } from '../../utils/logger.ts';
import { LspClient } from './client.ts';

/**
 * Resolve a server command: check node_modules/.bin/ first (bundled),
 * then fall back to system PATH via Bun.which().
 * Returns the resolved command path, or the original command if neither found.
 */
function resolveCommand(command: string): string {
  // Try node_modules/.bin in project root
  const bundled = join(process.cwd(), 'node_modules', '.bin', command);
  if (existsSync(bundled)) return bundled;
  // Try system PATH
  const system = Bun.which(command);
  if (system) return system;
  // Return as-is — spawn will fail with a clear error
  return command;
}

export interface LspServerConfig {
  command: string;
  args: string[];
  initializationOptions?: Record<string, unknown>;
}

/** Well-known LSP server command → language IDs mapping for auto-detection. */
const WELL_KNOWN_SERVERS: Array<{ command: string; langIds: string[]; args: string[] }> = [
  { command: 'typescript-language-server', langIds: ['typescript', 'tsx', 'javascript'], args: ['--stdio'] },
  { command: 'pyright-langserver', langIds: ['python'], args: ['--stdio'] },
  { command: 'pylsp', langIds: ['python'], args: [] },
  { command: 'rust-analyzer', langIds: ['rust'], args: [] },
  { command: 'gopls', langIds: ['go'], args: ['serve'] },
  { command: 'bash-language-server', langIds: ['bash'], args: ['start'] },
  { command: 'vscode-css-language-server', langIds: ['css'], args: ['--stdio'] },
  { command: 'vscode-html-language-server', langIds: ['html'], args: ['--stdio'] },
  { command: 'vscode-json-language-server', langIds: ['json'], args: ['--stdio'] },
];

export class LspService {
  private static instance: LspService | null = null;
  private clients: Map<string, LspClient> = new Map();
  private configs: Map<string, LspServerConfig> = new Map();
  private initializing: Map<string, Promise<LspClient | null>> = new Map();

  private constructor() {}

  /** Singleton accessor. */
  static getInstance(): LspService {
    if (!LspService.instance) {
      LspService.instance = new LspService();
    }
    return LspService.instance;
  }

  /** Register a server configuration for a language. */
  registerServer(langId: string, config: LspServerConfig): void {
    this.configs.set(langId, config);
  }

  /**
   * Get or start a client for a language.
   * Returns null if no server is configured or if the server fails to start.
   */
  async getClient(langId: string): Promise<LspClient | null> {
    // Return existing running client
    const existing = this.clients.get(langId);
    if (existing?.isRunning) return existing;

    // No config registered
    if (!this.configs.has(langId)) return null;

    // Deduplicate concurrent initialization
    const inFlight = this.initializing.get(langId);
    if (inFlight) return inFlight;

    const initPromise = this._startClient(langId);
    this.initializing.set(langId, initPromise);

    try {
      const client = await initPromise;
      return client;
    } finally {
      this.initializing.delete(langId);
    }
  }

  private async _startClient(langId: string): Promise<LspClient | null> {
    const config = this.configs.get(langId);
    if (!config) return null;

    const resolvedCommand = resolveCommand(config.command);
    const client = new LspClient(resolvedCommand, config.args);
    try {
      await client.start();
      await this._initializeServer(client);
      this.clients.set(langId, client);
      logger.info('LspService: started server', { langId, command: config.command });
      return client;
    } catch (err) {
      logger.error('LspService: failed to start server', { langId, err: String(err) });
      try { await client.stop(); } catch { /* ignore */ }
      return null;
    }
  }

  /**
   * Check if a server is available for a language
   * (config exists AND command is installed on PATH).
   */
  async isAvailable(langId: string): Promise<boolean> {
    const config = this.configs.get(langId);
    if (!config) return false;
    // Check bundled first
    const bundled = join(process.cwd(), 'node_modules', '.bin', config.command);
    if (existsSync(bundled)) return true;
    // Then system PATH
    try {
      const resolved = Bun.which(config.command);
      return resolved !== null;
    } catch {
      return false;
    }
  }

  /** Initialize a server with the LSP handshake. */
  private async _initializeServer(client: LspClient): Promise<void> {
    await client.request('initialize', {
      processId: process.pid,
      rootUri: pathToFileURL(process.cwd()).href,
      capabilities: {
        textDocument: {
          documentSymbol: { hierarchicalDocumentSymbolSupport: true },
          definition: {},
          references: {},
          hover: {},
          rename: { prepareSupport: true },
          publishDiagnostics: {},
        },
      },
    });
    client.notify('initialized', {});
  }

  /** Stop all running servers. */
  async shutdown(): Promise<void> {
    const stops = Array.from(this.clients.values()).map(c => c.stop().catch(() => {}));
    await Promise.all(stops);
    this.clients.clear();
    this.initializing.clear();
  }

  /**
   * Auto-detect installed LSP servers and return their configs.
   * Registers detected servers automatically.
   */
  async detectServers(): Promise<Map<string, LspServerConfig>> {
    const detected = new Map<string, LspServerConfig>();

    for (const { command, langIds, args } of WELL_KNOWN_SERVERS) {
      let found = false;
      // Check bundled first, then system PATH
      const bundledPath = join(process.cwd(), 'node_modules', '.bin', command);
      if (existsSync(bundledPath)) {
        found = true;
      } else {
        try {
          found = Bun.which(command) !== null;
        } catch {
          found = false;
        }
      }

      if (found) {
        const config: LspServerConfig = { command, args };
        for (const langId of langIds) {
          // Don't overwrite already-registered configs
          if (!this.configs.has(langId)) {
            this.configs.set(langId, config);
          }
          // Add to returned detected map regardless
          if (!detected.has(langId)) {
            detected.set(langId, config);
          }
        }
        logger.info('LspService: detected server', { command, langIds });
      }
    }

    return detected;
  }

  /** Reset singleton (for testing only). */
  static _resetInstance(): void {
    LspService.instance = null;
  }
}
