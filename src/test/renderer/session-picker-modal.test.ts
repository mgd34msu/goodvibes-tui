/**
 * Tests for renderSessionPickerModal renderer.
 */
import { frameFromLayer } from '../helpers/surface-frame.ts';
import { describe, test, expect, beforeEach } from 'bun:test';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SessionPickerModal } from '../../input/session-picker-modal.ts';
import { SessionManager } from '@pellux/goodvibes-sdk/platform/sessions';
import { renderSessionPickerModal } from '../../renderer/session-picker-modal.ts';
import { lineToString, linesToText } from '../setup.ts';
import { activeTokens } from '../../renderer/theme.ts';
import { makeTestSurface } from '../helpers/session-surface.ts';

const W = 120;
const sessionManager = new SessionManager(join(tmpdir(), 'gv-renderer-session-picker'), { surface: makeTestSurface(join(tmpdir(), 'gv-renderer-session-picker')) });

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
    const lines = frameFromLayer(renderSessionPickerModal(makeModal(), W), W, 24);
    expect(Array.isArray(lines)).toBe(true);
    expect(lines.length).toBeGreaterThan(0);
  });

  test('each line has correct terminal width', () => {
    const lines = frameFromLayer(renderSessionPickerModal(makeModal(), W), W, 24);
    for (const line of lines) {
      expect(line.length).toBe(W);
    }
  });

  test('title row carries the ✦ mark and the title', () => {
    const lines = frameFromLayer(renderSessionPickerModal(makeModal(), W), W, 24);
    expect(linesToText(lines).join('\n')).toContain('✦ Sessions');
  });

  test('hint row shows keycap hints (move, open, delete) and the search row is live', () => {
    const texts = linesToText(frameFromLayer(renderSessionPickerModal(makeModal(), W), W, 24)).join('\n');
    expect(texts).toContain(' ↑↓  move');
    expect(texts).toContain(' ⏎  open');
    expect(texts).toContain(' d  delete');
    expect(texts).toContain('▏Search sessions');
  });

  test('shows session names in list', () => {
    const lines = frameFromLayer(renderSessionPickerModal(makeModal(), W), W, 24);
    const texts = linesToText(lines).join('\n');
    expect(texts).toContain('alpha-session');
    expect(texts).toContain('beta-session');
  });

  test('the selected session is drawn as the selected row', () => {
    const lines = frameFromLayer(renderSessionPickerModal(makeModal(), W), W, 24);
    const row = lines.find((line) => lineToString(line).includes('alpha-session'))!;
    const cell = row[lineToString(row).indexOf('Alpha')] ?? row[lineToString(row).indexOf('alpha-session')]!;
    expect(cell.bold).toBe(true);
    expect(cell.fg).toBe(activeTokens().selectedListItemText);
  });

  test('empty sessions shows helpful message', () => {
    const modal = makeModal({ sessions: [] as typeof makeModal extends () => infer R ? (R extends { sessions: infer S } ? S : never) : never });
    modal.sessions = [];
    const lines = frameFromLayer(renderSessionPickerModal(modal, W), W, 24);
    const texts = linesToText(lines).join('\n');
    expect(texts).toContain('No saved sessions');
  });

  test('status message is displayed when set', () => {
    const modal = makeModal();
    modal.statusMessage = 'Deleted: alpha-session';
    const lines = frameFromLayer(renderSessionPickerModal(modal, W), W, 24);
    const texts = linesToText(lines).join('\n');
    expect(texts).toContain('Deleted: alpha-session');
  });

  test('delete confirmation guidance is displayed when armed', () => {
    const modal = makeModal();
    modal.deleteConfirmationTarget = 'alpha-session';
    modal.statusMessage = 'Press d again to delete alpha-session.';
    const lines = frameFromLayer(renderSessionPickerModal(modal, W), W, 24);
    const texts = linesToText(lines).join('\n');
    expect(texts).toContain('Deletion is armed for alpha-session');
    expect(texts).toContain('Press d again to delete "alpha-session"');
    expect(texts).toContain(' d  confirm delete');
  });

  test('works at narrow terminal width', () => {
    const narrowW = 60;
    const lines = frameFromLayer(renderSessionPickerModal(makeModal(), narrowW), narrowW, 24);
    for (const line of lines) {
      expect(line.length).toBe(narrowW);
    }
  });

  test('message count shown in list', () => {
    const lines = frameFromLayer(renderSessionPickerModal(makeModal(), W), W, 24);
    const texts = linesToText(lines).join('\n');
    // Session has 5 messages
    expect(texts).toContain('5');
  });
});
