/**
 * Behavior verification for the payment capability's CONFIG_SCHEMA settings.
 *
 * The SDK's `payments` section grew from a bare cvvHandling selector this app
 * used to fake locally into a full 28-key domain (enabled, defaultCardId,
 * currency, cvvHandling, six budget keys, shipping.preferredTier, the
 * fourteen billing/shipping address sub-fields, two approval/veto windows,
 * and notifyChannels). That grew the settings inventory the verification
 * ledger counts (`total`) without adding matching local behavior coverage,
 * which pushed `localBehaviorPercent` below its floor.
 *
 * These tests supply that missing coverage: for every key in
 * PAYMENTS_LOCAL_SETTINGS they exercise the real persistence behavior end to
 * end — schema default, `set()` write to disk, reload into a fresh
 * ConfigManager, read-back equality, and reset-to-default — through the
 * actual ConfigManager, not a mock. Passing here is what makes counting these
 * keys as behavior-verified in the ledger honest.
 *
 * Card MATERIAL (number, expiry, CVV, cardholder name) is deliberately absent
 * from PAYMENTS_LOCAL_SETTINGS and from this file: those four fields are not
 * CONFIG_SCHEMA keys at all (see input/payments-config.ts) — their own
 * containment and daemon-scope coverage lives in
 * src/test/security/payments-cvv-containment.test.ts.
 */
import { describe, test, expect } from 'bun:test';
import { join } from 'node:path';
import { makeProjectTempDir } from '../helpers/project-temp.ts';
import { ConfigManager, CONFIG_SCHEMA } from '@pellux/goodvibes-sdk/platform/config';
import type { ConfigKey } from '@pellux/goodvibes-sdk/platform/config';
import { PAYMENTS_LOCAL_SETTINGS } from '../../verification/verification-ledger.ts';

/**
 * A valid alternate value (distinct from the schema default) for each key,
 * chosen to satisfy the key's own validator. Enum keys pick a different
 * allowed member; numbers move to another in-range integer; booleans flip;
 * strings take a concrete non-empty value that also satisfies any format
 * validator (currency's 3-letter code, notifyChannels' allowed-channel list).
 */
const ALTERNATE_VALUE: Record<string, unknown> = {
  'payments.enabled': true,
  'payments.defaultCardId': 'card_test_fixture_1',
  'payments.currency': 'GBP',
  'payments.cvvHandling': 'prompt',
  'payments.budget.dailyItem': 5,
  'payments.budget.dailyOverage': 2,
  'payments.budget.perPurchaseCeilingEnabled': false,
  'payments.budget.perPurchaseCeiling': 10,
  'payments.budget.overageToleranceEnabled': true,
  'payments.budget.overageToleranceDailyAllowance': 3,
  'payments.shipping.preferredTier': 'fast',
  'payments.billingAddress.name': 'Jane Q. Fakename',
  'payments.billingAddress.line1': '123 Fake St',
  'payments.billingAddress.line2': 'Apt 4',
  'payments.billingAddress.city': 'Faketown',
  'payments.billingAddress.region': 'CA',
  'payments.billingAddress.postalCode': '90210',
  'payments.billingAddress.country': 'US',
  'payments.shippingAddress.name': 'Jane Q. Fakename',
  'payments.shippingAddress.line1': '456 Fake Ave',
  'payments.shippingAddress.line2': 'Suite 9',
  'payments.shippingAddress.city': 'Faketown',
  'payments.shippingAddress.region': 'CA',
  'payments.shippingAddress.postalCode': '90211',
  'payments.shippingAddress.country': 'US',
  'payments.windows.vetoMinutes': 15,
  'payments.windows.approvalMinutes': 90,
  'payments.majorRetailersAdditional': 'example-retailer.com,another-shop.co.uk',
  'payments.majorRetailersExcluded': 'blocked-shop.example',
  'payments.ebayMinSellerFeedbackCount': 250,
  'payments.ebayMinSellerPositivePercent': 99,
  'payments.notifyChannels': 'tui,telegram',
};

const schemaByKey = new Map(CONFIG_SCHEMA.map((s) => [s.key, s]));

