import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { configManager } from '../config/index.ts';
import { logger } from '../utils/logger.ts';
import { getHookDispatcher } from './index.ts';
import { getHookPointContract } from './contracts.ts';
import { matchesEventPath, matchesMatcher } from './matcher.ts';
import type { HookChain, HookDefinition, HookEvent, HookResult, HookType, HooksConfig } from './types.ts';

export interface HookAuthoringAction {
  readonly kind: 'load' | 'save' | 'reload' | 'scaffold-hook' | 'scaffold-chain' | 'remove' | 'toggle' | 'simulate' | 'export';
  readonly target: string;
  readonly timestamp: number;
  readonly detail?: string;
}

export interface HookSimulationResult {
  readonly eventPath: string;
  readonly matchedHooks: readonly {
    readonly pattern: string;
    readonly name: string;
    readonly type: HookType;
    readonly contract: string;
  }[];
  readonly matchedChains: readonly {
    readonly name: string;
    readonly stepMatches: number;
  }[];
  readonly capturedAt: number;
}

const EMPTY_CONFIG: HooksConfig = Object.freeze({ hooks: {}, chains: [] });

function cloneConfig(config: HooksConfig): HooksConfig {
  return {
    hooks: Object.fromEntries(
      Object.entries(config.hooks ?? {}).map(([pattern, defs]) => [pattern, defs.map((def) => ({ ...def }))]),
    ),
    chains: (config.chains ?? []).map((chain) => ({
      ...chain,
      steps: chain.steps.map((step) => ({ ...step })),
      action: { ...chain.action },
    })),
  };
}

function ensureConfigShape(parsed: unknown): HooksConfig {
  if (!parsed || typeof parsed !== 'object') return cloneConfig(EMPTY_CONFIG);
  const candidate = parsed as Partial<HooksConfig>;
  return {
    hooks: candidate.hooks && typeof candidate.hooks === 'object' ? candidate.hooks : {},
    chains: Array.isArray(candidate.chains) ? candidate.chains : [],
  };
}

export class HookWorkbench {
  private static instance: HookWorkbench | null = null;
  private managedConfig: HooksConfig = cloneConfig(EMPTY_CONFIG);
  private recentActions: HookAuthoringAction[] = [];
  private lastSimulation: HookSimulationResult | null = null;
  private lastLoadedPath: string | null = null;

  static getInstance(): HookWorkbench {
    if (!HookWorkbench.instance) HookWorkbench.instance = new HookWorkbench();
    return HookWorkbench.instance;
  }

  static resetInstance(): void {
    HookWorkbench.instance = null;
  }

  getHooksFilePath(): string {
    return resolve(process.cwd(), configManager.get('tools.hooksFile') as string);
  }

  getManagedConfig(): HooksConfig {
    return cloneConfig(this.managedConfig);
  }

  listManagedHooks(): Array<{ pattern: string; hook: HookDefinition }> {
    const entries: Array<{ pattern: string; hook: HookDefinition }> = [];
    for (const [pattern, defs] of Object.entries(this.managedConfig.hooks ?? {})) {
      for (const hook of defs) entries.push({ pattern, hook: { ...hook } });
    }
    return entries;
  }

  listManagedChains(): HookChain[] {
    return (this.managedConfig.chains ?? []).map((chain) => ({
      ...chain,
      steps: chain.steps.map((step) => ({ ...step })),
      action: { ...chain.action },
    }));
  }

  listRecentActions(limit = 8): HookAuthoringAction[] {
    return this.recentActions.slice(0, limit);
  }

  getLastSimulation(): HookSimulationResult | null {
    return this.lastSimulation;
  }

  private recordAction(action: HookAuthoringAction): void {
    this.recentActions.unshift(action);
    if (this.recentActions.length > 25) this.recentActions.length = 25;
  }

