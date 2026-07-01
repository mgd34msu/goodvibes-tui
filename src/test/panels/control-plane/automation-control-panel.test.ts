import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { AutomationControlPanel } from '../../../panels/automation-control-panel.ts';
import { createAutomationReadModel } from '../../helpers/ui-read-models.ts';
import { baseDelivery, baseJob, baseRun, createDomainDispatch, createRuntimeStore, linesText, setupControlPlaneBrokers, teardownControlPlaneBrokers } from './_shared.ts';

describe('control-plane operator panels', () => {
  let root = '';

  beforeEach(() => {
    root = setupControlPlaneBrokers().root;
  });

  afterEach(() => {
    teardownControlPlaneBrokers(root);
  });

  test('AutomationControlPanel renders jobs, runs, and delivery posture', () => {
    const store = createRuntimeStore();
    const dispatch = createDomainDispatch(store);
    dispatch.syncAutomationJob(baseJob(), 'test');
    dispatch.syncAutomationRun(baseRun(), 'test');
    dispatch.syncDeliveryAttempt(baseDelivery(), 'test');

    const panel = new AutomationControlPanel(createAutomationReadModel(store));
    const text = linesText(panel.render(100, 28));
    expect(text).toContain('Automation Control');
    expect(text).toContain('Nightly Sweep');
    expect(text).toContain('running');
    expect(text).toContain('deliveries ok');
    // UX: jobs section header with enabled/total counts + context-aware hints.
    expect(text).toContain('Jobs (1 enabled / 1)');
    expect(text).toContain('select run');
  });
});
