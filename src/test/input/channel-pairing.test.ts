import { describe, it, expect } from 'bun:test';
import { getBuiltinSetupSchema } from '@pellux/goodvibes-sdk/platform/channels';
import type { ConfigManager } from '../../config/index.ts';
import type { CommandContext } from '../../input/command-registry.ts';
import { runChannelPairing } from '../../input/commands/channel-pairing.ts';

const PAIRABLE_SURFACES = [
  'slack', 'discord', 'ntfy', 'webhook', 'homeassistant', 'telegram',
  'google-chat', 'signal', 'whatsapp', 'telephony', 'imessage', 'msteams',
  'bluebubbles', 'mattermost', 'matrix',
] as const;

function makeCtx() {
  const store = new Map<string, unknown>();
  const printed: string[] = [];
  const configManager = {
    get: (k: string) => store.get(k),
    setDynamic: (k: string, v: unknown) => store.set(k, v),
  } as unknown as ConfigManager;
  const ctx = {
    platform: { configManager, secretsManager: undefined },
    print: (t: string) => printed.push(t),
    renderRequest: () => {},
    // Concealed input intentionally absent to keep the test non-interactive.
    beginConcealedInput: undefined,
  } as unknown as CommandContext;
  return { ctx, store, printed, text: () => printed.join('\n') };
}

describe('/channel pair', () => {
  it('lists adapters from the SDK setup schema (not a hand-maintained list)', async () => {
    const { ctx, text } = makeCtx();
    await runChannelPairing([], ctx);
    expect(text()).toContain('Channel adapters');
    // Every pairable surface id appears.
    for (const surface of PAIRABLE_SURFACES) {
      expect(text()).toContain(surface);
    }
  });

  it('rejects an unknown surface with the list of valid ones', async () => {
    const { ctx, text } = makeCtx();
    await runChannelPairing(['not-a-channel'], ctx);
    expect(text()).toContain('Unknown channel');
    expect(text()).toContain('slack');
  });

  it('shows a surface\'s declared credentials and marks them not set initially', async () => {
    const { ctx, text } = makeCtx();
    await runChannelPairing(['slack'], ctx);
    expect(text()).toContain('Slack');
    expect(text()).toContain('Declared credentials');
    expect(text()).toContain('not set');
  });

  it('verify reports missing credentials, then passes locally once every credential resolves', async () => {
    const { ctx, store, printed, text } = makeCtx();
    await runChannelPairing(['slack', 'verify'], ctx);
    expect(text()).toContain('[fail]');
    // No control-plane base URL is configured in this stub, so the live
    // round-trip is honestly reported as unavailable rather than skipped silently.
    expect(text()).toContain('Cannot perform a live round-trip');

    // Populate every declared credential field for slack, then re-verify.
    const schema = getBuiltinSetupSchema('slack');
    for (const field of schema.fields) {
      if (!field.configKey) continue;
      if (field.kind === 'secret') store.set(field.configKey, 'goodvibes-secret://slack');
      else if (field.kind === 'string' || field.kind === 'url' || field.kind === 'number') store.set(field.configKey, 'T123');
    }
    printed.length = 0;
    await runChannelPairing(['slack', 'verify'], ctx);
    expect(text()).not.toContain('[fail]');
    expect(text()).toContain('All declared credentials resolve');
  });
});