function freshManager(): { manager: ConfigManager; root: string; configDir: string } {
  const root = makeProjectTempDir('goodvibes-payments-settings');
  const configDir = join(root, '.config-override');
  const manager = new ConfigManager({ surfaceRoot: 'tui', workingDir: root, configDir });
  return { manager, root, configDir };
}

describe('payments settings — inventory integrity', () => {
  test('PAYMENTS_LOCAL_SETTINGS is exactly the CONFIG_SCHEMA payments.* key set', () => {
    const schemaPaymentsKeys: string[] = CONFIG_SCHEMA
      .map((s): string => s.key)
      .filter((key) => key.startsWith('payments.'))
      .sort();
    const counted: string[] = [...PAYMENTS_LOCAL_SETTINGS].sort();
    expect(counted).toEqual(schemaPaymentsKeys);
  });

  test('every ledger-counted payments key exists in CONFIG_SCHEMA with a defined default', () => {
    for (const key of PAYMENTS_LOCAL_SETTINGS) {
      const schema = schemaByKey.get(key);
      expect(schema, `${key} must be a live CONFIG_SCHEMA key`).toBeDefined();
      expect(schema!.default, `${key} must declare a default`).toBeDefined();
    }
  });

  test('an alternate test value is defined for every key', () => {
    for (const key of PAYMENTS_LOCAL_SETTINGS) {
      expect(ALTERNATE_VALUE[key], `${key} needs an alternate value`).toBeDefined();
      // The alternate must genuinely differ from the default, or the round-trip
      // proves nothing.
      expect(ALTERNATE_VALUE[key]).not.toEqual(schemaByKey.get(key)!.default);
    }
  });
});

describe('payments settings — default exposure', () => {
  test('a fresh ConfigManager returns each key at its schema default', () => {
    const { manager } = freshManager();
    for (const key of PAYMENTS_LOCAL_SETTINGS) {
      const expected = schemaByKey.get(key)!.default;
      expect(manager.get(key as ConfigKey), `${key} default`).toEqual(expected as never);
    }
  });
});

describe('payments settings — write/reload persistence round-trip', () => {
  test('each key persists to disk and reloads into a fresh ConfigManager', () => {
    const { manager, root, configDir } = freshManager();

    // Write every alternate value through the real set() path (validates +
    // saves to disk). payments.* is entirely daemon-owned, so these all land
    // in the daemon tier file rather than the ordinary global settings file —
    // exactly the routing this round's daemon-visibility fix depends on.
    for (const key of PAYMENTS_LOCAL_SETTINGS) {
      manager.set(key as ConfigKey, ALTERNATE_VALUE[key] as never);
      expect(manager.get(key as ConfigKey), `${key} in-memory after set`).toEqual(
        ALTERNATE_VALUE[key] as never,
      );
    }

    // A brand-new manager over the same on-disk config must read every value
    // back — proving the write actually reached durable storage.
    const reloaded = new ConfigManager({ surfaceRoot: 'tui', workingDir: root, configDir });
    reloaded.load();
    for (const key of PAYMENTS_LOCAL_SETTINGS) {
      expect(reloaded.get(key as ConfigKey), `${key} after reload`).toEqual(
        ALTERNATE_VALUE[key] as never,
      );
    }
  });
});

describe('payments settings — reset restores default', () => {
  test('reset returns each key to its schema default and persists that', () => {
    const { manager, root, configDir } = freshManager();

    for (const key of PAYMENTS_LOCAL_SETTINGS) {
      manager.set(key as ConfigKey, ALTERNATE_VALUE[key] as never);
      manager.reset(key as ConfigKey);
      const expected = schemaByKey.get(key)!.default;
      expect(manager.get(key as ConfigKey), `${key} after reset`).toEqual(expected as never);
    }

    const reloaded = new ConfigManager({ surfaceRoot: 'tui', workingDir: root, configDir });
    reloaded.load();
    for (const key of PAYMENTS_LOCAL_SETTINGS) {
      const expected = schemaByKey.get(key)!.default;
      expect(reloaded.get(key as ConfigKey), `${key} default after reload`).toEqual(
        expected as never,
      );
    }
  });
});
