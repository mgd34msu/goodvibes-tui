import { afterAll, describe, expect, test } from 'bun:test';
import { normalizeEverySchedule } from '@pellux/goodvibes-sdk/platform/automation';
import { getTestRuntimeServices, resetTestRuntimeServices, disposeTestRuntimeServicesAfterAll } from '../helpers/runtime-services.ts';

// Stop the shared test runtime graph when this file ends. Called here, not
// registered inside the helper, for the reason its doc comment gives.
disposeTestRuntimeServicesAfterAll();

/**
 * Locks the model-override resolution wiring in the TUI's services composition:
 * the live ProviderRegistry is threaded into BOTH AgentManager and
 * AutomationManager, so a BARE model id (no `provider:` prefix) resolves through
 * the shared resolver to its provider-qualified registry key instead of being
 * rejected with the "must be a provider-qualified registry key" lecture.
 *
 * The test composition seeds a single provider `mock` carrying `mock-model`
 * (see runtime-services.ts seedRuntimeProviderTestModels), so `mock-model` is a
 * bare id unique across the registry: the resolver auto-qualifies it to
 * `mock:mock-model`. If either site were constructed WITHOUT the registry, that
 * same call would throw instead of resolving.
 */
describe('model override resolution — services composition wiring', () => {
  afterAll(() => resetTestRuntimeServices());

  test('agent spawn: a bare model id resolves through the shared resolver', () => {
    const services = getTestRuntimeServices();
    const record = services.agentManager.spawn({
      mode: 'spawn',
      task: 'resolve a bare model override',
      model: 'mock-model',
    });
    expect(record.model).toBe('mock:mock-model');
  });

  test('automation create: a bare model id resolves through the shared resolver', async () => {
    const services = getTestRuntimeServices();
    const job = await services.automationManager.createJob({
      name: 'bare-model-automation',
      prompt: 'run with a bare model id',
      schedule: normalizeEverySchedule('15m'),
      model: 'mock-model',
    });
    expect(job.execution.modelId).toBe('mock:mock-model');
  });
});
