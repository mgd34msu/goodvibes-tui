import type { Notifier } from '@pellux/goodvibes-sdk/platform/integrations';
import type { RuntimeEventBus } from '@/runtime/index.ts';
import type { createDomainDispatch } from './store/index.ts';

type DomainDispatch = ReturnType<typeof createDomainDispatch>;

/**
 * Reflect the notifier's outbound delivery queues into the integrations domain
 * (so the UI shows per-channel health) and attach the notifier to the runtime
 * bus when any queue exists. Extracted from bootstrap-core to keep that file
 * within the module size budget.
 */
export function syncNotifierQueueIntegrations(
  notifier: Notifier,
  runtimeBus: RuntimeEventBus,
  domainDispatch: DomainDispatch,
): void {
  const queueStatuses = notifier.getQueueStatus();
  if (queueStatuses.length === 0) return;
  notifier.attachToRuntimeBus(runtimeBus);
  for (const queueStatus of queueStatuses) {
    domainDispatch.syncIntegration({
      id: queueStatus.channel,
      displayName: queueStatus.channel[0]!.toUpperCase() + queueStatus.channel.slice(1),
      category: 'communication',
      status: queueStatus.metrics.deadLettered > 0 ? 'degraded' : 'healthy',
      enabled: true,
      successCount: queueStatus.metrics.delivered,
      errorCount: queueStatus.metrics.deadLettered,
      ...(queueStatus.dlqEntries[0]?.deadAt ? { lastErrorAt: queueStatus.dlqEntries[0].deadAt } : {}),
      ...(queueStatus.dlqEntries[0]?.finalError ? { lastError: queueStatus.dlqEntries[0].finalError } : {}),
      meta: {
        attempts: queueStatus.metrics.totalAttempts,
        retrying: queueStatus.metrics.retrying,
        deadLetters: queueStatus.metrics.deadLettered,
        dlqSize: queueStatus.metrics.dlqSize,
        sloEnforced: queueStatus.sloEnforced,
      },
    }, 'bootstrap.notifier');
  }
}
