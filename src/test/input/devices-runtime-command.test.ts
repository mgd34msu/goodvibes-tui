import { describe, expect, test } from 'bun:test';
import { CommandRegistry, type CommandContext } from '../../input/command-registry.ts';
import { registerDevicesRuntimeCommands } from '../../input/commands/devices-runtime.ts';
import type { MintedPairingToken, PublicPairingToken } from '@pellux/goodvibes-sdk/platform/pairing';

function fakePairingTokens(initial: PublicPairingToken[] = []) {
  let tokens = [...initial];
  let legacyRevoked = false;
  return {
    _tokens: () => tokens,
    list: () => tokens,
    rename: (id: string, name: string) => {
      const t = tokens.find((x) => x.id === id);
      if (!t) return false;
      tokens = tokens.map((x) => (x.id === id ? { ...x, name } : x));
      return true;
    },
    revoke: (id: string) => {
      const had = tokens.some((x) => x.id === id);
      tokens = tokens.filter((x) => x.id !== id);
      return had;
    },
    mint: (input: { name: string }): MintedPairingToken => ({ id: 'm', name: input.name, token: 'mint', createdAt: 0 }),
    mintForMigration: (input: { name: string }): MintedPairingToken => ({ id: 'mig', name: input.name, token: 'migrated-secret', createdAt: 0 }),
    authenticate: () => null,
    isLegacyRevoked: () => legacyRevoked,
    revokeLegacyShared: () => { legacyRevoked = true; },
  };
}

function ctx(pairingTokens: unknown, out: string[]): CommandContext {
  return { print: (m: string) => out.push(m), platform: { pairingTokens } } as unknown as CommandContext;
}

async function run(pairingTokens: unknown, args: string[]): Promise<string> {
  const registry = new CommandRegistry();
  registerDevicesRuntimeCommands(registry);
  const out: string[] = [];
  await registry.execute('devices', args, ctx(pairingTokens, out));
  return out.join('\n');
}

const SAMPLE: PublicPairingToken[] = [
  { id: 'aaaa1111bbbb', name: 'my laptop', createdAt: Date.UTC(2026, 6, 10), lastSeenAt: Date.UTC(2026, 6, 13) },
  { id: 'cccc3333dddd', name: 'kitchen tablet', createdAt: Date.UTC(2026, 6, 1) },
];

describe('/devices command', () => {
  test('list shows each device and the legacy-shared status', async () => {
    const text = await run(fakePairingTokens(SAMPLE), []);
    expect(text).toContain('my laptop');
    expect(text).toContain('kitchen tablet');
    expect(text).toContain('Legacy shared token: active');
  });

  test('empty list is honest', async () => {
    const text = await run(fakePairingTokens([]), ['list']);
    expect(text).toContain('(none yet');
  });

  test('rename by unambiguous prefix updates the name', async () => {
    const tokens = fakePairingTokens(SAMPLE);
    const text = await run(tokens, ['rename', 'aaaa', 'work', 'mac']);
    expect(text).toContain('Renamed device to "work mac"');
    expect(tokens._tokens().find((t) => t.id === 'aaaa1111bbbb')!.name).toBe('work mac');
  });

  test('revoke removes the token', async () => {
    const tokens = fakePairingTokens(SAMPLE);
    const text = await run(tokens, ['revoke', 'cccc']);
    expect(text).toContain('Revoked "kitchen tablet"');
    expect(tokens._tokens().some((t) => t.id === 'cccc3333dddd')).toBe(false);
  });

  test('revoke reports an unknown id honestly', async () => {
    const text = await run(fakePairingTokens(SAMPLE), ['revoke', 'zzz']);
    expect(text).toContain('No device matches');
  });

  test('migrate-shared mints a per-device token shown once', async () => {
    const text = await run(fakePairingTokens(SAMPLE), ['migrate-shared', 'new phone']);
    expect(text).toContain('migrated-secret');
    expect(text).toContain('new phone');
  });

  test('revoke-shared retires the legacy token', async () => {
    const tokens = fakePairingTokens(SAMPLE);
    const text = await run(tokens, ['revoke-shared']);
    expect(text).toContain('Revoked the legacy shared token');
    expect(tokens.isLegacyRevoked()).toBe(true);
    const again = await run(tokens, ['revoke-shared']);
    expect(again).toContain('already revoked');
  });

  test('degrades honestly when no pairing service is wired', async () => {
    const text = await run(undefined, ['list']);
    expect(text).toContain('Device management is unavailable');
  });
});
