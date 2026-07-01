import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { RoutesPanel } from '../../../panels/routes-panel.ts';
import { createRoutesReadModel } from '../../helpers/ui-read-models.ts';
import { baseRoute, createDomainDispatch, createRuntimeStore, linesText, setupControlPlaneBrokers, teardownControlPlaneBrokers } from './_shared.ts';

describe('control-plane operator panels', () => {
  let root = '';

  beforeEach(() => {
    root = setupControlPlaneBrokers().root;
  });

  afterEach(() => {
    teardownControlPlaneBrokers(root);
  });

  test('RoutesPanel renders bound surface/session context', () => {
    const store = createRuntimeStore();
    const dispatch = createDomainDispatch(store);
    dispatch.syncRouteBinding(baseRoute(), 'test');

    const panel = new RoutesPanel(createRoutesReadModel(store));
    const text = linesText(panel.render(100, 26));
    expect(text).toContain('Route Bindings');
    expect(text).toContain('slack');
    expect(text).toContain('session-shared');
    expect(text).toContain('build-alerts');
  });
});
