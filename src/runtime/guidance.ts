import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import type { ConfigManager } from '@pellux/goodvibes-sdk/platform/config/manager';
import type { SessionMaintenanceStatus } from '@pellux/goodvibes-sdk/platform/runtime/session-maintenance';
import type { EcosystemRecommendation } from '@pellux/goodvibes-sdk/platform/runtime/ecosystem/recommendations';

export type GuidanceMode = 'off' | 'minimal' | 'guided';
export type GuidanceCategory = 'onboarding' | 'operational' | 'recovery' | 'optimization';

export interface GuidanceItem {
  readonly id: string;
  readonly category: GuidanceCategory;
  readonly title: string;
  readonly summary: string;
  readonly commands: readonly string[];
}

export interface ContextualGuidanceSnapshot {
  readonly pendingApproval: boolean;
  readonly denialCount: number;
  readonly authRequiredMcpCount: number;
  readonly degradedProviderCount: number;
  readonly intelligenceUnavailable: boolean;
  readonly recommendations: readonly EcosystemRecommendation[];
}

interface GuidanceDismissalStore {
  readonly version: 1;
  readonly dismissed: Record<string, number>;
}

export interface GuidancePersistenceOptions {
  readonly guidancePath?: string;
  readonly userRoot?: string;
  readonly homeDirectory?: string;
}

function resolveGuidancePath(options?: GuidancePersistenceOptions): string {
  if (options?.guidancePath) {
    return options.guidancePath;
  }
  const userRoot = options?.userRoot ?? options?.homeDirectory;
  if (!userRoot) {
    throw new Error('Guidance persistence requires guidancePath or an explicit userRoot/homeDirectory.');
  }
  return join(userRoot, '.goodvibes', 'tui', 'guidance.json');
}

function readDismissals(options?: GuidancePersistenceOptions): GuidanceDismissalStore {
  try {
    const guidanceFile = resolveGuidancePath(options);
    if (!existsSync(guidanceFile)) return { version: 1, dismissed: {} };
    return JSON.parse(readFileSync(guidanceFile, 'utf-8')) as GuidanceDismissalStore;
  } catch {
    return { version: 1, dismissed: {} };
  }
}

function writeDismissals(store: GuidanceDismissalStore, options?: GuidancePersistenceOptions): void {
  const guidanceFile = resolveGuidancePath(options);
  mkdirSync(dirname(guidanceFile), { recursive: true });
  writeFileSync(guidanceFile, `${JSON.stringify(store, null, 2)}\n`, 'utf-8');
}

export function dismissGuidance(id: string, options?: GuidancePersistenceOptions): void {
  const store = readDismissals(options);
  store.dismissed[id] = Date.now();
  writeDismissals(store, options);
}

export function resetGuidance(id?: string, options?: GuidancePersistenceOptions): void {
  if (!id) {
    writeDismissals({ version: 1, dismissed: {} }, options);
    return;
  }
  const store = readDismissals(options);
  delete store.dismissed[id];
  writeDismissals(store, options);
}

export function evaluateContextualGuidance(
  configManager: ConfigManager,
  snapshot: ContextualGuidanceSnapshot,
  maintenance: SessionMaintenanceStatus,
  options?: GuidancePersistenceOptions,
): GuidanceItem[] {
  const mode = (configManager.get('behavior.guidanceMode') as GuidanceMode | undefined) ?? 'minimal';
  if (mode === 'off') return [];

  const dismissed = readDismissals(options).dismissed;
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

  if (snapshot.pendingApproval) {
    items.push({
      id: 'pending-approval',
      category: 'recovery',
      title: 'A permission decision is waiting',
      summary: 'Operator approval is currently blocking the active workflow.',
      commands: ['/approval', '/security'],
    });
  }

  if (snapshot.denialCount >= 3 && mode === 'guided') {
    items.push({
      id: 'repeated-denials',
      category: 'operational',
      title: 'Repeated denials suggest a policy mismatch',
      summary: 'Several actions were denied in this session. Review whether a scoped durable rule should be added.',
      commands: ['/policy', '/security', '/approval'],
    });
  }

  if (snapshot.authRequiredMcpCount > 0) {
    items.push({
      id: 'mcp-auth-required',
      category: 'recovery',
      title: 'One or more MCP servers require authentication',
      summary: `${snapshot.authRequiredMcpCount} MCP server${snapshot.authRequiredMcpCount === 1 ? '' : 's'} cannot operate until auth is completed.`,
      commands: ['/mcp', '/services auth-review'],
    });
  }

  if (snapshot.degradedProviderCount > 0) {
    items.push({
      id: 'provider-health',
      category: 'recovery',
      title: 'Provider health is degraded',
      summary: 'At least one configured provider is rate-limited, unavailable, or in an auth error state.',
      commands: ['/provider', '/health'],
    });
  }

  if (mode === 'guided' && snapshot.intelligenceUnavailable) {
    items.push({
      id: 'intelligence-setup',
      category: 'onboarding',
      title: 'Workspace intelligence is not ready',
      summary: 'Diagnostics and symbol search are unavailable for this workspace. Enable or configure intelligence to improve code-aware workflows.',
      commands: ['/setup onboarding', '/health'],
    });
  }

  if (snapshot.recommendations.length > 0) {
    const top = snapshot.recommendations[0]!;
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
