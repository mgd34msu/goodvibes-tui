import { describe, expect, test } from 'bun:test';
import {
  handleBrokerApprovalChange,
  buildFixSessionAffordance,
  handleFixSessionAttachKey,
  refreshFixSessionsFromApprovals,
  type BrokerApprovalCardBroker,
} from '../../permissions/broker-approval-card.ts';
import type { PendingPermissionState } from '../../shell/blocking-input.ts';
import type { RememberTier } from '@pellux/goodvibes-sdk/platform/permissions';

function makeRequest(callId: string, tool = 'ci-fix') {
  return { callId, tool, reason: 'Fix the failing CI run?', args: {} } as never;
}

function makeBroker(records: Record<string, { status: string; request: unknown }>): BrokerApprovalCardBroker & {
  resolved: Array<{ id: string; approved: boolean }>;
} {
  const resolved: Array<{ id: string; approved: boolean }> = [];
  return {
    resolved,
    listApprovals: () => [],
    getApproval: (id: string) => (records[id] as never) ?? null,
    resolveApproval: async (id: string, input: {
      readonly approved: boolean;
      readonly remember?: boolean;
      readonly rememberTier?: RememberTier;
      readonly reason?: string;
      readonly modifiedArgs?: Record<string, unknown>;
      readonly actor: string;
      readonly actorSurface?: string;
    }) => { resolved.push({ id, approved: input.approved }); return null; },
  } as never;
}

describe('broker-originated approval cards', () => {
  test('a broker-originated ci:fix-session ask opens a card and accepting answers the broker', () => {
    let pending: PendingPermissionState | null = null;
    let renders = 0;
    const broker = makeBroker({ 'ap-1': { status: 'pending', request: makeRequest('call-1') } });

    handleBrokerApprovalChange({
      approval: { id: 'ap-1', callId: 'call-1', status: 'pending', request: makeRequest('call-1') },
      getPending: () => pending,
      setPending: (next) => { pending = next; },
      broker,
      render: () => { renders += 1; },
      defer: (cb) => cb(),
    });

    // The ask surfaced as a real card built from broker state.
    expect(pending).not.toBeNull();
    expect(pending!.callId).toBe('call-1');
    expect(renders).toBe(1);

    // Accepting the card answers the broker record (reaches every waiter).
    pending!.resolve(true, false);
    expect(broker.resolved).toEqual([{ id: 'ap-1', approved: true }]);
  });

  test('does not double-open when a local card is already up for the same call', () => {
    const localCard = { callId: 'call-2' } as PendingPermissionState;
    let pending: PendingPermissionState | null = localCard;
    const broker = makeBroker({ 'ap-2': { status: 'pending', request: makeRequest('call-2') } });

    handleBrokerApprovalChange({
      approval: { id: 'ap-2', callId: 'call-2', status: 'pending', request: makeRequest('call-2') },
      getPending: () => pending,
      setPending: (next) => { pending = next; },
      broker,
      render: () => {},
      defer: (cb) => cb(),
    });

    // The existing local card is untouched — no second card built.
    expect(pending).toBe(localCard);
  });

  test('clears the active card once its approval resolves', () => {
    const card = { callId: 'call-3' } as PendingPermissionState;
    let pending: PendingPermissionState | null = card;
    let renders = 0;
    const broker = makeBroker({});

    handleBrokerApprovalChange({
      approval: { id: 'ap-3', callId: 'call-3', status: 'approved', request: makeRequest('call-3') },
      getPending: () => pending,
      setPending: (next) => { pending = next; },
      broker,
      render: () => { renders += 1; },
      defer: (cb) => cb(),
    });

    expect(pending).toBeNull();
    expect(renders).toBe(1);
  });

  test('a record carrying a spawned fix-session id surfaces the jump/attach affordance', () => {
    let pending: PendingPermissionState | null = null;
    const started: string[] = [];
    const broker = makeBroker({});

    // The accepted ci:fix-session record is stamped with the spawned id and
    // republished (status resolved, card already cleared).
    handleBrokerApprovalChange({
      approval: { id: 'ap-9', callId: 'call-9', status: 'approved', request: makeRequest('call-9'), fixSessionId: 'sess-abc' },
      getPending: () => pending,
      setPending: (next) => { pending = next; },
      broker,
      render: () => {},
      onFixSessionStarted: (id) => { started.push(id); },
      defer: (cb) => cb(),
    });

    expect(started).toEqual(['sess-abc']);
  });

  test('buildFixSessionAffordance arms the one-key jump once per id (no retype instruction); refresh path dedupes', () => {
    const messages: string[] = [];
    const armed: string[] = [];
    const affordance = buildFixSessionAffordance({
      notify: (m) => messages.push(m),
      arm: (id) => armed.push(id),
    });

    affordance('sess-xyz');
    affordance('sess-xyz'); // repeat — no second notice/arm
    expect(messages).toHaveLength(1);
    expect(armed).toEqual(['sess-xyz']);
    // The notice offers a one-key jump, never a command for the user to retype.
    expect(messages[0]).toContain('press j to jump');
    expect(messages[0]).not.toContain('/session resume');
    expect(messages[0]).not.toContain('sess-xyz');

    // The listApprovals refresh path feeds the same de-duplicating affordance.
    refreshFixSessionsFromApprovals(
      () => [{ fixSessionId: 'sess-xyz' }, { fixSessionId: 'sess-new' }, {}],
      affordance,
    );
    expect(messages).toHaveLength(2);
    expect(armed).toEqual(['sess-xyz', 'sess-new']);
  });

  test('handleFixSessionAttachKey: the jump key attaches to the armed session; other keys fall through', () => {
    const attached: string[] = [];
    let renders = 0;
    const deps = { armedFixSessionId: 'sess-jump', attach: (id: string) => attached.push(id), render: () => { renders += 1; } };

    // A non-jump key does nothing (the surface has already cleared the arm).
    expect(handleFixSessionAttachKey('x', deps)).toBe(false);
    expect(attached).toEqual([]);

    // 'j' attaches to the armed session — the machine runs the resume, no retype.
    expect(handleFixSessionAttachKey('j', deps)).toBe(true);
    expect(attached).toEqual(['sess-jump']);
    expect(renders).toBe(1);
  });

  test('a resolved ask that is not the active card is ignored', () => {
    const card = { callId: 'call-4' } as PendingPermissionState;
    let pending: PendingPermissionState | null = card;
    const broker = makeBroker({});

    handleBrokerApprovalChange({
      approval: { id: 'ap-x', callId: 'other-call', status: 'approved', request: makeRequest('other-call') },
      getPending: () => pending,
      setPending: (next) => { pending = next; },
      broker,
      render: () => {},
      defer: (cb) => cb(),
    });

    expect(pending).toBe(card);
  });
});
