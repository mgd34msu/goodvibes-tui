import { describe, expect, test } from 'bun:test';
import { installProcessLifecycle, type ProcessLifecycleDeps } from '../../runtime/process-lifecycle.ts';
import type { BootstrapContext } from '../../runtime/bootstrap.ts';

/**
 * What an escaped promise rejection is CALLED. The generic formatter used to
 * caption every unclassifiable rejection "Provider error", which shipped a
 * startup UI crash ("Cannot access 'render' before initialization") dressed
 * as a model-backend failure. An unhandled rejection with no recognizable
 * provider signature is a GoodVibes bug and must say so; one that IS
 * classifiable (auth, network...) keeps its specific line.
 */

function makeHandler(): { handle: (reason: unknown) => void; messages: string[] } {
  const messages: string[] = [];
  const ctx = {
    systemMessageRouter: { high: (m: string) => { messages.push(m); }, low: () => {} },
  } as unknown as BootstrapContext;
  const deps = {
    stdin: { setRawMode: () => {}, removeAllListeners: () => {} },
    stdout: { write: () => true, removeListener: () => {} },
    ctx,
    noAltScreen: false,
    ansi: { CLEAR_SCREEN: '', ALT_SCREEN_EXIT: '', PASTE_DISABLE: '', KEYBOARD_EXT_DISABLE: '', MOUSE_DISABLE: '', CURSOR_SHOW: '', FOCUS_DISABLE: '' },
    getInput: () => { throw new Error('not used'); },
    render: () => {},
    getTerminalOutputGuard: () => ({ dispose: () => {} }),
    getPromptContentWidth: () => 80,
    buildSessionContinuityHints: () => ({}),
    unsubs: [],
    getRecoveryInterval: () => null,
    setRecoveryInterval: () => {},
    getStopSpokenOutputForExit: () => null,
  } as unknown as ProcessLifecycleDeps;
  const handlers = installProcessLifecycle(deps);
  return { handle: handlers.unhandledRejectionHandler, messages };
}

describe('unhandledRejection labeling', () => {
  test('an unclassifiable rejection is called a GoodVibes bug, not a provider error', () => {
    const { handle, messages } = makeHandler();
    handle(new ReferenceError("Cannot access 'render' before initialization"));
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatch(/GoodVibes bug/);
    expect(messages[0]).not.toMatch(/provider error/i);
    expect(messages[0]).toContain("Cannot access 'render' before initialization");
  });

  test('a classifiable rejection keeps its specific line', () => {
    const { handle, messages } = makeHandler();
    handle(new Error('fetch failed'));
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatch(/network error/i);
    expect(messages[0]).not.toMatch(/GoodVibes bug/);
  });

  test('a provider-shaped 5xx is never blamed on GoodVibes', () => {
    // The classifier has no 5xx rule, so a provider outage classifies
    // generic; the provider/statusCode markers are what keep the caption
    // honest.
    const { handle, messages } = makeHandler();
    const outage = Object.assign(new Error('OpenAI Codex API error 503: Service Unavailable'), {
      provider: 'openai-subscriber',
      statusCode: 503,
    });
    handle(outage);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatch(/Unexpected error/);
    expect(messages[0]).not.toMatch(/GoodVibes bug/);
    expect(messages[0]).toMatch(/\/model/);
  });
});
