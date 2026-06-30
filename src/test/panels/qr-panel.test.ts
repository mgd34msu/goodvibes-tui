import { describe, expect, test } from 'bun:test';
import { QrPanel } from '../../panels/qr-panel.ts';

const INFO = {
  url: 'http://192.168.1.50:3141',
  token: 'tok_abcdef0123456789',
  username: 'operator',
  password: 'bootstrap-pw',
};

function textOf(panel: QrPanel, w = 60, h = 40): string {
  return panel.render(w, h).flat().map((c) => c.char).join('');
}

describe('QrPanel', () => {
  test('explains what the code is for and shows connection fields', () => {
    const panel = new QrPanel(INFO);
    const text = textOf(panel);
    expect(text).toContain('Companion Pairing');
    expect(text).toContain('Scan with the GoodVibes companion app');
    expect(text).toContain('192.168.1.50');
    expect(text).toContain('operator');
  });

  test('only advertises wired actions in the hints row', () => {
    const withActions = new QrPanel(INFO, () => INFO, () => {});
    const aText = textOf(withActions);
    expect(aText).toContain('regenerate token');
    expect(aText).toContain('copy token');

    const readOnly = new QrPanel(INFO);
    const rText = textOf(readOnly);
    expect(rText).toContain('read-only');
    expect(rText).not.toContain('regenerate token');
  });

  test('truncates an over-wide URL without overflowing the row', () => {
    const longUrl = { ...INFO, url: 'http://' + 'a'.repeat(200) + '.example.com:3141' };
    const panel = new QrPanel(longUrl);
    const lines = panel.render(40, 40);
    for (const line of lines) expect(line.length).toBe(40);
  });
});
