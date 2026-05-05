import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createShellPathService } from '@/runtime/index.ts';
import { CommandRegistry } from '../../input/command-registry.ts';
import { applyInitialTuiCliState } from '../../cli/tui-startup.ts';
import { writeOnboardingCheckMarker } from '../../runtime/onboarding/index.ts';
import type { CommandContext } from '../../input/command-registry.ts';
import type { InputHandler } from '../../input/handler.ts';
import type { GoodVibesCliParseResult } from '../../cli/types.ts';

function makeShellPaths() {
  const root = join(tmpdir(), `gv-tui-startup-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  return createShellPathService({
    workingDirectory: join(root, 'workspace'),
    homeDirectory: join(root, 'home'),
  });
}

function makeCli(overrides: Partial<GoodVibesCliParseResult> = {}): GoodVibesCliParseResult {
  return {
    binary: 'goodvibes',
    command: 'tui',
    rawCommand: undefined,
    commandArgs: [],
    positionals: [],
    flags: {
      provider: undefined,
      model: undefined,
      daemonHome: undefined,
      workingDir: undefined,
      help: false,
      version: false,
      prompt: undefined,
      print: false,
      outputFormat: 'text',
      configOverrides: [],
      enableFeatures: [],
      disableFeatures: [],
      noAltScreen: false,
      port: undefined,
      hostname: undefined,
      open: false,
      continueLast: false,
      resume: undefined,
      session: undefined,
      fork: false,
      rawOutput: false,
      acceptRawOutputRisk: false,
    },
    errors: [],
    ...overrides,
  };
}

function runStartup(shellPaths: ReturnType<typeof makeShellPaths>): { readonly opened: number } {
  let opened = 0;
  const input = {
    prompt: '',
    cursorPos: 0,
    openOnboardingWizard: () => {
      opened += 1;
    },
  } as unknown as InputHandler;

  applyInitialTuiCliState({
    cli: makeCli(),
    input,
    commandRegistry: new CommandRegistry(),
    commandContext: {} as CommandContext,
    shellPaths,
    render: () => {},
  });

  return { opened };
}

describe('initial TUI onboarding startup check', () => {
  test('opens onboarding when the global user check marker is absent', () => {
    const shellPaths = makeShellPaths();

    expect(runStartup(shellPaths).opened).toBe(1);
  });

  test('does not use project markers as the global onboarding check', () => {
    const shellPaths = makeShellPaths();
    writeOnboardingCheckMarker(shellPaths, {
      scope: 'project',
      source: 'wizard',
      mode: 'new',
    });

    expect(runStartup(shellPaths).opened).toBe(1);
  });

  test('skips automatic onboarding after the global user check marker exists', () => {
    const shellPaths = makeShellPaths();
    writeOnboardingCheckMarker(shellPaths, {
      scope: 'user',
      source: 'wizard',
      mode: 'new',
    });

    expect(runStartup(shellPaths).opened).toBe(0);
  });
});
