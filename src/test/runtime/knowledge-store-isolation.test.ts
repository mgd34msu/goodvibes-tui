import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigManager } from '@pellux/goodvibes-sdk/platform/config';
import { RuntimeEventBus } from '@/runtime/index.ts';
import { createRuntimeServices } from '../../runtime/services.ts';
import { createRuntimeStore } from '../../runtime/store/index.ts';
import { trackDisposables } from '../helpers/disposables.ts';

/**
 * A composed runtime graph starts a dozen pollers while it builds, the fleet
 * registry tick, the config-file watch, the memory governor, the knowledge
 * scheduler, the cross-session sweep, the orchestration snapshot writer, the
 * push-subscription sweep and the snapshot / retention / consolidation
 * schedulers. Nothing upstream stops a graph it did not compose itself, so the
 * test that built it owns stopping it.
 */
const disposables = trackDisposables();

const roots: string[] = [];

function makeRuntime() {
  const root = join(tmpdir(), `gv-knowledge-isolation-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const workingDir = join(root, 'workspace');
  const homeDir = join(root, 'home');
  const configDir = join(root, 'config');
  mkdirSync(workingDir, { recursive: true });
  mkdirSync(homeDir, { recursive: true });
  mkdirSync(configDir, { recursive: true });
  roots.push(root);

  const configManager = new ConfigManager({
    surfaceRoot: 'tui',
    configDir,
    workingDir,
    homeDir,
  });

  return {
    configManager,
    services: disposables.add(createRuntimeServices({
      configManager,
      runtimeBus: new RuntimeEventBus(),
      runtimeStore: createRuntimeStore(),
      workingDir,
      homeDirectory: homeDir,
    })),
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('runtime knowledge store isolation', () => {
  test('regular Knowledge/Wiki, Agent knowledge, and Home Graph use separate sqlite stores', async () => {
    const { configManager, services } = makeRuntime();
    const controlPlaneDir = configManager.getControlPlaneConfigDir();

    await services.knowledgeService.getStatus({ includeAllSpaces: true });
    const agentStatus = await services.agentKnowledgeService.getStatus({ includeAllSpaces: true });
    const sync = await services.homeGraphService.syncSnapshot({
      installationId: 'isolation',
      title: 'Isolation Home',
      capturedAt: Date.now(),
      pageAutomation: { enabled: false },
      areas: [{ id: 'area-lab', name: 'Lab' }],
      devices: [{ id: 'device-light', name: 'Isolation Light', areaId: 'area-lab' }],
      entities: [{ id: 'light.isolation_light', name: 'Isolation Light', deviceId: 'device-light', areaId: 'area-lab' }],
      integrations: [{ id: 'integration-light', name: 'Light Integration' }],
    });
    const homeGraphStatus = await services.homeGraphService.status({ installationId: 'isolation' });
    const ask = await services.homeGraphService.ask({
      installationId: 'isolation',
      query: 'where is the isolation light?',
      includeSources: true,
      includeLinkedObjects: true,
      timeoutMs: 1_000,
    });
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(sync.ok).toBe(true);
    expect(ask.ok).toBe(true);
    expect(homeGraphStatus.nodeCount).toBeGreaterThan(0);
    expect(agentStatus.sourceCount).toBe(0);
    expect(agentStatus.nodeCount).toBe(0);
    expect(existsSync(join(controlPlaneDir, 'knowledge-wiki.sqlite'))).toBe(true);
    expect(existsSync(join(controlPlaneDir, 'knowledge-agent.sqlite'))).toBe(true);
    expect(existsSync(join(controlPlaneDir, 'knowledge-home-graph.sqlite'))).toBe(true);

    const regularNodes = services.knowledgeService.queryNodes({ includeAllSpaces: true, limit: 100 }).items;
    const agentNodes = services.agentKnowledgeService.queryNodes({ includeAllSpaces: true, limit: 100 }).items;
    const regularMap = await services.knowledgeService.map({ includeAllSpaces: true, limit: 100 });
    expect(regularNodes.some((node) => node.title.includes('Isolation Light') || node.id.includes('isolation'))).toBe(false);
    expect(agentNodes.some((node) => node.title.includes('Isolation Light') || node.id.includes('isolation'))).toBe(false);
    expect(regularMap.nodes.some((node) => String(node.title ?? '').includes('Isolation Light') || node.id.includes('isolation'))).toBe(false);
  });
});
