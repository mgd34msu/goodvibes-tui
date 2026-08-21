/**
 * Containment tests for the payment card's CVV (and, where noted, the other
 * card secret fields): a value stored through the daemon secret path must
 * never appear in plaintext anywhere else, not in a log line, not in any
 * rendered frame, not in the settings modal's mid-edit buffer, not in input
 * history, not in any export or diagnostic dump this app can produce.
 *
 * This round also proves the daemon-visibility fix directly: a payment
 * setting written from the TUI lands in the daemon-owned config tier (a real
 * file on disk the daemon reads), never in a TUI-local store and never in
 * the ordinary user/client settings tier; and every card secret this app
 * writes lands at daemon scope, from every entry surface (the settings modal
 * and /payments card alike), not just the one path that happened to pass
 * an explicit scope before this round's fix.
 *
 * Each test below names the one surface it protects and asserts against
 * REAL production code paths (the settings modal's actual render function,
 * the actual /payments card command handler, the actual composer key-route
 * handler, the actual redaction functions a support-bundle export runs
 * through), not a mock standing in for them. A fake CVV value is used
 * throughout; it is never a real card number or code.
 */
import { describe, test, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { mkdirSync, rmSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { logger } from '@pellux/goodvibes-sdk/platform/utils';
import { ConfigManager } from '@pellux/goodvibes-sdk/platform/config';
import { CVV_PROMPT_TRADEOFF_WARNING as SDK_CVV_PROMPT_TRADEOFF_WARNING } from '@pellux/goodvibes-sdk/platform/payments';
import { SecretsManager } from '../../config/secrets.ts';
import { SubscriptionManager } from '@pellux/goodvibes-sdk/platform/config';
import { ServiceRegistry } from '@pellux/goodvibes-sdk/platform/config';
import { createFeatureFlagManager } from '@/runtime/index.ts';
import type { FeatureFlagManager } from '@/runtime/index.ts';
import type { McpRegistry } from '@pellux/goodvibes-sdk/platform/mcp';
import { SettingsModal } from '../../input/settings-modal.ts';
import { renderSettingsModal } from '../../renderer/settings-modal.ts';
import { lineToString, linesToText } from '../setup.ts';
import { buildGoodVibesSecretKey, buildGoodVibesSecretRef, defaultSecretBackedScope, isSecretReferenceValue, persistSecretBackedConfigValue } from '../../config/secret-config.ts';
import type { SecretScope } from '../../config/secrets.ts';
import { setSecretBackedSettingValue } from '../../input/settings-modal-secrets.ts';
import { PAYMENTS_CARD_CVV_CONFIG_KEY, PAYMENTS_CVV_HANDLING_CONFIG_KEY } from '../../input/payments-config.ts';
import { runPaymentsCommand, startCardEntryFlow, CARD_ENTRY_SURFACE, CARD_SECRET_FIELDS } from '../../input/commands/payment-card-intake.ts';
import { mayEnterCardDetails, mayOfferCardEntryFlow, describeCardEntryRefusal } from '@pellux/goodvibes-sdk/platform/payments';
import type { CommandContext } from '../../input/command-registry.ts';
import { handlePromptKeyToken, type KeyRouteState } from '../../input/handler-feed-routes.ts';
import { InputHistory } from '../../input/input-history.ts';
import { redactConfig, collectSensitiveConfigValues, redactSerializedSecrets } from '@pellux/goodvibes-terminal-shell';

const FAKE_CVV = '731';
// Deliberately NOT the command's own placeholder example (4242424242424242,
// shown as static guidance text before any input, e.g. "e.g. 4242..."): using
// a different fake number here means a transcript match on THIS value can
// only come from an actual echo of the typed field, never a coincidental
// match against the always-printed example text.
const FAKE_CARD_NUMBER = '4000056655665556';
// Also deliberately distinct from the command's own placeholder ("e.g. 12/34").
const FAKE_EXPIRY = '09/29';
const FAKE_CARDHOLDER = 'Jane Q. Fakename';

function makeTmpDir(): string {
  const dir = join(tmpdir(), `gv-payments-cvv-containment-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function createConfigManager(root: string): ConfigManager {
  return new ConfigManager({ surfaceRoot: 'tui', workingDir: root, homeDir: root, configDir: join(root, '.goodvibes', 'global-tui') });
}

describe('payments CVV containment', () => {
  const originalCwd = process.cwd();
  const originalHome = process.env.HOME;
  let tmpDir: string;
  let cm: ConfigManager;
  let secrets: SecretsManager;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    process.env.HOME = tmpDir;
    process.chdir(tmpDir);
    cm = createConfigManager(tmpDir);
    secrets = new SecretsManager({
      projectRoot: tmpDir,
      globalHome: tmpDir,
      daemonHome: join(tmpDir, '.goodvibes', 'daemon'),
      configManager: cm,
    });
  });

  afterEach(() => {
    process.chdir(originalCwd);
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // 1. Storage: the config value is a secret reference, never the raw CVV,
  //    AND it lands in the daemon-owned config tier, not a TUI-local file.
  // -------------------------------------------------------------------------
  test('storing the CVV through the daemon secret path writes a goodvibes:// reference to the real ConfigManager, never the raw value', async () => {
    const stored = await persistSecretBackedConfigValue(cm, secrets, PAYMENTS_CARD_CVV_CONFIG_KEY, FAKE_CVV, { scope: 'daemon' });
    expect(stored).not.toBe(FAKE_CVV);
    expect(isSecretReferenceValue(stored)).toBe(true);

    const configValue = cm.get(PAYMENTS_CARD_CVV_CONFIG_KEY);
    expect(configValue).toBe(stored);
    expect(String(configValue)).not.toContain(FAKE_CVV);

    // The reference lives in the daemon's own settings file (payments.* is a
    // daemon-owned config prefix), never in a TUI-local JSON file (there is
    // no such file anymore) and never in the ordinary global/user settings
    // file this same ConfigManager also owns.
    const daemonTierPath = cm.getDaemonTierPath();
    expect(daemonTierPath).not.toBeNull();
    const daemonRaw = JSON.parse(readFileSync(daemonTierPath!, 'utf-8')) as { payments?: { cardCvv?: unknown } };
    expect(daemonRaw.payments?.cardCvv).toBe(stored);
    expect(existsSync(join(tmpDir, '.goodvibes', 'tui', 'payments.json'))).toBe(false);
    // The ordinary global (client-tier) settings file never even needed to be
    // created, nothing in this write touched it, since payments.* is
    // entirely daemon-owned.
    if (existsSync(cm.getConfigPath())) {
      const globalRaw = JSON.parse(readFileSync(cm.getConfigPath(), 'utf-8')) as Record<string, unknown>;
      expect(JSON.stringify(globalRaw)).not.toContain('cardCvv');
    }

    // Functional correctness: the raw value really did land in the secret store,
    // under the daemon scope (the daemon, not just this interactive client,
    // is what needs it for an unattended purchase).
    const secretKey = buildGoodVibesSecretKey('payments.cardCvv');
    expect(configValue).toBe(buildGoodVibesSecretRef(secretKey));
    expect(await secrets.get(secretKey)).toBe(FAKE_CVV);
  });

  // -------------------------------------------------------------------------
  // 1b. A real (non-card) payments setting also lands in the daemon tier,
  //     never a TUI-local file and never the user/client tier.
  // -------------------------------------------------------------------------
  test('a real payments.* setting written from the TUI lands in the daemon-owned config tier, not a TUI-local file and not the user tier', () => {
    cm.setDynamic(PAYMENTS_CVV_HANDLING_CONFIG_KEY, 'prompt');
    const daemonTierPath = cm.getDaemonTierPath()!;
    const daemonRaw = JSON.parse(readFileSync(daemonTierPath, 'utf-8')) as { payments?: { cvvHandling?: unknown } };
    expect(daemonRaw.payments?.cvvHandling).toBe('prompt');

    // Not in the ordinary global (client-tier) settings file, which, since
    // payments.* is entirely daemon-owned, never even needed to be created.
    if (existsSync(cm.getConfigPath())) {
      const globalRaw = JSON.parse(readFileSync(cm.getConfigPath(), 'utf-8')) as Record<string, unknown>;
      expect(JSON.stringify(globalRaw)).not.toContain('cvvHandling');
    }

    // Not in the shared (user) tier either, if one is configured.
    const sharedTierPath = cm.getSharedTierPath();
    if (sharedTierPath && existsSync(sharedTierPath)) {
      const sharedRaw = JSON.parse(readFileSync(sharedTierPath, 'utf-8')) as Record<string, unknown>;
      expect(JSON.stringify(sharedRaw)).not.toContain('cvvHandling');
    }

    // No TUI-local payments store exists anywhere in this workspace.
    expect(existsSync(join(tmpDir, '.goodvibes', 'tui', 'payments.json'))).toBe(false);
  });

  // -------------------------------------------------------------------------
  // 1c. Scope defaulting: every daemon-owned secret-backed key defaults to
  //     daemon scope; a genuinely client-owned key is unaffected.
  // -------------------------------------------------------------------------
  describe('defaultSecretBackedScope: the fix behind every scope assertion below', () => {
    test('daemon-owned keys (payments.*, surfaces.*) default to daemon scope', () => {
      expect(defaultSecretBackedScope(PAYMENTS_CARD_CVV_CONFIG_KEY)).toBe('daemon');
      expect(defaultSecretBackedScope('surfaces.slack.botToken')).toBe('daemon');
      expect(defaultSecretBackedScope('surfaces.telegram.botToken')).toBe('daemon');
    });

    test('a client-owned key is unaffected; still defaults to user scope', () => {
      expect(defaultSecretBackedScope('behavior.autoApprove')).toBe('user');
    });
  });

  // -------------------------------------------------------------------------
  // 1d. The settings modal's generic secret-edit path (setSecretBackedSettingValue)
  //     now writes every daemon-owned secret at daemon scope, the exact bug
  //     this round fixed, generalized past the card special-case.
  // -------------------------------------------------------------------------
  describe('settings modal secret writes land at the right scope (Step 3 fix)', () => {
    function recordingSecretsManager(): { calls: Array<{ key: string; scope: SecretScope | undefined }>; set: (key: string, value: string, options?: { scope?: SecretScope }) => Promise<void>; delete: (key: string, options?: { scope?: SecretScope }) => Promise<void> } {
      const calls: Array<{ key: string; scope: SecretScope | undefined }> = [];
      return {
        calls,
        set: async (key, _value, options) => { calls.push({ key, scope: options?.scope }); },
        delete: async (key, options) => { calls.push({ key, scope: options?.scope }); },
      };
    }

    test('a card secret field (the original bug report) writes at daemon scope, not user', () => {
      const recorder = recordingSecretsManager();
      setSecretBackedSettingValue({
        key: PAYMENTS_CARD_CVV_CONFIG_KEY,
        value: FAKE_CVV,
        configManager: cm,
        secretsManager: recorder,
        setConfigValue: (key, value) => cm.setDynamic(key, value),
      });
      expect(recorder.calls.length).toBeGreaterThan(0);
      for (const call of recorder.calls) expect(call.scope).toBe('daemon');
    });

    test('a messaging-surface secret field (same defect class; surfaces.slack.botToken) also writes at daemon scope', () => {
      const recorder = recordingSecretsManager();
      setSecretBackedSettingValue({
        key: 'surfaces.slack.botToken',
        value: 'xoxb-fake-value-not-real',
        configManager: cm,
        secretsManager: recorder,
        setConfigValue: (key, value) => cm.setDynamic(key, value),
      });
      expect(recorder.calls.length).toBeGreaterThan(0);
      for (const call of recorder.calls) expect(call.scope).toBe('daemon');
    });
  });

  // -------------------------------------------------------------------------
  // 2. Rendered frame: the settings modal table row + doc pane + search results
  // -------------------------------------------------------------------------
  describe('settings modal render surface', () => {
    let modal: SettingsModal;
    const W = 120;

    beforeEach(() => {
      modal = new SettingsModal();
      const ffm: FeatureFlagManager = createFeatureFlagManager();
      const subscriptionManager = new SubscriptionManager(join(tmpDir, '.goodvibes', 'tui', 'subscriptions.json'));
      const serviceRegistry = new ServiceRegistry(join(tmpDir, '.goodvibes', 'tui', 'services.json'), {
        secretsManager: secrets,
        subscriptionManager,
      });
      const mcpRegistry = { listServerSecurity: () => [], setServerTrustMode: () => {} } as unknown as McpRegistry;
      mkdirSync(join(tmpDir, '.goodvibes', 'tui'), { recursive: true });
      modal.open(cm, ffm, subscriptionManager, serviceRegistry, mcpRegistry, secrets);
    });

    function selectCvvEntry(): void {
      while (modal.currentCategory !== 'payments') modal.nextCategory();
      modal.focusPane = 'settings';
      modal.selectedIndex = modal.currentItems.findIndex((entry) => entry.setting.key === PAYMENTS_CARD_CVV_CONFIG_KEY);
      expect(modal.selectedIndex).toBeGreaterThanOrEqual(0);
    }

    test('the CVV row never renders the typed value while editing; table row and the "Current:" doc line', () => {
      selectCvvEntry();
      modal.editingMode = true;
      modal.editBuffer = FAKE_CVV;
      const lines = renderSettingsModal(modal, W);
      const texts = linesToText(lines).join('\n');
      expect(texts).not.toContain(FAKE_CVV);
      // Keystrokes still visibly register: a bullet mask of the same length, plus cursor.
      expect(texts).toContain('•'.repeat(FAKE_CVV.length) + '█');
    });

    test('the settings modal mid-edit buffer for the CVV is masked to bullets of the same length, not the plaintext', () => {
      selectCvvEntry();
      modal.editingMode = true;
      modal.editBuffer = FAKE_CVV;
      // The in-memory editBuffer necessarily holds the plaintext while editing
      // (there is no way to edit a value without holding it somewhere), what
      // must never happen is that value reaching a render. This asserts the
      // render path specifically, the same invariant the row assertion above
      // proves, pinned here under its own name because it is the exact surface
      // named in the containment brief.
      const lines = renderSettingsModal(modal, W);
      const texts = linesToText(lines).join('\n');
      expect(texts).not.toContain(modal.editBuffer);
      expect(texts).toContain('•'.repeat(modal.editBuffer.length));
    });

    test('the CVV never renders at rest either, once stored', async () => {
      await persistSecretBackedConfigValue(cm, secrets, PAYMENTS_CARD_CVV_CONFIG_KEY, FAKE_CVV, { scope: 'daemon' });
      // The modal snapshots entries at open(); re-open to pick up the
      // out-of-band write the same way re-opening the settings workspace
      // after an external change would.
      const ffm: FeatureFlagManager = createFeatureFlagManager();
      const subscriptionManager = new SubscriptionManager(join(tmpDir, '.goodvibes', 'tui', 'subscriptions.json'));
      const serviceRegistry = new ServiceRegistry(join(tmpDir, '.goodvibes', 'tui', 'services.json'), { secretsManager: secrets, subscriptionManager });
      const mcpRegistry = { listServerSecurity: () => [], setServerTrustMode: () => {} } as unknown as McpRegistry;
      modal.open(cm, ffm, subscriptionManager, serviceRegistry, mcpRegistry, secrets);
      selectCvvEntry();
      const lines = renderSettingsModal(modal, W);
      const texts = linesToText(lines).join('\n');
      expect(texts).not.toContain(FAKE_CVV);
    });

    test('search results for the CVV setting also mask the typed value while editing', () => {
      modal.setSearchQuery('cvv');
      const result = modal.searchResults.find((entry) => entry.setting.key === PAYMENTS_CARD_CVV_CONFIG_KEY);
      expect(result).toBeDefined();
      modal.selectedIndex = modal.searchResults.indexOf(result!);
      modal.editingMode = true;
      modal.editBuffer = FAKE_CVV;
      const lines = renderSettingsModal(modal, W);
      const texts = linesToText(lines).join('\n');
      expect(texts).not.toContain(FAKE_CVV);
    });

    test('selecting cvvHandling = prompt states the unattended-purchasing tradeoff at the moment of selection, using the SDK\'s own wording', () => {
      while (modal.currentCategory !== 'payments') modal.nextCategory();
      modal.focusPane = 'settings';
      modal.selectedIndex = modal.currentItems.findIndex((entry) => entry.setting.key === PAYMENTS_CVV_HANDLING_CONFIG_KEY);
      expect(modal.selectedIndex).toBeGreaterThanOrEqual(0);
      modal.adjustSelected('right'); // stored -> prompt (the only two values)
      expect(modal.getSelected()?.currentValue).toBe('prompt');
      expect(modal.lastSettingEffectMessage ?? '').toContain('disables unattended purchasing');
      // The exact SDK string, not a locally-authored copy: this is the
      // shared-string fix (Step 4), a local fork of this text is the drift
      // class that caused the platform's Telegram outage.
      expect(modal.lastSettingEffectMessage).toBe(SDK_CVV_PROMPT_TRADEOFF_WARNING);
      // And it is NOT the old TUI-local literal this session deleted.
      expect(modal.lastSettingEffectMessage).not.toContain('the daemon stops and waits for you to type it before any purchase can complete');
      const lines = renderSettingsModal(modal, W);
      const header = lineToString(lines.find((l) => lineToString(l).includes('disables unattended purchasing')) ?? lines[0]!);
      expect(header).toContain('disables unattended purchasing');
    });
  });

  // -------------------------------------------------------------------------
  // 3. Logging: a failed store never logs the CVV
  // -------------------------------------------------------------------------
  test('a failed CVV store logs the key and the error, never the CVV value', async () => {
    const errorSpy = spyOn(logger, 'error').mockImplementation(() => {});
    try {
      const failingSecretsManager = {
        set: async () => { throw new Error('disk full'); },
        delete: async () => {},
      };
      setSecretBackedSettingValue({
        key: PAYMENTS_CARD_CVV_CONFIG_KEY,
        value: FAKE_CVV,
        // configManager is used only to read storage.secretPolicy (a real key);
        // the actual payments.cardCvv write goes through setConfigValue below.
        configManager: cm,
        secretsManager: failingSecretsManager,
        setConfigValue: (key, value) => cm.setDynamic(key, value),
      });
      // setSecretBackedSettingValue fires the secret write and returns without
      // awaiting it; give the rejected promise's .catch a turn to run.
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(errorSpy).toHaveBeenCalled();
      for (const call of errorSpy.mock.calls) {
        const serialized = JSON.stringify(call);
        expect(serialized).not.toContain(FAKE_CVV);
      }
    } finally {
      errorSpy.mockRestore();
    }
  });

  // -------------------------------------------------------------------------
  // 4. /payments card command: transcript prints and logger calls
  // -------------------------------------------------------------------------
  function makeCommandCtx(): { ctx: CommandContext; printed: string[] } {
    const printed: string[] = [];
    const ctx = {
      platform: { configManager: cm, secretsManager: secrets },
      print: (t: string) => printed.push(t),
      renderRequest: () => {},
      beginConcealedInput: (_request: { onSubmit: (v: string) => void; onCancel?: () => void }) => {},
    } as unknown as CommandContext;
    return { ctx, printed };
  }

  test('the /payments card transcript never prints the raw CVV (or any other card secret field)', async () => {
    const { ctx, printed } = makeCommandCtx();
    const fakeValues: Record<string, string> = {
      'payments.cardNumber': FAKE_CARD_NUMBER,
      'payments.cardExpiry': FAKE_EXPIRY,
      'payments.cardCvv': FAKE_CVV,
      'payments.cardholderName': FAKE_CARDHOLDER,
    };

    // Drive the full chained flow by capturing each beginConcealedInput call
    // and immediately "typing" the fake value for that field, exactly the way
    // the real composer delivers a concealed submission (plaintext passed once
    // to onSubmit, never read back from a rendered buffer).
    let submissions = 0;
    const ctxWithChain = {
      ...ctx,
      beginConcealedInput: (request: { onSubmit: (v: string) => void }) => {
        const field = CARD_SECRET_FIELDS[submissions];
        submissions += 1;
        expect(field).toBeDefined();
        request.onSubmit(fakeValues[field!.key as string] ?? '');
      },
    } as unknown as CommandContext;

    runPaymentsCommand(['card'], ctxWithChain);
    // Every persistSecretBackedConfigValue call is fire-and-forget (async);
    // give them a turn to settle before asserting on printed output.
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(submissions).toBe(CARD_SECRET_FIELDS.length);
    const transcript = printed.join('\n');
    for (const value of Object.values(fakeValues)) {
      expect(transcript).not.toContain(value);
    }
    expect(transcript).toContain('stored securely (hidden)');

    // Functional correctness alongside containment: the four references landed
    // in the real ConfigManager (daemon tier), and each secret resolves to the
    // fake plaintext at daemon scope.
    for (const field of CARD_SECRET_FIELDS) {
      const configValue = cm.get(field.key);
      expect(typeof configValue).toBe('string');
      expect(isSecretReferenceValue(configValue as string)).toBe(true);
      const secretKey = buildGoodVibesSecretKey(field.key);
      expect(await secrets.get(secretKey)).toBe(fakeValues[field.key as string]);
    }
  });

  test('/payments status never prints the raw CVV, only set/not-set', async () => {
    await persistSecretBackedConfigValue(cm, secrets, PAYMENTS_CARD_CVV_CONFIG_KEY, FAKE_CVV, { scope: 'daemon' });
    const { ctx, printed } = makeCommandCtx();
    runPaymentsCommand(['status'], ctx);
    const transcript = printed.join('\n');
    expect(transcript).not.toContain(FAKE_CVV);
    expect(transcript).toContain('CVV');
    expect(transcript).toContain('set');
  });

  // -------------------------------------------------------------------------
  // 4b. Card details are entered only at a local terminal or the webui,
  //     the entry-surface boundary is decided by the SDK's own allowlist,
  //     never a local literal in this command.
  // -------------------------------------------------------------------------
  describe('card entry is gated on the SDK entry-surface allowlist', () => {
    test("this command's own surface (CARD_ENTRY_SURFACE) is a real entry surface, per the SDK", () => {
      expect(CARD_ENTRY_SURFACE).toBe('tui');
      expect(mayEnterCardDetails(CARD_ENTRY_SURFACE)).toBe(true);
      expect(mayOfferCardEntryFlow(CARD_ENTRY_SURFACE)).toBe(true);
    });

    test('a remote messaging surface is refused by the SDK allowlist itself, not a local literal', () => {
      for (const remote of ['telegram', 'discord', 'slack', 'whatsapp', 'signal', 'ntfy', 'webhook']) {
        expect(mayEnterCardDetails(remote)).toBe(false);
        expect(mayOfferCardEntryFlow(remote)).toBe(false);
      }
    });

    test('startCardEntryFlow refuses to begin when driven with a non-entry surface, printing the SDK\'s own refusal text', () => {
      const { ctx, printed } = makeCommandCtx();
      let concealedInputOffered = false;
      const ctxNoConceal = {
        ...ctx,
        beginConcealedInput: () => { concealedInputOffered = true; },
      } as unknown as CommandContext;

      startCardEntryFlow(ctxNoConceal, 'telegram');

      // The flow must never even OFFER the masked-input prompt on a surface
      // that cannot accept the answer, prompting is itself the harm (see
      // payment-card-intake.ts's header).
      expect(concealedInputOffered).toBe(false);
      const transcript = printed.join('\n');
      expect(transcript).toBe(describeCardEntryRefusal('telegram'));
      expect(transcript).toContain("can't take card details over telegram");
      // No card field prompt text ever printed.
      for (const field of CARD_SECRET_FIELDS) {
        expect(transcript).not.toContain(`Enter ${field.label}`);
      }
    });

    test('startCardEntryFlow proceeds normally on this command\'s real surface (tui); unchanged behavior', () => {
      const { ctx, printed } = makeCommandCtx();
      let concealedInputOffered = false;
      const ctxWithConceal = {
        ...ctx,
        beginConcealedInput: () => { concealedInputOffered = true; },
      } as unknown as CommandContext;

      startCardEntryFlow(ctxWithConceal, CARD_ENTRY_SURFACE);

      expect(concealedInputOffered).toBe(true);
      expect(printed.join('\n')).not.toContain("can't take card details");
    });

    test('runPaymentsCommand(["card"], ...), the real registered command, uses this same gate (defaults to CARD_ENTRY_SURFACE)', () => {
      const { ctx } = makeCommandCtx();
      let concealedInputOffered = false;
      const ctxWithConceal = {
        ...ctx,
        beginConcealedInput: () => { concealedInputOffered = true; },
      } as unknown as CommandContext;
      runPaymentsCommand(['card'], ctxWithConceal);
      expect(concealedInputOffered).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // 5. Input history: a concealed CVV submission never reaches arrow-up recall
  // -------------------------------------------------------------------------
  test('submitting the CVV through concealed input never reaches the composer input history', () => {
    const history = new InputHistory({ persist: false, userRoot: tmpDir });
    const addSpy = spyOn(history, 'add');

    // Minimal KeyRouteState: submitConcealedInput simulates the composer's
    // real InputHandler.submitConcealedInput, which returns true and delivers
    // the plaintext when concealed mode is active, see concealed-input.ts's
    // submitConcealedInputFor. The real enter-key route
    // (handlePromptKeyToken in handler-feed-routes.ts) is driven directly here,
    // not reimplemented, so this proves the actual ordering: the concealed
    // branch returns before the history.add() call is ever reached.
    let delivered: string | null = null;
    const state = {
      prompt: FAKE_CVV,
      cursorPos: FAKE_CVV.length,
      inputScrollTop: 0,
      commandMode: false,
      contentWidth: 80,
      maxInputRows: 8,
      inputHistory: history,
      indicatorFocused: false,
      conversationManager: null,
      commandContext: undefined,
      autocomplete: null,
      blockActionsMenu: { open: () => {} },
      getBlockAnchorLine: () => 0,
      openFleetPanel: () => {},
      modalOpened: () => {},
      saveUndoState: () => {},
      breakUndoCoalesce: () => {},
      ensureInputCursorVisible: () => {},
      getWrappedPromptInfo: () => ({ wrappedLines: [''], segments: [], cursorWrappedLine: 0 }),
      moveCursorVertical: () => false,
      handlePathCompletion: () => false,
      handleBlockToggle: () => {},
      findMarkerAtPos: () => null,
      cleanupMarkerRegistry: () => {},
      expandPrompt: (t: string) => t,
      scroll: () => {},
      exitApp: () => {},
      requestRender: () => {},
      submitConcealedInput: (value: string) => { delivered = value; return true; },
    } as unknown as KeyRouteState;

    handlePromptKeyToken(state, { type: 'key', name: 'enter', logicalName: 'enter', ctrl: false, shift: false, meta: false } as never);

    // Widening cast: `delivered` is only ever reassigned inside the
    // `submitConcealedInput` closure above, and TS's control-flow narrowing
    // does not see across that call boundary, it keeps treating the
    // variable as pinned to its literal `null` initializer here.
    expect(delivered as string | null).toBe(FAKE_CVV);
    expect(addSpy).not.toHaveBeenCalled();
    expect(history.getEntries()).toEqual([]);
    expect(history.getEntries().join('\n')).not.toContain(FAKE_CVV);
  });

  // -------------------------------------------------------------------------
  // 6. Diagnostic dumps / exports: the redaction pass a support-bundle export
  //    runs its raw config through (src/cli/redaction.ts, used by
  //    handleBundleCommand's `export` subcommand in src/cli/bundle-command.ts)
  // -------------------------------------------------------------------------
  describe('support-bundle redaction (src/cli/redaction.ts)', () => {
    test('the real storage path never leaves plaintext for redaction to catch in the first place', async () => {
      await persistSecretBackedConfigValue(cm, secrets, PAYMENTS_CARD_CVV_CONFIG_KEY, FAKE_CVV, { scope: 'daemon' });
      const rawConfig = { payments: { cardCvv: cm.get(PAYMENTS_CARD_CVV_CONFIG_KEY) } };
      const redacted = redactConfig(rawConfig);
      // Not redacted (a goodvibes:// reference is intentionally left visible,
      // see shouldRedactValue in redaction.ts), but it is also not the CVV.
      expect(JSON.stringify(redacted.value)).not.toContain(FAKE_CVV);
      expect(String((redacted.value as { payments: { cardCvv: unknown } }).payments.cardCvv)).toMatch(/^goodvibes:\/\/secrets\//);
    });

    test('DEFECT FOUND AND FIXED: a raw literal under payments.card* is redacted by name, not just by suffix', () => {
      // Before this session's fix, isSensitiveConfigPath's suffix pattern
      // (…secret|password|token|keyFile$) did not match "cardNumber",
      // "cardExpiry" or "cardholderName", so if a raw value were EVER stored
      // under one of these keys instead of a goodvibes:// reference (a bug
      // elsewhere, not the normal path exercised above), a support-bundle
      // export would have carried it in plaintext. This proves the backstop:
      // every one of the four card-material keys is redacted regardless of
      // its raw value.
      const rawConfig = {
        payments: {
          cardNumber: FAKE_CARD_NUMBER,
          cardExpiry: FAKE_EXPIRY,
          cardCvv: FAKE_CVV,
          cardholderName: FAKE_CARDHOLDER,
          // Real shape now: billingAddress is a structured SDK config object
          // (payments.billingAddress.line1, etc.), not a card-material field.
          billingAddress: { line1: '123 Fake St' },
        },
      };
      const redacted = redactConfig(rawConfig);
      const serialized = JSON.stringify(redacted.value);
      expect(serialized).not.toContain(FAKE_CVV);
      expect(serialized).not.toContain(FAKE_CARD_NUMBER);
      expect(serialized).not.toContain(FAKE_EXPIRY);
      expect(serialized).not.toContain(FAKE_CARDHOLDER);
      // The non-card, non-secret field is untouched, redaction is scoped to
      // the four card-material fields, not to the whole payments domain.
      expect(serialized).toContain('123 Fake St');
      expect(redacted.redactedPaths).toContain('payments.cardNumber');
      expect(redacted.redactedPaths).toContain('payments.cardCvv');

      const collected = collectSensitiveConfigValues(rawConfig);
      expect(collected).toContain(FAKE_CVV);
      const serializedBundle = redactSerializedSecrets(JSON.stringify(rawConfig), collected);
      expect(serializedBundle).not.toContain(FAKE_CVV);
      expect(serializedBundle).not.toContain(FAKE_CARD_NUMBER);
    });
  });
});
