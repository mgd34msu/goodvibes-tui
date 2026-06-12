import { describe, expect, test } from 'bun:test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createShellPathService, persistConversation } from '@/runtime/index.ts';
import { SessionManager } from '@pellux/goodvibes-sdk/platform/sessions';
import { CommandRegistry } from '../../input/command-registry.ts';
import { applyInitialTuiCliState } from '../../cli/tui-startup.ts';
import { writeOnboardingCheckMarker } from '../../runtime/onboarding/index.ts';
import { writeWizardProgress } from '../../runtime/onboarding/index.ts';
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
      fork: undefined,
      yes: false,
      nonInteractive: false,
    },
    errors: [],
    warnings: [],
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

// Helper: run startup with a given CLI shape and capture dispatched session commands
function runStartupWithCli(
  shellPaths: ReturnType<typeof makeShellPaths>,
  cliOverrides: Partial<GoodVibesCliParseResult> = {},
): { readonly opened: number; readonly dispatched: Array<{ name: string; args: string[] }>; readonly chain: Promise<void> | undefined } {
  let opened = 0;
  const dispatched: Array<{ name: string; args: string[] }> = [];
  const input = {
    prompt: '',
    cursorPos: 0,
    openOnboardingWizard: () => { opened += 1; },
  } as unknown as InputHandler;

  const registry = new CommandRegistry();
  // Intercept execute calls to capture dispatched commands
  const originalExecute = registry.execute.bind(registry);
  registry.execute = async (name: string, args: string[], ctx: CommandContext) => {
    dispatched.push({ name, args });
    return originalExecute(name, args, ctx);
  };

  const chain = applyInitialTuiCliState({
    cli: makeCli(cliOverrides),
    input,
    commandRegistry: registry,
    commandContext: {} as CommandContext,
    shellPaths,
    render: () => {},
  });

  return { opened, dispatched, chain };
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

  test('resumes interrupted wizard session when marker exists and progress file is present', () => {
    const shellPaths = makeShellPaths();
    // User has completed first-run onboarding (marker present).
    writeOnboardingCheckMarker(shellPaths, {
      scope: 'user',
      source: 'wizard',
      mode: 'new',
    });
    // But they left the wizard part-way through a subsequent edit session.
    writeWizardProgress(shellPaths, {
      mode: 'edit',
      stepIndex: 2,
      toggleState: [['capabilities.external-integrations', true]],
      radioState: [],
      textState: [],
    });

    let capturedMode: string | undefined;
    let preloadCalled = false;
    const input = {
      prompt: '',
      cursorPos: 0,
      openOnboardingWizard: (options: { mode?: string; reset?: boolean; preload?: unknown }) => {
        capturedMode = options.mode;
        if (typeof options.preload === 'function') {
          // Simulate the wizard controller interface the preload callback receives.
          const wizard = {
            setStep: (_idx: number) => {},
            toggleState: new Map<string, boolean>(),
            radioState: new Map<string, string>(),
            textState: new Map<string, string>(),
          };
          options.preload(wizard);
          preloadCalled = true;
        }
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

    // The wizard should be opened in the mode that was saved (edit).
    expect(capturedMode).toBe('edit');
    // The preload callback must have been invoked to restore wizard state.
    expect(preloadCalled).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Session lifecycle flags — startup hydration
// ---------------------------------------------------------------------------

describe('session lifecycle flags at startup', () => {
  function makeSessionShellPaths() {
    const root = join(tmpdir(), `gv-tui-session-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const workspace = join(root, 'workspace');
    const home = join(root, 'home');
    mkdirSync(workspace, { recursive: true });
    mkdirSync(home, { recursive: true });
    return createShellPathService({ workingDirectory: workspace, homeDirectory: home });
  }

  function persistSession(shellPaths: ReturnType<typeof makeSessionShellPaths>, sessionId: string) {
    const sessionManager = new SessionManager(shellPaths.workingDirectory, { surfaceRoot: 'tui' });
    persistConversation(
      sessionId,
      {
        messages: [{ role: 'user', content: 'test' }],
        timestamp: Date.now(),
        titleSource: 'user',
        returnContext: undefined as never,
      },
      'openai:gpt-5.2',
      'openai',
      sessionId,
      { workingDirectory: shellPaths.workingDirectory, homeDirectory: shellPaths.homeDirectory, sessionManager, surfaceRoot: 'tui' },
    );
  }

  test('--continue dispatches session resume with the last pointer session id', () => {
    const shellPaths = makeSessionShellPaths();
    persistSession(shellPaths, 'user-last-session');

    const { dispatched } = runStartupWithCli(shellPaths, {
      flags: {
        ...makeCli().flags,
        continueLast: true,
      },
    });

    // The session resume command is dispatched asynchronously — check the call was initiated
    // (The promise is void-chained; the test verifies the dispatch was initiated synchronously)
    expect(dispatched.some((d) => d.name === 'session' && d.args[0] === 'resume' && d.args[1] === 'user-last-session')).toBe(true);
  });

  test('--continue with no pointer file does not dispatch session resume', () => {
    const shellPaths = makeSessionShellPaths();
    // No session persisted — pointer file does not exist

    const { dispatched } = runStartupWithCli(shellPaths, {
      flags: {
        ...makeCli().flags,
        continueLast: true,
      },
    });

    expect(dispatched.filter((d) => d.name === 'session')).toHaveLength(0);
  });

  test('--resume with explicit id dispatches session resume with that id', () => {
    const shellPaths = makeSessionShellPaths();

    const { dispatched } = runStartupWithCli(shellPaths, {
      flags: {
        ...makeCli().flags,
        resume: 'user-explicit-id',
      },
    });

    expect(dispatched.some((d) => d.name === 'session' && d.args[0] === 'resume' && d.args[1] === 'user-explicit-id')).toBe(true);
  });

  test('bare --resume resolves via pointer and dispatches session resume with concrete id', () => {
    const shellPaths = makeSessionShellPaths();
    persistSession(shellPaths, 'user-bare-resume-session');

    const { dispatched } = runStartupWithCli(shellPaths, {
      flags: {
        ...makeCli().flags,
        resume: 'latest',
      },
    });

    // Bare --resume resolves the pointer file — must dispatch with the concrete session id, not 'latest'
    expect(dispatched.some((d) => d.name === 'session' && d.args[0] === 'resume' && d.args[1] === 'user-bare-resume-session')).toBe(true);
  });

  test('bare --resume with no pointer file does not dispatch session resume', () => {
    const shellPaths = makeSessionShellPaths();
    // No session persisted — pointer file absent

    const { dispatched } = runStartupWithCli(shellPaths, {
      flags: {
        ...makeCli().flags,
        resume: 'latest',
      },
    });

    expect(dispatched.filter((d) => d.name === 'session')).toHaveLength(0);
  });

  test('bare --fork dispatches session fork for current session', () => {
    const shellPaths = makeSessionShellPaths();

    const { dispatched } = runStartupWithCli(shellPaths, {
      flags: {
        ...makeCli().flags,
        fork: true,
      },
    });

    // Bare --fork calls session fork without a prior resume
    expect(dispatched.some((d) => d.name === 'session' && d.args[0] === 'fork')).toBe(true);
    // Should NOT resume first when fork=current
    expect(dispatched.some((d) => d.name === 'session' && d.args[0] === 'resume')).toBe(false);
  });

  test('--fork with explicit id dispatches resume then fork', async () => {
    const shellPaths = makeSessionShellPaths();

    const { dispatched, chain } = runStartupWithCli(shellPaths, {
      flags: {
        ...makeCli().flags,
        fork: 'user-source-session',
      },
    });

    // Await the full resume→fork chain so both dispatches are captured
    await chain;

    // First: resume the source session
    expect(dispatched.some((d) => d.name === 'session' && d.args[0] === 'resume' && d.args[1] === 'user-source-session')).toBe(true);
    // Then: fork is dispatched after resume resolves
    expect(dispatched.some((d) => d.name === 'session' && d.args[0] === 'fork')).toBe(true);
  });
});
