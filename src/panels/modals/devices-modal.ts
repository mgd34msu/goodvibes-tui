import { MODAL_TONES } from './modal-theme.ts';
import { infoRow } from './modal-surface-helpers.ts';
import type {
  ConfigModalActionContext,
  ConfigModalRow,
  ConfigModalSurface,
  ConfigModalView,
} from '../../input/config-modal-types.ts';
import type { MintedPairingToken, PublicPairingToken } from '@pellux/goodvibes-sdk/platform/pairing';
import { formatDeviceLine, shortTokenId } from '../../cli/pairing-devices.ts';

// ---------------------------------------------------------------------------
// Paired Devices — the settings security-domain device/token management surface.
// Lists every per-device pairing token (name · created · last-seen · id) and
// mirrors the pairing.tokens.* gateway verbs: revoke a device, migrate off the
// legacy shared token, revoke the shared token. Rename needs a name, which the
// stable-layout modal cannot capture inline, so it routes to the /devices rename
// command with the row's id pre-filled in the guidance. buildView reads list()
// fresh every render, so a revoke/migrate reflects immediately.
// ---------------------------------------------------------------------------

/** The token-store capability this surface needs — satisfied by PairingTokenManager. */
export interface DevicesModalPairingTokens {
  list(): PublicPairingToken[];
  rename(id: string, name: string): boolean;
  revoke(id: string): boolean;
  mintForMigration(input: { readonly name: string }): MintedPairingToken;
  isLegacyRevoked(): boolean;
  revokeLegacyShared(): void;
}

export interface DevicesModalDeps {
  readonly pairingTokens: DevicesModalPairingTokens;
  /** Injectable clock so last-seen formatting is deterministic in tests. */
  readonly now?: () => number;
  readonly copyToClipboard?: (text: string) => void;
}

const DEVICE_ROW_PREFIX = 'device:';

function deviceIdOf(row: ConfigModalRow | null): string | null {
  return row && row.id.startsWith(DEVICE_ROW_PREFIX) ? row.id.slice(DEVICE_ROW_PREFIX.length) : null;
}

class DevicesModalSurface implements ConfigModalSurface {
  readonly name = 'devices-modal';
  readonly title = 'Paired Devices';
  private requestRender: () => void = () => {};

  constructor(private readonly deps: DevicesModalDeps) {}

  readonly actions = [
    { key: 'r', id: 'rename', label: 'rename', enabledFor: (row: ConfigModalRow | null) => deviceIdOf(row) !== null },
    { key: 'x', id: 'revoke', label: 'revoke', confirm: true, enabledFor: (row: ConfigModalRow | null) => deviceIdOf(row) !== null },
    { key: 'm', id: 'migrateShared', label: 'migrate off shared token' },
    { key: 's', id: 'revokeShared', label: 'revoke shared token', confirm: true, enabledFor: () => !this.deps.pairingTokens.isLegacyRevoked() },
  ];

  onOpen(requestRender: () => void): void { this.requestRender = requestRender; }

  buildView(): ConfigModalView {
    const now = this.deps.now?.() ?? Date.now();
    const tokens = this.deps.pairingTokens.list();
    const rows: ConfigModalRow[] = [];
    rows.push(infoRow('intro', 'Devices paired to this daemon. Each has its own token — revoke one without affecting the others.', { dim: true }));

    if (tokens.length === 0) {
      rows.push(infoRow('empty', 'No devices paired yet — run /pair (or open the pairing QR) to add one.'));
    } else {
      for (const token of tokens) {
        rows.push({ id: `${DEVICE_ROW_PREFIX}${token.id}`, label: formatDeviceLine(token, now) });
      }
    }

    const legacyRevoked = this.deps.pairingTokens.isLegacyRevoked();
    rows.push(infoRow(
      'legacy',
      legacyRevoked
        ? 'Legacy shared token: revoked.'
        : 'Legacy shared token: active — migrate a device off it (m), then revoke it (s).',
      legacyRevoked ? { dim: true } : { fg: MODAL_TONES.reasoning },
    ));

    return {
      title: 'Paired Devices',
      tabs: [{ id: 'devices', label: 'Devices', rows, hints: ['r rename', 'x revoke', 'm migrate off shared', 's revoke shared'] }],
    };
  }

  onAction(id: string, ctx: ConfigModalActionContext): void {
    const tokens = this.deps.pairingTokens;

    if (id === 'rename') {
      const deviceId = deviceIdOf(ctx.row);
      if (!deviceId) { ctx.setStatus('Select a device row first.'); return; }
      // The stable-layout modal cannot capture a name inline — route to the
      // command with the id pre-filled so the user only types the new name.
      ctx.print(`To rename this device, run:  /devices rename ${shortTokenId(deviceId)} <new name>`);
      return;
    }

    if (id === 'revoke') {
      const deviceId = deviceIdOf(ctx.row);
      if (!deviceId) { ctx.setStatus('Select a device row first.'); return; }
      const record = tokens.list().find((t) => t.id === deviceId);
      const revoked = tokens.revoke(deviceId);
      ctx.setStatus(revoked ? `Revoked "${record?.name ?? shortTokenId(deviceId)}" — its token stops working now.` : 'That device was already absent.');
      this.requestRender();
      return;
    }

    if (id === 'migrateShared') {
      const minted = tokens.mintForMigration({ name: 'migrated device' });
      if (this.deps.copyToClipboard) {
        this.deps.copyToClipboard(minted.token);
        ctx.print(`Minted "${minted.name}" and copied its one-time token to the clipboard. Pair the device, then revoke the shared token (s).`);
      } else {
        ctx.print(`Minted "${minted.name}" (one-time token): ${minted.token}\nPair the device with it, then revoke the shared token (s).`);
      }
      this.requestRender();
      return;
    }

    if (id === 'revokeShared') {
      if (tokens.isLegacyRevoked()) { ctx.setStatus('The legacy shared token is already revoked.'); return; }
      tokens.revokeLegacyShared();
      ctx.setStatus('Revoked the legacy shared token — devices on it must re-pair with their own token.');
      this.requestRender();
      return;
    }
  }
}

export function createDevicesModalSurface(deps: DevicesModalDeps): ConfigModalSurface {
  return new DevicesModalSurface(deps);
}

/**
 * Deterministic golden/render fixture: frozen token list + clock so last-seen
 * formatting is stable.
 */
export function devicesModalGoldenSurface(): ConfigModalSurface {
  const now = Date.UTC(2026, 6, 13, 12, 0, 0);
  const tokens: PublicPairingToken[] = [
    { id: 'aaaa1111bbbb2222', name: 'my laptop', createdAt: Date.UTC(2026, 6, 10, 9, 0, 0), lastSeenAt: now - 3 * 60_000 },
    { id: 'cccc3333dddd4444', name: 'kitchen tablet', createdAt: Date.UTC(2026, 6, 1, 9, 0, 0), lastSeenAt: now - 5 * 60 * 60_000 },
    { id: 'eeee5555ffff6666', name: 'phone (never scanned)', createdAt: Date.UTC(2026, 6, 13, 8, 0, 0) },
  ];
  let legacyRevoked = false;
  return createDevicesModalSurface({
    now: () => now,
    pairingTokens: {
      list: () => tokens,
      rename: () => true,
      revoke: () => true,
      mintForMigration: () => ({ id: 'new', name: 'migrated device', token: 'tok', createdAt: now }),
      isLegacyRevoked: () => legacyRevoked,
      revokeLegacyShared: () => { legacyRevoked = true; },
    },
  });
}
