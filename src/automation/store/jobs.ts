import { join } from 'node:path';
import { PersistentStore } from '../../state/persistent-store.ts';
import type { AutomationJob } from '../jobs.ts';

interface AutomationJobsSnapshot extends Record<string, unknown> {
  version: 1;
  jobs: AutomationJob[];
}

const DEFAULT_PATH = join(process.cwd(), '.goodvibes', 'tui', 'automation-jobs.json');

function defaultSnapshot(): AutomationJobsSnapshot {
  return {
    version: 1,
    jobs: [],
  };
}

export class AutomationJobStore {
  private readonly store: PersistentStore<AutomationJobsSnapshot>;

  constructor(path: string = DEFAULT_PATH) {
    this.store = new PersistentStore<AutomationJobsSnapshot>(path);
  }

  async load(): Promise<AutomationJobsSnapshot> {
    const snapshot = await this.store.load();
    if (!snapshot || !Array.isArray(snapshot.jobs)) {
      return defaultSnapshot();
    }
    return {
      version: 1,
      jobs: snapshot.jobs,
    };
  }

  async save(jobs: readonly AutomationJob[]): Promise<void> {
    await this.store.persist({
      version: 1,
      jobs: [...jobs],
    });
  }
}
