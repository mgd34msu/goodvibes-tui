import { PersistentStore } from '../../state/persistent-store.ts';
import type { AutomationRun } from '../runs.ts';
import { resolveAutomationStorePath, type AutomationStorePathConfig } from './paths.ts';

interface AutomationRunsSnapshot extends Record<string, unknown> {
  version: 1;
  runs: AutomationRun[];
}

function defaultSnapshot(): AutomationRunsSnapshot {
  return {
    version: 1,
    runs: [],
  };
}

export interface AutomationRunStoreConfig {
  readonly path?: string;
  readonly configManager?: AutomationStorePathConfig;
}

export class AutomationRunStore {
  private readonly store: PersistentStore<AutomationRunsSnapshot>;

  constructor(config: string | AutomationRunStoreConfig = {}) {
    const path = typeof config === 'string'
      ? config
      : config.path ?? resolveAutomationStorePath('automation-runs.json', config.configManager ?? {});
    this.store = new PersistentStore<AutomationRunsSnapshot>(path);
  }

  async load(): Promise<AutomationRunsSnapshot> {
    const snapshot = await this.store.load();
    if (!snapshot || !Array.isArray(snapshot.runs)) {
      return defaultSnapshot();
    }
    return {
      version: 1,
      runs: snapshot.runs,
    };
  }

  async save(runs: readonly AutomationRun[]): Promise<void> {
    await this.store.persist({
      version: 1,
      runs: [...runs],
    });
  }
}
