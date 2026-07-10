/**
 * channel-pairing.ts — guided `/channel pair` flow.
 *
 * Adapters and their credential requirements are driven from the TUI's own
 * channel-surface declaration (EXTERNAL_SURFACE_SPECS — the same source the
 * onboarding wizard uses), never a hand-maintained list here. Secret (masked)
 * credentials are stored the same secure way onboarding stores them, via
 * persistSecretBackedConfigValue (secret manager + a config reference), so the
 * plaintext never lands in config or the transcript.
 *
 *   /channel pair                  → list adapters + how many credentials are set
 *   /channel pair <surface>        → show the adapter's declared credentials and
 *                                     prompt (masked) for each missing secret
 *   /channel pair <surface> verify → report whether every credential resolves
 *
 * NOTE: the SDK's authoritative getBuiltinSetupSchema is not exported through
 * any public package path, so this drives from EXTERNAL_SURFACE_SPECS instead.
 * A live round-trip test message is owned by the daemon channel runtime
 * (the `retest` lifecycle action); this command verifies that the declared
 * credentials resolve — the precondition the daemon needs — and reports honestly.
 */
import type { CommandContext } from '../command-registry.ts';
import type { ConfigManager } from '../../config/index.ts';
import { EXTERNAL_SURFACE_SPECS, type ExternalSurfaceSetupFieldSpec, type ExternalSurfaceSpec } from '../onboarding/onboarding-wizard-external-surfaces.ts';
import { persistSecretBackedConfigValue } from '../../config/secret-config.ts';

function findSpec(surface: string): ExternalSurfaceSpec | undefined {
  return EXTERNAL_SURFACE_SPECS.find((spec) => spec.id === surface);
}

function fieldValue(field: ExternalSurfaceSetupFieldSpec, configManager: ConfigManager): string {
  const raw = configManager.get(field.configKey);
  return raw === undefined || raw === null ? '' : String(raw);
}

/** A field counts as configured once it has any stored value (a secret reference counts). */
function fieldConfigured(field: ExternalSurfaceSetupFieldSpec, configManager: ConfigManager): boolean {
  if (field.kind === 'radio') return true; // radios always carry a default
  return fieldValue(field, configManager).length > 0;
}

/** Credential fields the user must supply — masked (secret) and free-text; radios are defaulted. */
function credentialFields(spec: ExternalSurfaceSpec): ExternalSurfaceSetupFieldSpec[] {
  return spec.fields.filter((field) => field.kind === 'masked' || field.kind === 'text');
}

function listAdapters(ctx: CommandContext): void {
  const configManager = ctx.platform.configManager;
  const lines: string[] = ['Channel adapters — pair with /channel pair <surface>:', ''];
  for (const spec of EXTERNAL_SURFACE_SPECS) {
    const creds = credentialFields(spec);
    const set = creds.filter((f) => fieldConfigured(f, configManager)).length;
    const enabled = configManager.get(spec.enabledConfigKey) === true;
    const state = creds.length === 0 ? 'no credentials' : `${set}/${creds.length} set`;
    lines.push(`  ${spec.id.padEnd(14)} ${spec.label.padEnd(22)} ${state.padEnd(12)} ${enabled ? '(enabled)' : ''}`);
  }
  lines.push('');
  lines.push('Run /channel pair <surface> to see and enter its declared credentials.');
  ctx.print(lines.join('\n'));
}

function renderSurface(spec: ExternalSurfaceSpec, configManager: ConfigManager): string[] {
  const lines = [`${spec.label} (${spec.id})`, spec.hint, '', 'Declared credentials:'];
  for (const field of spec.fields) {
    if (field.kind === 'radio') continue;
    const configured = fieldConfigured(field, configManager);
    const kindTag = field.kind === 'masked' ? 'secret' : 'value';
    const status = configured ? 'set' : 'not set';
    lines.push(`  - ${field.label} (${kindTag}): ${status} — ${field.hint}`);
  }
  return lines;
}

