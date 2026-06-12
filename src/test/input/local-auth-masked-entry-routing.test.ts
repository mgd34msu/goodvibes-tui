// ---------------------------------------------------------------------------
// local-auth-masked-entry-routing.test.ts
//
// Integration tests that go through the REAL CommandContext wiring built by
// createBootstrapCommandActions (bootstrap-command-parts.ts) and assert:
//
//   1. openLocalAuthMaskedEntry is present on the context (not undefined) —
//      i.e., it was properly assigned by the bootstrap action builder.
//   2. The real CommandRegistry + handleLocalAuthCommand route:
//      /local-auth rotate-password <user>   (no password arg)
//      opens the local-auth panel in masked mode.
//   3. Keystrokes fed to the live LocalAuthPanel.handleInput() accumulate
//      in the masked buffer and render as bullet chars (not plaintext).
// ---------------------------------------------------------------------------

import { beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { UserAuthManager } from '@pellux/goodvibes-sdk/platform/security';
import { InputTokenizer } from '@pellux/goodvibes-sdk/platform/core';
import { PanelManager } from '../../panels/panel-manager.ts';
import { LocalAuthPanel } from '../../panels/local-auth-panel.ts';
import { CommandRegistry } from '../../input/command-registry.ts';
import type { CommandContext } from '../../input/command-registry.ts';
import { registerLocalAuthRuntimeCommands } from '../../input/commands/local-auth-runtime.ts';
import { createBootstrapCommandActions } from '../../runtime/bootstrap-command-parts.ts';
import { handlePanelFocusToken } from '../../input/handler-feed-routes.ts';
import type { PanelFocusRouteState } from '../../input/handler-feed-routes.ts';
import { KeybindingsManager } from '../../input/keybindings.ts';
import type { Line } from '../../types/grid.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function linesText(lines: Line[]): string {
  return lines
    .map((line) => line.map((cell) => cell.char ?? ' ').join(''))
    .join('\n');
}

/** Stub LocalAuthInspectionQuery (display-only) — same shape as the panel tests. */
const EMPTY_INSPECTION: import('../../runtime/ui-service-queries.ts').LocalAuthInspectionQuery = {
  inspect: () => ({
    userStorePath: '/tmp/gv-test-users',
    bootstrapCredentialPath: '/tmp/gv-test-bootstrap',
    persisted: false,
    bootstrapCredentialPresent: false,
    userCount: 0,
    sessionCount: 0,
    users: [],
    sessions: [],
  }),
} as unknown as import('../../runtime/ui-service-queries.ts').LocalAuthInspectionQuery;

/** Build a PanelManager with the LocalAuthPanel type registered. */
function makePanelManager(): PanelManager {
  const pm = new PanelManager();
  pm.registerType({
    id: 'local-auth',
    name: 'Local Auth',
    icon: 'U',
    category: 'monitoring',
    description: 'Local user auth management panel',
    factory: () => new LocalAuthPanel(EMPTY_INSPECTION),
  });
  return pm;
}

