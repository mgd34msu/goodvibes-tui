import { describe, expect, test } from 'bun:test';
import { renderStatusLine } from '../../renderer/status-line.ts';

const text = (line: ReturnType<typeof renderStatusLine>): string => line.map((c) => c.char || ' ').join('');

describe('status line while the keyboard is in the work tree', () => {
  const keys = [['↑↓', 'move between beads'], ['←→', 'fold / unfold'], ['enter', 'open'], ['y', 'copy'], ['esc', 'back to typing']] as const;

  test('its keys replace the esc interrupt hint and the directory, after the safety chips', () => {
    const line = renderStatusLine({
      width: 140,
      chips: [{ text: '! auto-approve', fg: '#ff0000', keep: true }],
      busy: {},
      directory: '~/proj',
      keys,
    });
    const t = text(line);
    expect(t).toContain('! auto-approve');
    expect(t).toContain('move between beads');
    expect(t).toContain('back to typing');
    expect(t).not.toContain('interrupt');
    expect(t).not.toContain('~/proj');
    expect(t.indexOf('! auto-approve')).toBeLessThan(t.indexOf('move between beads'));
  });

  test('on a narrow screen whole keys drop from the end, never cut', () => {
    const t = text(renderStatusLine({ width: 70, keys }));
    expect(t).toContain('move between beads');
    expect(t).not.toMatch(/back to typi(?!ng)/);
  });
});
