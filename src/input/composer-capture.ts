/**
 * Composer capture intents — leading markers in the composer that write to
 * memory instead of (or in addition to) sending a turn.
 *
 *   `!# <text>`  pins <text> to session memory AND sends it as a normal prompt
 *                (pre-existing behavior).
 *   `# <text>`   captures <text> as a session-memory note and does NOT send a
 *                turn — a pure "jot this down" gesture. A single leading `#`
 *                only; `##...` (markdown headings) is left alone so it can be
 *                sent as an ordinary prompt.
 *
 * Both write through the existing session memory machinery
 * (SessionMemoryStore.add) and surface a visible confirmation naming what was
 * written and where.
 */

/** The provider-registry surface the `@model:` directive needs. */
export interface AtModelRegistry {
  setCurrentModel(reference: string): void;
  getCurrentModel(): { id: string; provider: string; registryKey: string; displayName: string };
}

export interface AtModelDeps {
  readonly providerRegistry: AtModelRegistry;
  /** Session runtime whose model/provider labels follow an explicit switch. */
  readonly runtime: { model: string; provider: string };
  readonly configManager: { set(key: string, value: unknown): void };
  /** Surfaces the switch confirmation / unknown-model message. */
  readonly notify: (message: string) => void;
}

const AT_MODEL_PATTERN = /@model:([^\s]+)/g;

/**
 * Apply every `@model:<id>` directive in a composer submission and return the
 * text with the directives stripped.
 *
 * The switch is a real, persisted selection (config `provider.model`), not a
 * per-turn override, so the runtime labels are updated alongside it and each
 * one is announced. An unknown id is reported as unknown rather than silently
 * dropped — the user asked for a specific backend and did not get it.
 */
export function applyAtModelDirective(input: string, deps: AtModelDeps): string {
  let text = input;
  let match: RegExpExecArray | null;
  const pattern = new RegExp(AT_MODEL_PATTERN.source, 'g');
  while ((match = pattern.exec(input)) !== null) {
    const modelId = match[1]!;
    try {
      deps.providerRegistry.setCurrentModel(modelId);
      const def = deps.providerRegistry.getCurrentModel();
      deps.runtime.model = def.id;
      deps.runtime.provider = def.provider;
      deps.configManager.set('provider.model', def.registryKey);
      deps.notify(`[Model] Switched to ${def.displayName} (${def.provider}) via @model:`);
    } catch {
      deps.notify(`[Model] Unknown model: ${modelId}`);
    }
    text = text.replace(match[0], '').trim();
  }
  return text;
}

export interface ComposerCaptureDeps {
  readonly sessionMemoryStore: { add(text: string): string };
  /** Surfaces the confirmation / usage message (a system message the shell renders). */
  readonly notify: (message: string) => void;
}

export interface ComposerCaptureResult {
  /** Text the caller should continue submission with (empty when nothing should be sent). */
  readonly text: string;
  /** Whether a capture marker was recognized and handled. */
  readonly captured: boolean;
}

function truncateForChip(text: string): string {
  return text.length > 60 ? `${text.slice(0, 57)}...` : text;
}

/**
 * Interpret composer capture markers. Returns the (possibly emptied) text to
 * continue with and whether a marker was handled. When `captured` is true and
 * the returned `text` is empty, the caller should not send a turn.
 */
export function applyComposerCapture(input: string, deps: ComposerCaptureDeps): ComposerCaptureResult {
  // `!#` — pin to session memory and continue to send as a prompt.
  if (input.startsWith('!#')) {
    const memoryText = input.slice(2).trim();
    if (!memoryText) {
      deps.notify('[Memory] Usage: !# <text to pin as session memory>');
      return { text: '', captured: true };
    }
    const id = deps.sessionMemoryStore.add(memoryText);
    deps.notify(`[Memory] Pinned: "${memoryText}" (${id})`);
    return { text: memoryText, captured: true };
  }

  // `#` (single, not `##`) — capture a note to session memory; do not send.
  const leading = input.replace(/^\s+/, '');
  if (leading.startsWith('#') && !leading.startsWith('##')) {
    const noteText = leading.slice(1).trim();
    if (!noteText) {
      deps.notify('[Note] Usage: # <text to save as a session-memory note>');
      return { text: '', captured: true };
    }
    const id = deps.sessionMemoryStore.add(noteText);
    // Confirmation chip: names WHAT was written and WHERE it went.
    deps.notify(`✓ Note saved → session memory: "${truncateForChip(noteText)}" (${id})`);
    return { text: '', captured: true };
  }

  return { text: input, captured: false };
}
