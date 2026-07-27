/**
 * payments-config.ts — TUI-local synthetic settings for the payment card
 * capability.
 *
 * None of these keys are in the SDK's CONFIG_SCHEMA yet, so they follow the
 * same synthetic-entry pattern already used for tts.speed,
 * behavior.notifyAfterSeconds, storage.codeIndexEnabled, etc. in
 * settings-modal-data.ts: a cast ConfigKey, a ConfigSetting descriptor, and a
 * builder that reads the current value defensively (configManager.get
 * returns undefined for a key the SDK schema doesn't know about, rather than
 * throwing).
 *
 * Four fields are secret-tier (see config/secret-config.ts's
 * SECRET_CONFIG_KEYS): card number, expiry, CVV, and cardholder name. Primary
 * entry for those is the concealed-input flow in
 * commands/payment-card-intake.ts; they are also reachable as ordinary
 * secret-backed settings rows here, which is what makes them masked
 * mid-edit — see renderer/settings-modal.ts's currentSettingValue(). Billing
 * and shipping address are ordinary (non-secret) string settings.
 *
 * cvvHandling selects whether the CVV is stored (the default, per the
 * 2026-07-27 payment-capability ruling) or requested at purchase time.
 *
 * Storage: `payments` has no entry anywhere in the SDK's DEFAULT_CONFIG (it
 * added a `worktree` section specifically so worktree-setup-config.ts's keys
 * could live there; there is no equivalent for payments in the installed
 * SDK, 1.18.0). ConfigManager.get/setDynamic walk the dotted path through
 * that object and throw "Invalid config path: section 'payments' does not
 * exist" for a section that was never populated — this is not a
 * defensive-read gap the way tts.speed's missing SUB-key is, it is a missing
 * top-level section, and there is no supported way to add one from outside
 * the SDK package. So these seven keys are NOT backed by the real
 * ConfigManager at all: they're backed by PaymentsConfigStore
 * (payments-store.ts), a small dedicated JSON file — the same shape this app
 * already uses for capabilities that don't fit the SDK's config schema
 * (WatcherRegistry, BookmarkManager, PairingTokenManager, ServiceRegistry,
 * SubscriptionManager). Every reader here takes a structural
 * `PaymentsConfigReader` rather than the SDK's ConfigManager type so it works
 * against either the store or (defensively) a real ConfigManager without
 * fighting TypeScript's generic `get<K>` overload.
 */

import type { ConfigSetting } from '@pellux/goodvibes-sdk/platform/config';
import type { ConfigKey } from '../config/index.ts';
import type { SettingEntry } from './settings-modal-types.ts';

/** Anything that can answer `get(key)` for these seven keys — PaymentsConfigStore in production. */
export interface PaymentsConfigReader {
  readonly get: (key: ConfigKey) => unknown;
}

export const PAYMENTS_CARD_NUMBER_CONFIG_KEY = 'payments.card.number' as ConfigKey;
export const PAYMENTS_CARD_EXPIRY_CONFIG_KEY = 'payments.card.expiry' as ConfigKey;
export const PAYMENTS_CARD_CVV_CONFIG_KEY = 'payments.card.cvv' as ConfigKey;
export const PAYMENTS_CARD_CARDHOLDER_NAME_CONFIG_KEY = 'payments.card.cardholderName' as ConfigKey;
export const PAYMENTS_BILLING_ADDRESS_CONFIG_KEY = 'payments.billingAddress' as ConfigKey;
export const PAYMENTS_SHIPPING_ADDRESS_CONFIG_KEY = 'payments.shippingAddress' as ConfigKey;
export const PAYMENTS_CVV_HANDLING_CONFIG_KEY = 'payments.cvvHandling' as ConfigKey;

export const PAYMENTS_CVV_HANDLING_VALUES = ['stored', 'prompt'] as const;
export type PaymentsCvvHandling = (typeof PAYMENTS_CVV_HANDLING_VALUES)[number];
export const PAYMENTS_CVV_HANDLING_DEFAULT: PaymentsCvvHandling = 'stored';

/**
 * TODO(sdk): switch to the SDK's own CVV_PROMPT_TRADEOFF_WARNING export once
 * @pellux/goodvibes-sdk ships one. As installed (1.18.0) there is no
 * `platform/payments` export at all — verified against the package's
 * `exports` map, and no occurrence of `CVV_PROMPT_TRADEOFF_WARNING` or
 * `cvvHandling` anywhere under node_modules/@pellux/goodvibes-sdk. This
 * wording is this session's own, written so the settings modal can state the
 * tradeoff the moment 'prompt' is selected rather than shipping with no
 * notice at all; replace it with the SDK's exact string once one exists.
 */
export const CVV_PROMPT_TRADEOFF_WARNING =
  'Prompting for the CVV at purchase time disables unattended purchasing: the daemon stops and waits for you to type it before any purchase can complete, so it cannot buy anything while you are away.';

function readStringField(configManager: PaymentsConfigReader, key: ConfigKey): string {
  // Defensive try/catch (belt-and-suspenders, same rationale as
  // worktree-setup-config.ts's readWorktreeSetupList): PaymentsConfigStore
  // never throws for these keys, but a caller that accidentally passes the
  // real ConfigManager here would hit "Invalid config path: section
  // 'payments' does not exist" — this degrades to empty rather than crashing
  // the whole settings modal.
  try {
    const raw = configManager.get(key);
    return typeof raw === 'string' ? raw : '';
  } catch {
    return '';
  }
}

