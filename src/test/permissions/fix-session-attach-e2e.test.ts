import { afterAll, describe, expect, test } from 'bun:test';
import {
  handleBrokerApprovalChange,
  buildFixSessionAffordance,
  buildFixSessionErrorNotice,
  handleFixSessionAttachKey,
} from '../../permissions/broker-approval-card.ts';
import { getTestRuntimeServices, resetTestRuntimeServices, disposeTestRuntimeServicesAfterAll } from '../helpers/runtime-services.ts';

// Stop the shared test runtime graph when this file ends. Called here, not
// registered inside the helper, for the reason its doc comment gives.
disposeTestRuntimeServicesAfterAll();

/**
 * End-to-end proof against the linked SDK tarball (round 10): the CI fix-session
 * id stamped on an accepted approval record is now a REAL, attach/resume-
 * resolvable shared-session id, it round-trips through a SharedSessionBroker
 * lookup and never carries the 'auto-' automation-job-id shape. The TUI
 * affordance turns that id into a one-key jump whose attach runs the resume (the
 * machine does what the retype instruction used to ask the user to do), and a
 * FAILED spawn stamps fixSessionError, which the surface renders honestly with
 * no dead action.
 */
describe('CI fix-session attach: end-to-end against the linked SDK', () => {
  afterAll(() => resetTestRuntimeServices());

  async function acceptedApprovalFor(callId: string): Promise<{ approvalBroker: ReturnType<typeof getTestRuntimeServices>['approvalBroker'] }> {
    const { approvalBroker } = getTestRuntimeServices();
    await approvalBroker.start();
    // A ci:fix-session offer that auto-accepts through its local prompt, leaving
    // an APPROVED record stampFixSession can attach the spawned session to.
    await approvalBroker.requestApproval({
      request: { callId, tool: 'ci-fix', reason: 'Fix the failing CI run?', args: {} } as never,
      localPrompt: async () => ({ approved: true, remember: false }) as never,
    });
    return { approvalBroker };
  }

  test('a stamped success carries a real, broker-resolvable session id (not an auto- job id) and arms the one-key jump', async () => {
    const services = getTestRuntimeServices();
    const { approvalBroker } = await acceptedApprovalFor('call-e2e-1');

    // The fix job runs a pinned fresh shared session; register it and get its real id.
    const session = await services.sessionBroker.createSession();
    expect(session.id.startsWith('auto-')).toBe(false); // never the automation job-id shape
    expect(services.sessionBroker.getSession(session.id)).not.toBeNull(); // attach/resume resolves it

    const record = await approvalBroker.stampFixSession('call-e2e-1', { sessionId: session.id });
    expect(record).not.toBeNull();
    expect(record!.fixSessionId).toBe(session.id);
    expect(record!.fixSessionError).toBeUndefined();

    // Drive the record through the surface affordance: it arms the one-key jump
    // with the REAL id; the jump key runs the resume against that id.
    let armed: string | null = null;
    const notices: string[] = [];
    const onFixSessionStarted = buildFixSessionAffordance({
      notify: (m) => notices.push(m),
      arm: (id) => { armed = id; },
    });
    handleBrokerApprovalChange({
      approval: { id: record!.id, callId: record!.callId, status: record!.status, request: record!.request as never, fixSessionId: record!.fixSessionId },
      getPending: () => null, setPending: () => {}, broker: {} as never, render: () => {},
      onFixSessionStarted, defer: (cb) => cb(),
    });
    // `armed` is only ever reassigned inside the `arm` callback above, so TS's
    // control-flow narrowing (which can't see into that closure from here)
    // collapses it back to its initial `null` at this reference point even
    // though the callback has already run synchronously by now (`defer: (cb) =>
    // cb()`). Reassert its real declared type.
    expect(armed as string | null).toBe(session.id);
    expect(notices[0]).not.toContain('/session resume'); // no retype instruction

    const attached: string[] = [];
    expect(handleFixSessionAttachKey('j', { armedFixSessionId: armed!, attach: (id) => attached.push(id), render: () => {} })).toBe(true);
    expect(attached).toEqual([session.id]); // the machine resumes the real session, end to end
  });

  test('a stamped failure carries fixSessionError and renders honestly with no jump armed', async () => {
    const { approvalBroker } = await acceptedApprovalFor('call-e2e-2');
    const record = await approvalBroker.stampFixSession('call-e2e-2', { error: 'agent spawn failed: no provider credential' });
    expect(record).not.toBeNull();
    expect(record!.fixSessionError).toBe('agent spawn failed: no provider credential');
    expect(record!.fixSessionId).toBeUndefined();

    let armed: string | null = null;
    const startedIds: string[] = [];
    const errorNotices: string[] = [];
    handleBrokerApprovalChange({
      approval: { id: record!.id, callId: record!.callId, status: record!.status, request: record!.request as never, fixSessionError: record!.fixSessionError },
      getPending: () => null, setPending: () => {}, broker: {} as never, render: () => {},
      onFixSessionStarted: (id) => { startedIds.push(id); armed = id; },
      onFixSessionError: buildFixSessionErrorNotice((m) => errorNotices.push(m)),
      defer: (cb) => cb(),
    });
    expect(startedIds).toEqual([]); // no session started
    expect(armed).toBeNull(); // no dead action armed
    expect(errorNotices).toHaveLength(1);
    expect(errorNotices[0]).toContain('agent spawn failed: no provider credential');
  });
});
