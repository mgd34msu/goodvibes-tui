/**
 * payments-store.ts — the JSON-backed store behind the seven payments.*
 * config keys (see payments-config.ts's header comment for why this exists
 * instead of the real ConfigManager: `payments` has no section anywhere in
 * the SDK's DEFAULT_CONFIG, so ConfigManager.get/setDynamic throw for it).
 *
 * Structurally compatible with SecretBackedConfigManager (get/setDynamic —
 * see config/secret-config.ts), so persistSecretBackedConfigValue works
 * against this store exactly as it does against the real ConfigManager: a
 * card secret field's stored value is always a goodvibes://secrets/...
 * reference, never the raw value, on disk here or anywhere else.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ConfigKey } from '../config/index.ts';
import {
  PAYMENTS_CARD_NUMBER_CONFIG_KEY,
  PAYMENTS_CARD_EXPIRY_CONFIG_KEY,
  PAYMENTS_CARD_CVV_CONFIG_KEY,
  PAYMENTS_CARD_CARDHOLDER_NAME_CONFIG_KEY,
  PAYMENTS_BILLING_ADDRESS_CONFIG_KEY,
  PAYMENTS_SHIPPING_ADDRESS_CONFIG_KEY,
  PAYMENTS_CVV_HANDLING_CONFIG_KEY,
} from './payments-config.ts';

interface PaymentsStoreData {
  cvvHandling?: string;
  cardNumber?: string;
  cardExpiry?: string;
  cardCvv?: string;
  cardholderName?: string;
  billingAddress?: string;
  shippingAddress?: string;
}

const FIELD_BY_KEY: ReadonlyMap<ConfigKey, keyof PaymentsStoreData> = new Map([
  [PAYMENTS_CVV_HANDLING_CONFIG_KEY, 'cvvHandling'],
  [PAYMENTS_CARD_NUMBER_CONFIG_KEY, 'cardNumber'],
  [PAYMENTS_CARD_EXPIRY_CONFIG_KEY, 'cardExpiry'],
  [PAYMENTS_CARD_CVV_CONFIG_KEY, 'cardCvv'],
  [PAYMENTS_CARD_CARDHOLDER_NAME_CONFIG_KEY, 'cardholderName'],
  [PAYMENTS_BILLING_ADDRESS_CONFIG_KEY, 'billingAddress'],
  [PAYMENTS_SHIPPING_ADDRESS_CONFIG_KEY, 'shippingAddress'],
]);

export class PaymentsConfigStore {
  private data: PaymentsStoreData = {};

  constructor(private readonly filePath: string) {
    this.load();
  }

  private load(): void {
    try {
      if (existsSync(this.filePath)) {
        const parsed: unknown = JSON.parse(readFileSync(this.filePath, 'utf-8'));
        if (parsed && typeof parsed === 'object') this.data = parsed as PaymentsStoreData;
      }
    } catch {
      // A corrupt or unreadable file degrades to empty rather than crashing
      // the settings modal — the same posture every synthetic setting in
      // this app takes toward a bad on-disk value.
      this.data = {};
    }
  }

  private save(): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, JSON.stringify(this.data, null, 2) + '\n', 'utf-8');
  }

  get(key: ConfigKey): unknown {
    const field = FIELD_BY_KEY.get(key);
    if (!field) return undefined;
    return this.data[field];
  }

  setDynamic(key: ConfigKey, value: unknown): void {
    const field = FIELD_BY_KEY.get(key);
    if (!field) return;
    this.data[field] = typeof value === 'string' ? value : undefined;
    this.save();
  }
}
