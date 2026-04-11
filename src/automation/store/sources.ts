import { PersistentStore } from '../../state/persistent-store.ts';
import type { AutomationSourceRecord } from '../sources.ts';
import { resolveAutomationStorePath, type AutomationStorePathConfig } from './paths.ts';

interface AutomationSourcesSnapshot extends Record<string, unknown> {
  version: 1;
  sources: AutomationSourceRecord[];
}

function defaultSnapshot(): AutomationSourcesSnapshot {
  return {
    version: 1,
    sources: [],
  };
}

export interface AutomationSourceStoreConfig {
  readonly path?: string;
  readonly configManager?: AutomationStorePathConfig;
}

export class AutomationSourceStore {
  private readonly store: PersistentStore<AutomationSourcesSnapshot>;

  constructor(config: string | AutomationSourceStoreConfig = {}) {
    const path = typeof config === 'string'
      ? config
      : config.path ?? resolveAutomationStorePath('automation-sources.json', config.configManager);
    this.store = new PersistentStore<AutomationSourcesSnapshot>(path);
  }

  async load(): Promise<AutomationSourcesSnapshot> {
    const snapshot = await this.store.load();
    if (!snapshot || !Array.isArray(snapshot.sources)) {
      return defaultSnapshot();
    }
    return {
      version: 1,
      sources: snapshot.sources,
    };
  }

  async save(sources: readonly AutomationSourceRecord[]): Promise<void> {
    await this.store.persist({
      version: 1,
      sources: [...sources],
    });
  }
}
