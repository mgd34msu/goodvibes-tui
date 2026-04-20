/**
 * m-5: registerDiscoveredProviders idempotency test.
 *
 * Verifies that calling registerDiscoveredProviders() twice with overlapping
 * servers does not duplicate providers in the registry. This guards against
 * the race in src/daemon/cli.ts where loadPersistedProviders() registers
 * providers and the background scan() may return overlapping results shortly
 * after, causing double-registration.
 */

import { describe, expect, test } from 'bun:test';
import type { DiscoveredServer } from '@pellux/goodvibes-sdk/platform/discovery/scanner';
import { createTestManagers } from '../helpers/test-managers.ts';

function makeServer(name: string): DiscoveredServer {
  return {
    name,
    host: '192.168.0.100',
    port: 11434,
    baseURL: `http://192.168.0.100:11434`,
    models: ['llama3.2'],
    serverType: 'ollama',
  };
}

describe('registerDiscoveredProviders idempotency', () => {
  test('registering the same servers twice does not duplicate providers', () => {
    const { providerRegistry: registry } = createTestManagers();
    const servers = [makeServer('Server Alpha'), makeServer('Server Beta')];

    registry.registerDiscoveredProviders(servers);
    const countAfterFirst = registry.listProviders().length;

    // Second call with the same servers (simulates scan() returning same results
    // as loadPersistedProviders()). The SDK clears previous discovered providers
    // before re-registering, so the count must not exceed the first count.
    registry.registerDiscoveredProviders(servers);
    const countAfterSecond = registry.listProviders().length;

    // Providers must not be duplicated.
    expect(countAfterSecond).toBe(countAfterFirst);
  });

  test('registering overlapping server sets replaces discovered set atomically', () => {
    const { providerRegistry: registry } = createTestManagers();
    const serverA = makeServer('Server Alpha');
    const serverB = makeServer('Server Beta');
    const serverC = makeServer('Server Gamma');

    // First call: A + B (e.g., from loadPersistedProviders)
    registry.registerDiscoveredProviders([serverA, serverB]);
    const countAfterFirst = registry.listProviders().length;

    // Second call: B + C (e.g., from scan() — B is in both sets).
    // SDK semantics: clears previous discovered providers, registers B+C.
    registry.registerDiscoveredProviders([serverB, serverC]);
    const countAfterSecond = registry.listProviders().length;

    // The discovered set now has 2 servers (B + C), same count as first call
    // (A + B). Built-in count is constant. Total must equal countAfterFirst.
    expect(countAfterSecond).toBe(countAfterFirst);
  });
});
