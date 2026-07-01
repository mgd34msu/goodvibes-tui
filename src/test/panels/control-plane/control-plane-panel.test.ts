import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { ControlPlanePanel } from '../../../panels/control-plane-panel.ts';
import type { PermissionPromptRequest } from '@pellux/goodvibes-sdk/platform/permissions';
import { createControlPlaneReadModel } from '../../helpers/ui-read-models.ts';
import { getTestApprovalBroker, getTestSessionBroker } from '../../helpers/runtime-services.ts';
import { ControlPlaneGateway, baseClient, createDomainDispatch, createRuntimeStore, linesText, setupControlPlaneBrokers, teardownControlPlaneBrokers } from './_shared.ts';

describe('control-plane operator panels', () => {
  let root = '';

  beforeEach(() => {
    root = setupControlPlaneBrokers().root;
  });

  afterEach(() => {
    teardownControlPlaneBrokers(root);
  });

  test('ControlPlanePanel renders clients, approvals, sessions, and recent events', async () => {
    const store = createRuntimeStore();
    const dispatch = createDomainDispatch(store);
    dispatch.syncControlPlaneState({
      enabled: true,
      isRunning: true,
      host: '127.0.0.1',
      port: 3421,
      connectionState: 'connected',
      requestCount: 14,
      errorCount: 1,
    }, 'test');
    dispatch.syncControlPlaneClient(baseClient(), 'test');

    const gateway = new ControlPlaneGateway({ runtimeStore: store, server: { enabled: true, host: '127.0.0.1', port: 3421 } });
    gateway.publishEvent('session-update', { sessionId: 'session-shared', status: 'open' });

    const sessionBroker = getTestSessionBroker();
    await sessionBroker.start();
    await sessionBroker.createSession({
      id: 'session-shared',
      title: 'Shared session',
      participant: {
        surfaceKind: 'web',
        surfaceId: 'web-console',
        externalId: 'session-shared',
        displayName: 'web console',
        lastSeenAt: Date.now(),
      },
    });

    const broker = getTestApprovalBroker();
    const request: PermissionPromptRequest = {
      callId: 'call-approval-1',
      tool: 'exec',
      args: { cmd: 'git status' },
      category: 'execute',
      analysis: {
        classification: 'execute',
        riskLevel: 'high',
        summary: 'Review git status execution',
        reasons: ['Shell execution from an external approval path.'],
        target: 'git status',
        targetKind: 'command',
      },
    };
    void broker.requestApproval({
      sessionId: 'session-shared',
      routeId: 'route-slack',
      request,
      localPrompt: undefined,
    });
    await new Promise((resolve) => setTimeout(resolve, 5));

    const panel = new ControlPlanePanel(createControlPlaneReadModel(store, {
      approvals: broker.listApprovals(6),
      sessions: sessionBroker.listSessions(6),
      recentEvents: gateway.listRecentEvents(6),
    }));
    const text = linesText(panel.render(110, 30));
    expect(text).toContain('Control Plane');
    expect(text).toContain('Web Console');
    expect(text).toContain('exec');
    expect(text).toContain('Shared session');
    expect(text).toContain('session-update');
    // UX: labelled sections + context-aware hints replace the static nav line.
    expect(text).toContain('Approvals (');
    expect(text).toContain('Sessions (');
    expect(text).toContain('Recent Events (');
    expect(text).toContain('select client');
  });
});
