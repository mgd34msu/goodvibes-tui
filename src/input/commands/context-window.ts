/**
 * /context window, view, set, or clear a custom context window for the
 * current model.
 *
 * The override is stored by the SDK's ProviderRegistry (persisted under the
 * control-plane config dir with provenance 'configured_cap'), so it survives
 * restarts, applies to any model (cloud or local), and is honored by every
 * consumer of the same home. Clearing returns the model to its automatic
 * window (catalog / provider API / family fallback). The source line names
 * where the window came from, with the SDK's describeContextWindowSource
 * ('catalog: abacus', 'consensus of 4 providers', 'family default').
 */
import type { CommandContext } from '../command-registry.ts';
import type { ModelDefinition } from '@pellux/goodvibes-sdk/platform/providers';
import { MAX_CONTEXT_WINDOW_OVERRIDE, describeContextWindowSource } from '@pellux/goodvibes-sdk/platform/providers';

/**
 * Parse a user-supplied context window size. Accepts plain token counts
 * ("200000"), thousands ("200k", "12.5k"), and millions ("1m", "2M").
 * Returns null for anything unparseable or outside 1..MAX_CONTEXT_WINDOW_OVERRIDE.
 */
export function parseContextWindowSize(raw: string): number | null {
  const match = /^(\d+(?:\.\d+)?)\s*([km])?$/i.exec(raw.trim());
  if (!match) return null;
  const base = Number(match[1]);
  const suffix = match[2]?.toLowerCase();
  const multiplier = suffix === 'm' ? 1_000_000 : suffix === 'k' ? 1_000 : 1;
  const value = Math.round(base * multiplier);
  if (!Number.isInteger(value) || value <= 0 || value > MAX_CONTEXT_WINDOW_OVERRIDE) return null;
  return value;
}

/** Status text for the current model's window + override state. */
export function buildContextWindowStatusText(
  model: ModelDefinition,
  /** The window a source states, or null when unknown. */
  resolvedWindow: number | null,
  override: number | null,
  observed: number | null = null,
): string {
  const resolvedText = resolvedWindow === null
    ? model.contextWindowProvenance === 'accepted_floor'
      ? `unknown (the provider accepted ${model.contextWindow.toLocaleString()} tokens, more than the stated window)`
      : model.contextWindowOrigin?.kind === 'family_default'
        ? `unknown (no catalog provider lists this model; the family default of ${model.contextWindow.toLocaleString()} tokens is a guess)`
        : 'unknown (no catalog entry or provider report states it)'
    : `${resolvedWindow.toLocaleString()} tokens`;
  const sourceText = resolvedWindow === null && model.contextWindowProvenance === 'accepted_floor'
    ? null
    : describeContextWindowSource(model);
  const lines = [
    `Context window for ${model.displayName} (${model.registryKey}):`,
    `  resolved: ${resolvedText}`,
    ...(sourceText === null ? [] : [`  source:   ${sourceText}`]),
    `  override: ${override === null ? 'none (automatic)' : `${override.toLocaleString()} tokens`}`,
  ];
  if (observed !== null) {
    lines.push(`  learned limit: ${observed.toLocaleString()} tokens (the provider rejected a longer request; self-corrects as requests succeed)`);
  }
  lines.push(
    '',
    'Set:   /context window <size>   (e.g. 120000, 200k, 1m)',
    'Clear: /context window clear    (also forgets the learned limit)',
  );
  return lines.join('\n');
}

/** Handle `/context window [<size>|clear]`. Returns the text it printed (for tests). */
export function handleContextWindowSubcommand(args: readonly string[], ctx: CommandContext): string {
  const registry = ctx.provider.providerRegistry;
  const model = registry.getCurrentModel();
  const arg = args[0]?.trim().toLowerCase() ?? '';

  let output: string;
  if (arg === '') {
    output = buildContextWindowStatusText(
      model,
      registry.getKnownContextWindowForModel(model),
      registry.getModelContextCap(model.registryKey),
      registry.getObservedContextWindow(model.registryKey),
    );
  } else if (arg === 'clear' || arg === 'auto' || arg === 'reset') {
    const existed = registry.clearModelContextCap(model.registryKey);
    const known = registry.getKnownContextWindowForModel(registry.getCurrentModel());
    const resolved = known === null ? 'unknown' : `${known.toLocaleString()} tokens`;
    output = existed
      ? `Context window settings cleared for ${model.displayName} (custom override and any learned limit). Back to automatic: ${resolved}.`
      : `${model.displayName} has no custom context window or learned limit set (automatic: ${resolved}).`;
  } else {
    const size = parseContextWindowSize(arg);
    if (size === null) {
      output = `Invalid size '${args[0]}'. Use a token count between 1 and ${MAX_CONTEXT_WINDOW_OVERRIDE.toLocaleString()}, e.g. 120000, 200k, 1m, or 'clear'.`;
    } else {
      const was = registry.getKnownContextWindowForModel(model);
      registry.setModelContextCap(model.registryKey, size);
      output = `Context window for ${model.displayName} set to ${size.toLocaleString()} tokens (was ${was === null ? 'unknown' : `${was.toLocaleString()} tokens`}). Clear with /context window clear.`;
    }
  }

  ctx.print(output);
  ctx.renderRequest();
  return output;
}
