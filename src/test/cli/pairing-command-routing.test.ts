import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readOptionValue } from '../../cli/management-utils.ts';

/**
 * The `goodvibes pair` command must mint through the DAEMON verb caller. The
 * local `services.gatewayMethods` catalog is deliberately empty in this
 * surface (runtime/services.ts constructs it only because the SDK's external
 * bootstrap takes a daemon-grade graph), so invoking it answers
 * "Gateway method has no internal handler" for every verb. That is exactly
 * how `goodvibes pair` shipped broken.
 */
describe('pair command routes through the daemon', () => {
  const source = readFileSync(join(import.meta.dir, '../../cli/management-commands.ts'), 'utf-8');

  test('pairing.handoff.create goes through daemonVerbs, never the empty local catalog', () => {
    expect(source).toContain("daemonVerbs.invoke<PairingHandoffCreateResult>(\n      'pairing.handoff.create'");
    expect(source).not.toContain("gatewayMethods.invoke('pairing.handoff.create'");
  });

  test('no management command invokes the empty local catalog at all', () => {
    expect(source).not.toContain('gatewayMethods.invoke(');
  });
});

describe('readOptionValue takes the flag token verbatim', () => {
  test('the token includes its dashes, so lookups must too', () => {
    expect(readOptionValue(['--name', 'kitchen tablet'], '--name')).toBe('kitchen tablet');
    expect(readOptionValue(['--name=kitchen'], '--name')).toBe('kitchen');
    // The bare-word form silently never matches; `pair --name x` minted a
    // default-named token because of exactly this lookup.
    expect(readOptionValue(['--name', 'kitchen'], 'name')).toBeUndefined();
  });
});
