import { describe, expect, test } from 'bun:test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createShellPathService } from '@/runtime/index.ts';
import type { CommandContext } from '../../input/command-registry.ts';
import type { SelectionItem, SelectionResult } from '../../input/selection-modal.ts';
import { startOnboardingFastPath } from '../../runtime/onboarding/fast-path.ts';
import { readOnboardingCheckMarker } from '../../runtime/onboarding/index.ts';

function makeShellPaths() {
  const root = join(tmpdir(), `gv-fastpath-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(root, { recursive: true });
  return createShellPathService({ workingDirectory: join(root, 'workspace'), homeDirectory: join(root, 'home') });
}

interface Harness {
  wizardOpens: number;
  selectionOpened: boolean;
  chooseFullSetup: boolean;
  chooseNothing: boolean;
  offeredItems: SelectionItem[];
  printed: string[];
  ctx: CommandContext;
  input: { openOnboardingWizard: (o: { mode: 'new'; reset: boolean }) => void };
}

/** A registry double whose getForModel reflects a genuinely keyless or key-requiring provider. */
function makeModelProvider(readiness: 'keyless' | 'needs-key') {
  return readiness === 'keyless'
    ? {
        name: 'openrouter',
        isConfigured: () => false,
        describeAuthState: () => ({ configured: false, allowAnonymous: true, anonymousReady: true, authEnvVars: [] as string[] }),
      }
    : {
        name: 'anthropic',
        isConfigured: () => false,
        describeAuthState: () => ({ configured: false, allowAnonymous: false, anonymousReady: false, authEnvVars: ['ANTHROPIC_API_KEY'] }),
      };
}

function makeHarness(opts: {
  configuredProviders: string[] | 'no-registry';
  chooseFullSetup?: boolean;
  chooseNothing?: boolean;
  defaultModel?: string;
  defaultModelReadiness?: 'keyless' | 'needs-key';
}): Harness {
  const h: Harness = {
    wizardOpens: 0,
    selectionOpened: false,
    chooseFullSetup: opts.chooseFullSetup ?? false,
    chooseNothing: opts.chooseNothing ?? false,
    offeredItems: [],
    printed: [],
    ctx: null as unknown as CommandContext,
    input: { openOnboardingWizard: () => { h.wizardOpens += 1; } },
  };
  const provider = opts.configuredProviders === 'no-registry'
    ? {}
    : {
        providerRegistry: {
          getConfiguredProviderIds: () => opts.configuredProviders as string[],
          ...(opts.defaultModelReadiness
            ? { getForModel: () => makeModelProvider(opts.defaultModelReadiness!) }
            : {}),
        },
      };
  h.ctx = {
    provider,
    platform: { config: { provider: { model: opts.defaultModel ?? 'openrouter:openrouter/free' } } },
    print: (text: string) => { h.printed.push(text); },
    openSelection: (
      _title: string,
      items: SelectionItem[],
      _opts: unknown,
      cb: (r: SelectionResult | null) => void,
    ) => {
      h.selectionOpened = true;
      h.offeredItems = items;
      if (h.chooseNothing) { cb(null); return; }
      const target = h.chooseFullSetup ? 'full-setup' : 'start-now';
      const item = items.find((i) => i.id === target)!;
      cb({ item, action: 'select' });
    },
  } as unknown as CommandContext;
  return h;
}

describe('onboarding fast path', () => {
  test('a configured provider skips the wizard and writes the check marker (0 steps)', () => {
    const shellPaths = makeShellPaths();
    const h = makeHarness({ configuredProviders: ['anthropic'] });
    startOnboardingFastPath({ input: h.input, commandContext: h.ctx, shellPaths, render: () => {} });
    expect(h.wizardOpens).toBe(0);
    expect(h.selectionOpened).toBe(false);
    expect(readOnboardingCheckMarker(shellPaths, 'user').exists).toBe(true);
  });

  test('no provider: choosing "start now" writes the marker without the wizard', () => {
    const shellPaths = makeShellPaths();
    const h = makeHarness({ configuredProviders: [] });
    startOnboardingFastPath({ input: h.input, commandContext: h.ctx, shellPaths, render: () => {} });
    expect(h.selectionOpened).toBe(true);
    expect(h.wizardOpens).toBe(0);
    expect(readOnboardingCheckMarker(shellPaths, 'user').exists).toBe(true);
  });

  test('no provider: dismissing the prompt still starts (marker written, skippable)', () => {
    const shellPaths = makeShellPaths();
    const h = makeHarness({ configuredProviders: [], chooseNothing: true });
    startOnboardingFastPath({ input: h.input, commandContext: h.ctx, shellPaths, render: () => {} });
    expect(h.wizardOpens).toBe(0);
    expect(readOnboardingCheckMarker(shellPaths, 'user').exists).toBe(true);
  });

  test('no provider: choosing "full guided setup" opens the wizard and does not mark done', () => {
    const shellPaths = makeShellPaths();
    const h = makeHarness({ configuredProviders: [], chooseFullSetup: true });
    startOnboardingFastPath({ input: h.input, commandContext: h.ctx, shellPaths, render: () => {} });
    expect(h.wizardOpens).toBe(1);
    expect(readOnboardingCheckMarker(shellPaths, 'user').exists).toBe(false);
  });

  test('falls back to the wizard when the surface cannot detect providers', () => {
    const shellPaths = makeShellPaths();
    const h = makeHarness({ configuredProviders: 'no-registry' });
    startOnboardingFastPath({ input: h.input, commandContext: h.ctx, shellPaths, render: () => {} });
    expect(h.wizardOpens).toBe(1);
  });

  test('keyless-ready default: the start choice and status line carry the generated keyless copy (full strings)', () => {
    const shellPaths = makeShellPaths();
    const h = makeHarness({ configuredProviders: [], defaultModelReadiness: 'keyless' });
    startOnboardingFastPath({ input: h.input, commandContext: h.ctx, shellPaths, render: () => {} });
    const startItem = h.offeredItems.find((i) => i.id === 'start-now')!;
    expect(startItem.label).toBe('Start now');
    expect(startItem.detail).toBe('Use the default model (openrouter:openrouter/free) — no API key needed');
    expect(h.printed).toEqual([
      'Use the default model (openrouter:openrouter/free) — no API key needed. Add a provider key anytime with /provider, or run /onboarding for full setup.',
    ]);
  });

  test('key-requiring default: the copy honestly asks for a key and never promises keyless (full strings)', () => {
    const shellPaths = makeShellPaths();
    const h = makeHarness({
      configuredProviders: [],
      defaultModel: 'anthropic:claude-sonnet-4-5',
      defaultModelReadiness: 'needs-key',
    });
    startOnboardingFastPath({ input: h.input, commandContext: h.ctx, shellPaths, render: () => {} });
    const startItem = h.offeredItems.find((i) => i.id === 'start-now')!;
    expect(startItem.label).toBe('Add an API key to start');
    expect(startItem.detail).toBe(
      'The default model (anthropic:claude-sonnet-4-5) uses anthropic, which requires an API key (set ANTHROPIC_API_KEY)',
    );
    expect(h.printed).toEqual([
      'The default model (anthropic:claude-sonnet-4-5) uses anthropic, which requires an API key (set ANTHROPIC_API_KEY). Add a provider key anytime with /provider, or run /onboarding for full setup.',
    ]);
    for (const item of h.offeredItems) {
      expect(item.label).not.toContain('no API key needed');
      expect(item.detail ?? '').not.toContain('no API key needed');
    }
  });

  test('a surface without getForModel resolves to the honest unresolvable copy, never a keyless claim', () => {
    const shellPaths = makeShellPaths();
    const h = makeHarness({ configuredProviders: [] });
    startOnboardingFastPath({ input: h.input, commandContext: h.ctx, shellPaths, render: () => {} });
    const startItem = h.offeredItems.find((i) => i.id === 'start-now')!;
    expect(startItem.label).toBe('Choose a model to start');
    expect(startItem.detail).toBe(
      'The configured default model (openrouter:openrouter/free) is not available: provider registry unavailable on this surface',
    );
    expect(startItem.detail).not.toContain('no API key needed');
  });
});
