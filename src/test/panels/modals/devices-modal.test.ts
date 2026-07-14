import { describe, test, expect } from 'bun:test';
import { ConfigModal } from '../../../input/config-modal.ts';
import { renderConfigModal } from '../../../renderer/config-modal.ts';
import { createDevicesModalSurface, devicesModalGoldenSurface } from '../../../panels/modals/devices-modal.ts';
import type { ConfigModalSurface } from '../../../input/config-modal-types.ts';
import type { MintedPairingToken, PublicPairingToken } from '@pellux/goodvibes-sdk/platform/pairing';
import { actionCtx, open, tabText } from './modal-surface-test-helpers.ts';

/** Render a surface to plain text rows at the given terminal size. */
function renderRows(surface: ConfigModalSurface, width: number, height: number): string[] {
  const modal = new ConfigModal();
  modal.open(surface, () => {});
  modal.syncStructure();
  const lines = renderConfigModal(modal, width, height);
  modal.close();
  return lines.map((line) => line.map((c) => (c.char === '' ? ' ' : c.char)).join('').replace(/\s+$/, ''));
}

describe('devices modal render (full text, no clipping)', () => {
  for (const [label, width, height] of [['80x24', 80, 24], ['60-col', 60, 24]] as const) {
    test(`renders the full device list and shared-token line at ${label}`, () => {
      const rows = renderRows(devicesModalGoldenSurface(), width, height);
      // Flow the wrapped rows back into contiguous text so a line that wraps at a
      // narrow width still reads as its full string (nothing is clipped, only wrapped).
      const flowed = rows.join(' ').replace(/[│┌┐└┘─▸]/g, ' ').replace(/\s+/g, ' ');
      expect(flowed).toContain('my laptop');
      expect(flowed).toContain('kitchen tablet');
      expect(flowed).toContain('phone (never scanned)');
      expect(flowed).toContain('last seen 3m ago');
      expect(flowed).toContain('last seen 5h ago');
      expect(flowed).toContain('last seen never');
      // The legacy-shared guidance renders in full.
      expect(flowed).toContain('Legacy shared token: active — migrate a device off it (m), then revoke it (s).');
      // No rendered line exceeds the terminal width (full text wraps, never clips).
      for (const row of rows) expect(row.length).toBeLessThanOrEqual(width);
    });
  }
});

// Deterministic action fixture with a live token store.
function liveSurface(): { surface: ConfigModalSurface; state: { tokens: PublicPairingToken[]; legacyRevoked: boolean; migrated: MintedPairingToken | null } } {
  const state = {
    tokens: [
      { id: 'aaaa1111', name: 'my laptop', createdAt: 0, lastSeenAt: 0 },
      { id: 'bbbb2222', name: 'tablet', createdAt: 0 },
    ] as PublicPairingToken[],
    legacyRevoked: false,
    migrated: null as MintedPairingToken | null,
  };
  const surface = createDevicesModalSurface({
    now: () => 0,
    pairingTokens: {
      list: () => state.tokens,
      rename: (id, name) => { state.tokens = state.tokens.map((t) => (t.id === id ? { ...t, name } : t)); return true; },
      revoke: (id) => { const had = state.tokens.some((t) => t.id === id); state.tokens = state.tokens.filter((t) => t.id !== id); return had; },
      mintForMigration: (input) => { const m = { id: 'm', name: input.name, token: 'secret', createdAt: 0 }; state.migrated = m; return m; },
      isLegacyRevoked: () => state.legacyRevoked,
      revokeLegacyShared: () => { state.legacyRevoked = true; },
    },
  });
  return { surface, state };
}

describe('devices modal actions', () => {
  test('revoke drops the selected device and the list reflects it live', () => {
    const { surface, state } = liveSurface();
    open(surface);
    const statuses: string[] = [];
    surface.onAction?.('revoke', actionCtx({ id: 'device:aaaa1111', label: 'x' }, { setStatus: (m: string) => statuses.push(m) }));
    expect(state.tokens.some((t) => t.id === 'aaaa1111')).toBe(false);
    expect(statuses.join(' ')).toContain('Revoked "my laptop"');
    expect(tabText(surface.buildView(), 'devices')).not.toContain('my laptop');
  });

  test('rename routes to the /devices command with the id pre-filled (no inline text capture)', () => {
    const { surface } = liveSurface();
    open(surface);
    const printed: string[] = [];
    surface.onAction?.('rename', actionCtx({ id: 'device:aaaa1111', label: 'x' }, { print: (m: string) => printed.push(m) }));
    expect(printed.join('\n')).toContain('/devices rename aaaa1111');
  });

  test('migrate off shared token mints a one-time token', () => {
    const { surface, state } = liveSurface();
    open(surface);
    const printed: string[] = [];
    surface.onAction?.('migrateShared', actionCtx(null, { print: (m: string) => printed.push(m) }));
    expect(state.migrated).not.toBeNull();
    expect(printed.join('\n')).toContain('secret');
  });

  test('revoke shared token flips the legacy line and disables the action', () => {
    const { surface, state } = liveSurface();
    open(surface);
    surface.onAction?.('revokeShared', actionCtx(null, {}));
    expect(state.legacyRevoked).toBe(true);
    expect(tabText(surface.buildView(), 'devices')).toContain('Legacy shared token: revoked');
    const revokeShared = (surface.actions ?? []).find((a) => a.id === 'revokeShared');
    expect(revokeShared?.enabledFor?.(null, 'devices')).toBe(false);
  });

  test('empty state is honest', () => {
    const surface = createDevicesModalSurface({
      pairingTokens: { list: () => [], rename: () => false, revoke: () => false, mintForMigration: () => ({ id: 'm', name: 'x', token: 't', createdAt: 0 }), isLegacyRevoked: () => false, revokeLegacyShared: () => {} },
    });
    expect(tabText(open(surface), 'devices')).toContain('No devices paired yet');
  });
});
