/**
 * reasoning-effort-surface.ts — the TUI's single reading of the SDK's
 * per-model reasoning-effort spec.
 *
 * Every effort-shaped surface (the `/effort` command, the model picker's
 * effort step, the model-switch and failover notices) asks this module what a
 * specific model offers, instead of each one carrying its own list. The list
 * used to be the hardcoded four levels `instant, low, medium, high`, which was
 * wrong in both directions: it offered `instant` to models that reject it and
 * hid `xhigh`/`max`/`none` from models that accept them.
 *
 * The honest presentation differs per spec kind, so the wording is generated
 * here rather than templated at each call site:
 *
 *   - `effort`        — the model names its levels; offer exactly those.
 *   - `budget_tokens` — the model takes a thinking-token budget, so each level
 *                       is shown with the budget it sends.
 *   - `toggle`        — reasoning is on or off only; say so, and do not imply
 *                       that the levels in between mean anything.
 *   - `unavailable`   — nothing is configurable; the picker says that instead
 *                       of presenting an empty list.
 *
 * A `fallback`-sourced spec is a labelled guess: neither the live catalog nor
 * the curated family table recognised the model. The SDK's OpenAI and Gemini
 * adapters send nothing at all for such a model (silence beats a guess on an
 * endpoint that also serves non-reasoning models), so surfaces built here say
 * that outright rather than implying the choice takes effect.
 */

import {
  EFFORT_DESCRIPTIONS,
  budgetTokensForLevel,
  describeReasoningWire,
  reasoningEffortLevels,
  resolveEffortForModel,
  resolveReasoningEffortSpec,
  setActiveReasoningEffortOptions,
  type ReasoningEffortSpec,
  type ResolvedReasoningEffort,
} from '@pellux/goodvibes-sdk/platform/providers';

/** The subset of a model this module needs; `ModelDefinition` satisfies it. */
export interface EffortModelLike {
  readonly id: string;
  readonly provider?: string | undefined;
  readonly displayName?: string | undefined;
  readonly reasoningEffort?: ReasoningEffortSpec | undefined;
}

/** Sentence appended wherever a best-guess spec is presented as choices. */
const FALLBACK_EFFORT_CAVEAT =
  'Best guess: this model is not in the model catalog, so these levels are unverified and some providers send nothing at all for it.';

/**
 * Whether a value really is a ReasoningEffortSpec.
 *
 * `ModelDefinition.reasoningEffort` used to be a bare `string[]`. A definition
 * built by older code, restored from an older cache, or supplied by a plugin
 * can still arrive in that shape, and passing it through as a spec would make
 * every surface read `.values` off an array and crash. A value that fails this
 * check is treated as "the model said nothing", which falls through to the
 * curated family table and then to the labelled best guess.
 */
function isReasoningEffortSpec(value: unknown): value is ReasoningEffortSpec {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as { kind?: unknown; values?: unknown };
  return typeof record.kind === 'string' && Array.isArray(record.values);
}

/**
 * The spec that governs one model, applying the SDK's source precedence
 * (live catalog, then curated family table, then the labelled best guess).
 */
export function effortSpecForModel(model: EffortModelLike): ReasoningEffortSpec {
  const declared = isReasoningEffortSpec(model.reasoningEffort) ? model.reasoningEffort : undefined;
  return resolveReasoningEffortSpec({
    modelId: model.id,
    ...(declared ? { spec: declared } : {}),
  });
}

/** The levels a model actually offers, in severity order. */
export function effortLevelsForModel(model: EffortModelLike): readonly string[] {
  return reasoningEffortLevels(effortSpecForModel(model));
}

/**
 * Whether a surface should offer an effort CHOICE for this model.
 *
 * Stricter than "has levels": a `fallback`-sourced spec is a labelled guess at
 * a model nothing recognises, and the SDK's OpenAI and Gemini adapters send
 * nothing at all for such a model. Putting a picker step in front of a choice
 * that will be discarded is worse than not offering it, so an automatic step
 * (the model picker's effort stage) is skipped. `/effort`, which the user asked
 * for explicitly, still lists the guessed levels with their caveat attached.
 */