/** Chain a masked prompt for each missing secret field, storing each securely. */
function promptMissingSecrets(
  ctx: CommandContext,
  spec: ExternalSurfaceSpec,
  missing: readonly ExternalSurfaceSetupFieldSpec[],
  index: number,
): void {
  const configManager = ctx.platform.configManager;
  if (index >= missing.length) {
    configManager.setDynamic(spec.enabledConfigKey, true);
    ctx.print(`\n${spec.label} credentials stored and the surface is enabled. Verify with: /channel pair ${spec.id} verify`);
    ctx.renderRequest();
    return;
  }
  const field = missing[index]!;
  if (!ctx.beginConcealedInput) {
    ctx.print('[pair] Concealed input is unavailable on this surface; set credentials via /config and re-run verify.');
    return;
  }
  ctx.print(`[pair] Enter ${field.label} (${field.placeholder || 'value'}) — masked; Enter to store, Esc to stop.`);
  ctx.beginConcealedInput({
    label: field.label,
    onSubmit: (value) => {
      if (value.length === 0) {
        ctx.print(`[pair] ${field.label} left unset.`);
        promptMissingSecrets(ctx, spec, missing, index + 1);
        return;
      }
      void persistSecretBackedConfigValue(configManager, ctx.platform.secretsManager, field.configKey, value)
        .then(() => {
          ctx.print(`[pair] ${field.label} stored securely (hidden).`);
          promptMissingSecrets(ctx, spec, missing, index + 1);
        })
        .catch((error: unknown) => {
          ctx.print(`[pair] Failed to store ${field.label}: ${error instanceof Error ? error.message : String(error)}`);
          promptMissingSecrets(ctx, spec, missing, index + 1);
        });
    },
    onCancel: () => {
      ctx.print(`[pair] Stopped. Re-run /channel pair ${spec.id} to finish the remaining credentials.`);
    },
  });
}

function verifySurface(ctx: CommandContext, spec: ExternalSurfaceSpec): void {
  const configManager = ctx.platform.configManager;
  const creds = credentialFields(spec);
  const lines: string[] = [`Verifying ${spec.label} (${spec.id}) credentials:`];
  const missing: ExternalSurfaceSetupFieldSpec[] = [];
  for (const field of creds) {
    const ok = fieldConfigured(field, configManager);
    if (!ok) missing.push(field);
    lines.push(`  ${ok ? '[ok]  ' : '[fail]'} ${field.label}${ok ? '' : ' — missing'}`);
  }
  lines.push('');
  if (missing.length === 0) {
    const enabled = configManager.get(spec.enabledConfigKey) === true;
    lines.push(`All declared credentials resolve.${enabled ? ' Surface is enabled.' : ` Enable it with /config set ${spec.enabledConfigKey} true.`}`);
    lines.push('A live round-trip test message is performed by the daemon channel runtime (retest); once the daemon is running, /channel delivery shows live status.');
  } else {
    lines.push(`${missing.length} credential(s) still missing: ${missing.map((f) => f.label).join(', ')}.`);
    lines.push(`Run /channel pair ${spec.id} to enter them.`);
  }
  ctx.print(lines.join('\n'));
}

/** Entry point for `/channel pair [...]`. */
export function runChannelPairing(args: readonly string[], ctx: CommandContext): void {
  const surface = args[0];
  if (!surface) {
    listAdapters(ctx);
    return;
  }
  const spec = findSpec(surface);
  if (!spec) {
    ctx.print(`Unknown channel "${surface}". Available: ${EXTERNAL_SURFACE_SPECS.map((s) => s.id).join(', ')}`);
    return;
  }
  const action = (args[1] ?? '').toLowerCase();
  if (action === 'verify' || action === 'test') {
    verifySurface(ctx, spec);
    return;
  }

  const configManager = ctx.platform.configManager;
  ctx.print(renderSurface(spec, configManager).join('\n'));
  const missingSecrets = spec.fields.filter((f) => f.kind === 'masked' && !fieldConfigured(f, configManager));
  const missingText = spec.fields.filter((f) => f.kind === 'text' && !fieldConfigured(f, configManager));
  if (missingText.length > 0) {
    ctx.print(`\nNon-secret values to set with /config (or accept defaults): ${missingText.map((f) => `${f.label} → ${f.configKey}`).join('; ')}`);
  }
  if (missingSecrets.length === 0) {
    ctx.print(`\nNo missing secrets. Verify with: /channel pair ${spec.id} verify`);
    return;
  }
  ctx.print(`\nEntering ${missingSecrets.length} secret credential(s) — Esc to stop.`);
  promptMissingSecrets(ctx, spec, missingSecrets, 0);
}
