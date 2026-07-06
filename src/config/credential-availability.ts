/**
 * credential-availability.ts — client-side credential-status read.
 *
 * When the TUI acts as a CLIENT of an adopted external daemon (the host-service
 * `mode === 'external'` topology — see runtime/bootstrap.ts), provider/model/secret
 * STATUS is read from that daemon's `credentials.get` wire method rather than from
 * the TUI's own surfaceRoot ('tui') store. This module folds a `credentials.get`
 * outcome into an honest availability value, mirroring the goodvibes-webui v1.0.1
 * `deriveCredentialAvailability` contract exactly:
 *
 *   - a 503 CREDENTIAL_STORE_UNAVAILABLE (matched by machine code), a METHOD_NOT_FOUND
 *     from an older daemon, or ANY transport failure  ->  { available: false, reason }
 *     — an honest, reason-carrying "unavailable" state.
 *   - NEVER a fabricated "configured"; NEVER a secret byte. Only the boolean status
 *     metadata surface (key / configured / usable / source / secure) is carried.
 *
 * STATUS ONLY moves to the daemon path. Secret RESOLUTION — the value-reads provider
 * auth needs, plus the env-only API-key posture — stays local and is untouched by
 * this module. The daemon's `credentials.get` never returns raw key bytes over the
 * wire (see the SDK decision record 2026-07-06-config-sharing-shared-tier-and-secret-read),
 * so no plaintext can reach a caller through this path by construction.
 */

/** One credential's status metadata from the daemon's shared store — never bytes. */
export interface CredentialStatusEntry {
  readonly key: string;
  readonly configured: boolean;
  readonly usable: boolean;
  readonly source?: string;
  readonly secure?: boolean;
}

/** Honest availability: either a status list, or a reason we could not read it. */
export type CredentialAvailability =
  | { readonly available: true; readonly credentials: readonly CredentialStatusEntry[] }
  | { readonly available: false; readonly reason: string };

/** A `credentials.get` invocation outcome — success value OR a thrown error. */
export type CredentialStatusOutcome =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error: unknown };

/** Credential-read posture: read the daemon's shared store, or the local own store. */
export type CredentialReadMode = 'host' | 'client';

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function readString(record: Record<string, unknown> | null, key: string): string {
  if (!record) return '';
  const value = record[key];
  return typeof value === 'string' ? value : '';
}

/**
 * Map the authoritative host-service mode string to the credential-read posture.
 * Only 'external' (a separately-running daemon this TUI adopted) reads credential
 * STATUS over the wire; every other mode ('embedded'/'disabled'/'blocked'/
 * 'incompatible'/'unavailable') is the local host reading its own store.
 */
export function credentialReadModeFromHostMode(hostMode: string): CredentialReadMode {
  return hostMode === 'external' ? 'client' : 'host';
}

/**
 * Fold a `credentials.get` outcome into an honest availability value. Mirrors
 * goodvibes-webui v1.0.1 `deriveCredentialAvailability`: any failure becomes a
 * reason-carrying `available: false`; a malformed success (no credentials array)
 * is treated as unavailable rather than fabricated as configured; on success only
 * the boolean status surface is carried, never a secret value.
 */
export function deriveCredentialAvailability(outcome: CredentialStatusOutcome): CredentialAvailability {
  if (!outcome.ok) {
    const err = asRecord(outcome.error);
    const code = readString(err, 'code');
    if (code === 'CREDENTIAL_STORE_UNAVAILABLE') {
      return { available: false, reason: 'The daemon has no shared credential store wired.' };
    }
    if (code === 'METHOD_NOT_FOUND' || code === 'NOT_INVOKABLE') {
      return { available: false, reason: 'This daemon does not serve credential status yet.' };
    }
    return { available: false, reason: 'Credential status unavailable right now.' };
  }
  const value = asRecord(outcome.value);
  const raw = value?.credentials;
  if (!Array.isArray(raw)) return { available: false, reason: 'Credential status unavailable right now.' };
  const credentials: CredentialStatusEntry[] = [];
  for (const item of raw) {
    const rec = asRecord(item);
    const key = readString(rec, 'key');
    if (!rec || !key) continue;
    credentials.push({
      key,
      configured: rec.configured === true,
      usable: rec.usable === true,
      source: readString(rec, 'source') || undefined,
      secure: rec.secure === true ? true : rec.secure === false ? false : undefined,
    });
  }
  return { available: true, credentials };
}

/**
 * Client-side credential-status read. Invokes the adopted external daemon's
 * `credentials.get` and folds success OR any thrown transport/daemon error into an
 * honest availability. The daemon's `credentials.get` transport error carries the
 * machine `code` at the top level (e.g. an HttpStatusError whose body supplied
 * `CREDENTIAL_STORE_UNAVAILABLE` / `METHOD_NOT_FOUND`), which `deriveCredentialAvailability`
 * classifies. Only the boolean status surface is returned; a raw secret value can
 * never reach a caller through this path.
 */
export async function readClientCredentialStatus(
  invokeCredentialsGet: () => Promise<unknown>,
): Promise<CredentialAvailability> {
  try {
    const value = await invokeCredentialsGet();
    return deriveCredentialAvailability({ ok: true, value });
  } catch (error) {
    return deriveCredentialAvailability({ ok: false, error });
  }
}
