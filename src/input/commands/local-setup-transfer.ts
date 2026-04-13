import { dirname, join, resolve } from 'node:path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { CommandContext } from '../command-registry.ts';
import type { ConfigKey } from '../../config/index.ts';
import { CONFIG_SCHEMA } from '../../config/index.ts';
import { requireShellPaths } from './runtime-services.ts';

export interface SetupReviewSnapshot {
  readonly sessionId: string;
  readonly providerCount: number;
  readonly serviceCount: number;
  readonly oauthProviderCount: number;
  readonly builtinSubscriptionProviderCount: number;
  readonly activeSubscriptionCount: number;
  readonly pendingSubscriptionCount: number;
  readonly serviceIssues: string[];
  readonly skillCount: number;
  readonly pluginCount: number;
  readonly quarantinedPluginCount: number;
  readonly pluginDirectories: string[];
  readonly managedHookCount: number;
  readonly managedHookChainCount: number;
  readonly mcpServerCount: number;
  readonly quarantinedMcpCount: number;
  readonly elevatedMcpCount: number;
  readonly remoteRunnerCount: number;
  readonly sandboxReplIsolation: string;
  readonly sandboxMcpIsolation: string;
  readonly sandboxSecureModeReady: boolean;
  readonly issues: Array<{ severity: 'pass' | 'warn' | 'fail'; area: string; message: string }>;
  readonly services: string[];
}

export interface SetupTransferBundle {
  readonly schemaVersion: 'v1';
  readonly exportedAt: number;
  readonly startupReview: SetupReviewSnapshot;
  readonly config: Record<string, unknown>;
  readonly services?: Record<string, unknown>;
  readonly ecosystem?: {
    readonly plugins?: Record<string, unknown>;
    readonly skills?: Record<string, unknown>;
  };
}

export function inspectSetupTransferBundle(bundle: SetupTransferBundle): string {
  const ecosystemPluginCount = bundle.ecosystem?.plugins && Array.isArray((bundle.ecosystem.plugins as { entries?: unknown[] }).entries)
    ? ((bundle.ecosystem.plugins as { entries: unknown[] }).entries.length)
    : 0;
  const ecosystemSkillCount = bundle.ecosystem?.skills && Array.isArray((bundle.ecosystem.skills as { entries?: unknown[] }).entries)
    ? ((bundle.ecosystem.skills as { entries: unknown[] }).entries.length)
    : 0;
  return [
    'Setup Transfer Review',
    `  schemaVersion: ${bundle.schemaVersion}`,
    `  exportedAt: ${new Date(bundle.exportedAt).toISOString()}`,
    `  session: ${bundle.startupReview.sessionId}`,
    `  services: ${bundle.startupReview.serviceCount}`,
    `  plugins: ${bundle.startupReview.pluginCount}`,
    `  skills: ${bundle.startupReview.skillCount}`,
    `  remote runners: ${bundle.startupReview.remoteRunnerCount}`,
    `  config keys: ${Object.keys(bundle.config ?? {}).length}`,
    `  curated plugins: ${ecosystemPluginCount}`,
    `  curated skills: ${ecosystemSkillCount}`,
  ].join('\n');
}

export function buildSetupTransferBundle(ctx: CommandContext, snapshot: SetupReviewSnapshot): SetupTransferBundle {
  const shellPaths = requireShellPaths(ctx);
  const config: Record<string, unknown> = {};
  for (const entry of CONFIG_SCHEMA) {
    try {
      config[entry.key] = structuredClone(ctx.platform.configManager.get(entry.key as ConfigKey));
    } catch {
      // Ignore unreadable config values in transfer bundles.
    }
  }
  const servicesPath = shellPaths.resolveProjectTuiPath('services.json');
  const pluginsPath = shellPaths.resolveProjectTuiPath('ecosystem', 'plugins.json');
  const skillsPath = shellPaths.resolveProjectTuiPath('ecosystem', 'skills.json');
  const services = existsSync(servicesPath)
    ? JSON.parse(readFileSync(servicesPath, 'utf-8')) as Record<string, unknown>
    : undefined;
  const plugins = existsSync(pluginsPath)
    ? JSON.parse(readFileSync(pluginsPath, 'utf-8')) as Record<string, unknown>
    : undefined;
  const skills = existsSync(skillsPath)
    ? JSON.parse(readFileSync(skillsPath, 'utf-8')) as Record<string, unknown>
    : undefined;

  return {
    schemaVersion: 'v1',
    exportedAt: Date.now(),
    startupReview: snapshot,
    config,
    services,
    ecosystem: {
      plugins,
      skills,
    },
  };
}

export function createSetupLink(surface: string, target?: string): string {
  const encodedTarget = target ? `?target=${encodeURIComponent(target)}` : '';
  return `goodvibes://open/${encodeURIComponent(surface)}${encodedTarget}`;
}

export function parseSetupLink(value: string): { surface: string; target?: string } | null {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'goodvibes:') return null;
    const segments = parsed.pathname.split('/').filter(Boolean);
    if (parsed.hostname !== 'open' || segments.length !== 1) return null;
    return {
      surface: decodeURIComponent(segments[0]!),
      target: parsed.searchParams.get('target') ?? undefined,
    };
  } catch {
    return null;
  }
}

export function exportSetupTransferBundle(
  ctx: CommandContext,
  pathArg: string,
  bundle: SetupTransferBundle,
): string {
  const shellPaths = requireShellPaths(ctx);
  const targetPath = shellPaths.resolveWorkspacePath(pathArg);
  mkdirSync(dirname(targetPath), { recursive: true });
  writeFileSync(targetPath, JSON.stringify(bundle, null, 2) + '\n', 'utf-8');
  return targetPath;
}
