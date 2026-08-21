/**
 * channel-pairing.ts, guided `/channel pair` flow.
 *
 * Adapters and their credential requirements are driven from the SDK's
 * getBuiltinSetupSchema, the same setup-schema source every GoodVibes
 * consumer (TUI, webui, agent) reads, not a hand-maintained list here.
 * Secret (masked) credentials are stored the same secure way onboarding
 * stores them, via persistSecretBackedConfigValue (secret manager + a
 * config reference), so the plaintext never lands in config or the
 * transcript.
 *
 *   /channel pair                  → list adapters + how many credentials are set
 *   /channel pair <surface>        → show the adapter's declared credentials and
 *                                     prompt (masked) for each missing secret
 *   /channel pair <surface> verify → a REAL round-trip: send a test message
 *                                     through the daemon (channels.test.send)
 *                                     and report the actual delivered/error
 *                                     outcome, never a fabricated success.
 */
import { getBuiltinSetupSchema } from '@pellux/goodvibes-sdk/platform/channels';
import type { ChannelSetupFieldDescriptor, ChannelSetupSchema, ChannelSurface } from '@pellux/goodvibes-sdk/platform/channels';
import type { CommandContext } from '../command-registry.ts';
import type { ConfigManager, ConfigKey } from '@pellux/goodvibes-sdk/platform/config';
import { persistSecretBackedConfigValue } from '../../config/secret-config.ts';
import { describeOperatorRpcError, getOperatorRpc } from './operator-rpc.ts';

/**
 * Surfaces pairable through /channel pair, every ChannelSurface except the
 * two internal render surfaces ('tui', 'web'), which are not externally
 * paired channels. The `satisfies Record<...>` shape makes this exhaustive:
 * a new ChannelSurface value that isn't listed here fails to compile.
 */
type PairableSurface = Exclude<ChannelSurface, 'tui' | 'web'>;
const PAIRABLE_SURFACE_SET = {
  slack: true,
  discord: true,
  ntfy: true,
  webhook: true,
  homeassistant: true,
  telegram: true,
  'google-chat': true,
  signal: true,
  whatsapp: true,
  telephony: true,
  imessage: true,
  msteams: true,
  bluebubbles: true,
  mattermost: true,
  matrix: true,
} satisfies Record<PairableSurface, true>;
const PAIRABLE_SURFACES: readonly PairableSurface[] = Object.keys(PAIRABLE_SURFACE_SET) as PairableSurface[];

function findSchema(surface: string): ChannelSetupSchema | undefined {
  return PAIRABLE_SURFACES.includes(surface as PairableSurface) ? getBuiltinSetupSchema(surface as PairableSurface) : undefined;
}

/** The always-present 'enabled' boolean field's config key, if declared. */
function enabledConfigKey(schema: ChannelSetupSchema): ConfigKey | undefined {
  return schema.fields.find((f) => f.id === 'enabled' && f.kind === 'boolean')?.configKey as ConfigKey | undefined;
}

function fieldValue(field: ChannelSetupFieldDescriptor, configManager: ConfigManager): string {
  if (!field.configKey) return '';
  const raw = configManager.get(field.configKey as ConfigKey);
  return raw === undefined || raw === null ? '' : String(raw);
}

/** A field counts as configured once it has any stored value; 'select' fields always carry a default. */
function fieldConfigured(field: ChannelSetupFieldDescriptor, configManager: ConfigManager): boolean {
  if (field.kind === 'select' || field.kind === 'boolean') return true;
  return fieldValue(field, configManager).length > 0;
}

/** Credential fields the user must supply, secret (masked) and plain text; booleans/selects are defaulted. */
function credentialFields(schema: ChannelSetupSchema): ChannelSetupFieldDescriptor[] {
  return schema.fields.filter((field) => field.kind === 'secret' || field.kind === 'string' || field.kind === 'url' || field.kind === 'number');
}

