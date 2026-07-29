/**
 * What this machine holds reaches `cluster status`.
 *
 * The two cluster layers were built separately and each owns half of this
 * answer. The group layer defines `surfaceHoldings` and renders it, but holds
 * no elections. The per-surface election decides who reads which inbox, but has
 * no group to report to. Unwired, `cluster status` prints "surfaces: not
 * reported by this daemon" on a perfectly healthy machine — which is the worst
 * possible output for the question an operator opens `cluster status` to answer:
 * my inbox is quiet, is THIS the machine that is supposed to be reading it?
 *
 * These tests hold the wiring in place at the composition root, which is the
 * only place both halves exist. They run a REAL election to completion rather
 * than reading the reader back immediately — an assertion taken before the boot
 * probe closes would pass against a list that is empty for timing reasons and
 * would keep passing if the wiring were removed.
 */
import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { inboxSurface, surfaceIdFor } from '@pellux/goodvibes-sdk/platform/cluster';
import { createClusterServices } from '../../runtime/cluster-group-composition.ts';
import type { ConfigManager, SecretsManager } from '@pellux/goodvibes-sdk/platform/config';
import type { ShellPathService } from '@/runtime/index.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

/**
 * Clustering ON with a short boot probe, so an election concludes in about a
 * second instead of the production default. The timings are the only thing
 * shortened; the election itself is the real one.
 */
function configManager(): ConfigManager {
  return {
    get: () => undefined,
    getCategory: (category: string) => (category === 'cluster'
      ? { enabled: true, bootProbeSeconds: 1, heartbeatSeconds: 1, masterTimeoutSeconds: 3 }
      : {}),
    set: () => {},
  } as unknown as ConfigManager;
}

function secretsManager(): SecretsManager {
  const store = new Map<string, string>();
  return {
    get: async (key: string) => store.get(key) ?? null,
    set: async (key: string, value: string) => { store.set(key, value); },
    delete: async (key: string) => { store.delete(key); },
  } as unknown as SecretsManager;
}

function services(): ReturnType<typeof createClusterServices> {
  const root = makeProjectTempDir('goodvibes-cluster-holdings');
  return createClusterServices({
    configManager: configManager(),
    shellPaths: {
      resolveProjectPath: (...segments: string[]) => join(root, ...segments),
    } as unknown as ShellPathService,
    secretsManager: secretsManager(),
  });
}

/**
 * Wait for a condition, polling.
 *
 * The ceiling is generous on purpose: it is a hang detector, not a performance
 * assertion. The election it waits on takes about a second and a half idle, and
 * a loaded host is allowed to be slower without turning this into a red run.
 */
async function waitUntil(predicate: () => boolean, label: string, ceilingMs = 30_000): Promise<void> {
  const deadline = Date.now() + ceilingMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out after ${ceilingMs}ms waiting for: ${label}`);
}

describe('the group layer reports the elections actually running', () => {
  test('a machine holding nothing yet reports an empty list, not "unavailable"', () => {
    const { clusterGroup } = services();
    // Composing must not have joined a network or held an election, so there is
    // genuinely nothing held — and that is a different statement from "this
    // daemon cannot tell you", which is what an unwired reader would produce.
    expect(clusterGroup.runtime.surfaceHoldings()).toEqual([]);
  });

  test('a surface the election awarded shows up in the group layer', async () => {
    const { clusterGroup, clusterCoordinator } = services();
    clusterCoordinator.register({
      id: 'inbox-poller:work-slack',
      surface: inboxSurface('work-slack'),
      start: async () => {},
      stop: async () => {},
    });
    await clusterCoordinator.start();
    try {
      await waitUntil(
        () => (clusterGroup.runtime.surfaceHoldings() ?? []).length > 0,
        'the group layer to report the surface this node won',
      );

      const holdings = clusterGroup.runtime.surfaceHoldings();
      expect(holdings).toHaveLength(1);
      // The exact surface that was elected, named by the digest the election
      // itself derived — not a placeholder and not a second tally.
      expect(holdings![0]!.surfaceId).toBe(surfaceIdFor(inboxSurface('work-slack')));
      expect(holdings![0]!.reason).toContain('elected');
      expect(clusterCoordinator.isMaster).toBe(true);
    } finally {
      await clusterCoordinator.stop('test');
    }
  }, 60_000);

  test('an account name never reaches the reported holding', async () => {
    const { clusterGroup, clusterCoordinator } = services();
    clusterCoordinator.register({
      id: 'inbox-poller:mikes-private-mailbox',
      surface: inboxSurface('mikes-private-mailbox'),
      start: async () => {},
      stop: async () => {},
    });
    await clusterCoordinator.start();
    try {
      await waitUntil(
        () => (clusterGroup.runtime.surfaceHoldings() ?? []).length > 0,
        'the group layer to report the surface this node won',
      );

      const holdings = clusterGroup.runtime.surfaceHoldings()!;
      expect(holdings).toHaveLength(1);
      // `cluster status` output gets pasted into issues, so the account is
      // named by digest everywhere — in the id and in the human reason alike.
      expect(JSON.stringify(holdings)).not.toContain('mikes-private-mailbox');
      expect(holdings[0]!.surfaceId).toBe(surfaceIdFor(inboxSurface('mikes-private-mailbox')));
      expect(holdings[0]!.surfaceId).toMatch(/^[0-9a-f]{32}$/);
    } finally {
      await clusterCoordinator.stop('test');
    }
  }, 60_000);
});