export function offersConfigurableEffort(model: EffortModelLike): boolean {
  const spec = effortSpecForModel(model);
  return spec.values.length > 0 && spec.source !== 'fallback';
}

/**
 * Publish the current model's real levels to the SDK so a
 * `provider.reasoningEffort` write is validated against them rather than
 * against a fixed list. Pass no model to clear.
 */
export function publishActiveEffortOptions(model: EffortModelLike | null | undefined): void {
  if (!model) {
    setActiveReasoningEffortOptions(null);
    return;
  }
  setActiveReasoningEffortOptions(effortLevelsForModel(model));
}

/** Map a requested level onto what a model accepts (snapping down, never up). */
export function resolveEffortForModelSurface(
  requested: string | undefined,
  model: EffortModelLike,
): ResolvedReasoningEffort {
  return resolveEffortForModel(requested, {
    id: model.id,
    ...(model.displayName ? { displayName: model.displayName } : {}),
    reasoningEffort: effortSpecForModel(model),
  });
}

/** One level plus the line describing what choosing it does on this model. */
export interface EffortChoice {
  readonly level: string;
  readonly description: string;
}

/**
 * A level's description under a specific spec. Budget-typed models get the
 * token budget the level actually sends, because "medium" means nothing to a
 * user comparing it against a `thinking.budget_tokens` figure.
 */
function describeEffortLevel(level: string, spec: ReasoningEffortSpec): string {
  const base = EFFORT_DESCRIPTIONS[level] ?? '';
  if (spec.kind === 'budget_tokens') {
    const budget = budgetTokensForLevel(level, spec);
    const budgetText = budget > 0 ? `${budget.toLocaleString()} thinking tokens` : 'thinking off';
    return base ? `${base} (${budgetText})` : budgetText;
  }
  if (spec.kind === 'toggle') {
    return level === 'none' ? 'Reasoning off' : 'Reasoning on, at the model\'s own depth';
  }
  return base;
}

/** What a surface needs to present one model's effort options honestly. */
export interface EffortPresentation {
  readonly spec: ReasoningEffortSpec;
  readonly choices: readonly EffortChoice[];
  /** True when there is nothing to choose and the surface must say so. */
  readonly configurable: boolean;
  /** One line stating what this model does with the setting; always present. */
  readonly headline: string;
  /** Caveat to show beneath the choices, when the spec carries one. */
  readonly caveat?: string | undefined;
}

/** Build the full presentation for a model's effort options. */
export function effortPresentationForModel(model: EffortModelLike): EffortPresentation {
  const spec = effortSpecForModel(model);
  const name = model.displayName ?? model.id;
  const choices = spec.values.map((level) => ({ level, description: describeEffortLevel(level, spec) }));
  const caveat = spec.source === 'fallback' ? FALLBACK_EFFORT_CAVEAT : spec.note;

  let headline: string;
  switch (spec.kind) {
    case 'effort':
      headline = `${name} accepts these reasoning levels.`;
      break;
    case 'budget_tokens':
      headline = `${name} takes a thinking-token budget; each level below sends the budget shown.`;
      break;
    case 'toggle':
      headline = `${name} only exposes reasoning on or off — there is no depth to choose.`;
      break;
    case 'unavailable':
      headline = `${name} has no configurable reasoning level; it runs at its own fixed depth.`;
      break;
  }

  return {
    spec,
    choices,
    configurable: choices.length > 0,
    headline,
    ...(caveat ? { caveat } : {}),
  };
}

/**
 * The `/effort` explainer lines for one model, generated from the resolved
 * spec. Replaces the old fixed block that named Mercury-2, Claude, Gemini and
 * GPT-5 for every model regardless of which one was actually serving.
 */