/** A field-level hint: the matching secretTarget's detail for secrets, else the placeholder, else the label. */
function fieldHint(field: ChannelSetupFieldDescriptor, schema: ChannelSetupSchema): string {
  if (field.kind === 'secret' && field.secretTargetId) {
    const target = schema.secretTargets.find((t) => t.id === field.secretTargetId);
    if (target?.detail) return target.envKeys?.length ? `${target.detail} (env: ${target.envKeys.join(', ')})` : target.detail;
  }
  return field.placeholder ? `e.g. ${field.placeholder}` : field.label;
}

function listAdapters(ctx: CommandContext): void {
  const configManager = ctx.platform.configManager;
  const lines: string[] = ['Channel adapters: pair with /channel pair <surface>:', ''];
  for (const surface of PAIRABLE_SURFACES) {
    const schema = getBuiltinSetupSchema(surface);
    const creds = credentialFields(schema);
    const set = creds.filter((f) => fieldConfigured(f, configManager)).length;
    const enabledKey = enabledConfigKey(schema);
    const enabled = enabledKey !== undefined && configManager.get(enabledKey) === true;
    const state = creds.length === 0 ? 'no credentials' : `${set}/${creds.length} set`;
    lines.push(`  ${surface.padEnd(14)} ${schema.label.padEnd(22)} ${state.padEnd(12)} ${enabled ? '(enabled)' : ''}`);
  }
  lines.push('');
  lines.push('Run /channel pair <surface> to see and enter its declared credentials.');
  ctx.print(lines.join('\n'));
}

function renderSurface(schema: ChannelSetupSchema, configManager: ConfigManager): string[] {
  const lines = [`${schema.label} (${schema.surface})`, schema.description, '', `Setup mode: ${schema.setupMode}`, '', 'Declared credentials:'];
  for (const field of credentialFields(schema)) {
    const configured = fieldConfigured(field, configManager);
    const kindTag = field.kind === 'secret' ? 'secret' : 'value';
    const status = configured ? 'set' : 'not set';
    lines.push(`  - ${field.label} (${kindTag}): ${status}; ${fieldHint(field, schema)}`);
  }
  if (schema.externalSteps.length > 0) {
    lines.push('', 'External setup steps:');
    for (const step of schema.externalSteps) lines.push(`  - ${step}`);
  }
  return lines;
}

/** Chain a masked prompt for each missing secret field, storing each securely. */
function promptMissingSecrets(
  ctx: CommandContext,
  schema: ChannelSetupSchema,
  missing: readonly ChannelSetupFieldDescriptor[],
  index: number,
): void {
  const configManager = ctx.platform.configManager;
  if (index >= missing.length) {
    const enabledKey = enabledConfigKey(schema);
    if (enabledKey !== undefined) configManager.setDynamic(enabledKey, true);
    ctx.print(`\n${schema.label} credentials stored${enabledKey !== undefined ? ' and the surface is enabled' : ''}. Verify with: /channel pair ${schema.surface} verify`);
    ctx.renderRequest();
    return;
  }
  const field = missing[index]!;
  if (!field.configKey) {
    ctx.print(`[pair] ${field.label} has no config key declared; skipping.`);
    promptMissingSecrets(ctx, schema, missing, index + 1);
    return;
  }
  const configKey = field.configKey as ConfigKey;
  if (!ctx.beginConcealedInput) {
    ctx.print('[pair] Concealed input is unavailable on this surface; set credentials via /config and re-run verify.');
    return;
  }
  ctx.print(`[pair] Enter ${field.label} (${field.placeholder || 'value'}): masked; Enter to store, Esc to stop.`);
  ctx.beginConcealedInput({
    label: field.label,
    onSubmit: (value) => {
      if (value.length === 0) {
        ctx.print(`[pair] ${field.label} left unset.`);
        promptMissingSecrets(ctx, schema, missing, index + 1);
        return;
      }
      void persistSecretBackedConfigValue(configManager, ctx.platform.secretsManager, configKey, value)
        .then(() => {
          ctx.print(`[pair] ${field.label} stored securely (hidden).`);
          promptMissingSecrets(ctx, schema, missing, index + 1);
        })
        .catch((error: unknown) => {
          ctx.print(`[pair] Failed to store ${field.label}: ${error instanceof Error ? error.message : String(error)}`);
          promptMissingSecrets(ctx, schema, missing, index + 1);
        });
    },
    onCancel: () => {
      ctx.print(`[pair] Stopped. Re-run /channel pair ${schema.surface} to finish the remaining credentials.`);
    },
  });
}

