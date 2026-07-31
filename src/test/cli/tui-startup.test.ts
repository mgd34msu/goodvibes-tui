import { beforeEach, describe, expect, test } from 'bun:test';
import { resetAnsweredRecoveryOffersForTest } from '../../runtime/recovery-prompt.ts';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createShellPathService, persistConversation, writeRecoveryFile } from '@/runtime/index.ts';
import { SessionManager } from '@pellux/goodvibes-sdk/platform/sessions';
import { CommandRegistry } from '../../input/command-registry.ts';
import { applyInitialTuiCliState } from '../../cli/tui-startup.ts';
import { writeOnboardingCheckMarker } from '../../runtime/onboarding/index.ts';
import { writeWizardProgress } from '../../runtime/onboarding/index.ts';
import { ConversationManager } from '../../core/conversation.ts';
import { bindWriteLastSessionPointerToSurface } from '@pellux/goodvibes-sdk/platform/runtime/operations';
import type { CommandContext } from '../../input/command-registry.ts';
import type { InputHandler } from '../../input/handler.ts';
import type { GoodVibesCliParseResult } from '@pellux/goodvibes-terminal-shell';
import { makeTestSurface } from '../helpers/session-surface.ts';

beforeEach(() => { resetAnsweredRecoveryOffersForTest(); });

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
      strict: false,
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
    surface: makeTestSurface(shellPaths.workingDirectory, shellPaths.homeDirectory),
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
    surface: makeTestSurface(shellPaths.workingDirectory, shellPaths.homeDirectory),
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
      surface: makeTestSurface(shellPaths.workingDirectory, shellPaths.homeDirectory),
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
    const surface = makeTestSurface(shellPaths.workingDirectory, shellPaths.homeDirectory);
    void new SessionManager(shellPaths.workingDirectory, { surface });
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
      { surface },
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

// ---------------------------------------------------------------------------
// checkRecoveryForSession pre-resume check — --continue / bare --resume must
// never silently resume the shorter durable-store copy when the target
// session also has a crash-recovery snapshot strictly newer than that store
// (the autosave tail a plain resume would otherwise drop). See
// resumeNamedSessionWithRecoveryCheck in cli/tui-startup.ts.
// ---------------------------------------------------------------------------

