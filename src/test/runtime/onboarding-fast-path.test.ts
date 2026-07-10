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
  ctx: CommandContext;
  input: { openOnboardingWizard: (o: { mode: 'new'; reset: boolean }) => void };
}

function makeHarness(opts: { configuredProviders: string[] | 'no-registry'; chooseFullSetup?: boolean; chooseNothing?: boolean }): Harness {
  const h: Harness = {
    wizardOpens: 0,
    selectionOpened: false,
    chooseFullSetup: opts.chooseFullSetup ?? false,
    chooseNothing: opts.chooseNothing ?? false,
    ctx: null as unknown as CommandContext,
    input: { openOnboardingWizard: () => { h.wizardOpens += 1; } },
  };
  const provider = opts.configuredProviders === 'no-registry'
    ? {}
    : { providerRegistry: { getConfiguredProviderIds: () => opts.configuredProviders as string[] } };
  h.ctx = {
    provider,
    print: () => {},
    openSelection: (
      _title: string,
      items: SelectionItem[],
      _opts: unknown,
      cb: (r: SelectionResult | null) => void,
    ) => {
      h.selectionOpened = true;
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
});
