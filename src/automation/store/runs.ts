import { join } from 'node:path';
import { PersistentStore } from '../../state/persistent-store.ts';
import type { AutomationRun } from '../runs.ts';

interface AutomationRunsSnapshot extends Record<string, unknown> {
  version: 1;
  runs: AutomationRun[];
}

const DEFAULT_PATH = join(process.cwd(), '.goodvibes', 'tui', 'automation-runs.json');

function defaultSnapshot(): AutomationRunsSnapshot {
  return {
    version: 1,
    runs: [],
  };
}

export class AutomationRunStore {
  private readonly store: PersistentStore<AutomationRunsSnapshot>;

  constructor(path: string = DEFAULT_PATH) {
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
