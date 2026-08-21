import { describe, test, expect } from 'bun:test';
import {
  mintPairingHandoff,
  availablePairingOffers,
  defaultPairingTokenName,
  pairingQrContent,
  type PairingTokenMinter,
} from '@pellux/goodvibes-sdk/platform/pairing';
import { formatPairingOffers, formatPostureCapabilities, pairingPostureNotice } from '@pellux/goodvibes-sdk/platform/pairing';
import { LAN_PLAIN_HTTP_NOTICE, parsePairingHandoffLink } from '@pellux/goodvibes-sdk/platform/pairing';

function fakeMinter(): PairingTokenMinter & { minted: string[] } {
  const minted: string[] = [];
  let n = 0;
  return {
    minted,
    mint(input) {
      n += 1;
      minted.push(input.name);
      return { id: `id-${n}`, name: input.name, token: `tok-${n}`, createdAt: n };
    },
  };
}

describe('mintPairingHandoff', () => {
  test('mints a named token and builds a full deep link the SDK can parse back', () => {
    const minter = fakeMinter();
    const handoff = mintPairingHandoff({
      pairingTokens: minter,
      name: 'my phone',
      offers: ['notifications', 'relay'],
      webOrigin: 'https://app.example',
    });
    expect(minter.minted).toEqual(['my phone']);
    expect(handoff.token.name).toBe('my phone');
    expect(handoff.deepLink).toBe(pairingQrContent(handoff));
    const parsed = parsePairingHandoffLink(handoff.deepLink!);
    expect(parsed).not.toBeNull();
    expect(parsed!.token).toBe('tok-1');
    expect(parsed!.offers).toEqual(['notifications', 'relay']);
    // The QR content is a deep link, never a raw JSON blob.
    expect(handoff.deepLink!.startsWith('https://app.example')).toBe(true);
    expect(handoff.deepLink).not.toContain('{');
    // A secure-context origin carries a posture with NO LAN notice (never a nag)
    // and every browser capability available.
    expect(handoff.posture?.secureContext).toBe(true);
    expect(handoff.posture?.notice).toBeUndefined();
    expect(handoff.posture?.capabilities.every((c) => c.available)).toBe(true);
  });

  test('a plain-http LAN origin carries the SDK LAN notice verbatim and gated capabilities', () => {
    const handoff = mintPairingHandoff({
      pairingTokens: fakeMinter(),
      name: 'workshop',
      offers: ['notifications'],
      webOrigin: 'http://workshop.local:3141',
    });
    expect(handoff.posture?.secureContext).toBe(false);
    // The one honest line is the SDK export, byte-for-byte, never a local rewording.
    expect(pairingPostureNotice(handoff.posture)).toBe(LAN_PLAIN_HTTP_NOTICE);
    const caps = formatPostureCapabilities(handoff.posture);
    expect(caps.length).toBe(3);
    expect(caps.every((line) => line.includes('needs https'))).toBe(true);
  });

  test('no web origin means no posture (fragment-only handoff)', () => {
    const handoff = mintPairingHandoff({ pairingTokens: fakeMinter(), name: 'x', offers: [] });
    expect(handoff.posture).toBeUndefined();
    expect(pairingPostureNotice(handoff.posture)).toBeNull();
    expect(formatPostureCapabilities(handoff.posture)).toEqual([]);
  });

  test('without a web origin, falls back to the fragment and QR encodes it', () => {
    const handoff = mintPairingHandoff({ pairingTokens: fakeMinter(), name: 'x', offers: ['notifications'] });
    expect(handoff.deepLink).toBeUndefined();
    expect(handoff.fragment.startsWith('#pair=')).toBe(true);
    expect(pairingQrContent(handoff)).toBe(handoff.fragment);
  });

  test('each call mints its own token (per-device model)', () => {
    const minter = fakeMinter();
    const a = mintPairingHandoff({ pairingTokens: minter, name: 'a', offers: [] });
    const b = mintPairingHandoff({ pairingTokens: minter, name: 'b', offers: [] });
    expect(a.token.token).not.toBe(b.token.token);
  });
});

describe('availablePairingOffers', () => {
  test('notifications always; relay + passkey gated, in canonical order', () => {
    expect(availablePairingOffers({ relayEnabled: false, stepUpAvailable: false })).toEqual(['notifications']);
    expect(availablePairingOffers({ relayEnabled: true, stepUpAvailable: false })).toEqual(['notifications', 'relay']);
    expect(availablePairingOffers({ relayEnabled: true, stepUpAvailable: true })).toEqual(['notifications', 'relay', 'passkey']);
    expect(availablePairingOffers({ relayEnabled: false, stepUpAvailable: true })).toEqual(['notifications', 'passkey']);
  });
});

describe('defaultPairingTokenName', () => {
  test('date-stamped, human-distinguishable', () => {
    expect(defaultPairingTokenName(new Date('2026-07-13T09:41:00Z'))).toBe('paired device (2026-07-13 09:41)');
  });
});

describe('formatPairingOffers copy', () => {
  test('each offer renders label, consequence', () => {
    const lines = formatPairingOffers(['notifications', 'passkey']);
    expect(lines[0]).toContain('Notifications,');
    expect(lines[1]).toContain('Passkey,');
  });
  test('the one honest LAN line is the SDK export, a single line', () => {
    expect(LAN_PLAIN_HTTP_NOTICE.split('\n')).toHaveLength(1);
    expect(LAN_PLAIN_HTTP_NOTICE).toContain('unencrypted on your LAN');
  });
  test('capability labels are plain-language, no jargon', () => {
    const posture = { origin: 'http://box.local', scheme: 'http' as const, privateNetwork: true, secureContext: false, notice: LAN_PLAIN_HTTP_NOTICE, capabilities: [{ capability: 'push' as const, available: false, reason: 'needs https — available via tailscale' }] };
    const lines = formatPostureCapabilities(posture);
    expect(lines[0]).toBe('  Push notifications, needs https — available via tailscale');
  });
});