/** Build a minimal CommandContext with the actions wired via createBootstrapCommandActions. */
function makeContext(
  panelManager: PanelManager,
  auth: UserAuthManager,
): { context: CommandContext; printed: string[] } {
  const printed: string[] = [];

  const actions = createBootstrapCommandActions({
    providerRegistry: {} as never,
    configManager: {} as never,
    conversation: { log: () => {} } as never,
    runtime: {
      model: 'mock',
      provider: 'mock',
      debugMode: false,
      systemPrompt: '',
      reasoningEffort: 'medium',
      sessionId: 'test-session',
    } as never,
    requestRender: () => {},
    panelManager,
    loadSystemPrompt: () => '',
    activatePlan: () => {},
    requestPermission: async () => ({ granted: false }),
    localUserAuthManager: auth,
  });

  const context: CommandContext = {
    session: {
      conversationManager: {} as never,
      runtime: {
        model: 'mock',
        provider: 'mock',
        debugMode: false,
        systemPrompt: '',
        reasoningEffort: 'medium',
        sessionId: 'test-session',
      },
    },
    provider: { providerRegistry: {} as never },
    workspace: {},
    platform: { config: {} as never, configManager: {} as never, localUserAuthManager: auth },
    ops: {},
    extensions: { toolRegistry: {} as never, mcpRegistry: {} as never },
    renderRequest: () => {},
    print: (text: string) => { printed.push(text); },
    exit: () => {},
    ...actions,
  };

  return { context, printed };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('local-auth masked-entry command routing — bootstrap wiring', () => {
  let dir: string;
  let auth: UserAuthManager;
  let panelManager: PanelManager;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gv-routing-'));
    auth = new UserAuthManager({
      bootstrapFilePath: join(dir, 'users.json'),
      bootstrapCredentialPath: join(dir, 'bootstrap.txt'),
    });
    panelManager = makePanelManager();
  });

  // -------------------------------------------------------------------------
  // 1. openLocalAuthMaskedEntry is wired (not undefined) on the context
  // -------------------------------------------------------------------------
  test('openLocalAuthMaskedEntry is defined on the bootstrap CommandContext', () => {
    const { context } = makeContext(panelManager, auth);
    expect(context.openLocalAuthMaskedEntry).toBeDefined();
    expect(typeof context.openLocalAuthMaskedEntry).toBe('function');
  });

  // -------------------------------------------------------------------------
  // 2. /local-auth rotate-password <user> (argv-less) opens masked mode
  // -------------------------------------------------------------------------
  test('rotate-password without password arg opens LocalAuthPanel in masked mode', async () => {
    // Pre-create the user so rotatePassword won't throw if the panel were to commit.
    auth.addUser('alice', 'initial-pass', ['admin']);

    const registry = new CommandRegistry();
    registerLocalAuthRuntimeCommands(registry);

    const { context } = makeContext(panelManager, auth);

    // The registry entry is 'local-auth'; subcommand args are [subcommand, ...rest].
    await registry.execute('local-auth', ['rotate-password', 'alice'], context);

    // The panel must now be open in the panel manager.
    const rawPanel = panelManager.getPanel('local-auth');
    expect(rawPanel).not.toBeNull();
    expect(rawPanel instanceof LocalAuthPanel).toBe(true);

    // And it must be in masked-entry mode for alice.
    const panel = rawPanel as LocalAuthPanel;
    expect(panel.isMaskedEntryActive).toBe(true);
  });

  // -------------------------------------------------------------------------
  // 3. Keystrokes route through handlePanelFocusToken → getActive() → masked buffer
  // -------------------------------------------------------------------------
  test('keystrokes routed through the production handlePanelFocusToken accumulate in masked buffer and render as bullets', async () => {
    auth.addUser('bob', 'old-pass', ['admin']);

    const registry = new CommandRegistry();
    registerLocalAuthRuntimeCommands(registry);

    const { context } = makeContext(panelManager, auth);

    await registry.execute('local-auth', ['rotate-password', 'bob'], context);

    // After openLocalAuthMaskedEntry: the panel is open and active in the manager.
    const panel = panelManager.getPanel('local-auth') as LocalAuthPanel;
    expect(panel.isMaskedEntryActive).toBe(true);

    // Verify panelManager.getActive() returns the same LocalAuthPanel instance —
    // this is the exact codepath handler-feed-routes.ts:106 and :118 call.
    expect(panelManager.getActive()).toBe(panel);

    // Build the production PanelFocusRouteState used by handlePanelFocusToken.
    // KeybindingsManager needs a configPath (file need not exist; defaults are used).
    const kb = new KeybindingsManager({ configPath: join(dir, 'kb.json') });
    const routeState: PanelFocusRouteState = {
      panelManager,
      keybindingsManager: kb,
      panelFocused: true,
      commandMode: false,
      searchActive: false,
      autocompleteActive: false,
      requestRender: () => {},
      handlePathCompletion: () => false,
      cyclePanelTab: () => {},
    };

    // Feed text tokens through the real router (handler-feed-routes.ts:117-125).
    // InputTokenizer is the production tokenizer; single printable chars produce
    // type:'text' tokens whose value is iterated by the router into handleInput.
    const tokenizer = new InputTokenizer();
    for (const char of ['n', 'e', 'w']) {
      const tokens = tokenizer.feed(char);
      expect(tokens.length).toBeGreaterThan(0);
      for (const token of tokens) {
        const result = handlePanelFocusToken(routeState, token);
        expect(result.handled).toBe(true);
      }
    }

    const rendered = panel.render(80, 20);
    const text = linesText(rendered);

    // Plaintext keystrokes must not appear verbatim.
    expect(text).not.toContain('new');
    // Bullet chars must be present (one per character typed).
    expect(text).toContain('•');
    // Username is shown in the prompt label.
    expect(text).toContain('bob');
  });
});
