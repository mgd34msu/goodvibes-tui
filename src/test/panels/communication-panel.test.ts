import { describe, expect, test } from 'bun:test';
import { CommunicationPanel } from '../../panels/communication-panel.ts';
import { createRuntimeStore, createDomainDispatch } from '../../runtime/store/index.ts';
import type { Line } from '../../types/grid.ts';

function linesText(lines: Line[]): string {
  return lines
    .map((line) => line.map((cell) => cell.char ?? ' ').join('').trimEnd())
    .filter(Boolean)
    .join('\n');
}

describe('CommunicationPanel', () => {
  test('renders empty guidance when no communication has been recorded', () => {
    const store = createRuntimeStore();
    const panel = new CommunicationPanel(store);
    const text = linesText(panel.render(100, 12));

    expect(text).toContain('Communication Control Room');
    expect(text).toContain('No structured communication recorded yet');
  });

  test('renders sent and blocked communication details from the runtime store', () => {
    const store = createRuntimeStore();
    const dispatch = createDomainDispatch(store);

    dispatch.dispatchCommunicationEvent({
      type: 'COMMUNICATION_SENT',
      messageId: 'msg-1',
      fromId: 'reviewer-1',
      toId: 'engineer-1',
      scope: 'direct',
      kind: 'review',
      content: 'Please address findings A and B.',
      fromRole: 'reviewer',
      toRole: 'engineer',
      wrfcId: 'wrfc-1',
    });
    dispatch.dispatchCommunicationEvent({
      type: 'COMMUNICATION_DELIVERED',
      messageId: 'msg-1',
      fromId: 'reviewer-1',
      toId: 'engineer-1',
      scope: 'direct',
      kind: 'review',
    });
    dispatch.dispatchCommunicationEvent({
      type: 'COMMUNICATION_BLOCKED',
      messageId: 'msg-2',
      fromId: 'reviewer-1',
      toId: '*',
      scope: 'broadcast',
      kind: 'status',
      reason: 'broadcast reserved for orchestrator',
      fromRole: 'reviewer',
    });

    const panel = new CommunicationPanel(store);
    const text = linesText(panel.render(120, 16));

    expect(text).toContain('sent:1 delivered:1 blocked:1');
    expect(text).toContain('reviewer-1 -> engineer-1');
    expect(text).toContain('review');
    expect(text).toContain('broadcast reserved for orchestrator');
  });
});
