import { describe, test, expect } from 'bun:test';
import { createPairingModalSurface, type PairingModalConnectionInfo } from '../../../panels/modals/pairing-modal.ts';
import { actionCtx, captureCommands, open, tabText } from './modal-surface-test-helpers.ts';

const FIXED_INFO: PairingModalConnectionInfo = { url: 'http://192.168.1.50:3141', token: 'secret-token-abc123', username: 'mike', password: 'bootstrap-pass', version: '1.2.0', surface: 'tui' };

async function flush(): Promise<void> { await new Promise((resolve) => setTimeout(resolve, 0)); }

describe('pairing modal surface', () => {
  test('surface identity matches the qr-code -> pairing-modal redirect target', () => {
    expect(createPairingModalSurface({ getConnectionInfo: () => FIXED_INFO }).name).toBe('pairing-modal');
  });

  test('token and password are masked by default; toggleReveal flips them and back', () => {
    const surface = createPairingModalSurface({ getConnectionInfo: () => FIXED_INFO });
    const masked = tabText(open(surface), 'pairing');
    expect(masked).not.toContain('secret-token-abc123');
    expect(masked).not.toContain('bootstrap-pass');
    expect(masked).toContain('URL       http://192.168.1.50:3141');
    expect(masked).toContain('Username  mike');

    surface.onAction?.('toggleReveal', actionCtx(null));
    const revealedView = surface.buildView();
    const revealed = tabText(revealedView, 'pairing');
    expect(revealed).toContain('secret-token-abc123');
    expect(revealed).toContain('bootstrap-pass');
    expect(revealedView.tabs[0]!.hints).toContain('v hide token');

    surface.onAction?.('toggleReveal', actionCtx(null));
    expect(tabText(surface.buildView(), 'pairing')).not.toContain('secret-token-abc123');
  });

  test('renders a QR ascii block derived from the connection payload', () => {
    expect(/[▀▄█]/.test(tabText(open(createPairingModalSurface({ getConnectionInfo: () => FIXED_INFO })), 'pairing'))).toBe(true);
  });

  test('copy calls the injected clipboard callback and prints feedback (in-modal, non-destructive)', () => {
    let copied: string | null = null;
    const surface = createPairingModalSurface({ getConnectionInfo: () => FIXED_INFO, copyToClipboard: (t) => { copied = t; } });
    open(surface);
    const printed: string[] = [];
    surface.onAction?.('copyToken', actionCtx(null, { print: (m) => printed.push(m) }));
    expect(copied).toBe('secret-token-abc123');
    expect(printed).toEqual(['Token copied to clipboard.']);
  });

  test('regenerate is a confirmed action that routes to the /qrcode command path (never a modal-ized confirm)', () => {
    const surface = createPairingModalSurface({ getConnectionInfo: () => FIXED_INFO });
    open(surface);
    const cap = captureCommands();
    surface.onAction?.('regenerate', actionCtx(null, cap.extra));
    expect(cap.calls).toEqual([['qrcode', ['regenerate']]]);
    // Destructive: guarded by the host two-press confirm.
    expect((surface.actions ?? []).find((a) => a.id === 'regenerate')?.confirm).toBe(true);
  });

  // DEBT-3: once /qrcode regenerate resolves (it rotated the shared token store),
  // the modal RE-PULLS the lazy connection-info thunk so the new token + QR show
  // in place — no re-open needed.
  test('regenerate re-pulls the connection info after the command resolves', async () => {
    let token = 'token-v1';
    const surface = createPairingModalSurface({ getConnectionInfo: () => ({ ...FIXED_INFO, token }) });
    open(surface);
    surface.onAction?.('toggleReveal', actionCtx(null)); // reveal so the token value is readable
    expect(tabText(surface.buildView(), 'pairing')).toContain('token-v1');

    const calls: Array<[string, string[]]> = [];
    // The command rotates the store; the modal's re-pull reads the new value.
    const extra = { executeCommand: async (n: string, a: string[]) => { calls.push([n, a]); token = 'token-v2'; return true; } };
    surface.onAction?.('regenerate', actionCtx(null, extra));
    expect(calls).toEqual([['qrcode', ['regenerate']]]);

    await flush(); // let the .then() re-pull run
    // Re-pull re-masks the token; reveal again to read the rotated value.
    surface.onAction?.('toggleReveal', actionCtx(null));
    const text = tabText(surface.buildView(), 'pairing');
    expect(text).toContain('token-v2');
    expect(text).not.toContain('token-v1');
  });

  test('companions-connected count reads live from the control-plane read model', () => {
    const text = tabText(open(createPairingModalSurface({ getConnectionInfo: () => FIXED_INFO, controlPlaneReadModel: { getSnapshot: () => ({ activeClientIds: ['a', 'b'] }) } })), 'pairing');
    expect(text).toContain('Companions connected: 2');
  });

  test('degrades honestly when the connection info cannot be resolved', () => {
    const view = open(createPairingModalSurface({ getConnectionInfo: () => null }));
    expect(view.degraded).toContain('Companion pairing is unavailable');
  });
});
