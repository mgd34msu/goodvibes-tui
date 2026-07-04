import { describe, test, expect } from 'bun:test';
import {
  bindPairingModal,
  pairingModalGoldenSurface,
  type PairingModalConnectionInfo,
} from '../../../panels/modals/pairing-modal.ts';
import { EMPTY_VIEW } from '../../../panels/modals/modal-surface.ts';
import type { ModalConfig } from '../../../renderer/modal-factory.ts';

/** Flatten a ModalConfig's text/list/title content into one searchable string. */
function configText(config: ModalConfig): string {
  const parts: string[] = [config.title];
  if (config.search !== undefined) parts.push(config.search);
  for (const section of config.sections) {
    if (section.content) parts.push(section.content);
    for (const item of section.items ?? []) parts.push(item.label);
  }
  for (const hint of config.hints ?? []) parts.push(hint);
  if (config.footer) parts.push(config.footer);
  return parts.join('\n');
}

const FIXED_INFO: PairingModalConnectionInfo = {
  url: 'http://192.168.1.50:3141',
  token: 'secret-token-abc123',
  username: 'mike',
  password: 'bootstrap-pass',
  version: '1.2.0',
  surface: 'tui',
};

describe('pairing modal builder', () => {
  test('surface identity: name matches the qr-code -> pairing redirect target', () => {
    const surface = bindPairingModal({ connectionInfo: FIXED_INFO });
    expect(surface.name).toBe('pairing');
  });

  test('token and password are masked by default and reveal via the toggleReveal action', () => {
    const surface = bindPairingModal({ connectionInfo: FIXED_INFO });
    const masked = configText(surface.buildConfig(EMPTY_VIEW));
    expect(masked).not.toContain('secret-token-abc123');
    expect(masked).not.toContain('bootstrap-pass');
    expect(masked).toContain('URL       http://192.168.1.50:3141');
    expect(masked).toContain('Username  mike');
    expect(masked).toContain('v reveal token');

    surface.actions.toggleReveal!(EMPTY_VIEW);
    const revealed = configText(surface.buildConfig(EMPTY_VIEW));
    expect(revealed).toContain('secret-token-abc123');
    expect(revealed).toContain('bootstrap-pass');
    expect(revealed).toContain('v hide token');

    surface.actions.toggleReveal!(EMPTY_VIEW);
    expect(configText(surface.buildConfig(EMPTY_VIEW))).not.toContain('secret-token-abc123');
  });

  test('renders a QR ascii block derived from the connection payload', () => {
    const surface = bindPairingModal({ connectionInfo: FIXED_INFO });
    const text = configText(surface.buildConfig(EMPTY_VIEW));
    // Half-block QR glyphs from renderQrToString.
    expect(/[▀▄█]/.test(text)).toBe(true);
  });

  test('copy action calls the injected clipboard callback and prints feedback (kept in-modal, non-destructive)', () => {
    let copied: string | null = null;
    const surface = bindPairingModal({ connectionInfo: FIXED_INFO, copyToClipboard: (text) => { copied = text; } });
    const outcome = surface.actions.copyToken!(EMPTY_VIEW);
    expect(copied).toBe('secret-token-abc123');
    expect(outcome).toEqual({ kind: 'print', text: 'Token copied to clipboard.' });
  });

  test('copy action reports unavailability when no clipboard callback is wired', () => {
    const surface = bindPairingModal({ connectionInfo: FIXED_INFO });
    const outcome = surface.actions.copyToken!(EMPTY_VIEW);
    expect(outcome).toEqual({ kind: 'print', text: 'Clipboard not available.' });
  });

  test('regenerate is a destructive mutation and routes to the command path (never a modal-ized confirm)', () => {
    const surface = bindPairingModal({ connectionInfo: FIXED_INFO });
    const outcome = surface.actions.regenerate!(EMPTY_VIEW);
    expect(outcome).toEqual({ kind: 'runCommand', command: '/qrcode regenerate' });
  });

  test('companions-connected count reads live from the control-plane read model', () => {
    const surface = bindPairingModal({
      connectionInfo: FIXED_INFO,
      controlPlaneReadModel: { getSnapshot: () => ({ activeClientIds: ['a', 'b'] }) },
    });
    const text = configText(surface.buildConfig(EMPTY_VIEW));
    expect(text).toContain('Companions connected: 2');
  });

  test('golden surface renders deterministically across two independent builds', () => {
    const a = pairingModalGoldenSurface();
    const b = pairingModalGoldenSurface();
    expect(configText(a.buildConfig(EMPTY_VIEW))).toBe(configText(b.buildConfig(EMPTY_VIEW)));
  });
});
