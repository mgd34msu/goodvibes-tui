/**
 * pairing-devices.ts — shared rendering for the paired-device list.
 *
 * Both the /devices command family and the settings device-management modal
 * render each per-device token the same way (name · created · last-seen · id),
 * so the two surfaces never drift. Pure over its inputs and a `now` clock, so
 * the formatting is testable without real time.
 */
import type { PublicPairingToken } from '@pellux/goodvibes-sdk/platform/pairing';

/** A short, human-quotable id prefix used to target rename/revoke. */
export function shortTokenId(id: string): string {
  return id.slice(0, 8);
}

/** Relative last-seen, or "never" when the device has not authenticated yet. */
export function formatLastSeen(ms: number | undefined, now: number = Date.now()): string {
  if (ms === undefined) return 'never';
  const delta = Math.max(0, now - ms);
  if (delta < 60_000) return 'just now';
  const mins = Math.floor(delta / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/** Creation date as YYYY-MM-DD. */
export function formatCreated(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** One device line: name · created · last-seen · short id. */
export function formatDeviceLine(token: PublicPairingToken, now: number = Date.now()): string {
  return `${token.name}  ·  created ${formatCreated(token.createdAt)}  ·  last seen ${formatLastSeen(token.lastSeenAt, now)}  ·  ${shortTokenId(token.id)}`;
}

/** Resolve a token by exact id or unambiguous id-prefix; returns a resolution result. */
export function resolveTokenByIdPrefix(
  tokens: readonly PublicPairingToken[],
  idOrPrefix: string,
): { readonly ok: true; readonly token: PublicPairingToken } | { readonly ok: false; readonly reason: 'not-found' | 'ambiguous' } {
  const exact = tokens.find((t) => t.id === idOrPrefix);
  if (exact) return { ok: true, token: exact };
  const matches = tokens.filter((t) => t.id.startsWith(idOrPrefix));
  if (matches.length === 1) return { ok: true, token: matches[0]! };
  if (matches.length === 0) return { ok: false, reason: 'not-found' };
  return { ok: false, reason: 'ambiguous' };
}
