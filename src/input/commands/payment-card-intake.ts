/**
 * /payments card — capture a payment card through the composer's concealed
 * input mode, following the same guided-chain pattern as /channel pair
 * (channel-pairing.ts) and the SAME concealed-input mechanism as
 * provider-key-intake.ts (see concealed-input.ts).
 *
 * Card number, expiry, CVV, and cardholder name are secret-tier (see
 * config/secret-config.ts's SECRET_CONFIG_KEYS): each is entered through one
 * masked concealed-input prompt in turn and stored via
 * persistSecretBackedConfigValue, the same secret-manager + config-reference
 * path every other secret-backed setting in this app uses. The plaintext
 * never reaches the transcript, input history, or a log line — only a
 * redacted confirmation is printed after each field.
 *
 * Billing and shipping address are ordinary (non-secret) config fields —
 * this command points the user at the Payments settings category (or
 * /config payments) to set them, the same way /channel pair directs
 * non-secret credential fields, rather than routing plain text through the
 * concealed (masked) input path where it does not belong.
 *
 * Stored with `scope: 'daemon'`: the daemon — not just this interactive
 * client — is what completes an autonomous purchase, so the credential must
 * land in the daemon-scoped secret tier the daemon actually reads.
 */

import type { CommandRegistry, CommandContext } from '../command-registry.ts';
import type { ConfigKey } from '../../config/index.ts';
import { persistSecretBackedConfigValue } from '../../config/secret-config.ts';
import {
  PAYMENTS_CARD_NUMBER_CONFIG_KEY,
  PAYMENTS_CARD_EXPIRY_CONFIG_KEY,
  PAYMENTS_CARD_CVV_CONFIG_KEY,
  PAYMENTS_CARD_CARDHOLDER_NAME_CONFIG_KEY,
  PAYMENTS_BILLING_ADDRESS_CONFIG_KEY,
  PAYMENTS_SHIPPING_ADDRESS_CONFIG_KEY,
} from '../payments-config.ts';
import { PaymentsConfigStore } from '../payments-store.ts';

/**
 * The seven payments.* keys have no section in the SDK's ConfigManager (see
 * payments-config.ts's header comment), so this command reads/writes them
 * through PaymentsConfigStore, resolved from the same shellPaths every other
 * command-owned JSON store in this app uses (services.json, watchers.json).
 * A fresh instance per command invocation is fine here: the store loads from
 * disk at construction and saves immediately on every write, and card entry
 * is an interactive, one-user-at-a-time flow — there is no concurrent writer
 * to race against within a single session.
 */
function resolvePaymentsStore(ctx: CommandContext): PaymentsConfigStore | null {
  const shellPaths = ctx.workspace?.shellPaths;
  if (!shellPaths) return null;
  return new PaymentsConfigStore(shellPaths.resolveUserPath('tui', 'payments.json'));
}

interface CardField {
  readonly key: ConfigKey;
  readonly label: string;
  readonly placeholder: string;
}

/** Order matters only for the guided prompt sequence, not for storage. */
const CARD_SECRET_FIELDS: readonly CardField[] = [
  { key: PAYMENTS_CARD_NUMBER_CONFIG_KEY, label: 'Card number', placeholder: '4242424242424242' },
  { key: PAYMENTS_CARD_EXPIRY_CONFIG_KEY, label: 'Expiry (MM/YY)', placeholder: '12/34' },
  { key: PAYMENTS_CARD_CVV_CONFIG_KEY, label: 'CVV', placeholder: '123' },
  { key: PAYMENTS_CARD_CARDHOLDER_NAME_CONFIG_KEY, label: 'Cardholder name', placeholder: 'as printed on the card' },
];

function fieldConfigured(store: PaymentsConfigStore, field: CardField): boolean {
  const raw: unknown = store.get(field.key);
  return typeof raw === 'string' && raw.trim().length > 0;
}

