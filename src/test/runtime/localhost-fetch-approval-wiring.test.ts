import { describe, expect, test } from 'bun:test';
import { buildLocalhostFetchApproval } from '@pellux/goodvibes-sdk/platform/runtime/permissions/localhost-fetch-approval';
import { configGetStub, configSetProjectValueStub } from '../helpers/config-manager-stub.ts';

/**
 * Locks the loopback-fetch approval contract the TUI wires into registerAllTools
 * and both agentOrchestrator.setDependencies call sites: the ask rides the
 * approval broker and persists through configManager, so a project is asked once
 * and never again — including across restart (a fresh manager whose project
 * value is already set never asks).
 */

/** A configManager stand-in backed by an in-memory project settings store. */
function fakeConfigManager(initial: Record<string, unknown> = {}) {
  const store: Record<string, unknown> = { ...initial };
  return {
    store,
    // Both share the same `store` object, so a write is visible to the next read.
    get: configGetStub(store),
    setProjectValue: configSetProjectValueStub(store),
  };
}

describe('localhost fetch approval — TUI wiring contract', () => {
  test('first loopback fetch asks once through the broker and persists the allow', async () => {
    const asks: Array<{ host: string; url: string }> = [];
    const configManager = fakeConfigManager();
    const approval = buildLocalhostFetchApproval({
      requestApproval: async (input) => {
        asks.push({ host: String(input.metadata?.host), url: String(input.metadata?.url) });
        return { approved: true, remember: false };
      },
      configManager,
    });

    const first = await approval({ url: 'http://127.0.0.1:5173/api', host: '127.0.0.1' });
    expect(first).toBe(true);
    expect(asks).toHaveLength(1);
    // Approving IS "allow for this project" — persisted in the project tier.
    expect(configManager.store['fetch.allowLocalhost']).toBe(true);

    // A second fetch in the same session never asks again.
    const second = await approval({ url: 'http://127.0.0.1:5173/other', host: '127.0.0.1' });
    expect(second).toBe(true);
    expect(asks).toHaveLength(1);
  });

  test('approval persists across restart — a fresh manager with the stored value never asks', async () => {
    let askCount = 0;
    // Simulates a new process whose project settings already carry the allow.
    const configManager = fakeConfigManager({ 'fetch.allowLocalhost': true });
    const approval = buildLocalhostFetchApproval({
      requestApproval: async () => { askCount += 1; return { approved: true, remember: false }; },
      configManager,
    });

    const result = await approval({ url: 'http://localhost:8080/', host: 'localhost' });
    expect(result).toBe(true);
    expect(askCount).toBe(0);
  });

  test('denying refuses this fetch and does not persist an allow', async () => {
    const configManager = fakeConfigManager();
    const approval = buildLocalhostFetchApproval({
      requestApproval: async () => ({ approved: false, remember: false }),
      configManager,
    });
    const result = await approval({ url: 'http://127.0.0.1:9000/', host: '127.0.0.1' });
    expect(result).toBe(false);
    expect(configManager.store['fetch.allowLocalhost']).toBeUndefined();
  });
});
