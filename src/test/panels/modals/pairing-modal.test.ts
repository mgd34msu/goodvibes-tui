import { describe, test, expect } from 'bun:test';
import { createPairingModalSurface, type PairingModalConnectionInfo } from '../../../panels/modals/pairing-modal.ts';
import { actionCtx, open, tabText } from './modal-surface-test-helpers.ts';

const FIXED_INFO: PairingModalConnectionInfo = {
  url: 'http://workshop.local:3141',
  token: 'secret-token-abc123',
  tokenName: 'my laptop',
  deepLink: 'http://workshop.local:3141/#pair=secret-token-abc123&offers=notifications~relay',
  offers: ['notifications', 'relay'],
  httpOnLan: true,
};

describe('pairing modal surface', () => {
  test('surface identity matches the qr-code -> pairing-modal redirect target', () => {
    expect(createPairingModalSurface({ getConnectionInfo: () => FIXED_INFO }).name).toBe('pairing-modal');
  });

  test('token and deep link are masked by default; toggleReveal flips them and back', () => {
    const surface = createPairingModalSurface({ getConnectionInfo: () => FIXED_INFO });
    const masked = tabText(open(surface), 'pairing');
    expect(masked).not.toContain('secret-token-abc123');
    expect(masked).toContain('Web app   http://workshop.local:3141');
    expect(masked).toContain('Device    my laptop');

    surface.onAction?.('toggleReveal', actionCtx(null));
    const revealedView = surface.buildView();
    const revealed = tabText(revealedView, 'pairing');
    expect(revealed).toContain('secret-token-abc123');
    expect(revealed).toContain('http://workshop.local:3141/#pair=secret-token-abc123');
    expect(revealedView.tabs[0]!.hints).toContain('v hide token');

    surface.onAction?.('toggleReveal', actionCtx(null));
    expect(tabText(surface.buildView(), 'pairing')).not.toContain('secret-token-abc123');
  });

  test('QR encodes the deep link (no raw JSON blob), and the offer set + posture render', () => {
    const text = tabText(open(createPairingModalSurface({ getConnectionInfo: () => FIXED_INFO })), 'pairing');
    expect(/[▀▄█]/.test(text)).toBe(true);
    // No JSON connection blob leaks into the surface.
    expect(text).not.toContain('"token"');
    expect(text).not.toContain('daemonUrl');
    // Offer set with plain-language consequence lines.
    expect(text).toContain('Notifications —');
    expect(text).toContain('Relay —');
    // The single honest LAN-posture line (http on LAN).
    expect(text).toContain('plain http on your LAN');
  });

  test('copy copies the deep link, not a bare token', () => {
    let copied: string | null = null;
    const surface = createPairingModalSurface({ getConnectionInfo: () => FIXED_INFO, copyToClipboard: (t) => { copied = t; } });
    open(surface);
    const printed: string[] = [];
    surface.onAction?.('copyLink', actionCtx(null, { print: (m) => printed.push(m) }));
    expect(copied).toBe('http://workshop.local:3141/#pair=secret-token-abc123&offers=notifications~relay');
    expect(printed).toEqual(['Pairing link copied to clipboard.']);
  });

  test('new device token re-pulls the thunk to mint a fresh token + QR in place (in-modal, no command routing)', () => {
    let n = 1;
    const surface = createPairingModalSurface({ getConnectionInfo: () => ({ ...FIXED_INFO, token: `token-v${n}`, deepLink: `http://workshop.local:3141/#pair=token-v${n}` }) });
    open(surface);
    surface.onAction?.('toggleReveal', actionCtx(null));
    expect(tabText(surface.buildView(), 'pairing')).toContain('token-v1');

    n = 2;
    const statuses: string[] = [];
    surface.onAction?.('newToken', actionCtx(null, { setStatus: (m: string) => statuses.push(m) }));
    surface.onAction?.('toggleReveal', actionCtx(null)); // re-pull re-masks; reveal again
    const text = tabText(surface.buildView(), 'pairing');
    expect(text).toContain('token-v2');
    expect(text).not.toContain('token-v1');
    expect(statuses.some((s) => s.includes('fresh device token'))).toBe(true);
    // Non-destructive: it is not a confirmed action and routes to no command.
    expect((surface.actions ?? []).find((a) => a.id === 'newToken')?.confirm).toBeUndefined();
  });

  test('connected-devices count reads live from the control-plane read model', () => {
    const text = tabText(open(createPairingModalSurface({ getConnectionInfo: () => FIXED_INFO, controlPlaneReadModel: { getSnapshot: () => ({ activeClientIds: ['a', 'b'] }) } })), 'pairing');
    expect(text).toContain('Devices connected: 2');
  });

  test('degrades honestly when the connection info cannot be resolved', () => {
    const view = open(createPairingModalSurface({ getConnectionInfo: () => null }));
    expect(view.degraded).toContain('Device pairing is unavailable');
  });
});
