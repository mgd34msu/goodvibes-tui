/**
 * Containment tests for the payment card's CVV (and, where noted, the other
 * card secret fields): a value stored through the daemon secret path must
 * never appear in plaintext anywhere else — not in a log line, not in any
 * rendered frame, not in the settings modal's mid-edit buffer, not in input
 * history, not in any export or diagnostic dump this app can produce.
 *
 * Each test below names the one surface it protects and asserts against
 * REAL production code paths (the settings modal's actual render function,
 * the actual /payments card command handler, the actual composer key-route
 * handler, the actual redaction functions a support-bundle export runs
 * through) — not a mock standing in for them. A fake CVV value is used
 * throughout; it is never a real card number or code.
 */
import { describe, test, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { mkdirSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { logger } from '@pellux/goodvibes-sdk/platform/utils';
import { ConfigManager } from '@pellux/goodvibes-sdk/platform/config';
import { SecretsManager } from '../../config/secrets.ts';
import { SubscriptionManager } from '@pellux/goodvibes-sdk/platform/config';
import { ServiceRegistry } from '@pellux/goodvibes-sdk/platform/config';
import { createFeatureFlagManager } from '@/runtime/index.ts';
import type { FeatureFlagManager } from '@/runtime/index.ts';
import type { McpRegistry } from '@pellux/goodvibes-sdk/platform/mcp';
import { SettingsModal } from '../../input/settings-modal.ts';
import { renderSettingsModal } from '../../renderer/settings-modal.ts';
import { lineToString, linesToText } from '../setup.ts';
import { buildGoodVibesSecretKey, buildGoodVibesSecretRef, isSecretReferenceValue, persistSecretBackedConfigValue } from '../../config/secret-config.ts';
import { setSecretBackedSettingValue } from '../../input/settings-modal-secrets.ts';
import { PAYMENTS_CARD_CVV_CONFIG_KEY, PAYMENTS_CVV_HANDLING_CONFIG_KEY } from '../../input/payments-config.ts';
import { PaymentsConfigStore } from '../../input/payments-store.ts';
import { runPaymentsCommand, CARD_SECRET_FIELDS } from '../../input/commands/payment-card-intake.ts';
import type { CommandContext } from '../../input/command-registry.ts';
import { handlePromptKeyToken, type KeyRouteState } from '../../input/handler-feed-routes.ts';
import { InputHistory } from '../../input/input-history.ts';
import { redactConfig, collectSensitiveConfigValues, redactSerializedSecrets } from '../../cli/redaction.ts';

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
  let paymentsStore: PaymentsConfigStore;

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
    // payments.* has no ConfigManager section (see payments-config.ts's
    // header comment) — every payments key in this suite is read/written
    // through PaymentsConfigStore, never the real ConfigManager.
    paymentsStore = new PaymentsConfigStore(join(tmpDir, '.goodvibes', 'tui', 'payments.json'));
  });

  afterEach(() => {
    process.chdir(originalCwd);
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // 1. Storage: the config value is a secret reference, never the raw CVV
  // -------------------------------------------------------------------------
  test('storing the CVV through the daemon secret path writes a goodvibes:// reference to config, never the raw value', async () => {
    const stored = await persistSecretBackedConfigValue(paymentsStore, secrets, PAYMENTS_CARD_CVV_CONFIG_KEY, FAKE_CVV, { scope: 'daemon' });
    expect(stored).not.toBe(FAKE_CVV);
    expect(isSecretReferenceValue(stored)).toBe(true);

    const configValue = paymentsStore.get(PAYMENTS_CARD_CVV_CONFIG_KEY);
    expect(configValue).toBe(stored);
    expect(String(configValue)).not.toContain(FAKE_CVV);

    // Functional correctness: the raw value really did land in the secret store,
    // under the daemon scope (the daemon — not just this interactive client —
    // is what needs it for an unattended purchase).
    const secretKey = buildGoodVibesSecretKey('payments.card.cvv');
    expect(configValue).toBe(buildGoodVibesSecretRef(secretKey));
    expect(await secrets.get(secretKey)).toBe(FAKE_CVV);
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
      modal.open(cm, ffm, subscriptionManager, serviceRegistry, mcpRegistry, secrets, { paymentsStore });
    });

    function selectCvvEntry(): void {
      while (modal.currentCategory !== 'payments') modal.nextCategory();
      modal.focusPane = 'settings';
      modal.selectedIndex = modal.currentItems.findIndex((entry) => entry.setting.key === PAYMENTS_CARD_CVV_CONFIG_KEY);
      expect(modal.selectedIndex).toBeGreaterThanOrEqual(0);
    }

    test('the CVV row never renders the typed value while editing — table row and the "Current:" doc line', () => {
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
      // (there is no way to edit a value without holding it somewhere) — what
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
      await persistSecretBackedConfigValue(paymentsStore, secrets, PAYMENTS_CARD_CVV_CONFIG_KEY, FAKE_CVV, { scope: 'daemon' });
      // The modal snapshots entries at open(); re-open to pick up the
      // out-of-band write the same way re-opening the settings workspace
      // after an external change would.
      const ffm: FeatureFlagManager = createFeatureFlagManager();
      const subscriptionManager = new SubscriptionManager(join(tmpDir, '.goodvibes', 'tui', 'subscriptions.json'));
      const serviceRegistry = new ServiceRegistry(join(tmpDir, '.goodvibes', 'tui', 'services.json'), { secretsManager: secrets, subscriptionManager });
      const mcpRegistry = { listServerSecurity: () => [], setServerTrustMode: () => {} } as unknown as McpRegistry;
      modal.open(cm, ffm, subscriptionManager, serviceRegistry, mcpRegistry, secrets, { paymentsStore });
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

    test('selecting cvvHandling = prompt states the unattended-purchasing tradeoff at the moment of selection', () => {
      while (modal.currentCategory !== 'payments') modal.nextCategory();
      modal.focusPane = 'settings';
      modal.selectedIndex = modal.currentItems.findIndex((entry) => entry.setting.key === PAYMENTS_CVV_HANDLING_CONFIG_KEY);
      expect(modal.selectedIndex).toBeGreaterThanOrEqual(0);
      modal.adjustSelected('right'); // stored -> prompt (the only two values)
      expect(modal.getSelected()?.currentValue).toBe('prompt');
      expect(modal.lastSettingEffectMessage ?? '').toContain('disables unattended purchasing');
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
        // the actual payments.card.cvv write goes through setConfigValue below.
        configManager: cm,
        secretsManager: failingSecretsManager,
        setConfigValue: (key, value) => paymentsStore.setDynamic(key, value),
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
    let pendingConceal: { onSubmit: (v: string) => void; onCancel?: () => void } | null = null;
    const ctx = {
      platform: { configManager: cm, secretsManager: secrets },
      // The command resolves its own PaymentsConfigStore from
      // workspace.shellPaths.resolveUserPath('tui', 'payments.json') — see
      // resolvePaymentsStore in payment-card-intake.ts — the same tmpDir the
      // rest of this suite's paymentsStore instance already points at, so
      // reads/writes through either agree.
      workspace: {
        // Matches the real ShellPathService.resolveUserPath convention
        // (join(homeDirectory, '.goodvibes', ...segments)) so this points at
        // the SAME payments.json this suite's own paymentsStore instance uses.
        shellPaths: { resolveUserPath: (...segments: string[]) => join(tmpDir, '.goodvibes', ...segments) },
      },
      print: (t: string) => printed.push(t),
      renderRequest: () => {},
      beginConcealedInput: (request: { onSubmit: (v: string) => void; onCancel?: () => void }) => {
        pendingConceal = request;
      },
    } as unknown as CommandContext;
    return { ctx, printed };
  }

  test('the /payments card transcript never prints the raw CVV (or any other card secret field)', async () => {
    const { ctx, printed } = makeCommandCtx();
    const fakeValues: Record<string, string> = {
      'payments.card.number': FAKE_CARD_NUMBER,
      'payments.card.expiry': FAKE_EXPIRY,
      'payments.card.cvv': FAKE_CVV,
      'payments.card.cardholderName': FAKE_CARDHOLDER,
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
  });

  test('/payments status never prints the raw CVV, only set/not-set', async () => {
    await persistSecretBackedConfigValue(paymentsStore, secrets, PAYMENTS_CARD_CVV_CONFIG_KEY, FAKE_CVV, { scope: 'daemon' });
    const { ctx, printed } = makeCommandCtx();
    runPaymentsCommand(['status'], ctx);
    const transcript = printed.join('\n');
    expect(transcript).not.toContain(FAKE_CVV);
    expect(transcript).toContain('CVV');
    expect(transcript).toContain('set');
  });

  // -------------------------------------------------------------------------
  // 5. Input history: a concealed CVV submission never reaches arrow-up recall
  // -------------------------------------------------------------------------
  test('submitting the CVV through concealed input never reaches the composer input history', () => {
    const history = new InputHistory({ persist: false, userRoot: tmpDir });
    const addSpy = spyOn(history, 'add');

    // Minimal KeyRouteState: submitConcealedInput simulates the composer's
    // real InputHandler.submitConcealedInput, which returns true and delivers
    // the plaintext when concealed mode is active — see concealed-input.ts's
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
    // does not see across that call boundary — it keeps treating the
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
      await persistSecretBackedConfigValue(paymentsStore, secrets, PAYMENTS_CARD_CVV_CONFIG_KEY, FAKE_CVV, { scope: 'daemon' });
      const rawConfig = { payments: { card: { cvv: paymentsStore.get(PAYMENTS_CARD_CVV_CONFIG_KEY) } } };
      const redacted = redactConfig(rawConfig);
      // Not redacted (a goodvibes:// reference is intentionally left visible —
      // see shouldRedactValue in redaction.ts), but it is also not the CVV.
      expect(JSON.stringify(redacted.value)).not.toContain(FAKE_CVV);
      expect(String((redacted.value as { payments: { card: { cvv: unknown } } }).payments.card.cvv)).toMatch(/^goodvibes:\/\/secrets\//);
    });

    test('DEFECT FOUND AND FIXED: a raw literal under payments.card.* is redacted by path prefix, not just by suffix name', () => {
      // Before this session's fix, isSensitiveConfigPath's suffix pattern
      // (…secret|password|token|keyFile$) did not match "cvv", "number",
      // "expiry" or "cardholderName" — so if a raw value were EVER stored
      // under payments.card.* instead of a goodvibes:// reference (a bug
      // elsewhere, not the normal path exercised above), a support-bundle
      // export would have carried it in plaintext. This proves the backstop:
      // every payments.card.* path is redacted regardless of its raw value.
      const rawConfig = {
        payments: {
          card: {
            number: FAKE_CARD_NUMBER,
            expiry: FAKE_EXPIRY,
            cvv: FAKE_CVV,
            cardholderName: FAKE_CARDHOLDER,
          },
          billingAddress: '123 Fake St',
        },
      };
      const redacted = redactConfig(rawConfig);
      const serialized = JSON.stringify(redacted.value);
      expect(serialized).not.toContain(FAKE_CVV);
      expect(serialized).not.toContain(FAKE_CARD_NUMBER);
      expect(serialized).not.toContain(FAKE_EXPIRY);
      expect(serialized).not.toContain(FAKE_CARDHOLDER);
      // The non-card, non-secret field is untouched — redaction is scoped to
      // payments.card.*, not to the whole payments domain.
      expect(serialized).toContain('123 Fake St');
      expect(redacted.redactedPaths).toContain('payments.card.number');
      expect(redacted.redactedPaths).toContain('payments.card.cvv');

      const collected = collectSensitiveConfigValues(rawConfig);
      expect(collected).toContain(FAKE_CVV);
      const serializedBundle = redactSerializedSecrets(JSON.stringify(rawConfig), collected);
      expect(serializedBundle).not.toContain(FAKE_CVV);
      expect(serializedBundle).not.toContain(FAKE_CARD_NUMBER);
    });
  });
});
