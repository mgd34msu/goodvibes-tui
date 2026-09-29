/**
 * terminal-palette.ts, the terminal's own colours as reported at startup.
 *
 * `TerminalPalette` mirrors the SDK type of the same name (the theme engine's
 * input for "use the terminal's palette" themes). Keep the two shapes identical:
 * `background` from OSC 11, `foreground` from OSC 10, and `ansi[0..15]` from
 * OSC 4;N. Every value is `#rrggbb`; a slot the terminal did not answer is
 * `undefined`.
 *
 * The store beside the type holds the result of the startup probe
 * (terminal-palette-probe.ts). It stays `null` until the probe finishes
 * (all replies in, or the window closes). Nothing renders from it yet.
 */

/** Mirrors the SDK `TerminalPalette` type. `ansi` always has 16 entries. */
export type TerminalPalette = {
  background?: string;
  foreground?: string;
  ansi: Array<string | undefined>;
};

/** Number of ANSI palette slots queried (OSC 4;0 .. OSC 4;15). */
export const TERMINAL_PALETTE_ANSI_SLOTS = 16;

/** A palette with every slot unanswered. */
export function emptyTerminalPalette(): TerminalPalette {
  return { ansi: new Array<string | undefined>(TERMINAL_PALETTE_ANSI_SLOTS).fill(undefined) };
}

let probedPalette: TerminalPalette | null = null;
const listeners = new Set<(palette: TerminalPalette) => void>();

/**
 * The palette reported by the terminal at startup, or null when the probe has
 * not finished (or never ran: non-TTY). A finished probe with no replies yields
 * a palette whose slots are all undefined.
 */
export function getTerminalPalette(): TerminalPalette | null {
  return probedPalette;
}

/** Record the probe result and notify listeners. Called by the probe once. */
export function setTerminalPalette(palette: TerminalPalette): void {
  probedPalette = palette;
  for (const listener of listeners) listener(palette);
}

/** Subscribe to the probe result. Returns an unsubscribe function. */
export function onTerminalPalette(listener: (palette: TerminalPalette) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Test hook: forget the stored palette and listeners. */
export function resetTerminalPaletteForTests(): void {
  probedPalette = null;
  listeners.clear();
}
