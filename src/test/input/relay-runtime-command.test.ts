import { describe, expect, test } from 'bun:test';
import { CommandRegistry, type CommandContext } from '../../input/command-registry.ts';
import { registerRelayRuntimeCommands } from '../../input/commands/relay-runtime.ts';

const RELAY_CONFIG: Record<string, unknown> = {
  'relay.enabled': true,
  'relay.url': 'wss://relay.example.com',
  'relay.rendezvousId': 'abc123',
  'relay.label': 'my-daemon',
};

function ctx(options: {
  readonly out: string[];
  readonly configOverrides?: Record<string, unknown>;
  readonly flagOn?: boolean;
  readonly externalServices?: {
    relayStatus(): string;
    mintRelayPairing(): Promise<{ readonly payload: unknown; readonly encoded: string } | null>;
  };
}): CommandContext {
  const config = { ...RELAY_CONFIG, ...options.configOverrides };
  return {
    print: (m: string) => options.out.push(m),
    platform: {
      configManager: { get: (key: string) => config[key] },
      featureFlagManager: { isEnabled: () => options.flagOn ?? true },
      externalServices: options.externalServices,
    },
  } as unknown as CommandContext;
}

describe('/relay command', () => {
  test('status reports disabled when relay.enabled is off', async () => {
    const registry = new CommandRegistry();
    registerRelayRuntimeCommands(registry);
    const out: string[] = [];
    await registry.execute('relay', ['status'], ctx({ out, configOverrides: { 'relay.enabled': false } }));
    expect(out.join('\n')).toContain('Relay: disabled');
  });

  test('status reports disabled when the relay-connect flag is off, even if relay.enabled is on', async () => {
    const registry = new CommandRegistry();
    registerRelayRuntimeCommands(registry);
    const out: string[] = [];
    await registry.execute('relay', ['status'], ctx({ out, flagOn: false }));
    expect(out.join('\n')).toContain('Relay: disabled');
  });

  test('status reports the live registration state and rendezvous id when configured + flagged on', async () => {
    const registry = new CommandRegistry();
    registerRelayRuntimeCommands(registry);
    const out: string[] = [];
    await registry.execute('relay', [], ctx({
      out,
      externalServices: { relayStatus: () => 'registered', mintRelayPairing: async () => null },
    }));
    const text = out.join('\n');
    expect(text).toContain('Relay: registered');
    expect(text).toContain('abc123');
    expect(text).toContain('ciphertext and connection metadata');
  });

  test('status maps a non-registered live state to offline', async () => {
    const registry = new CommandRegistry();
    registerRelayRuntimeCommands(registry);
    const out: string[] = [];
    await registry.execute('relay', ['status'], ctx({
      out,
      externalServices: { relayStatus: () => 'reconnecting', mintRelayPairing: async () => null },
    }));
    expect(out.join('\n')).toContain('Relay: offline');
  });

  test('pair prints the encoded payload and a QR block when minting succeeds', async () => {
    const registry = new CommandRegistry();
    registerRelayRuntimeCommands(registry);
    const out: string[] = [];
    await registry.execute('relay', ['pair'], ctx({
      out,
      externalServices: {
        relayStatus: () => 'registered',
        mintRelayPairing: async () => ({ payload: {}, encoded: 'gv-relay:abc.def' }),
      },
    }));
    expect(out.join('\n')).toContain('gv-relay:abc.def');
  });

  test('pair refuses when relay is disabled', async () => {
    const registry = new CommandRegistry();
    registerRelayRuntimeCommands(registry);
    const out: string[] = [];
    await registry.execute('relay', ['pair'], ctx({ out, configOverrides: { 'relay.enabled': false } }));
    expect(out.join('\n')).toContain('Relay is disabled');
  });
});
