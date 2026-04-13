/**
 * Tests for renderSessionPickerModal renderer.
 */
import { describe, test, expect, beforeEach } from 'bun:test';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SessionPickerModal } from '../../input/session-picker-modal.ts';
import { SessionManager } from '../../sessions/manager.ts';
import { renderSessionPickerModal } from '../../renderer/session-picker-modal.ts';
import { lineToString, linesToText } from '../setup.ts';

const W = 120;
const sessionManager = new SessionManager(join(tmpdir(), 'gv-renderer-session-picker'));

function makeModal(overrides: Partial<SessionPickerModal> = {}): SessionPickerModal {
  const modal = new SessionPickerModal(sessionManager);
  modal.active = true;
  modal.sessions = [
    { name: 'alpha-session', title: 'Alpha', model: 'gpt-4', provider: 'openai', timestamp: 1700000000000, messageCount: 5, filePath: '/x/alpha.jsonl' },
    { name: 'beta-session',  title: 'Beta',  model: 'gpt-4', provider: 'openai', timestamp: 1700100000000, messageCount: 12, filePath: '/x/beta.jsonl' },
  ];
  modal.selectedIndex = 0;
  Object.assign(modal, overrides);
  return modal;
}

describe('renderSessionPickerModal', () => {
  test('returns a non-empty Line[] array', () => {
    const lines = renderSessionPickerModal(makeModal(), W);
    expect(Array.isArray(lines)).toBe(true);
    expect(lines.length).toBeGreaterThan(0);
  });

  test('each line has correct terminal width', () => {
    const lines = renderSessionPickerModal(makeModal(), W);
    for (const line of lines) {
      expect(line.length).toBe(W);
    }
  });

  test('title bar contains "Sessions"', () => {
    const lines = renderSessionPickerModal(makeModal(), W);
    const title = lineToString(lines[0]);
    expect(title).toContain('Sessions');
  });

  test('footer contains navigation hints', () => {
    const lines = renderSessionPickerModal(makeModal(), W);
    const footer = lineToString(lines[lines.length - 1]);
    expect(footer).toContain('Navigate');
    expect(footer).toContain('Load');
    expect(footer).toContain('Delete');
    expect(footer).toContain('Esc');
  });

  test('shows session names in list', () => {
    const lines = renderSessionPickerModal(makeModal(), W);
    const texts = linesToText(lines).join('\n');
    expect(texts).toContain('alpha-session');
    expect(texts).toContain('beta-session');
  });

  test('selected item has arrow indicator', () => {
    const lines = renderSessionPickerModal(makeModal(), W);
    const hasArrow = lines.some(line => line.some(cell => cell.char === '▸'));
    expect(hasArrow).toBe(true);
  });

  test('empty sessions shows helpful message', () => {
    const modal = makeModal({ sessions: [] as typeof makeModal extends () => infer R ? (R extends { sessions: infer S } ? S : never) : never });
    modal.sessions = [];
    const lines = renderSessionPickerModal(modal, W);
    const texts = linesToText(lines).join('\n');
    expect(texts).toContain('No saved sessions');
  });

  test('status message is displayed when set', () => {
    const modal = makeModal();
    modal.statusMessage = 'Deleted: alpha-session';
    const lines = renderSessionPickerModal(modal, W);
    const texts = linesToText(lines).join('\n');
    expect(texts).toContain('Deleted: alpha-session');
  });

  test('delete confirmation guidance is displayed when armed', () => {
    const modal = makeModal();
    modal.deleteConfirmationTarget = 'alpha-session';
    modal.statusMessage = 'Press d again to delete alpha-session.';
    const lines = renderSessionPickerModal(modal, W);
    const texts = linesToText(lines).join('\n');
    expect(texts).toContain('Deletion is armed for alpha-session');
    expect(texts).toContain('Arm / Delete');
  });

  test('works at narrow terminal width', () => {
    const narrowW = 60;
    const lines = renderSessionPickerModal(makeModal(), narrowW);
    for (const line of lines) {
      expect(line.length).toBe(narrowW);
    }
  });

  test('message count shown in list', () => {
    const lines = renderSessionPickerModal(makeModal(), W);
    const texts = linesToText(lines).join('\n');
    // Session has 5 messages
    expect(texts).toContain('5');
  });
});
