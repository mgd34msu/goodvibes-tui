/**
 * payments-config.ts — TUI-local synthetic settings for the payment card
 * capability's card MATERIAL fields.
 *
 * The SDK's CONFIG_SCHEMA now has a full real `payments` section (28 keys:
 * enabled, defaultCardId, currency, cvvHandling, the six budget keys,
 * shipping.preferredTier, the fourteen billing/shipping address sub-fields
 * (name, line1, line2, city, region, postalCode, country — each repeated for
 * billingAddress and shippingAddress), the two window keys, and
 * notifyChannels — see `@pellux/goodvibes-sdk/platform/config`). Every one of
 * those keys reads and writes through the ordinary CONFIG_SCHEMA-driven path
 * in settings-modal-data.ts's buildSettingGroups, exactly like `relay.*` or
 * any other real SDK domain — no synthetic entry or dedicated store is needed
 * for them, and this module builds none. (An earlier round of this module
 * modeled billing/shipping address as two flat TUI-local strings; the SDK's
 * own structured per-field keys superseded that the moment they shipped, so
 * those two synthetic entries are gone from this file entirely.)
 *
 * What this module still builds synthetic entries for is the four card
 * MATERIAL fields: number, expiry, CVV, cardholder name. Per the SDK's own
 * design (see its schema-domain-payments.ts header and `platform/payments`'s
 * method catalog), card material is deliberately never a config path at all:
 * it lives write-only in the daemon secret store, named by keys the daemon's
 * own `payments.cards.create` control-plane method derives internally. The
 * SDK does not yet expose an equivalent config-level path for a single
 * implicit card the way this app's `/payments card` flow models it, so these
 * four fields are synthetic sub-keys under the SDK's real `payments`
 * section — the same established pattern this codebase already uses for
 * `behavior.notifyAfterSeconds`, `display.themeMode`, etc.: a key one level
 * under an EXISTING section that CONFIG_SCHEMA has no scalar entry for.
 *
 * That one-level-under-an-existing-section shape matters mechanically: the
 * real ConfigManager's dotted-path resolver only throws "Invalid config path"
 * when an INTERMEDIATE segment is missing (e.g. `payments.card.number`, where
 * `card` is not itself a section) — it does not throw for a final leaf that
 * the schema has not declared (`payments.cardNumber`), the same tolerance
 * `display.themeMode` relies on under `display`. So these four keys are named
 * FLAT (`payments.cardNumber`, not `payments.card.number`) specifically so
 * `ConfigManager.get/setDynamic` accepts them — verified against the real
 * ConfigManager (not the fake store this module used before this round): a
 * flat sub-key persists to the real daemon-owned settings file precisely
 * because `payments.` is a `DAEMON_OWNED_CONFIG_PREFIXES` entry, which is
 * exactly what makes the daemon (and every other surface) able to see it
 * after this TUI closes — the thing the local JSON store this module used to
 * use never gave them.
 *
 * All four keys are secret-tier (see config/secret-config.ts's
 * SECRET_CONFIG_KEYS). Primary entry for those is the concealed-input flow in
 * commands/payment-card-intake.ts, itself gated on the SDK's
 * `mayOfferCardEntryFlow` (card details may only be typed at a local
 * terminal or the webui, never over a remote messaging surface — see that
 * file's header); they are also reachable as ordinary secret-backed settings
 * rows here, which is what makes them masked mid-edit — see
 * renderer/settings-modal.ts's currentSettingValue().
 *
 * cvvHandling — real now, not built here — selects whether the CVV is stored
 * (the default, per the 2026-07-27 payment-capability ruling) or requested at
 * purchase time; see `CVV_PROMPT_TRADEOFF_WARNING`, imported directly from
 * `@pellux/goodvibes-sdk/platform/payments` by every caller that needs it
 * (renderer/settings-modal.ts, settings-modal.ts) — no local copy lives here
 * or anywhere else in this app.
 */

import type { ConfigManager } from '@pellux/goodvibes-sdk/platform/config';
import type { ConfigKey } from '../config/index.ts';
import type { SettingEntry } from './settings-modal-types.ts';

