// ---------------------------------------------------------------------------
// confirm-state.test.ts — handleConfirmInput + renderConfirmLines unit tests
// ---------------------------------------------------------------------------

import { describe, test, expect } from 'bun:test';
import {
  handleConfirmInput,
  renderConfirmLines,
  type ConfirmState,
} from '../../panels/confirm-state.ts';
import type { Line } from '../../types/grid.ts';

function lineText(line: Line): string {
  return line.map((c) => c.char ?? ' ').join('').trimEnd();
}

describe('handleConfirmInput', () => {
  const confirmString: ConfirmState = { subject: 'session-abc', label: 'My Session' };
  const confirmGeneric: ConfirmState<{ id: string; action: 'stale' | 'contradicted' }> = {
    subject: { id: 'rec-1', action: 'stale' },
    label: 'Some record',
  };

  test('returns inactive when confirm is null', () => {
    expect(handleConfirmInput(null, 'y')).toBe('inactive');
    expect(handleConfirmInput(null, 'n')).toBe('inactive');
    expect(handleConfirmInput(null, 'escape')).toBe('inactive');
    expect(handleConfirmInput(null, 'x')).toBe('inactive');
  });

  test('returns confirmed when key is y', () => {
    expect(handleConfirmInput(confirmString, 'y')).toBe('confirmed');
  });

  test('returns confirmed when key is enter (project-standard: Enter confirms)', () => {
    expect(handleConfirmInput(confirmString, 'enter')).toBe('confirmed');
  });

  test('returns confirmed when key is return', () => {
    expect(handleConfirmInput(confirmString, 'return')).toBe('confirmed');
  });

  test('returns cancelled when key is n', () => {
    expect(handleConfirmInput(confirmString, 'n')).toBe('cancelled');
  });

  test('returns cancelled when key is escape', () => {
    expect(handleConfirmInput(confirmString, 'escape')).toBe('cancelled');
  });

  test('returns absorbed for any other key', () => {
    for (const key of ['x', 'd', 'ArrowUp', ' ', 'backspace']) {
      expect(handleConfirmInput(confirmString, key)).toBe('absorbed');
    }
  });

  test('works with generic subject type (ConfirmState<{id, action}>)', () => {
    expect(handleConfirmInput(confirmGeneric, 'y')).toBe('confirmed');
    expect(handleConfirmInput(confirmGeneric, 'enter')).toBe('confirmed');
    expect(handleConfirmInput(confirmGeneric, 'n')).toBe('cancelled');
    expect(handleConfirmInput(confirmGeneric, 'other')).toBe('absorbed');
  });
});

describe('renderConfirmLines', () => {
  const state: ConfirmState = { subject: 'skill-path', label: 'my-skill' };

  test('returns exactly 2 lines', () => {
    const lines = renderConfirmLines(80, state);
    expect(lines).toHaveLength(2);
  });

  test('first line contains the label', () => {
    const lines = renderConfirmLines(80, state);
    expect(lineText(lines[0]!)).toContain('my-skill');
  });

  test('first line contains question mark', () => {
    const lines = renderConfirmLines(80, state);
    expect(lineText(lines[0]!)).toContain('?');
  });

  test('second line contains Enter/y and n/Esc hints', () => {
    const lines = renderConfirmLines(80, state);
    const hint = lineText(lines[1]!);
    expect(hint).toContain('Enter');
    expect(hint).toContain('y');
    expect(hint).toContain('n');
    expect(hint).toContain('Esc');
  });

  test('each line has correct width', () => {
    const width = 60;
    const lines = renderConfirmLines(width, state);
    for (const line of lines) {
      expect(line.length).toBe(width);
    }
  });

  test('works with generic subject type', () => {
    const genericState: ConfirmState<{ id: string; action: 'contradicted' }> = {
      subject: { id: 'rec-2', action: 'contradicted' },
      label: 'Contradict this record',
    };
    const lines = renderConfirmLines(80, genericState);
    expect(lines).toHaveLength(2);
    expect(lineText(lines[0]!)).toContain('Contradict this record');
  });

  test('renders default verb "Delete" when verb is omitted', () => {
    const lines = renderConfirmLines(80, state);
    expect(lineText(lines[0]!)).toContain('Delete "my-skill"?');
  });

  test('renders custom verb honestly for non-destructive confirms', () => {
    const cancelState: ConfirmState = { subject: 'agent-1', label: 'Agent One', verb: 'Cancel' };
    const lines = renderConfirmLines(80, cancelState);
    expect(lineText(lines[0]!)).toContain('Cancel "Agent One"?');
    expect(lineText(lines[0]!)).not.toContain('Delete');
  });

  test('custom verb preserves exact-width + confirm/cancel keybinding contract', () => {
    const width = 60;
    const promoteState: ConfirmState = { subject: 'policy-1', label: 'Policy A', verb: 'Promote' };
    const lines = renderConfirmLines(width, promoteState);
    expect(lines).toHaveLength(2);
    for (const line of lines) expect(line.length).toBe(width);
    expect(handleConfirmInput(promoteState, 'y')).toBe('confirmed');
    expect(handleConfirmInput(promoteState, 'enter')).toBe('confirmed');
    expect(handleConfirmInput(promoteState, 'return')).toBe('confirmed');
    expect(handleConfirmInput(promoteState, 'n')).toBe('cancelled');
    expect(handleConfirmInput(promoteState, 'escape')).toBe('cancelled');
    expect(handleConfirmInput(promoteState, 'x')).toBe('absorbed');
  });
});
