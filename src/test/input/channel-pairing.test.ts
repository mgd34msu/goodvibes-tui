import { describe, it, expect } from 'bun:test';
import type { ConfigManager } from '../../config/index.ts';
import type { CommandContext } from '../../input/command-registry.ts';
import { runChannelPairing } from '../../input/commands/channel-pairing.ts';
import { EXTERNAL_SURFACE_SPECS } from '../../input/onboarding/onboarding-wizard-external-surfaces.ts';

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
  it('lists adapters from the surface declaration (not a hand-maintained list)', () => {
    const { ctx, text } = makeCtx();
    runChannelPairing([], ctx);
    expect(text()).toContain('Channel adapters');
    // Every declared surface id appears.
    for (const spec of EXTERNAL_SURFACE_SPECS) {
      expect(text()).toContain(spec.id);
    }
  });

  it('rejects an unknown surface with the list of valid ones', () => {
    const { ctx, text } = makeCtx();
    runChannelPairing(['not-a-channel'], ctx);
    expect(text()).toContain('Unknown channel');
    expect(text()).toContain('slack');
  });

  it('shows a surface\'s declared credentials and marks them not set initially', () => {
    const { ctx, text } = makeCtx();
    runChannelPairing(['slack'], ctx);
    expect(text()).toContain('Slack');
    expect(text()).toContain('Declared credentials');
    expect(text()).toContain('not set');
  });

  it('verify reports missing credentials, then passes once every credential resolves', () => {
    const { ctx, store, printed, text } = makeCtx();
    runChannelPairing(['slack', 'verify'], ctx);
    expect(text()).toContain('[fail]');

    // Populate every declared credential field for slack, then re-verify.
    const slack = EXTERNAL_SURFACE_SPECS.find((s) => s.id === 'slack')!;
    for (const field of slack.fields) {
      if (field.kind === 'masked' || field.kind === 'text') {
        store.set(field.configKey, field.kind === 'masked' ? 'goodvibes-secret://slack' : 'T123');
      }
    }
    printed.length = 0;
    runChannelPairing(['slack', 'verify'], ctx);
    expect(text()).not.toContain('[fail]');
    expect(text()).toContain('All declared credentials resolve');
  });
});
