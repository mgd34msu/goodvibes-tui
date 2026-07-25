/**
 * services-integration-helpers-surface.test.ts — pins the fix for the
 * "/health continuity reads the wrong paths" finding.
 *
 * runtime/services.ts used to construct IntegrationHelperService with the
 * legacy loose `{ workingDirectory, homeDirectory }` pair while every actual
 * write in this app goes through the declare-once, surface-root-scoped
 * SessionSurface (session-storage-services.ts). IntegrationHelperService's
 * continuity read (getContinuitySnapshot -> readLastSessionPointer /
 * checkRecoveryFile) resolved against the UNSCOPED legacy directory, so
 * /health continuity (and the health panel's continuity domain) reported
 * "nothing here" even when a pointer and a recovery snapshot both genuinely
 * existed — just not at the path this service was looking under.
 *
 * This test writes both through the SAME surface runtime/services.ts now
 * constructs IntegrationHelperService with, then reads them back through
 * createUiReadModels(...).continuity.getSnapshot() — the exact call
 * src/input/commands/health-runtime.ts's `/health continuity` branch makes.
 * A second case constructs a THROWAWAY legacy-scoped instance against the
 * same directories to prove the distinction is real: that instance reports
 * nothing, which is the shape of the original bug.
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import { IntegrationHelperService, writeLastSessionPointer, writeRecoveryFile } from '@/runtime/index.ts';
import { createUiReadModels } from '../../runtime/ui-read-models.ts';
import { getTestRuntimeServices, resetTestRuntimeServices } from '../helpers/runtime-services.ts';
import { ageRecoverySnapshot } from '../helpers/session-surface.ts';

beforeEach(() => {
  resetTestRuntimeServices();
});

describe('IntegrationHelperService continuity reads through the surface it was constructed with', () => {
  test('a pointer + recovery snapshot written via the surface are reported by getContinuitySnapshot (via the read model /health continuity uses)', () => {
    const services = getTestRuntimeServices();
    const sessionId = 'continuity-fix-session';

    writeLastSessionPointer(sessionId, { surface: services.surface });
    writeRecoveryFile(
      { messages: [{ role: 'user', content: 'hello' }], title: 'Continuity fix check', timestamp: Date.now() },
      sessionId,
      'Continuity fix check',
      { surface: services.surface },
    );
    // recoveryFilePresent reports whether a snapshot would be OFFERED, so the
    // file has to be old enough that no live writer is implied.
    ageRecoverySnapshot(services.surface.recoveryFile(sessionId));

    // The exact call health-runtime.ts's `/health continuity` branch makes:
    // readModels.continuity.getSnapshot().
    const readModels = createUiReadModels(services);
    const continuity = readModels.continuity.getSnapshot();

    expect(continuity.lastSessionPointer).toBe(sessionId);
    expect(continuity.recoveryFilePresent).toBe(true);
    expect(continuity.recoveryFile?.sessionId).toBe(sessionId);

    // Also true straight off the service the read model wraps.
    const direct = services.integrationHelpers.getContinuitySnapshot();
    expect(direct.lastSessionPointer).toBe(sessionId);
    expect(direct.recoveryFilePresent).toBe(true);
  });

  test('the same files are invisible to a legacy-scoped instance over the same directories — the shape of the original bug', () => {
    const services = getTestRuntimeServices();
    const sessionId = 'continuity-legacy-blind-session';

    writeLastSessionPointer(sessionId, { surface: services.surface });
    writeRecoveryFile(
      { messages: [{ role: 'user', content: 'hello' }], timestamp: Date.now() },
      sessionId,
      undefined,
      { surface: services.surface },
    );

    // Confirmed found through the surface-scoped instance the app actually uses.
    expect(services.integrationHelpers.getContinuitySnapshot().lastSessionPointer).toBe(sessionId);

    // A throwaway instance built the OLD (legacy) way, over the identical
    // workingDirectory/homeDirectory pair, resolves the unscoped legacy
    // directory instead — the same instance shape services.ts used to
    // construct, and the reason /health continuity read the wrong paths.
    const legacyScoped = new IntegrationHelperService({
      workingDirectory: services.workingDirectory,
      homeDirectory: services.homeDirectory,
      runtimeStore: services.runtimeStore,
      runtimeBus: services.runtimeBus,
      automationManager: services.automationManager,
      approvalBroker: services.approvalBroker,
      sessionBroker: services.sessionBroker,
      distributedRuntime: services.distributedRuntime,
      remoteRunnerRegistry: services.remoteRunnerRegistry,
      remoteSupervisor: services.remoteSupervisor,
      panelManager: services.panelManager,
      localUserAuthManager: services.localUserAuthManager,
      providerRegistry: services.providerRegistry,
      serviceRegistry: services.serviceRegistry,
      subscriptionManager: services.subscriptionManager,
      secretsManager: services.secretsManager,
    });

    const legacySnapshot = legacyScoped.getContinuitySnapshot();
    expect(legacySnapshot.lastSessionPointer).toBeNull();
    expect(legacySnapshot.recoveryFilePresent).toBe(false);
  });
});
