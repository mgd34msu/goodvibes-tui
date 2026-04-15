import type { HookPointContract } from '@pellux/goodvibes-sdk/platform/hooks/contracts';
import type { HookChain, HookDefinition, HookType } from '@pellux/goodvibes-sdk/platform/hooks/types';
import type {
  HookAuthoringAction,
  HookConfigInspection,
  HookSimulationResult,
} from '@pellux/goodvibes-sdk/platform/hooks/workbench';

export interface HookContractRecord extends HookPointContract {}

export interface HookWorkbenchApi {
  getFilePath(): string;
  listManagedHooks(): Array<{ pattern: string; hook: HookDefinition }>;
  listManagedChains(): HookChain[];
  listRecentActions(limit?: number): HookAuthoringAction[];
  load(path?: string): void;
  reload(path?: string): Promise<void>;
  scaffoldHook(name: string, match: string, type: HookType): Promise<HookDefinition>;
  scaffoldChain(name: string, matches: readonly string[]): Promise<HookChain>;
  remove(name: string): Promise<boolean>;
  toggle(name: string, enabled: boolean): Promise<boolean>;
  simulate(eventPath: string, payload?: Record<string, unknown>): HookSimulationResult;
  inspect(path: string): HookConfigInspection;
  export(path: string): Promise<string>;
  import(path: string, strategy?: 'merge' | 'replace'): Promise<void>;
}

export interface HookApiDispatcher {
  listHooks(): Array<{ pattern: string; hook: HookDefinition }>;
  listChains(): HookChain[];
}

export interface HookApiWorkbenchRuntime {
  getHooksFilePath(): string;
  listManagedHooks(): Array<{ pattern: string; hook: HookDefinition }>;
  listManagedChains(): HookChain[];
  listRecentActions(limit?: number): HookAuthoringAction[];
  loadManagedConfig(path?: string): void;
  loadAndApplyManagedHooks(path?: string): Promise<void>;
  scaffoldHook(name: string, match: string, type: HookType): HookDefinition;
  scaffoldChain(name: string, matches: readonly string[]): HookChain;
  removeManagedEntry(name: string): boolean;
  toggleManagedHook(name: string, enabled: boolean): boolean;
  simulate(eventPath: string, payload?: Record<string, unknown>): HookSimulationResult;
  inspectManagedConfig(path: string): HookConfigInspection;
  exportManagedConfig(path: string): Promise<string>;
  importManagedConfig(path: string, strategy?: 'merge' | 'replace'): void;
  saveManagedConfig(path?: string): Promise<void>;
}

export interface HookContractSource {
  listContracts(): readonly HookPointContract[];
}

export interface HookApi {
  contracts(filter?: string): readonly HookContractRecord[];
  dispatcher: {
    listHooks(): Array<{ pattern: string; hook: HookDefinition }>;
    listChains(): HookChain[];
  };
  workbench: HookWorkbenchApi;
}

export interface CreateHookApiOptions {
  readonly dispatcher: HookApiDispatcher;
  readonly workbench: HookApiWorkbenchRuntime;
  readonly listContracts: HookContractSource['listContracts'];
}

function normalizeFilter(filter: string | undefined): string | null {
  const value = filter?.trim().toLowerCase();
  return value && value.length > 0 ? value : null;
}

export function createHookApi(options: CreateHookApiOptions): HookApi {
  return {
    contracts(filter?: string): readonly HookContractRecord[] {
      const query = normalizeFilter(filter);
      const contracts = options.listContracts();
      if (!query) {
        return contracts;
      }
      return contracts.filter((contract) => (
        contract.pattern.toLowerCase().includes(query)
        || contract.description.toLowerCase().includes(query)
        || contract.authority.toLowerCase().includes(query)
        || contract.executionMode.toLowerCase().includes(query)
      ));
    },
    dispatcher: {
      listHooks(): Array<{ pattern: string; hook: HookDefinition }> {
        return options.dispatcher.listHooks();
      },
      listChains(): HookChain[] {
        return options.dispatcher.listChains();
      },
    },
    workbench: {
      getFilePath(): string {
        return options.workbench.getHooksFilePath();
      },
      listManagedHooks(): Array<{ pattern: string; hook: HookDefinition }> {
        return options.workbench.listManagedHooks();
      },
      listManagedChains(): HookChain[] {
        return options.workbench.listManagedChains();
      },
      listRecentActions(limit = 8): HookAuthoringAction[] {
        return options.workbench.listRecentActions(limit);
      },
      load(path?: string): void {
        options.workbench.loadManagedConfig(path);
      },
      reload(path?: string): Promise<void> {
        return options.workbench.loadAndApplyManagedHooks(path);
      },
      async scaffoldHook(name: string, match: string, type: HookType): Promise<HookDefinition> {
        options.workbench.loadManagedConfig();
        const hook = options.workbench.scaffoldHook(name, match, type);
        await options.workbench.saveManagedConfig();
        await options.workbench.loadAndApplyManagedHooks();
        return hook;
      },
      async scaffoldChain(name: string, matches: readonly string[]): Promise<HookChain> {
        options.workbench.loadManagedConfig();
        const chain = options.workbench.scaffoldChain(name, matches);
        await options.workbench.saveManagedConfig();
        await options.workbench.loadAndApplyManagedHooks();
        return chain;
      },
      async remove(name: string): Promise<boolean> {
        options.workbench.loadManagedConfig();
        const removed = options.workbench.removeManagedEntry(name);
        if (!removed) {
          return false;
        }
        await options.workbench.saveManagedConfig();
        await options.workbench.loadAndApplyManagedHooks();
        return true;
      },
      async toggle(name: string, enabled: boolean): Promise<boolean> {
        options.workbench.loadManagedConfig();
        const changed = options.workbench.toggleManagedHook(name, enabled);
        if (!changed) {
          return false;
        }
        await options.workbench.saveManagedConfig();
        await options.workbench.loadAndApplyManagedHooks();
        return true;
      },
      simulate(eventPath: string, payload: Record<string, unknown> = {}): HookSimulationResult {
        options.workbench.loadManagedConfig();
        return options.workbench.simulate(eventPath, payload);
      },
      inspect(path: string): HookConfigInspection {
        return options.workbench.inspectManagedConfig(path);
      },
      export(path: string): Promise<string> {
        options.workbench.loadManagedConfig();
        return options.workbench.exportManagedConfig(path);
      },
      async import(path: string, strategy: 'merge' | 'replace' = 'merge'): Promise<void> {
        options.workbench.loadManagedConfig();
        options.workbench.importManagedConfig(path, strategy);
        await options.workbench.saveManagedConfig();
        await options.workbench.loadAndApplyManagedHooks();
      },
    },
  };
}
