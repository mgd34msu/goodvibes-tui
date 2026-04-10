import { join } from 'node:path';
import { PersistentStore } from '../../state/persistent-store.ts';
import type { AutomationSourceRecord } from '../sources.ts';

interface AutomationSourcesSnapshot extends Record<string, unknown> {
  version: 1;
  sources: AutomationSourceRecord[];
}

const DEFAULT_PATH = join(process.cwd(), '.goodvibes', 'tui', 'automation-sources.json');

function defaultSnapshot(): AutomationSourcesSnapshot {
  return {
    version: 1,
    sources: [],
  };
}

export class AutomationSourceStore {
  private readonly store: PersistentStore<AutomationSourcesSnapshot>;

  constructor(path: string = DEFAULT_PATH) {
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
