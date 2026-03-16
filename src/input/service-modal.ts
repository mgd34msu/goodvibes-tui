/**
 * ServiceModal — state management for the /services command modal.
 *
 * Lists services from ServiceRegistry and tracks UI state:
 * selected index, test results per service, and the current action mode.
 */

import { ServiceRegistry, type ServiceConfig } from '../config/service-registry.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ServiceTestStatus = 'idle' | 'pending' | 'ok' | 'error';

export interface ServiceEntry {
  /** Registry key (e.g. 'openai'). */
  key: string;
  config: ServiceConfig;
  /** Whether a token/credential is present in SecretsManager. */
  hasToken: boolean;
  testStatus: ServiceTestStatus;
  /** HTTP status code from last test, or null. */
  testCode: number | null;
  /** Error message from last test, if any. */
  testError: string | null;
}

// ---------------------------------------------------------------------------
// ServiceModal
// ---------------------------------------------------------------------------

export class ServiceModal {
  public active = false;
  public entries: ServiceEntry[] = [];
  public selectedIndex = 0;

  private readonly registry: ServiceRegistry;

  constructor(registry?: ServiceRegistry) {
    this.registry = registry ?? new ServiceRegistry();
  }

  /**
   * Open the modal: load services from registry and resolve token presence.
   */
  async open(): Promise<void> {
    const all = this.registry.getAll();
    const entries: ServiceEntry[] = [];

    for (const [key, config] of Object.entries(all)) {
      // Check token presence via resolveAuth (non-destructive, just reads secrets).
      const headers = await this.registry.resolveAuth(key);
      entries.push({
        key,
        config,
        hasToken: headers !== null,
        testStatus: 'idle',
        testCode: null,
        testError: null,
      });
    }

    this.entries = entries;
    this.selectedIndex = 0;
    this.active = true;
  }

  close(): void {
    this.active = false;
  }

  moveUp(): void {
    if (this.entries.length === 0) return;
    this.selectedIndex = (this.selectedIndex - 1 + this.entries.length) % this.entries.length;
  }

  moveDown(): void {
    if (this.entries.length === 0) return;
    this.selectedIndex = (this.selectedIndex + 1) % this.entries.length;
  }

  getSelected(): ServiceEntry | null {
    return this.entries[this.selectedIndex] ?? null;
  }

  /**
   * Test the selected service: GET baseUrl/health or baseUrl.
   * Updates testStatus, testCode, and testError on the entry.
   */
  async testSelected(): Promise<void> {
    const entry = this.getSelected();
    if (!entry) return;

    entry.testStatus = 'pending';
    entry.testCode = null;
    entry.testError = null;

    const baseUrl = entry.config.baseUrl ?? '';
    if (!baseUrl) {
      entry.testStatus = 'error';
      entry.testError = 'No baseUrl configured';
      return;
    }

    // Resolve auth headers for the request.
    const headers = await this.registry.resolveAuth(entry.key);
    const reqHeaders: Record<string, string> = {
      Accept: 'application/json',
      ...(headers ?? {}),
    };

    // Try baseUrl/health first, then fall back to baseUrl.
    const urls = [
      baseUrl.replace(/\/$/, '') + '/health',
      baseUrl.replace(/\/$/, ''),
    ];

    for (const url of urls) {
      try {
        const resp = await fetch(url, {
          method: 'GET',
          headers: reqHeaders,
          signal: AbortSignal.timeout(5000),
        });
        entry.testStatus = resp.ok ? 'ok' : 'error';
        entry.testCode = resp.status;
        entry.testError = resp.ok ? null : `HTTP ${resp.status}`;
        return;
      } catch (err) {
        // Try next URL on network error
        entry.testError = (err as Error).message;
      }
    }

    entry.testStatus = 'error';
    if (!entry.testCode) entry.testCode = null;
  }
}