export function describeEffortForModel(model: EffortModelLike, current: string | undefined): string[] {
  const presentation = effortPresentationForModel(model);
  const { spec } = presentation;
  const wire = describeReasoningWire(spec, model.provider);
  const resolved = resolveEffortForModelSurface(current, model);

  const lines = [`Reasoning effort: ${current ?? '(not set)'}`, presentation.headline];

  if (spec.kind === 'unavailable') {
    lines.push(`  Sent on the wire: ${wire}`);
    if (presentation.caveat) lines.push(`  ${presentation.caveat}`);
    return lines;
  }

  if (resolved.value === undefined) {
    lines.push(`  Sent on the wire: nothing — ${model.displayName ?? model.id} runs at its own default.`);
  } else if (spec.kind === 'budget_tokens') {
    lines.push(`  Sent on the wire: ${wire} = ${budgetTokensForLevel(resolved.value, spec).toLocaleString()}`);
  } else {
    lines.push(`  Sent on the wire: ${wire} = '${resolved.value}'`);
  }

  if (resolved.note) lines.push(`  ${resolved.note}`);
  lines.push('');
  for (const choice of presentation.choices) {
    const marker = choice.level === resolved.value ? '◉' : ' ';
    lines.push(`  ${marker} ${choice.level.padEnd(8)}${choice.description}`);
  }
  if (presentation.caveat && spec.source === 'fallback') {
    lines.push('');
    lines.push(`  ${presentation.caveat}`);
  }
  return lines;
}

/**
 * One line for a non-interactive surface (`goodvibes status`, `goodvibes
 * doctor`) saying what the configured level becomes on the configured model.
 *
 * Printing the raw config value alone was misleading in three separate ways:
 * a model that does not offer the level receives the next one down, a model
 * with no configurable reasoning receives nothing, and a model the catalog
 * does not carry may have the field dropped entirely.
 *
 * `registryKey` is the `provider:model` form stored in `provider.model`; a
 * value without a colon is treated as a bare model id.
 */
export function describeConfiguredEffort(registryKey: string, configured: string): string {
  const trimmed = registryKey.trim();
  if (trimmed === '') return 'no model configured';
  const colon = trimmed.indexOf(':');
  const providerId = colon === -1 ? '' : trimmed.slice(0, colon);
  const modelId = colon === -1 ? trimmed : trimmed.slice(colon + 1);
  const model: EffortModelLike = { id: modelId, ...(providerId ? { provider: providerId } : {}) };

  const spec = effortSpecForModel(model);
  const resolved = resolveEffortForModelSurface(configured === '' ? undefined : configured, model);
  const wire = describeReasoningWire(spec, providerId);

  if (spec.kind === 'unavailable') return `not sent — ${modelId} has no configurable reasoning level`;
  if (spec.source === 'fallback') {
    return `${resolved.value ?? '(model default)'} — unverified: ${modelId} is not in the model catalog, so some providers send nothing for it`;
  }
  if (resolved.value === undefined) return `not sent — ${modelId} applies its own default`;
  if (spec.kind === 'budget_tokens') {
    return `${resolved.value} (${wire} = ${budgetTokensForLevel(resolved.value, spec).toLocaleString()})`;
  }
  if (resolved.value !== configured && configured !== '') {
    return `${resolved.value} (${wire}) — '${configured}' is not available on ${modelId}`;
  }
  return `${resolved.value} (${wire})`;
}

/**
 * Re-resolve a configured level against a model that is about to serve, for
 * the model-switch and failover paths. Returns the level to use and, when it
 * had to change, the SDK's own sentence explaining why — printed verbatim so
 * the wording cannot drift from the resolution that produced it.
 */
export function remapEffortForServingModel(
  configured: string | undefined,
  servingModel: EffortModelLike,
): { readonly value: string | undefined; readonly note?: string | undefined } {
  const resolved = resolveEffortForModelSurface(configured, servingModel);
  const changed = resolved.value !== configured;
  return {
    value: resolved.value,
    ...(changed && resolved.note ? { note: resolved.note } : {}),
  };
}

/**
 * The two levels every effort surface has to keep apart.
 *
 * `requested` is what the user asked for and what config `provider.reasoningEffort`
 * holds. `effective` is what the model now serving will actually receive, which
 * is `requested` snapped DOWN to that model's own levels (or `undefined` when the
 * model takes no reasoning parameter at all).
 */
