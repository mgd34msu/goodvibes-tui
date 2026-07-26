import { describe, test, expect } from 'bun:test';
import {
  createPairingModalSurface,
  type PairingModalConnectionInfo,
  type PairingTailscaleStatus,
  type PairingTailscaleServeReceipt,
} from '../../../panels/modals/pairing-modal.ts';
import { describeOriginPosture, LAN_PLAIN_HTTP_NOTICE } from '@pellux/goodvibes-sdk/platform/pairing';
import { ConfigModal } from '../../../input/config-modal.ts';
import { renderConfigModal } from '../../../renderer/config-modal.ts';
import type { ConfigModalSurface } from '../../../input/config-modal-types.ts';
import { actionCtx, open, tabRows, tabText } from './modal-surface-test-helpers.ts';

const FIXED_INFO: PairingModalConnectionInfo = {
  url: 'http://workshop.local:3141',
  token: 'secret-token-abc123',
  tokenName: 'my laptop',
  deepLink: 'http://workshop.local:3141/#pair=secret-token-abc123&offers=notifications~relay',
  offers: ['notifications', 'relay'],
  // A plain-http LAN origin ⇒ posture carries the SDK LAN notice + gated capabilities.
  posture: describeOriginPosture('http://workshop.local:3141'),
};

/** Render a surface through the real host at a size; each row as trimmed text. */
function renderRows(surface: ConfigModalSurface, width: number, height: number): string[] {
  const modal = new ConfigModal();
  modal.open(surface, () => {});
  modal.syncStructure();
  const lines = renderConfigModal(modal, width, height);
  modal.close();
  return lines.map((line) => line.map((c) => (c.char === '' ? ' ' : c.char)).join('').replace(/\s+$/, ''));
}

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

  test('QR encodes the deep link (no raw JSON blob); offers, capabilities, and the one honest LAN line render', () => {
    const text = tabText(open(createPairingModalSurface({ getConnectionInfo: () => FIXED_INFO })), 'pairing');
    expect(/[▀▄█]/.test(text)).toBe(true);
    // No JSON connection blob leaks into the surface.
    expect(text).not.toContain('"token"');
    expect(text).not.toContain('daemonUrl');
    // Offer set with plain-language consequence lines.
    expect(text).toContain('Notifications —');
    expect(text).toContain('Relay —');
    // The labeled capability list (what the device will get), from the posture.
    expect(text).toContain('This device will get:');
    expect(text).toContain('Push notifications — needs https — available via tailscale');
    // The ONE honest LAN line is the SDK export verbatim — never a local rewording.
    expect(text).toContain(LAN_PLAIN_HTTP_NOTICE);
  });

  test('a secure-context origin shows every capability available and NO LAN nag', () => {
    const secure: PairingModalConnectionInfo = { ...FIXED_INFO, url: 'https://app.example', deepLink: 'https://app.example/#pair=x', posture: describeOriginPosture('https://app.example') };
    const text = tabText(open(createPairingModalSurface({ getConnectionInfo: () => secure })), 'pairing');
    expect(text).toContain('Push notifications — available');
    expect(text).not.toContain(LAN_PLAIN_HTTP_NOTICE);
    expect(text).not.toContain('needs https');
  });

  test('copy copies the deep link, not a bare token', () => {
    let copied: string | null = null;
    const surface = createPairingModalSurface({ getConnectionInfo: () => FIXED_INFO, copyToClipboard: (t) => { copied = t; } });
    open(surface);
    const printed: string[] = [];
    surface.onAction?.('copyLink', actionCtx(null, { print: (m) => printed.push(m) }));
    // Reassigned inside the copyToClipboard closure above — cast back to the
    // declared type since TS freezes the narrowed type at the `let` initializer
    // and doesn't see through the closure's later assignment.
    expect(copied as string | null).toBe('http://workshop.local:3141/#pair=secret-token-abc123&offers=notifications~relay');
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

describe('pairing modal — full-text render (no clipping)', () => {
  // At a standard 24-row terminal the modal scrolls (never clips horizontally):
  // every rendered row fits the width, and the posture region that is in view
  // reads as whole words, not a truncated-to-the-edge stub.
  for (const [label, width] of [['80x24', 80], ['60-col', 60]] as const) {
    test(`${label}: nothing is clipped to the right edge; the visible content reads as whole words`, () => {
      const rows = renderRows(createPairingModalSurface({ getConnectionInfo: () => FIXED_INFO }), width, 24);
      for (const row of rows) expect(row.length).toBeLessThanOrEqual(width);
      const flowed = rows.join(' ').replace(/[│┌┐└┘─▸]/g, ' ').replace(/\s+/g, ' ');
      // Content above the fold reads in full (word-wrapped, not edge-truncated).
      expect(flowed).toContain('Offers (each declinable when you pair):');
      expect(flowed).toContain('Web app http://workshop.local:3141');
    });

    // Completeness: the one honest LAN line and every capability are carried as
    // intact rows in the built view (the modal windows/scrolls them, never
    // truncates a line) — the "modals show their full text" contract at the data
    // level that the grid then renders width-fit.
    test(`${label}: the full LAN notice and all capabilities are present, unabridged`, () => {
      const rows = tabRows(open(createPairingModalSurface({ getConnectionInfo: () => FIXED_INFO })), 'pairing').map((r) => r.label);
      expect(rows).toContain(LAN_PLAIN_HTTP_NOTICE);
      expect(rows).toContain('  Offline app (installable / background sync) — needs https — available via tailscale');
      expect(rows).toContain('  Push notifications — needs https — available via tailscale');
      expect(rows).toContain('  Voice input (microphone) — needs https — available via tailscale');
      // Every posture row, once box-wrapped at this width, stays within it.
      for (const row of renderRows(createPairingModalSurface({ getConnectionInfo: () => FIXED_INFO }), width, 24)) {
        expect(row.length).toBeLessThanOrEqual(width);
      }
    });
  }
});

describe('pairing modal — tailscale serve affordance', () => {
  const available: PairingTailscaleStatus = { available: true, loggedIn: true, magicDnsName: 'workshop.tail1234.ts.net', detail: 'tailscale up, logged in' };

  test('absent tailscale stays quiet — no affordance, no hint', async () => {
    const surface = createPairingModalSurface({ getConnectionInfo: () => FIXED_INFO, probeTailscale: async () => null });
    surface.onOpen?.(() => {});
    await Promise.resolve();
    const view = surface.buildView();
    // The LAN notice itself names Tailscale; what must be absent is the serve
    // AFFORDANCE — no detection row, no encrypted-access row, no serve hint.
    const text = tabText(view, 'pairing');
    expect(text).not.toContain('Tailscale detected');
    expect(text).not.toContain('Encrypted access (Tailscale)');
    expect(view.tabs[0]!.hints).not.toContain('t serve over tailscale');
  });

  test('detected tailscale offers the one-action serve; a run renders the https MagicDNS URL + receipt', async () => {
    let served = false;
    const receipt: PairingTailscaleServeReceipt = { at: 1, command: 'tailscale serve --bg 3423', ok: true, url: 'https://workshop.tail1234.ts.net', detail: 'serving https://workshop.tail1234.ts.net' };
    const surface = createPairingModalSurface({
      getConnectionInfo: () => FIXED_INFO,
      probeTailscale: async () => available,
      runTailscaleServe: async () => { served = true; return receipt; },
    });
    surface.onOpen?.(() => {});
    await Promise.resolve();
    const view = surface.buildView();
    expect(tabText(view, 'pairing')).toContain('Tailscale detected');
    expect(view.tabs[0]!.hints).toContain('t serve over tailscale');
    // The serve action is confirmed (standard second-press) and gated on availability.
    const action = (surface.actions ?? []).find((a) => a.id === 'tailscaleServe');
    expect(action?.confirm).toBe(true);
    expect(action?.enabledFor?.(null, 'pairing')).toBe(true);

    surface.onAction?.('tailscaleServe', actionCtx(null));
    await Promise.resolve();
    await Promise.resolve();
    expect(served).toBe(true);
    const after = tabText(surface.buildView(), 'pairing');
    expect(after).toContain('Encrypted access (Tailscale):');
    expect(after).toContain('https://workshop.tail1234.ts.net');
    expect(after).toContain('serving https://workshop.tail1234.ts.net');
  });
});
