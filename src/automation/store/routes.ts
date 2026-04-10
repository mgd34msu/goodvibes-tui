import { join } from 'node:path';
import { PersistentStore } from '../../state/persistent-store.ts';
import type { AutomationRouteBinding } from '../routes.ts';

interface AutomationRoutesSnapshot extends Record<string, unknown> {
  version: 1;
  routes: AutomationRouteBinding[];
}

const DEFAULT_PATH = join(process.cwd(), '.goodvibes', 'tui', 'automation-routes.json');

function defaultSnapshot(): AutomationRoutesSnapshot {
  return {
    version: 1,
    routes: [],
  };
}

export class AutomationRouteStore {
  private readonly store: PersistentStore<AutomationRoutesSnapshot>;

  constructor(path: string = DEFAULT_PATH) {
    this.store = new PersistentStore<AutomationRoutesSnapshot>(path);
  }

  async load(): Promise<AutomationRoutesSnapshot> {
    const snapshot = await this.store.load();
    if (!snapshot || !Array.isArray(snapshot.routes)) {
      return defaultSnapshot();
    }
    return {
      version: 1,
      routes: snapshot.routes,
    };
  }

  async save(routes: readonly AutomationRouteBinding[]): Promise<void> {
    await this.store.persist({
      version: 1,
      routes: [...routes],
    });
  }
}