/** Real ConfigManager's read surface — these four keys are defensive reads (see header comment). */
export type PaymentsConfigReader = Pick<ConfigManager, 'get'>;

export const PAYMENTS_CARD_NUMBER_CONFIG_KEY = 'payments.cardNumber' as ConfigKey;
export const PAYMENTS_CARD_EXPIRY_CONFIG_KEY = 'payments.cardExpiry' as ConfigKey;
export const PAYMENTS_CARD_CVV_CONFIG_KEY = 'payments.cardCvv' as ConfigKey;
export const PAYMENTS_CARD_CARDHOLDER_NAME_CONFIG_KEY = 'payments.cardholderName' as ConfigKey;

/** The real SDK schema key for the CVV-handling selector — no longer synthetic. */
export const PAYMENTS_CVV_HANDLING_CONFIG_KEY = 'payments.cvvHandling' as ConfigKey;

function readStringField(configManager: PaymentsConfigReader, key: ConfigKey): string {
  // Defensive try/catch, same rationale as worktree-setup-config.ts's
  // readWorktreeSetupList and this codebase's other one-level-under-a-real-
  // section synthetic reads (behavior.notifyAfterSeconds, display.themeMode): the real
  // ConfigManager never throws for these particular keys (verified — see
  // header comment), but degrading to empty rather than crashing the whole
  // settings modal is the same posture every synthetic setting here takes
  // toward an unexpected value.
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
    'Payment card number. Stored through the secret manager at daemon scope; entering it here or via /payments card never shows the typed characters in plaintext.',
  );
}

export function buildPaymentsCardExpiryEntry(configManager: PaymentsConfigReader): SettingEntry {
  return buildStringFieldEntry(
    configManager,
    PAYMENTS_CARD_EXPIRY_CONFIG_KEY,
    'Payment card expiry (MM/YY). Stored through the secret manager at daemon scope, same handling as the card number.',
  );
}

export function buildPaymentsCardCvvEntry(configManager: PaymentsConfigReader): SettingEntry {
  return buildStringFieldEntry(
    configManager,
    PAYMENTS_CARD_CVV_CONFIG_KEY,
    'Payment card CVV. Stored through the secret manager at daemon scope: never logged, never rendered, never shown mid-edit, excluded from every export and diagnostic dump.',
  );
}

export function buildPaymentsCardCardholderNameEntry(configManager: PaymentsConfigReader): SettingEntry {
  return buildStringFieldEntry(
    configManager,
    PAYMENTS_CARD_CARDHOLDER_NAME_CONFIG_KEY,
    'Name on the payment card. Stored through the secret manager at daemon scope, same handling as the card number.',
  );
}

/** All payments synthetic entries (the four card-material fields), in the order they should render. */
export function buildPaymentsSyntheticEntries(configManager: PaymentsConfigReader): SettingEntry[] {
  return [
    buildPaymentsCardNumberEntry(configManager),
    buildPaymentsCardExpiryEntry(configManager),
    buildPaymentsCardCvvEntry(configManager),
    buildPaymentsCardCardholderNameEntry(configManager),
  ];
}

/** Every payments synthetic config key this module owns, for refresh-loop membership checks. */
export const PAYMENTS_SYNTHETIC_CONFIG_KEYS: readonly ConfigKey[] = [
  PAYMENTS_CARD_NUMBER_CONFIG_KEY,
  PAYMENTS_CARD_EXPIRY_CONFIG_KEY,
  PAYMENTS_CARD_CVV_CONFIG_KEY,
  PAYMENTS_CARD_CARDHOLDER_NAME_CONFIG_KEY,
];

export function isPaymentsSyntheticConfigKey(key: string): key is ConfigKey {
  return (PAYMENTS_SYNTHETIC_CONFIG_KEYS as readonly string[]).includes(key);
}

/** Refresh one payments synthetic entry's currentValue/isDefault in place. */
export function refreshPaymentsSyntheticEntry(entry: SettingEntry, configManager: PaymentsConfigReader): void {
  const currentValue = readStringField(configManager, entry.setting.key as ConfigKey);
  entry.currentValue = currentValue;
  entry.isDefault = currentValue === '';
}
