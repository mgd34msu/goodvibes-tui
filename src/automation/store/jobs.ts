import { PersistentStore } from '../../state/persistent-store.ts';
import type { AutomationJob } from '../jobs.ts';
import { resolveAutomationStorePath, type AutomationStorePathConfig } from './paths.ts';

interface AutomationJobsSnapshot extends Record<string, unknown> {
  version: 1;
  jobs: AutomationJob[];
}

function defaultSnapshot(): AutomationJobsSnapshot {
  return {
    version: 1,
    jobs: [],
  };
}

export interface AutomationJobStoreConfig {
  readonly path?: string;
  readonly configManager?: AutomationStorePathConfig;
}

export class AutomationJobStore {
  private readonly store: PersistentStore<AutomationJobsSnapshot>;

  constructor(config: string | AutomationJobStoreConfig = {}) {
    const path = typeof config === 'string'
      ? config
      : config.path ?? resolveAutomationStorePath('automation-jobs.json', config.configManager ?? {});
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
