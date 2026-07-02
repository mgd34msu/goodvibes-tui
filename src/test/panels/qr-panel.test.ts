import { describe, expect, test } from 'bun:test';
import { QrPanel } from '../../panels/qr-panel.ts';
import type { UiControlPlaneSnapshot, UiReadModel } from '../../runtime/ui-read-models.ts';
import type { UserAuthManager } from '@pellux/goodvibes-sdk/platform/security';
import type { LocalAuthSnapshot } from '@pellux/goodvibes-sdk/platform/security';

const INFO = {
  url: 'http://192.168.1.50:3141',
  token: 'tok_abcdef0123456789',
  username: 'operator',
  password: 'bootstrap-pw',
};

function textOf(panel: QrPanel, w = 60, h = 40): string {
  return panel.render(w, h).flat().map((c) => c.char).join('');
}

function makeControlPlaneReadModel(activeClientIds: readonly string[]): UiReadModel<UiControlPlaneSnapshot> {
  const snapshot = { activeClientIds } as unknown as UiControlPlaneSnapshot;
  return { getSnapshot: () => snapshot, subscribe: () => () => {} };
}

function makeAuthManager(sessionCount: number): Pick<UserAuthManager, 'inspect'> {
  return { inspect: () => ({ sessionCount } as unknown as LocalAuthSnapshot) };
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

  test('token and bootstrap password are masked by default and revealed with v', () => {
    const panel = new QrPanel(INFO);
    const masked = textOf(panel);
    expect(masked).not.toContain(INFO.token);
    expect(masked).not.toContain(INFO.password);
    expect(masked).toContain('reveal token');

    expect(panel.handleInput('v')).toBe(true);
    const revealed = textOf(panel);
    expect(revealed).toContain(INFO.token);
    expect(revealed).toContain(INFO.password);
    expect(revealed).toContain('hide token');

    expect(panel.handleInput('v')).toBe(true);
    expect(textOf(panel)).not.toContain(INFO.token);
  });

  test('hints advertise ONLY wired actions (v is always wired since it is a display-only toggle)', () => {
    const withActions = new QrPanel(INFO, () => INFO, () => {});
    const aText = textOf(withActions);
    expect(aText).toContain('regenerate token');
    expect(aText).toContain('copy token');
    expect(aText).toContain('reveal token');

    const readOnly = new QrPanel(INFO);
    const rText = textOf(readOnly);
    expect(rText).not.toContain('regenerate token');
    expect(rText).not.toContain('copy token');
    expect(rText).toContain('reveal token');
  });

  test('shows connected companion count from the control-plane read model', () => {
    const panel = new QrPanel(INFO, undefined, undefined, makeControlPlaneReadModel(['client-1', 'client-2']));
    const text = textOf(panel);
    expect(text).toContain('connected: 2');
  });

  test('regenerate proceeds immediately when no companion session is live', () => {
    let regenerated = 0;
    const panel = new QrPanel(
      INFO,
      () => { regenerated += 1; return INFO; },
      undefined,
      undefined,
      makeAuthManager(0),
    );
    expect(panel.handleInput('r')).toBe(true);
    expect(regenerated).toBe(1);
    expect(textOf(panel)).toContain('Token regenerated');
  });

  test('regenerate warns and requires confirmation when a companion session is live', () => {
    let regenerated = 0;
    const panel = new QrPanel(
      INFO,
      () => { regenerated += 1; return INFO; },
      undefined,
      undefined,
      makeAuthManager(1),
    );
    expect(panel.handleInput('r')).toBe(true);
    expect(regenerated).toBe(0);
    const confirmText = textOf(panel);
    expect(confirmText).toContain('Regenerate');
    expect(confirmText).toContain('companion session is live');

    // Cancel first — must not regenerate.
    expect(panel.handleInput('n')).toBe(true);
    expect(regenerated).toBe(0);
    expect(textOf(panel)).toContain('cancelled');

    // Ask again and confirm this time.
    expect(panel.handleInput('r')).toBe(true);
    expect(panel.handleInput('y')).toBe(true);
    expect(regenerated).toBe(1);
  });

  test('truncates an over-wide URL without overflowing the row', () => {
    const longUrl = { ...INFO, url: 'http://' + 'a'.repeat(200) + '.example.com:3141' };
    const panel = new QrPanel(longUrl);
    const lines = panel.render(40, 40);
    for (const line of lines) expect(line.length).toBe(40);
  });

  test('render output is clamped to the exact requested height even when the QR code would overflow a small pane', () => {
    const panel = new QrPanel(INFO);
    for (const h of [10, 15, 20, 40]) {
      const lines = panel.render(60, h);
      expect(lines.length).toBe(h);
      for (const line of lines) expect(line.length).toBe(60);
    }
  });
});
