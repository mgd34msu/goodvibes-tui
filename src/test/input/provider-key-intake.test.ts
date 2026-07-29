import { describe, expect, test } from 'bun:test';
import type { LLMProvider, ProviderAuthState } from '@pellux/goodvibes-sdk/platform/providers';
import {
  decideProviderKeyIntake,
  runProviderKeyIntake,
  type ProviderKeyIntakeDeps,
} from '../../input/provider-key-intake.ts';
import type { ConcealedInputRequest } from '../../input/concealed-input.ts';

function providerWithAuthState(state: ProviderAuthState | undefined, isConfigured?: boolean): LLMProvider {
  return {
    name: 'p',
    models: [],
    chat: async () => { throw new Error('not used'); },
    ...(state ? { describeAuthState: () => state } : {}),
    ...(isConfigured === undefined ? {} : { isConfigured: () => isConfigured }),
  } as unknown as LLMProvider;
}

describe('decideProviderKeyIntake', () => {
  test('prompts for an unconfigured provider that accepts a key', () => {
    const provider = providerWithAuthState({
      configured: false,
      allowAnonymous: false,
      anonymousReady: false,
      authEnvVars: ['ACME_API_KEY'],
    });
    expect(decideProviderKeyIntake(provider)).toEqual({
      needsKey: true,
      secretKey: 'ACME_API_KEY',
      alreadyConfigured: false,
    });
  });

  test('leaves an already-configured provider alone', () => {
    const provider = providerWithAuthState({
      configured: true,
      allowAnonymous: false,
      anonymousReady: false,
      authEnvVars: ['ACME_API_KEY'],
    });
    expect(decideProviderKeyIntake(provider)).toEqual({ needsKey: false, alreadyConfigured: true });
  });

  test('leaves a keyless (anonymous-ready) provider alone', () => {
    const provider = providerWithAuthState({
      configured: false,
      allowAnonymous: true,
      anonymousReady: true,
      authEnvVars: [],
    });
    expect(decideProviderKeyIntake(provider)).toEqual({ needsKey: false, alreadyConfigured: false });
  });

  test('a provider with no declared auth state is treated per isConfigured', () => {
    expect(decideProviderKeyIntake(providerWithAuthState(undefined, true)))
      .toEqual({ needsKey: false, alreadyConfigured: true });
    expect(decideProviderKeyIntake(providerWithAuthState(undefined)))
      .toEqual({ needsKey: false, alreadyConfigured: true });
  });

  test('an undefined provider needs no key', () => {
    expect(decideProviderKeyIntake(undefined)).toEqual({ needsKey: false, alreadyConfigured: false });
  });
});

describe('runProviderKeyIntake — selection completes after intake', () => {
  function makeDeps(overrides: Partial<ProviderKeyIntakeDeps> = {}): {
    deps: ProviderKeyIntakeDeps;
    begun: ConcealedInputRequest[];
    setCalls: Array<{ key: string; value: string; options?: unknown }>;
    counters: { refreshCalls: number };
    prints: string[];
  } {
    const begun: ConcealedInputRequest[] = [];
    const setCalls: Array<{ key: string; value: string; options?: unknown }> = [];
    const counters = { refreshCalls: 0 };
    const prints: string[] = [];
    const deps: ProviderKeyIntakeDeps = {
      provider: providerWithAuthState({
        configured: false,
        allowAnonymous: false,
        anonymousReady: false,
        authEnvVars: ['ACME_API_KEY'],
      }),
      secretsManager: {
        set: async (key, value, options) => { setCalls.push({ key, value, options }); },
      },
      refreshProviderCredentials: async () => { counters.refreshCalls += 1; },
      beginConcealedInput: (request) => { begun.push(request); },
      print: (text) => { prints.push(text); },
      ...overrides,
    };
    return { deps, begun, setCalls, counters, prints };
  }

  test('stores the key, re-registers live, then runs the original selection exactly once', async () => {
    const bag = makeDeps();
    let completed = 0;
    runProviderKeyIntake('acme', bag.deps, () => { completed += 1; });

    // The prompt opened; selection has not completed yet.
    expect(bag.begun).toHaveLength(1);
    expect(completed).toBe(0);

    bag.begun[0]!.onSubmit('sk-secret-value');
    await Promise.resolve();
    await Promise.resolve();

    expect(bag.setCalls).toEqual([
      // Daemon scope, not user scope: the daemon is the process that runs the
      // model, and it does so with this TUI closed. See the comment at the
      // write site in input/provider-key-intake.ts.
      { key: 'ACME_API_KEY', value: 'sk-secret-value', options: { scope: 'daemon', medium: 'secure' } },
    ]);
    expect(bag.counters.refreshCalls).toBe(1);
    expect(completed).toBe(1);
    // The stored value never appears in any surfaced line.
    expect(bag.prints.join('\n')).not.toContain('sk-secret-value');
  });

  test('proceeds immediately (no prompt) when the provider is already configured', () => {
    const bag = makeDeps({
      provider: providerWithAuthState({
        configured: true,
        allowAnonymous: false,
        anonymousReady: false,
        authEnvVars: ['ACME_API_KEY'],
      }),
    });
    let completed = 0;
    runProviderKeyIntake('acme', bag.deps, () => { completed += 1; });
    expect(bag.begun).toHaveLength(0);
    expect(completed).toBe(1);
  });

  test('cancelling (Escape) still completes the selection, storing nothing', () => {
    const bag = makeDeps();
    let completed = 0;
    runProviderKeyIntake('acme', bag.deps, () => { completed += 1; });
    bag.begun[0]!.onCancel?.();
    expect(bag.setCalls).toHaveLength(0);
    expect(completed).toBe(1);
  });
});