  loadManagedConfig(path = this.getHooksFilePath()): HooksConfig {
    this.lastLoadedPath = path;
    if (!existsSync(path)) {
      this.managedConfig = cloneConfig(EMPTY_CONFIG);
      this.recordAction({ kind: 'load', target: path, timestamp: Date.now(), detail: 'empty config' });
      return this.getManagedConfig();
    }
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf-8')) as unknown;
      this.managedConfig = ensureConfigShape(parsed);
      this.recordAction({ kind: 'load', target: path, timestamp: Date.now(), detail: `${this.listManagedHooks().length} hooks / ${this.listManagedChains().length} chains` });
    } catch (error) {
      logger.debug('HookWorkbench.loadManagedConfig failed, using empty config', { path, error: String(error) });
      this.managedConfig = cloneConfig(EMPTY_CONFIG);
      this.recordAction({ kind: 'load', target: path, timestamp: Date.now(), detail: 'invalid JSON; using empty config' });
    }
    return this.getManagedConfig();
  }

  async saveManagedConfig(path = this.lastLoadedPath ?? this.getHooksFilePath()): Promise<void> {
    mkdirSync(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(this.managedConfig, null, 2)}\n`, 'utf-8');
    this.lastLoadedPath = path;
    this.recordAction({ kind: 'save', target: path, timestamp: Date.now(), detail: `${this.listManagedHooks().length} hooks / ${this.listManagedChains().length} chains` });
  }

  async loadAndApplyManagedHooks(path = this.getHooksFilePath()): Promise<void> {
    this.loadManagedConfig(path);
    const dispatcher = getHookDispatcher();
    dispatcher.clear();
    dispatcher.loadFromFile(path);
    this.recordAction({ kind: 'reload', target: path, timestamp: Date.now(), detail: 'dispatcher refreshed' });
  }

  scaffoldHook(name: string, match: string, type: HookType): HookDefinition {
    const hook: HookDefinition = {
      name,
      match,
      type,
      enabled: false,
      description: `Managed hook scaffold for ${match}`,
      ...(type === 'command' ? { command: 'echo implement-hook' } : {}),
      ...(type === 'prompt' ? { prompt: 'Return a HookResult JSON object for $ARGUMENTS.' } : {}),
      ...(type === 'http' ? { url: 'http://localhost:3000/hooks' } : {}),
      ...(type === 'ts' ? { path: './hooks/handler.ts' } : {}),
      ...(type === 'agent' ? { prompt: 'Handle this hook event: $ARGUMENTS' } : {}),
    };
    const config = cloneConfig(this.managedConfig);
    config.hooks ??= {};
    config.hooks[match] ??= [];
    config.hooks[match]!.push(hook);
    this.managedConfig = config;
    this.recordAction({ kind: 'scaffold-hook', target: name, timestamp: Date.now(), detail: `${type} ${match}` });
    return hook;
  }

  scaffoldChain(name: string, matches: readonly string[]): HookChain {
    const chain: HookChain = {
      name,
      description: `Managed hook workflow for ${matches.join(' -> ')}`,
      steps: matches.map((match) => ({ match })),
      action: {
        name: `${name}-action`,
        match: matches[matches.length - 1] ?? 'Post:tool:*',
        type: 'command',
        command: 'echo chain-action',
        enabled: true,
      },
    };
    const config = cloneConfig(this.managedConfig);
    config.chains ??= [];
    config.chains.push(chain);
    this.managedConfig = config;
    this.recordAction({ kind: 'scaffold-chain', target: name, timestamp: Date.now(), detail: matches.join(' -> ') });
    return chain;
  }

  removeManagedEntry(name: string): boolean {
    const config = cloneConfig(this.managedConfig);
    let removed = false;
    for (const [pattern, defs] of Object.entries(config.hooks ?? {})) {
      const nextDefs = defs.filter((def) => def.name !== name);
      if (nextDefs.length !== defs.length) {
        removed = true;
        if (nextDefs.length === 0) delete config.hooks?.[pattern];
        else config.hooks![pattern] = nextDefs;
      }
    }
    const nextChains = (config.chains ?? []).filter((chain) => chain.name !== name);
    if (nextChains.length !== (config.chains ?? []).length) {
      removed = true;
      config.chains = nextChains;
    }
    if (removed) {
      this.managedConfig = config;
      this.recordAction({ kind: 'remove', target: name, timestamp: Date.now() });
    }
    return removed;
  }

  toggleManagedHook(name: string, enabled: boolean): boolean {
    let changed = false;
    const config = cloneConfig(this.managedConfig);
    for (const defs of Object.values(config.hooks ?? {})) {
      for (const hook of defs) {
        if (hook.name === name) {
          hook.enabled = enabled;
          changed = true;
        }
      }
    }
    if (changed) {
      this.managedConfig = config;
      this.recordAction({ kind: 'toggle', target: name, timestamp: Date.now(), detail: enabled ? 'enabled' : 'disabled' });
    }
    return changed;
  }

  async exportManagedConfig(path: string): Promise<string> {
    await this.saveManagedConfig(path);
    this.recordAction({ kind: 'export', target: path, timestamp: Date.now() });
    return path;
  }

  simulate(eventPath: string, payload: Record<string, unknown> = {}): HookSimulationResult {
    const [phase, category, ...specificParts] = eventPath.split(':');
    const specific = specificParts.join(':');
    const event: HookEvent = {
      path: eventPath as HookEvent['path'],
      phase: phase as HookEvent['phase'],
      category: category as HookEvent['category'],
      specific,
      sessionId: 'hook-sim',
      timestamp: Date.now(),
      payload,
    };
    const matchedHooks = this.listManagedHooks()
      .filter(({ pattern, hook }) => matchesEventPath(pattern, event.path) && matchesMatcher(hook.matcher, event.specific))
      .map(({ pattern, hook }) => ({
        pattern,
        name: hook.name ?? '(unnamed)',
        type: hook.type,
        contract: getHookPointContract(event.path)?.description ?? 'No exact contract',
      }));
    const matchedChains = this.listManagedChains()
      .map((chain) => ({
        name: chain.name,
        stepMatches: chain.steps.filter((step) => matchesEventPath(step.match, event.path)).length,
      }))
      .filter((chain) => chain.stepMatches > 0);
    const result: HookSimulationResult = {
      eventPath,
      matchedHooks,
      matchedChains,
      capturedAt: Date.now(),
    };
    this.lastSimulation = result;
    this.recordAction({
      kind: 'simulate',
      target: eventPath,
      timestamp: result.capturedAt,
      detail: `${matchedHooks.length} hooks / ${matchedChains.length} chains`,
    });
    return result;
  }

  clear(): void {
    this.managedConfig = cloneConfig(EMPTY_CONFIG);
    this.recentActions = [];
    this.lastSimulation = null;
    this.lastLoadedPath = null;
  }
}

export function getHookWorkbench(): HookWorkbench {
  return HookWorkbench.getInstance();
}

export function _resetHookWorkbenchForTesting(): void {
  HookWorkbench.resetInstance();
}
