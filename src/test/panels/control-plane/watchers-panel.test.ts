import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { WatchersPanel } from '../../../panels/watchers-panel.ts';
import { createWatchersReadModel } from '../../helpers/ui-read-models.ts';
import { baseWatcher, createDomainDispatch, createRuntimeStore, linesText, setupControlPlaneBrokers, teardownControlPlaneBrokers } from './_shared.ts';

describe('control-plane operator panels', () => {
  let root = '';

  beforeEach(() => {
    root = setupControlPlaneBrokers().root;
  });

  afterEach(() => {
    teardownControlPlaneBrokers(root);
  });

  test('WatchersPanel renders degraded watcher state and lag', () => {
    const store = createRuntimeStore();
    const dispatch = createDomainDispatch(store);
    dispatch.syncWatcher(baseWatcher(), 'test');

    const panel = new WatchersPanel(createWatchersReadModel(store));
    const text = linesText(panel.render(100, 26));
    expect(text).toContain('Watchers');
    expect(text).toContain('Filesystem Watcher');
    expect(text).toContain('lagging');
    expect(text).toContain('source behind expected heartbeat');
  });
});