describe('recovery-aware --continue / bare --resume', () => {
  function makeRecoveryShellPaths() {
    const root = join(tmpdir(), `gv-tui-recovery-continue-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const workspace = join(root, 'workspace');
    const home = join(root, 'home');
    mkdirSync(workspace, { recursive: true });
    mkdirSync(home, { recursive: true });
    return createShellPathService({ workingDirectory: workspace, homeDirectory: home });
  }

  /** Scripted operator: answers each modal in turn with the given item ids (null = dismissed). */
  function scriptedOpener(answers: Array<string | null>): NonNullable<CommandContext['openSelection']> {
    let i = 0;
    return (_title, _items, _opts, cb) => {
      const id = answers[i] ?? null;
      i += 1;
      cb(id === null ? null : { item: { id, label: id }, action: 'select' });
    };
  }

  /** A durable store save, then (after a real gap so mtimes order correctly) a STRICTLY NEWER recovery snapshot for the same session — the exact shape a mid-turn crash leaves behind. */
  async function persistSessionThenNewerCrash(shellPaths: ReturnType<typeof makeRecoveryShellPaths>, sessionId: string, tailMessage: string) {
    const surface = makeTestSurface(shellPaths.workingDirectory, shellPaths.homeDirectory);
    void new SessionManager(shellPaths.workingDirectory, { surface });
    persistConversation(
      sessionId,
      { messages: [{ role: 'user', content: 'saved before the crash' }], timestamp: Date.now(), titleSource: 'user', returnContext: undefined as never },
      'openai:gpt-5.2', 'openai', sessionId, { surface },
    );
    await Bun.sleep(20); // real gap so the recovery snapshot's mtime is unambiguously newer than the store's
    writeRecoveryFile(
      { messages: [{ role: 'user', content: 'saved before the crash' }, { role: 'assistant', content: 'working...' }, { role: 'user', content: tailMessage }], title: 'Crash tail', timestamp: Date.now() },
      sessionId, 'Crash tail', { surface },
    );
    return surface;
  }

  function makeContinueRecoveryDeps(shellPaths: ReturnType<typeof makeRecoveryShellPaths>, surface: ReturnType<typeof makeTestSurface>, receipts: string[]) {
    return {
      sessionManager: new SessionManager(shellPaths.workingDirectory, { surface }),
      runtime: { sessionId: 'fresh-boot-session', model: 'test-model', provider: 'test-provider' },
      conversation: new ConversationManager(() => 80),
      writeLastSessionPointer: bindWriteLastSessionPointerToSurface(surface),
      receipt: (line: string) => receipts.push(line),
    };
  }

  test('--continue with a newer recovery snapshot offers it; choosing Resume applies the snapshot instead of a plain store resume', async () => {
    const shellPaths = makeRecoveryShellPaths();
    const surface = await persistSessionThenNewerCrash(shellPaths, 'crash-continue-resume', 'unsaved tail message');
    const dispatched: Array<{ name: string; args: string[] }> = [];
    const receipts: string[] = [];
    const recovery = makeContinueRecoveryDeps(shellPaths, surface, receipts);

    const chain = applyInitialTuiCliState({
      cli: makeCli({ flags: { ...makeCli().flags, continueLast: true } }),
      input: { prompt: '', cursorPos: 0, openOnboardingWizard: () => {} } as unknown as InputHandler,
      commandRegistry: { execute: async (name: string, args: string[]) => { dispatched.push({ name, args }); return true; } } as unknown as CommandRegistry,
      commandContext: { openSelection: scriptedOpener(['resume']) } as unknown as CommandContext,
      shellPaths,
      surface,
      render: () => {},
      continueRecovery: recovery,
    });

    await chain;

    // No plain store resume dispatched — the snapshot itself was applied.
    expect(dispatched.some((d) => d.name === 'session' && d.args[0] === 'resume')).toBe(false);
    // The snapshot's 3 messages (including the unsaved tail) landed in the live conversation.
    expect(recovery.conversation.getMessageCount()).toBe(3);
    // The runtime adopted the recovered session id.
    expect(recovery.runtime.sessionId).toBe('crash-continue-resume');
    expect(receipts.some((r) => r.includes('crash-continue-resume'))).toBe(true);
    // Load-then-delete: the recovery point is retired once resumed.
    expect(existsSync(surface.recoveryFile('crash-continue-resume'))).toBe(false);
  });

  test('--continue with a newer recovery snapshot: "Not now" falls through to the plain store resume (after the established Keep/Remove question)', async () => {
    const shellPaths = makeRecoveryShellPaths();
    const surface = await persistSessionThenNewerCrash(shellPaths, 'crash-continue-decline', 'unsaved tail message 2');
    const dispatched: Array<{ name: string; args: string[] }> = [];
    const receipts: string[] = [];
    const recovery = makeContinueRecoveryDeps(shellPaths, surface, receipts);

    const chain = applyInitialTuiCliState({
      cli: makeCli({ flags: { ...makeCli().flags, continueLast: true } }),
      input: { prompt: '', cursorPos: 0, openOnboardingWizard: () => {} } as unknown as InputHandler,
      commandRegistry: { execute: async (name: string, args: string[]) => { dispatched.push({ name, args }); return true; } } as unknown as CommandRegistry,
      commandContext: { openSelection: scriptedOpener(['not-now', 'keep']) } as unknown as CommandContext,
      shellPaths,
      surface,
      render: () => {},
      continueRecovery: recovery,
    });

    await chain;

    // The plain store resume proceeds after the decline.
    expect(dispatched.some((d) => d.name === 'session' && d.args[0] === 'resume' && d.args[1] === 'crash-continue-decline')).toBe(true);
    // Nothing was applied to the live conversation from the snapshot.
    expect(recovery.conversation.getMessageCount()).toBe(0);
    expect(recovery.runtime.sessionId).toBe('fresh-boot-session');
    // Kept: the snapshot survives on disk, to be offered again next launch.
    expect(existsSync(surface.recoveryFile('crash-continue-decline'))).toBe(true);
  });

  test('--continue with continueRecovery wired but no live snapshot resumes straight from the store — no modal is ever opened', async () => {
    const shellPaths = makeRecoveryShellPaths();
    const surface = makeTestSurface(shellPaths.workingDirectory, shellPaths.homeDirectory);
    void new SessionManager(shellPaths.workingDirectory, { surface });
    persistConversation(
      'crash-continue-none',
      { messages: [{ role: 'user', content: 'test' }], timestamp: Date.now(), titleSource: 'user', returnContext: undefined as never },
      'openai:gpt-5.2', 'openai', 'crash-continue-none', { surface },
    );
    const dispatched: Array<{ name: string; args: string[] }> = [];
    const receipts: string[] = [];
    let openSelectionCalls = 0;
    const recovery = makeContinueRecoveryDeps(shellPaths, surface, receipts);

    const chain = applyInitialTuiCliState({
      cli: makeCli({ flags: { ...makeCli().flags, continueLast: true } }),
      input: { prompt: '', cursorPos: 0, openOnboardingWizard: () => {} } as unknown as InputHandler,
      commandRegistry: { execute: async (name: string, args: string[]) => { dispatched.push({ name, args }); return true; } } as unknown as CommandRegistry,
      commandContext: { openSelection: () => { openSelectionCalls += 1; } } as unknown as CommandContext,
      shellPaths,
      surface,
      render: () => {},
      continueRecovery: recovery,
    });

    await chain;

    expect(dispatched.some((d) => d.name === 'session' && d.args[0] === 'resume' && d.args[1] === 'crash-continue-none')).toBe(true);
    expect(openSelectionCalls).toBe(0);
  });

  test('bare --resume (pointer form) with a newer recovery snapshot: choosing Resume applies the snapshot, same as --continue', async () => {
    const shellPaths = makeRecoveryShellPaths();
    const surface = await persistSessionThenNewerCrash(shellPaths, 'crash-bare-resume', 'unsaved tail message 3');
    const dispatched: Array<{ name: string; args: string[] }> = [];
    const receipts: string[] = [];
    const recovery = makeContinueRecoveryDeps(shellPaths, surface, receipts);

    const chain = applyInitialTuiCliState({
      cli: makeCli({ flags: { ...makeCli().flags, resume: 'latest' } }),
      input: { prompt: '', cursorPos: 0, openOnboardingWizard: () => {} } as unknown as InputHandler,
      commandRegistry: { execute: async (name: string, args: string[]) => { dispatched.push({ name, args }); return true; } } as unknown as CommandRegistry,
      commandContext: { openSelection: scriptedOpener(['resume']) } as unknown as CommandContext,
      shellPaths,
      surface,
      render: () => {},
      continueRecovery: recovery,
    });

    await chain;

    expect(dispatched.some((d) => d.name === 'session' && d.args[0] === 'resume')).toBe(false);
    expect(recovery.conversation.getMessageCount()).toBe(3);
    expect(recovery.runtime.sessionId).toBe('crash-bare-resume');
  });
});

// ---------------------------------------------------------------------------
// Registration self-records — no modal is ever raised for it; it only
// ever fires for an ALREADY-trusted workspace (the owner-boundary rider:
// self-recording must not widen anything for a workspace that was merely
// opened read-only, never decided, or explicitly kept restricted).
// ---------------------------------------------------------------------------

describe('registration self-records at startup (no modal, ever)', () => {
  function makeWorkspaceCommandContext(opts: {
    readonly trusted: boolean;
    readonly offerRegister: boolean;
  }): { readonly commandContext: CommandContext; readonly registerCalls: Array<string | undefined> } {
    const registerCalls: Array<string | undefined> = [];
    const commandContext = {
      workspace: {
        workspaceTrustManager: {
          isTrusted: () => opts.trusted,
        },
        workspaceRegistrationManager: {
          evaluate: async () => ({
            root: '/project',
            status: opts.offerRegister ? ('unknown' as const) : ('covered' as const),
            coveredBy: opts.offerRegister ? null : '/project',
            viaWorktreeLink: false,
            broad: false,
            offerRegister: opts.offerRegister,
            reason: 'test',
          }),
          register: async (label?: string) => {
            registerCalls.push(label);
            return { registered: true as const, result: { record: {} as never, alreadyRegistered: false } };
          },
        },
      },
    } as unknown as CommandContext;
    return { commandContext, registerCalls };
  }

  test('self-records (labeled "via TUI") on startup when the workspace is already trusted and unregistered', async () => {
    const shellPaths = makeShellPaths();
    writeOnboardingCheckMarker(shellPaths, { scope: 'user', source: 'wizard', mode: 'new' });
    const { commandContext, registerCalls } = makeWorkspaceCommandContext({ trusted: true, offerRegister: true });
    const input = { prompt: '', cursorPos: 0, openOnboardingWizard: () => {} } as unknown as InputHandler;

    applyInitialTuiCliState({
      cli: makeCli(),
      input,
      commandRegistry: new CommandRegistry(),
      commandContext,
      shellPaths,
      surface: makeTestSurface(shellPaths.workingDirectory, shellPaths.homeDirectory),
      render: () => {},
    });
    // Fire-and-forget — give the microtask queue a turn to run it.
    await Promise.resolve();
    await Promise.resolve();

    expect(registerCalls).toEqual(['via TUI']);
  });

  test('never self-records for a restricted (not-yet-trusted) workspace', async () => {
    const shellPaths = makeShellPaths();
    writeOnboardingCheckMarker(shellPaths, { scope: 'user', source: 'wizard', mode: 'new' });
    const { commandContext, registerCalls } = makeWorkspaceCommandContext({ trusted: false, offerRegister: true });
    const input = { prompt: '', cursorPos: 0, openOnboardingWizard: () => {} } as unknown as InputHandler;

    applyInitialTuiCliState({
      cli: makeCli(),
      input,
      commandRegistry: new CommandRegistry(),
      commandContext,
      shellPaths,
      surface: makeTestSurface(shellPaths.workingDirectory, shellPaths.homeDirectory),
      render: () => {},
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(registerCalls).toEqual([]);
  });

  test('never self-records when the registry already covers/declines the root, even if trusted', async () => {
    const shellPaths = makeShellPaths();
    writeOnboardingCheckMarker(shellPaths, { scope: 'user', source: 'wizard', mode: 'new' });
    const { commandContext, registerCalls } = makeWorkspaceCommandContext({ trusted: true, offerRegister: false });
    const input = { prompt: '', cursorPos: 0, openOnboardingWizard: () => {} } as unknown as InputHandler;

    applyInitialTuiCliState({
      cli: makeCli(),
      input,
      commandRegistry: new CommandRegistry(),
      commandContext,
      shellPaths,
      surface: makeTestSurface(shellPaths.workingDirectory, shellPaths.homeDirectory),
      render: () => {},
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(registerCalls).toEqual([]);
  });

  test('no selection/modal surface is ever opened for registration — commandContext.openSelection is never called', async () => {
    const shellPaths = makeShellPaths();
    writeOnboardingCheckMarker(shellPaths, { scope: 'user', source: 'wizard', mode: 'new' });
    const { commandContext } = makeWorkspaceCommandContext({ trusted: true, offerRegister: true });
    let openSelectionCalls = 0;
    (commandContext as unknown as { openSelection: () => void }).openSelection = () => { openSelectionCalls += 1; };
    const input = { prompt: '', cursorPos: 0, openOnboardingWizard: () => {} } as unknown as InputHandler;

    applyInitialTuiCliState({
      cli: makeCli(),
      input,
      commandRegistry: new CommandRegistry(),
      commandContext,
      shellPaths,
      surface: makeTestSurface(shellPaths.workingDirectory, shellPaths.homeDirectory),
      render: () => {},
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(openSelectionCalls).toBe(0);
  });
});
