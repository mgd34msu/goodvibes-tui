import { describe, expect, test } from 'bun:test';
import {
  credentialReadModeFromHostMode,
  deriveCredentialAvailability,
  readClientCredentialStatus,
  type CredentialAvailability,
} from '../../config/credential-availability.ts';

// Prove the client-side credential-status read degrades HONESTLY and never
// fabricates a confident "configured" or leaks a secret value. Fully hermetic — no
// daemon, no ports, no network. The transport error shapes below mirror the real
// HttpStatusError the daemon wire produces (top-level `.code` sourced from the
// daemon response body: CREDENTIAL_STORE_UNAVAILABLE / METHOD_NOT_FOUND), so these
// cases exercise the exact classification the live client path would hit.

// Impossible-value sentinel: no real credential key would ever be named this, so a
// test asserting its ABSENCE can never be defeated by a legitimate future key.
const IMPOSSIBLE_SECRET_VALUE = '__never-a-real-secret-value-9f3c__';

function reasonOf(availability: CredentialAvailability): string {
  if (availability.available) throw new Error('expected unavailable');
  return availability.reason;
}

describe('deriveCredentialAvailability — honest degrade (W6-C1)', () => {
  test('503 CREDENTIAL_STORE_UNAVAILABLE (by machine code) -> unavailable with reason', () => {
    const out = deriveCredentialAvailability({
      ok: false,
      error: { code: 'CREDENTIAL_STORE_UNAVAILABLE', status: 503, message: 'Shared credential store unavailable' },
    });
    expect(out.available).toBe(false);
    expect(reasonOf(out)).toBe('The daemon has no shared credential store wired.');
  });

  test('METHOD_NOT_FOUND from an older daemon -> unavailable with reason', () => {
    const out = deriveCredentialAvailability({ ok: false, error: { code: 'METHOD_NOT_FOUND', status: 404 } });
    expect(out.available).toBe(false);
    expect(reasonOf(out)).toBe('This daemon does not serve credential status yet.');
  });

  test('NOT_INVOKABLE (uncataloged) -> unavailable with reason', () => {
    const out = deriveCredentialAvailability({ ok: false, error: { code: 'NOT_INVOKABLE' } });
    expect(out.available).toBe(false);
    expect(reasonOf(out)).toBe('This daemon does not serve credential status yet.');
  });

  test('plain transport failure (no code) -> generic unavailable reason, NEVER fabricated configured', () => {
    const out = deriveCredentialAvailability({ ok: false, error: new Error('fetch failed') });
    expect(out.available).toBe(false);
    expect(reasonOf(out)).toBe('Credential status unavailable right now.');
  });

  test('malformed success (no credentials array) -> unavailable, not fabricated as configured', () => {
    const out = deriveCredentialAvailability({ ok: true, value: { credentials: 'nope' } });
    expect(out.available).toBe(false);
    expect(reasonOf(out)).toBe('Credential status unavailable right now.');
  });

  test('happy path -> carries ONLY status metadata (key/configured/usable/source/secure), never bytes', () => {
    const out = deriveCredentialAvailability({
      ok: true,
      value: {
        available: true,
        credentials: [
          // A daemon body could carry extra fields (including, hypothetically, a value);
          // the deriver must copy the status surface ONLY and drop everything else.
          { key: 'ANTHROPIC_API_KEY', configured: true, usable: true, source: 'env', secure: false, value: IMPOSSIBLE_SECRET_VALUE, token: IMPOSSIBLE_SECRET_VALUE },
          { key: 'SLACK_BOT_TOKEN', configured: true, usable: false, source: 'secrets.enc', secure: true },
          { configured: true }, // no key -> skipped
        ],
      },
    });
    expect(out.available).toBe(true);
    if (!out.available) throw new Error('unreachable');
    expect(out.credentials).toHaveLength(2);
    const [first, second] = out.credentials;
    expect(first).toEqual({ key: 'ANTHROPIC_API_KEY', configured: true, usable: true, source: 'env', secure: false });
    expect(second).toEqual({ key: 'SLACK_BOT_TOKEN', configured: true, usable: false, source: 'secrets.enc', secure: true });
    // No secret value survives the fold on any path.
    expect(JSON.stringify(out)).not.toContain(IMPOSSIBLE_SECRET_VALUE);
    expect(Object.keys(first as Record<string, unknown>)).not.toContain('value');
    expect(Object.keys(first as Record<string, unknown>)).not.toContain('token');
  });

  test('usable defaults false and secure stays undefined when absent (no confident fabrication)', () => {
    const out = deriveCredentialAvailability({ ok: true, value: { credentials: [{ key: 'K', configured: true }] } });
    expect(out.available).toBe(true);
    if (!out.available) throw new Error('unreachable');
    expect(out.credentials[0]).toEqual({ key: 'K', configured: true, usable: false });
  });
});

describe('credentialReadModeFromHostMode — only external is a client read', () => {
  test("'external' -> client", () => {
    expect(credentialReadModeFromHostMode('external')).toBe('client');
  });

  test.each(['embedded', 'disabled', 'blocked', 'incompatible', 'unavailable', 'anything-else'])(
    "'%s' -> host (read own store, never over the wire)",
    (mode) => {
      expect(credentialReadModeFromHostMode(mode)).toBe('host');
    },
  );
});

describe('readClientCredentialStatus — wraps a live credentials.get invoke', () => {
  test('resolves to available on a well-formed snapshot', async () => {
    const out = await readClientCredentialStatus(async () => ({
      available: true,
      credentials: [{ key: 'K', configured: true, usable: true }],
    }));
    expect(out.available).toBe(true);
  });

  test('a thrown 503 CREDENTIAL_STORE_UNAVAILABLE is folded to honest unavailable', async () => {
    const out = await readClientCredentialStatus(async () => {
      throw Object.assign(new Error('Shared credential store unavailable'), { code: 'CREDENTIAL_STORE_UNAVAILABLE', status: 503 });
    });
    expect(out.available).toBe(false);
    expect(reasonOf(out)).toBe('The daemon has no shared credential store wired.');
  });

  test('a thrown METHOD_NOT_FOUND is folded to honest unavailable', async () => {
    const out = await readClientCredentialStatus(async () => {
      throw Object.assign(new Error('Unknown gateway method: credentials.get'), { code: 'METHOD_NOT_FOUND', status: 404 });
    });
    expect(out.available).toBe(false);
    expect(reasonOf(out)).toBe('This daemon does not serve credential status yet.');
  });

  test('a bare transport failure is folded to honest unavailable, never fabricated configured', async () => {
    const out = await readClientCredentialStatus(async () => {
      throw new Error('ECONNREFUSED');
    });
    expect(out.available).toBe(false);
    expect(reasonOf(out)).toBe('Credential status unavailable right now.');
  });
});