function renderCardStatus(ctx: CommandContext): string[] {
  const store = resolvePaymentsStore(ctx);
  if (!store) return ['[payments] No workspace shell paths are wired on this surface; card status is unavailable.'];
  const lines = ['Payment card on file:'];
  for (const field of CARD_SECRET_FIELDS) {
    lines.push(`  ${field.label.padEnd(20)} ${fieldConfigured(store, field) ? 'set' : 'not set'}`);
  }
  const billing: unknown = store.get(PAYMENTS_BILLING_ADDRESS_CONFIG_KEY);
  const shipping: unknown = store.get(PAYMENTS_SHIPPING_ADDRESS_CONFIG_KEY);
  lines.push(`  ${'Billing address'.padEnd(20)} ${typeof billing === 'string' && billing.trim().length > 0 ? 'set' : 'not set'}`);
  lines.push(`  ${'Shipping address'.padEnd(20)} ${typeof shipping === 'string' && shipping.trim().length > 0 ? 'set' : 'not set'}`);
  lines.push('');
  lines.push('Run /payments card to enter or replace the card (masked input, chained prompts).');
  lines.push('Billing/shipping address are ordinary config values: set them via /config payments or the Settings > Payments category (payments.billingAddress, payments.shippingAddress).');
  return lines;
}

/** Chain a masked prompt for each card secret field, storing each through the daemon-scoped secret tier. */
function promptCardFields(ctx: CommandContext, fields: readonly CardField[], index: number): void {
  if (index >= fields.length) {
    ctx.print('\nCard stored. Billing/shipping address are ordinary config values — set them via /config payments or the Settings > Payments category.');
    ctx.renderRequest();
    return;
  }
  const field = fields[index]!;
  if (!ctx.beginConcealedInput) {
    ctx.print('[payments] Concealed input is unavailable on this surface; card entry requires it and cannot fall back to plaintext.');
    return;
  }
  const store = resolvePaymentsStore(ctx);
  if (!store) {
    ctx.print('[payments] No workspace shell paths are wired on this surface; card entry is unavailable.');
    return;
  }
  ctx.print(`[payments] Enter ${field.label} (e.g. ${field.placeholder}) — masked; Enter to store, Esc to stop.`);
  ctx.beginConcealedInput({
    label: field.label,
    onSubmit: (value) => {
      if (value.length === 0) {
        ctx.print(`[payments] ${field.label} left unset.`);
        promptCardFields(ctx, fields, index + 1);
        return;
      }
      void persistSecretBackedConfigValue(
        store,
        ctx.platform.secretsManager,
        field.key,
        value,
        { scope: 'daemon' },
      )
        .then(() => {
          ctx.print(`[payments] ${field.label} stored securely (hidden).`);
          promptCardFields(ctx, fields, index + 1);
        })
        .catch((error: unknown) => {
          ctx.print(`[payments] Failed to store ${field.label}: ${error instanceof Error ? error.message : String(error)}`);
          promptCardFields(ctx, fields, index + 1);
        });
    },
    onCancel: () => {
      ctx.print(`[payments] Stopped. Re-run /payments card to finish the remaining fields.`);
    },
  });
}

/** Entry point for `/payments [card|status]` — exported directly so tests can drive it without the registry. */
export function runPaymentsCommand(args: readonly string[], ctx: CommandContext): void {
  const sub = (args[0] ?? '').toLowerCase();
  if (sub === '' || sub === 'status') {
    ctx.print(renderCardStatus(ctx).join('\n'));
    return;
  }
  if (sub === 'card') {
    if (!ctx.beginConcealedInput) {
      ctx.print('[payments] Concealed input is unavailable on this surface.');
      return;
    }
    ctx.print(`Entering ${CARD_SECRET_FIELDS.length} card field(s) — masked; Esc to stop at any point.`);
    promptCardFields(ctx, CARD_SECRET_FIELDS, 0);
    return;
  }
  ctx.print('Usage: /payments [card|status]');
}

/** Card secret fields in prompt order — exported for tests that need to drive the chain field-by-field. */
export { CARD_SECRET_FIELDS };

export function registerPaymentCardCommands(registry: CommandRegistry): void {
  registry.register({
    name: 'payments',
    description: 'Payment card on file for daemon-initiated purchases (card entry is masked input)',
    usage: '/payments [card]',
    argsHint: '[card]',
    handler(args, ctx) {
      runPaymentsCommand(args, ctx);
    },
  });
}
