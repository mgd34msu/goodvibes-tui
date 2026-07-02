import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { ControlPlanePanel } from '../../../panels/control-plane-panel.ts';
import type { PermissionPromptRequest } from '@pellux/goodvibes-sdk/platform/permissions';
import { createControlPlaneReadModel } from '../../helpers/ui-read-models.ts';
import { getTestApprovalBroker, getTestSessionBroker } from '../../helpers/runtime-services.ts';
import { ControlPlaneGateway, baseClient, createDomainDispatch, createRuntimeStore, linesText, setupControlPlaneBrokers, teardownControlPlaneBrokers } from './_shared.ts';

function makeRequest(callId: string): PermissionPromptRequest {
  return {
    callId,
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
}

describe('control-plane operator panels', () => {
  let root = '';

  beforeEach(() => {
    root = setupControlPlaneBrokers().root;
  });

  afterEach(() => {
    teardownControlPlaneBrokers(root);
  });

  async function buildFixture() {
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
    void broker.requestApproval({
      sessionId: 'session-shared',
      routeId: 'route-slack',
      request: makeRequest('call-approval-1'),
      localPrompt: undefined,
    });
    await new Promise((resolve) => setTimeout(resolve, 5));

    const readModel = createControlPlaneReadModel(store, {
      approvals: broker.listApprovals(50),
      sessions: sessionBroker.listSessions(50),
      recentEvents: gateway.listRecentEvents(50),
    });

    const panel = new ControlPlanePanel(readModel, {
      approvalBroker: broker,
      sessionBroker,
      getControlPlaneRecentEvents: (limit) => gateway.listRecentEvents(limit),
    });

    return { store, dispatch, gateway, sessionBroker, broker, panel };
  }

  test('defaults to the approvals section and Tab cycles clients/approvals/sessions/events', async () => {
    const { panel } = await buildFixture();

    const approvalsText = linesText(panel.render(110, 30));
    expect(approvalsText).toContain('Control Plane');
    expect(approvalsText).toContain('exec');
    expect(approvalsText).toContain('pending');
    // I3/WO-121: the panel is fully in-panel actionable now — no more
    // "use the web operator surface" signpost.
    expect(approvalsText).not.toContain('web operator surface');
    expect(approvalsText).not.toContain('Web Console');

    panel.handleInput('tab');
    const clientsText = linesText(panel.render(110, 30));
    expect(clientsText).toContain('Web Console');

    panel.handleInput('tab');
    const sessionsText = linesText(panel.render(110, 30));
    expect(sessionsText).toContain('Shared session');

    panel.handleInput('tab');
    const eventsText = linesText(panel.render(110, 30));
    expect(eventsText).toContain('session-update');

    panel.handleInput('tab');
    const backToApprovals = linesText(panel.render(110, 30));
    expect(backToApprovals).toContain('exec');
  });

  test('a approves a pending approval via ApprovalBroker.resolveApproval behind ConfirmState and the tally updates', async () => {
    const { panel, broker } = await buildFixture();

    // Approvals is the default/primary focus section; the single pending
    // approval is selected as soon as the panel renders.
    panel.render(110, 30);
    panel.handleInput('a');
    const confirmText = linesText(panel.render(110, 30));
    expect(confirmText).toContain('Approve');

    panel.handleInput('y');
    await new Promise((resolve) => setTimeout(resolve, 5));

    const approved = broker.listApprovals(50).find((entry) => entry.request.callId === 'call-approval-1');
    expect(approved?.status).toBe('approved');

    const finalText = linesText(panel.render(110, 30));
    expect(finalText).toContain('0 pending / 1');
  });

  test('d denies a pending approval behind ConfirmState, and Esc cancels without resolving', async () => {
    const { panel, broker } = await buildFixture();

    panel.render(110, 30);
    panel.handleInput('d');
    const confirmText = linesText(panel.render(110, 30));
    expect(confirmText).toContain('Deny');

    panel.handleInput('escape');
    await new Promise((resolve) => setTimeout(resolve, 5));
    let entry = broker.listApprovals(50).find((e) => e.request.callId === 'call-approval-1');
    expect(entry?.status).toBe('pending');

    panel.handleInput('d');
    panel.handleInput('y');
    await new Promise((resolve) => setTimeout(resolve, 5));
    entry = broker.listApprovals(50).find((e) => e.request.callId === 'call-approval-1');
    expect(entry?.status).toBe('denied');
  });

  test('approvals sort pending-first and scroll beyond 6 entries', async () => {
    const { panel, broker } = await buildFixture();

    for (let i = 2; i <= 12; i++) {
      void broker.requestApproval({
        sessionId: 'session-shared',
        routeId: 'route-slack',
        request: makeRequest(`call-approval-${i}`),
        localPrompt: undefined,
      });
    }
    await new Promise((resolve) => setTimeout(resolve, 5));

    // Resolve the first approval so a non-pending entry exists; it must sort
    // after the still-pending ones rather than staying in creation order.
    const first = broker.listApprovals(50).find((entry) => entry.request.callId === 'call-approval-1')!;
    await broker.resolveApproval(first.id, { approved: true, actor: 'test', actorSurface: 'test' });

    const text = linesText(panel.render(110, 16));
    expect(text).toContain('11 pending / 12');
    // Scroll windowing (I1/S1 contract): more than 6 entries triggers the
    // "showing X-Y of Z" window summary instead of a hard slice(0, 6).
    expect(text).toMatch(/showing \d+-\d+ of 12/);
  });
});