/**
 * Verify a surface: report which declared credentials resolve locally, then
 * perform a REAL round-trip through the daemon (channels.test.send) and
 * report the actual delivered/error outcome, never a fabricated success.
 */
async function verifySurface(ctx: CommandContext, schema: ChannelSetupSchema): Promise<void> {
  const configManager = ctx.platform.configManager;
  const creds = credentialFields(schema);
  const lines: string[] = [`Verifying ${schema.label} (${schema.surface}):`];
  const missing: ChannelSetupFieldDescriptor[] = [];
  for (const field of creds) {
    const ok = fieldConfigured(field, configManager);
    if (!ok) missing.push(field);
    lines.push(`  ${ok ? '[ok]  ' : '[fail]'} ${field.label}${ok ? '' : '; missing'}`);
  }
  lines.push('');
  if (missing.length === 0) {
    lines.push('All declared credentials resolve.');
  } else {
    lines.push(`${missing.length} credential(s) still missing: ${missing.map((f) => f.label).join(', ')}.`);
    lines.push(`Run /channel pair ${schema.surface} to enter them.`);
  }
  ctx.print(lines.join('\n'));

  const rpc = getOperatorRpc(ctx);
  if (!rpc.available) {
    ctx.print(`\n[verify] Cannot perform a live round-trip: ${rpc.reason}`);
    return;
  }
  ctx.print(`\n[verify] Sending a real test message through ${schema.surface}...`);
  try {
    const result = await rpc.sdk.operator.invoke('channels.test.send', { surface: schema.surface });
    if (result.delivered) {
      ctx.print(`[verify] delivered:true${result.responseId ? ` (responseId: ${result.responseId})` : ''}${result.address ? ` → ${result.address}` : ''}`);
    } else {
      ctx.print(`[verify] delivered:false; ${result.error ?? 'the daemon returned no error detail'}`);
    }
  } catch (error) {
    ctx.print(`[verify] round-trip request failed: ${describeOperatorRpcError(error)}`);
  }
}

/** Entry point for `/channel pair [...]`. */
export async function runChannelPairing(args: readonly string[], ctx: CommandContext): Promise<void> {
  const surface = args[0];
  if (!surface) {
    listAdapters(ctx);
    return;
  }
  const schema = findSchema(surface);
  if (!schema) {
    ctx.print(`Unknown channel "${surface}". Available: ${PAIRABLE_SURFACES.join(', ')}`);
    return;
  }
  const action = (args[1] ?? '').toLowerCase();
  if (action === 'verify' || action === 'test') {
    await verifySurface(ctx, schema);
    return;
  }

  const configManager = ctx.platform.configManager;
  ctx.print(renderSurface(schema, configManager).join('\n'));
  const creds = credentialFields(schema);
  const missingSecrets = creds.filter((f) => f.kind === 'secret' && !fieldConfigured(f, configManager));
  const missingText = creds.filter((f) => f.kind !== 'secret' && !fieldConfigured(f, configManager));
  if (missingText.length > 0) {
    ctx.print(`\nNon-secret values to set with /config (or accept defaults): ${missingText.map((f) => `${f.label} → ${f.configKey}`).join('; ')}`);
  }
  if (missingSecrets.length === 0) {
    ctx.print(`\nNo missing secrets. Verify with: /channel pair ${schema.surface} verify`);
    return;
  }
  ctx.print(`\nEntering ${missingSecrets.length} secret credential(s): Esc to stop.`);
  promptMissingSecrets(ctx, schema, missingSecrets, 0);
}
