import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import type { ConfigManager } from '../config/manager.ts';
import type { RuntimeStore } from './store/index.ts';
import type { SessionMaintenanceStatus } from './session-maintenance.ts';
import { buildEcosystemRecommendations } from './ecosystem/recommendations.ts';

export type GuidanceMode = 'off' | 'minimal' | 'guided';
export type GuidanceCategory = 'onboarding' | 'operational' | 'recovery' | 'optimization';

export interface GuidanceItem {
  readonly id: string;
  readonly category: GuidanceCategory;
  readonly title: string;
  readonly summary: string;
  readonly commands: readonly string[];
}

interface GuidanceDismissalStore {
  readonly version: 1;
  readonly dismissed: Record<string, number>;
}

const GUIDANCE_FILE = join(homedir(), '.goodvibes', 'tui', 'guidance.json');

function readDismissals(): GuidanceDismissalStore {
  try {
    if (!existsSync(GUIDANCE_FILE)) return { version: 1, dismissed: {} };
    return JSON.parse(readFileSync(GUIDANCE_FILE, 'utf-8')) as GuidanceDismissalStore;
  } catch {
    return { version: 1, dismissed: {} };
  }
}

function writeDismissals(store: GuidanceDismissalStore): void {
  mkdirSync(join(homedir(), '.goodvibes', 'tui'), { recursive: true });
  writeFileSync(GUIDANCE_FILE, `${JSON.stringify(store, null, 2)}\n`, 'utf-8');
}

export function dismissGuidance(id: string): void {
  const store = readDismissals();
  store.dismissed[id] = Date.now();
  writeDismissals(store);
}

export function resetGuidance(id?: string): void {
  if (!id) {
    writeDismissals({ version: 1, dismissed: {} });
    return;
  }
  const store = readDismissals();
  delete store.dismissed[id];
  writeDismissals(store);
}

export function evaluateContextualGuidance(
  configManager: ConfigManager,
  runtimeStore: RuntimeStore | undefined,
  maintenance: SessionMaintenanceStatus,
): GuidanceItem[] {
  const mode = (configManager.get('behavior.guidanceMode') as GuidanceMode | undefined) ?? 'minimal';
  if (mode === 'off') return [];

  const state = runtimeStore?.getState();
  const dismissed = readDismissals().dismissed;
  const items: GuidanceItem[] = [];

  if (maintenance.level === 'suggest-compact' || maintenance.level === 'needs-repair') {
    items.push({
      id: 'context-maintenance',
      category: 'recovery',
      title: 'Context pressure needs attention',
      summary: 'The active session is near or beyond its healthy context budget.',
      commands: maintenance.nextSteps,
    });
  } else if (mode === 'guided' && maintenance.level === 'watch') {
    items.push({
      id: 'context-watch',
      category: 'optimization',
      title: 'Context pressure is rising',
      summary: 'Context is still healthy, but it is moving toward the configured compaction threshold.',
      commands: maintenance.nextSteps,
    });
  }

  if (state?.permissions.awaitingDecision) {
    items.push({
      id: 'pending-approval',
      category: 'recovery',
      title: 'A permission decision is waiting',
      summary: 'Operator approval is currently blocking the active workflow.',
      commands: ['/approval', '/security'],
    });
  }

  if ((state?.permissions.denialCount ?? 0) >= 3 && mode === 'guided') {
    items.push({
      id: 'repeated-denials',
      category: 'operational',
      title: 'Repeated denials suggest a policy mismatch',
      summary: 'Several actions were denied in this session. Review whether a scoped durable rule should be added.',
      commands: ['/policy', '/security', '/approval'],
    });
  }

  const authRequiredMcp = [...(state?.mcp.servers.values() ?? [])].filter((server) => server.status === 'auth_required');
  if (authRequiredMcp.length > 0) {
    items.push({
      id: 'mcp-auth-required',
      category: 'recovery',
      title: 'One or more MCP servers require authentication',
      summary: `${authRequiredMcp.length} MCP server${authRequiredMcp.length === 1 ? '' : 's'} cannot operate until auth is completed.`,
      commands: ['/mcp', '/services auth-review'],
    });
  }

  if ((state?.providerHealth.degradedCount ?? 0) > 0 || (state?.providerHealth.unavailableCount ?? 0) > 0) {
    items.push({
      id: 'provider-health',
      category: 'recovery',
      title: 'Provider health is degraded',
      summary: 'At least one configured provider is rate-limited, unavailable, or in an auth error state.',
      commands: ['/provider', '/health'],
    });
  }

  if (mode === 'guided' && state && state.intelligence.diagnosticsStatus === 'unavailable' && state.intelligence.symbolSearchStatus === 'unavailable') {
    items.push({
      id: 'intelligence-setup',
      category: 'onboarding',
      title: 'Workspace intelligence is not ready',
      summary: 'Diagnostics and symbol search are unavailable for this workspace. Enable or configure intelligence to improve code-aware workflows.',
      commands: ['/setup onboarding', '/health'],
    });
  }

  const ecosystemRecommendations = buildEcosystemRecommendations(runtimeStore);
  if (ecosystemRecommendations.length > 0) {
    const top = ecosystemRecommendations[0]!;
    items.push({
      id: 'ecosystem-recommendation',
      category: 'operational',
      title: top.title,
      summary: top.reason,
      commands: [top.command, '/marketplace recommend'],
    });
  }

  return items.filter((item) => !(item.id in dismissed));
}

export function formatGuidanceItems(items: readonly GuidanceItem[]): string[] {
  if (items.length === 0) return ['No active guidance items.'];
  return items.flatMap((item) => [
    `[${item.category}] ${item.title}`,
    `  ${item.summary}`,
    ...(item.commands.length > 0 ? [`  next: ${item.commands.join('  ')}`] : []),
    `  dismiss: /guidance dismiss ${item.id}`,
  ]);
}