function buildStringFieldEntry(
  configManager: PaymentsConfigReader,
  key: ConfigKey,
  description: string,
): SettingEntry {
  const currentValue = readStringField(configManager, key);
  return {
    setting: { key, type: 'string', default: '', description },
    currentValue,
    isDefault: currentValue === '',
  };
}

export function buildPaymentsCardNumberEntry(configManager: PaymentsConfigReader): SettingEntry {
  return buildStringFieldEntry(
    configManager,
    PAYMENTS_CARD_NUMBER_CONFIG_KEY,
    'Payment card number. Stored through the secret manager; entering it here or via /payments card never shows the typed characters in plaintext.',
  );
}

export function buildPaymentsCardExpiryEntry(configManager: PaymentsConfigReader): SettingEntry {
  return buildStringFieldEntry(
    configManager,
    PAYMENTS_CARD_EXPIRY_CONFIG_KEY,
    'Payment card expiry (MM/YY). Stored through the secret manager, same handling as the card number.',
  );
}

export function buildPaymentsCardCvvEntry(configManager: PaymentsConfigReader): SettingEntry {
  return buildStringFieldEntry(
    configManager,
    PAYMENTS_CARD_CVV_CONFIG_KEY,
    'Payment card CVV. Stored through the secret manager: never logged, never rendered, never shown mid-edit, excluded from every export and diagnostic dump.',
  );
}

export function buildPaymentsCardCardholderNameEntry(configManager: PaymentsConfigReader): SettingEntry {
  return buildStringFieldEntry(
    configManager,
    PAYMENTS_CARD_CARDHOLDER_NAME_CONFIG_KEY,
    'Name on the payment card. Stored through the secret manager, same handling as the card number.',
  );
}

export function buildPaymentsBillingAddressEntry(configManager: PaymentsConfigReader): SettingEntry {
  return buildStringFieldEntry(
    configManager,
    PAYMENTS_BILLING_ADDRESS_CONFIG_KEY,
    'Billing address for the payment card. An ordinary config value — not secret-tier.',
  );
}

export function buildPaymentsShippingAddressEntry(configManager: PaymentsConfigReader): SettingEntry {
  return buildStringFieldEntry(
    configManager,
    PAYMENTS_SHIPPING_ADDRESS_CONFIG_KEY,
    'Default shipping address for purchases. An ordinary config value — not secret-tier.',
  );
}

export function buildPaymentsCvvHandlingEntry(configManager: PaymentsConfigReader): SettingEntry {
  let raw: unknown;
  try {
    raw = configManager.get(PAYMENTS_CVV_HANDLING_CONFIG_KEY);
  } catch {
    raw = undefined;
  }
  const currentValue: PaymentsCvvHandling = raw === 'prompt' ? 'prompt' : PAYMENTS_CVV_HANDLING_DEFAULT;
  const setting: ConfigSetting = {
    key: PAYMENTS_CVV_HANDLING_CONFIG_KEY,
    type: 'enum',
    default: PAYMENTS_CVV_HANDLING_DEFAULT,
    enumValues: [...PAYMENTS_CVV_HANDLING_VALUES],
    description: 'Whether the payment card\'s CVV is stored (the daemon can complete a purchase unattended) or requested at purchase time (a human must be present to type it).',
  };
  return {
    setting,
    currentValue,
    isDefault: currentValue === PAYMENTS_CVV_HANDLING_DEFAULT,
  };
}

/** All payments synthetic entries, in the order they should render. */
export function buildPaymentsSyntheticEntries(configManager: PaymentsConfigReader): SettingEntry[] {
  return [
    buildPaymentsCvvHandlingEntry(configManager),
    buildPaymentsCardNumberEntry(configManager),
    buildPaymentsCardExpiryEntry(configManager),
    buildPaymentsCardCvvEntry(configManager),
    buildPaymentsCardCardholderNameEntry(configManager),
    buildPaymentsBillingAddressEntry(configManager),
    buildPaymentsShippingAddressEntry(configManager),
  ];
}

/** Every payments config key this module owns, for refresh-loop membership checks. */
export const PAYMENTS_SYNTHETIC_CONFIG_KEYS: readonly ConfigKey[] = [
  PAYMENTS_CVV_HANDLING_CONFIG_KEY,
  PAYMENTS_CARD_NUMBER_CONFIG_KEY,
  PAYMENTS_CARD_EXPIRY_CONFIG_KEY,
  PAYMENTS_CARD_CVV_CONFIG_KEY,
  PAYMENTS_CARD_CARDHOLDER_NAME_CONFIG_KEY,
  PAYMENTS_BILLING_ADDRESS_CONFIG_KEY,
  PAYMENTS_SHIPPING_ADDRESS_CONFIG_KEY,
];

export function isPaymentsSyntheticConfigKey(key: string): key is ConfigKey {
  return (PAYMENTS_SYNTHETIC_CONFIG_KEYS as readonly string[]).includes(key);
}

/** Refresh one payments synthetic entry's currentValue/isDefault in place. */
export function refreshPaymentsSyntheticEntry(entry: SettingEntry, configManager: PaymentsConfigReader): void {
  if (entry.setting.key === PAYMENTS_CVV_HANDLING_CONFIG_KEY) {
    const refreshed = buildPaymentsCvvHandlingEntry(configManager);
    entry.currentValue = refreshed.currentValue;
    entry.isDefault = refreshed.isDefault;
    return;
  }
  const currentValue = readStringField(configManager, entry.setting.key as ConfigKey);
  entry.currentValue = currentValue;
  entry.isDefault = currentValue === '';
}
