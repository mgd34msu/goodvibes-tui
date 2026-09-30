// ---------------------------------------------------------------------------
// local-auth-masked-entry-routing.test.ts
//
// Goes through the real wiring: createBootstrapCommandActions puts a
// placeholder on the context, wireViewOpeners replaces it with the kit-modal
// opener, and `/local-auth rotate-password <user>` / `add-user <user>` (no
// password argument) open the masked entry modal on the surface-modal host.
// Keystrokes from the production tokenizer reach the modal through the host,
// render only as dots, and Enter calls the real UserAuthManager.
// ---------------------------------------------------------------------------

import { beforeEach, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { UserAuthManager } from '@pellux/goodvibes-sdk/platform/security';
import { InputTokenizer } from '@pellux/goodvibes-sdk/platform/core';
import type { ConfigManager } from '@pellux/goodvibes-sdk/platform/config';
import { CommandRegistry } from '../../input/command-registry.ts';
import type { CommandContext } from '../../input/command-registry.ts';
import { registerLocalAuthRuntimeCommands } from '../../input/commands/local-auth-runtime.ts';
import { createBootstrapCommandActions } from '../../runtime/bootstrap-command-parts.ts';
import { SurfaceModalHost } from '../../input/surface-modal-host.ts';
import { MaskedEntryModal } from '../../input/masked-entry-modal.ts';
import { wireViewOpeners } from '../../shell/view-openers.ts';
import { layerTextBlock } from '../helpers/surface-frame.ts';
import { makeTestShellViews } from '../helpers/shell-views.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

function makeContext(auth: UserAuthManager, host: SurfaceModalHost, wire: boolean): { context: CommandContext; printed: string[]; logged: string[] } {
  const printed: string[] = [];
  const logged: string[] = [];
  const actions = createBootstrapCommandActions({
    providerRegistry: {} as never,
    configManager: {} as never,
    conversation: { log: (text: string) => { logged.push(text); } } as never,
    runtime: {
      model: 'mock',
      provider: 'mock',
      debugMode: false,
      systemPrompt: '',
      reasoningEffort: 'medium',
      sessionId: 'test-session',
    } as never,
    requestRender: () => {},
    loadSystemPrompt: () => '',
    activatePlan: () => {},
    requestPermission: async () => ({ approved: false }),
    localUserAuthManager: auth,
  });
  const context: CommandContext = {
    session: {
      conversationManager: {} as never,
      runtime: { model: 'mock', provider: 'mock', debugMode: false, systemPrompt: '', reasoningEffort: 'medium', sessionId: 'test-session' },
    },
    provider: { providerRegistry: {} as never },
    workspace: {},
    platform: { config: {} as never, configManager: {} as never, localUserAuthManager: auth },
    ops: {},
    extensions: { toolRegistry: {} as never, mcpRegistry: {} as never },
    ...actions,
    renderRequest: () => {},
    print: (text: string) => { printed.push(text); },
    exit: () => {},
  };
  if (wire) {
    const configManager = { get: () => undefined, set: () => {} } as unknown as ConfigManager;
    const { views, viewPanelAdapter } = makeTestShellViews({ configManager, localUserAuthManager: auth });
    wireViewOpeners({
      commandContext: context,
      input: { surfaceModals: host } as never,
      views,
      viewPanelAdapter,
      render: () => {},
    });
  }
  return { context, printed, logged };
}

function feed(host: SurfaceModalHost, text: string): void {
  const tokenizer = new InputTokenizer();
  for (const token of tokenizer.feed(text)) host.handleToken(token);
}

describe('local-auth masked entry: command routing into the kit modal', () => {
  let dir: string;
  let auth: UserAuthManager;
  let host: SurfaceModalHost;

  beforeEach(() => {
    dir = makeProjectTempDir('gv-routing');
    auth = new UserAuthManager({
      bootstrapFilePath: join(dir, 'users.json'),
      bootstrapCredentialPath: join(dir, 'bootstrap.txt'),
    });
    host = new SurfaceModalHost();
  });

  test('the bootstrap context has an opener before the shell attaches, and it says so instead of failing', () => {
    const { context, logged } = makeContext(auth, host, false);
    expect(typeof context.openLocalAuthMaskedEntry).toBe('function');
    context.openLocalAuthMaskedEntry!('rotate-password', 'alice');
    expect(host.active).toBe(false);
    expect(logged.join('\n')).toContain('opens once the terminal UI is attached');
  });

  test('rotate-password without a password argument opens the masked entry modal', async () => {
    auth.addUser('alice', 'initial-pass', ['admin']);
    const registry = new CommandRegistry();
    registerLocalAuthRuntimeCommands(registry);
    const { context } = makeContext(auth, host, true);
    await registry.execute('local-auth', ['rotate-password', 'alice'], context);
    const top = host.top();
    expect(top instanceof MaskedEntryModal).toBe(true);
    expect((top as MaskedEntryModal).step).toBe('password');
    expect((top as MaskedEntryModal).username).toBe('alice');
  });

  test('typed keystrokes render only as dots, and Enter rotates the password through the real manager', async () => {
    auth.addUser('bob', 'old-pass', ['admin']);
    const registry = new CommandRegistry();
    registerLocalAuthRuntimeCommands(registry);
    const { context, printed } = makeContext(auth, host, true);
    await registry.execute('local-auth', ['rotate-password', 'bob'], context);
    const modal = host.top() as MaskedEntryModal;

    for (const ch of 'new-pass-9') feed(host, ch);
    expect(modal.passwordLength).toBe(10);
    const text = layerTextBlock(modal.render(100, 30));
    expect(text).not.toContain('new-pass');
    expect(text).toContain('●'.repeat(10));
    expect(text).toContain('bob');

    feed(host, '\r');
    expect(host.active).toBe(false);
    expect(modal.passwordLength).toBe(0);
    expect(printed.join('\n')).toContain('Rotated the password for bob');
    expect(printed.join('\n')).not.toContain('new-pass');
    expect(auth.authenticate('bob', 'new-pass-9').ok).toBe(true);
    expect(auth.authenticate('bob', 'old-pass').ok).toBe(false);
  });

  test('add-user without a name asks for the name first, then the password', async () => {
    const { context, printed } = makeContext(auth, host, true);
    context.openLocalAuthMaskedEntry!('add-user');
    const modal = host.top() as MaskedEntryModal;
    expect(modal.step).toBe('username');
    feed(host, 'carol');
    feed(host, '\r');
    expect(modal.step).toBe('password');
    feed(host, 'secret-1');
    const text = layerTextBlock(modal.render(100, 30));
    expect(text).not.toContain('secret-1');
    feed(host, '\r');
    expect(host.active).toBe(false);
    expect(printed.join('\n')).toContain('Added local auth user carol');
  });

  test('a too-short password is refused by the manager and the modal stays open', async () => {
    auth.addUser('erin', 'initial-pass', ['admin']);
    const { context } = makeContext(auth, host, true);
    context.openLocalAuthMaskedEntry!('rotate-password', 'erin');
    const modal = host.top() as MaskedEntryModal;
    feed(host, 'short');
    feed(host, '\r');
    expect(host.active).toBe(true);
    expect(modal.error).toContain('at least 8 characters');
    expect(layerTextBlock(modal.render(100, 30))).toContain('at least 8 characters');
  });

  test('a failed call keeps the modal open with the error and an empty buffer', async () => {
    const { context } = makeContext(auth, host, true);
    context.openLocalAuthMaskedEntry!('rotate-password', 'nobody');
    const modal = host.top() as MaskedEntryModal;
    feed(host, 'long-enough-pw');
    feed(host, '\r');
    expect(host.active).toBe(true);
    expect(modal.error).not.toBeNull();
    expect(modal.passwordLength).toBe(0);
  });

  test('Esc closes the modal and drops the buffer', async () => {
    const { context } = makeContext(auth, host, true);
    context.openLocalAuthMaskedEntry!('rotate-password', 'dave');
    const modal = host.top() as MaskedEntryModal;
    feed(host, 'abc');
    host.escape();
    expect(host.active).toBe(false);
    expect(modal.passwordLength).toBe(0);
  });
});