export interface ServingEffort {
  /** The user's stored preference; '' when nothing has ever been chosen. */
  readonly requested: string;
  /** What this model receives; undefined means the field is not sent at all. */
  readonly effective: string | undefined;
  /** True when the serving model could not honour the requested level. */
  readonly capped: boolean;
  /** The SDK's own sentence explaining the snap, when there was one. */
  readonly note?: string | undefined;
}

/**
 * Minimal reader shape for config `provider.reasoningEffort`. A real
 * ConfigManager satisfies it; a test double can be a one-method object.
 */
export interface RequestedEffortReader {
  get(key: 'provider.reasoningEffort'): unknown;
}

/**
 * Read the user's REQUESTED reasoning level.
 *
 * This is the ONE place any automatic (model-driven) resolution is allowed to
 * get its input from, and it deliberately does not consult the session's
 * effective level. Reading the effective level back as the next resolution's
 * baseline is what used to make a downgrade permanent: switching to a model
 * that caps at 'medium' stored 'medium' as the preference, so switching back to
 * a model that accepts 'xhigh' had nothing left to restore. Config holds what
 * was asked for; only an explicit user choice writes it.
 */
export function requestedEffortLevel(config: RequestedEffortReader): string {
  const raw = config.get('provider.reasoningEffort');
  return typeof raw === 'string' ? raw.trim() : '';
}

/** Resolve an explicit level against the model now serving. */
export function servingEffortForLevel(requested: string, model: EffortModelLike): ServingEffort {
  if (requested === '') return { requested, effective: undefined, capped: false };
  const remapped = remapEffortForServingModel(requested, model);
  return {
    requested,
    effective: remapped.value,
    capped: remapped.value !== requested,
    ...(remapped.note ? { note: remapped.note } : {}),
  };
}

/**
 * Resolve the user's REQUESTED level against the model now serving. Every
 * automatic model-switch path goes through this, so none of them can
 * accidentally resolve from a previously snapped value.
 */
export function resolveRequestedEffortForServingModel(
  config: RequestedEffortReader,
  model: EffortModelLike,
): ServingEffort {
  return servingEffortForLevel(requestedEffortLevel(config), model);
}

/**
 * How an effort level is shown once the requested and effective levels can
 * differ.
 *
 * The stored preference is no longer overwritten with the snapped value, so a
 * surface that printed the stored level alone would claim 'xhigh' while 'high'
 * went on the wire. Instead of corrupting the preference to keep the display
 * honest, the display carries both values and names the model that caps it.
 * When the two agree, the single value is printed exactly as before.
 */
export function describeServingEffort(state: ServingEffort, model: EffortModelLike): string {
  const name = model.displayName ?? model.id;
  if (state.requested === '') return '(not set)';
  if (!state.capped) return state.requested;
  if (state.effective === undefined) {
    // Two different reasons the field is dropped, and they must not be
    // conflated: the model takes no reasoning parameter at all, or it takes one
    // but offers nothing at or below the requested level (resolution snaps DOWN
    // only, never up to a costlier level).
    const reason = effortLevelsForModel(model).length === 0
      ? `${name} has no configurable reasoning level`
      : `${name} offers nothing at or below ${state.requested}`;
    return `(not sent) (requested ${state.requested}; ${reason})`;
  }
  return `${state.effective} (requested ${state.requested}; ${name} caps at ${state.effective})`;
}

/**
 * Normalize any model-shaped record to what this module consumes.
 *
 * Deliberately structural rather than `ModelDefinition`: the model-selection
 * callback carries a lighter record (id, provider, displayName, registryKey)
 * and still needs the same resolution.
 */
export function toEffortModel(model: EffortModelLike): EffortModelLike {
  return {
    id: model.id,
    provider: model.provider,
    displayName: model.displayName,
    ...(model.reasoningEffort ? { reasoningEffort: model.reasoningEffort } : {}),
  };
}
