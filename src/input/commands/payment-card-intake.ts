/**
 * /payments card, capture a payment card through the composer's concealed
 * input mode, following the same guided-chain pattern as /channel pair
 * (channel-pairing.ts) and the SAME concealed-input mechanism as
 * provider-key-intake.ts (see concealed-input.ts).
 *
 * Card number, expiry, CVV, and cardholder name are secret-tier (see
 * config/secret-config.ts's SECRET_CONFIG_KEYS): each is entered through one
 * masked concealed-input prompt in turn and stored via
 * persistSecretBackedConfigValue, the same secret-manager + config-reference
 * path every other secret-backed setting in this app uses. The plaintext
 * never reaches the transcript, input history, or a log line, only a
 * redacted confirmation is printed after each field.
 *
 * Billing and shipping address are ordinary (non-secret) config fields, now
 * real structured CONFIG_SCHEMA entries (payments.billingAddress.{name,
 * line1, line2, city, region, postalCode, country} and the shippingAddress
 * equivalents), this command points the user at the Payments settings
 * category (or /config payments) to set them, the same way /channel pair
 * directs non-secret credential fields, rather than routing plain text
 * through the concealed (masked) input path where it does not belong.
 *
 * Stored with `scope: 'daemon'`: the daemon, not just this interactive
 * client, is what completes an autonomous purchase, so the credential must
 * land in the daemon-scoped secret tier the daemon actually reads.
 *
 * The config-reference half (the `goodvibes://secrets/...` marker
 * persistSecretBackedConfigValue writes alongside the secret) goes through
 * `ctx.platform.configManager` directly, the same real ConfigManager every
 * other command in this app uses, not a TUI-local store. See
 * payments-config.ts's header comment for why these particular keys
 * (`payments.cardNumber`, etc., flat sub-keys under the SDK's real
 * `payments` section) are ConfigManager-safe even though the SDK's
 * CONFIG_SCHEMA has no scalar entry for them yet: `payments.` is a
 * daemon-owned config prefix, so the reference lands in the daemon's own
 * settings file and is visible to the daemon, the webui and the agent,
 * not just this TUI session.
 *
 * ── Card details are entered only at a local terminal or the webui ────────
 *
 * Owner ruling (see the SDK's platform/payments/entry-surface.ts): card
 * material may be TYPED only on `tui`, `agent-terminal`, or `webui`, never
 * over Telegram, ntfy, Discord, Slack, WhatsApp, Signal, a webhook, or any
 * other remote messaging surface. A card number typed into a hosted chat is
 * stored on that provider's own servers, in history this app cannot erase,
 * and it already passed through their infrastructure before reaching us,
 * our own encryption at rest does nothing for a value copied elsewhere on
 * its way in. This is a SEPARATE question from which surfaces may APPROVE or
 * VETO a purchase (every command-authority channel still can); the two are
 * never merged into one check.
 *
 * This command always runs inside the TUI's own composer (CARD_ENTRY_SURFACE
 * below), which the SDK's allowlist accepts, so this gate changes nothing
 * about today's behavior. What it buys is that the refusal already exists
 * the moment this app (or a shared command registry) ever grows a path that
 * lets `/payments card` be reached from somewhere else: the check is real
 * and SDK-driven, not an implicit "this is the TUI so it's fine" assumption.
 */

import type { CommandRegistry, CommandContext } from '../command-registry.ts';
import { persistSecretBackedConfigValue } from '../../config/secret-config.ts';
import type { ConfigKey } from '@pellux/goodvibes-sdk/platform/config';
import { describeCardEntryRefusal, mayOfferCardEntryFlow } from '@pellux/goodvibes-sdk/platform/payments';
import {
  PAYMENTS_CARD_NUMBER_CONFIG_KEY,
  PAYMENTS_CARD_EXPIRY_CONFIG_KEY,
  PAYMENTS_CARD_CVV_CONFIG_KEY,
  PAYMENTS_CARD_CARDHOLDER_NAME_CONFIG_KEY,
} from '../payments-config.ts';

/**
 * This command is wired only into the TUI's own composer command registry,
 * it is never reachable from a channel bridge (Telegram, Discord, ...), each
 * of which has its own separate command surface in the daemon. The constant
 * still names the surface explicitly and is checked through the SDK's own
 * allowlist below, rather than skipping the check because "this is the TUI".
 */
export const CARD_ENTRY_SURFACE = 'tui';

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

function fieldConfigured(ctx: CommandContext, field: CardField): boolean {
  const raw: unknown = ctx.platform.configManager.get(field.key);
  return typeof raw === 'string' && raw.trim().length > 0;
}

function renderCardStatus(ctx: CommandContext): string[] {
  const lines = ['Payment card on file:'];
  for (const field of CARD_SECRET_FIELDS) {
    lines.push(`  ${field.label.padEnd(20)} ${fieldConfigured(ctx, field) ? 'set' : 'not set'}`);
  }
  lines.push('');
  lines.push('Run /payments card to enter or replace the card (masked input, chained prompts).');
  lines.push('Billing/shipping address, budgets, windows and the rest of the payment capability are ordinary config values: set them via /config payments or the Settings > Payments category.');
  return lines;
}

/** Chain a masked prompt for each card secret field, storing each through the daemon-scoped secret tier. */
function promptCardFields(ctx: CommandContext, fields: readonly CardField[], index: number): void {
  if (index >= fields.length) {
    ctx.print('\nCard stored. Billing/shipping address and the rest of the payment capability are ordinary config values; set them via /config payments or the Settings > Payments category.');
    ctx.renderRequest();
    return;
  }
  const field = fields[index]!;
  if (!ctx.beginConcealedInput) {
    ctx.print('[payments] Concealed input is unavailable on this surface; card entry requires it and cannot fall back to plaintext.');
    return;
  }
  ctx.print(`[payments] Enter ${field.label} (e.g. ${field.placeholder}): masked; Enter to store, Esc to stop.`);
  ctx.beginConcealedInput({
    label: field.label,
    onSubmit: (value) => {
      if (value.length === 0) {
        ctx.print(`[payments] ${field.label} left unset.`);
        promptCardFields(ctx, fields, index + 1);
        return;
      }
      void persistSecretBackedConfigValue(
        ctx.platform.configManager,
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

/**
 * Start the card-entry flow, gated on the SDK's own entry-surface allowlist
 * rather than an assumption baked into this command. `surface` defaults to
 * this command's real, fixed identity (CARD_ENTRY_SURFACE), exposed as a
 * parameter only so tests can drive the refusal path without needing this
 * app to actually be reachable from a remote channel.
 */
export function startCardEntryFlow(ctx: CommandContext, surface: string = CARD_ENTRY_SURFACE): void {
  if (!mayOfferCardEntryFlow(surface)) {
    ctx.print(describeCardEntryRefusal(surface));
    return;
  }
  if (!ctx.beginConcealedInput) {
    ctx.print('[payments] Concealed input is unavailable on this surface.');
    return;
  }
  ctx.print(`Entering ${CARD_SECRET_FIELDS.length} card field(s): masked; Esc to stop at any point.`);
  promptCardFields(ctx, CARD_SECRET_FIELDS, 0);
}

/** Entry point for `/payments [card|status]`, exported directly so tests can drive it without the registry. */
export function runPaymentsCommand(args: readonly string[], ctx: CommandContext): void {
  const sub = (args[0] ?? '').toLowerCase();
  if (sub === '' || sub === 'status') {
    ctx.print(renderCardStatus(ctx).join('\n'));
    return;
  }
  if (sub === 'card') {
    startCardEntryFlow(ctx);
    return;
  }
  ctx.print('Usage: /payments [card|status]');
}

/** Card secret fields in prompt order, exported for tests that need to drive the chain field-by-field. */
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
