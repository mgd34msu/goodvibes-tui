/**
 * command-palette-types.ts, the shapes the command palette and its renderer
 * share (kept apart so the renderer never imports the modal it draws).
 */

export type PaletteGroup = 'Suggested' | 'Session' | 'Views' | 'Settings' | 'Commands';

export interface PaletteEntry {
  /** The command's primary name. */
  readonly id: string;
  /** Human title for the row. */
  readonly title: string;
  readonly description: string;
  readonly category: string;
  readonly group: Exclude<PaletteGroup, 'Suggested'>;
  readonly aliases: readonly string[];
  /** Extra search words (former view names and the like). */
  readonly keywords: readonly string[];
  readonly argsHint?: string;
  /** True when the command has required arguments: Enter fills the composer. */
  readonly needsArgs: boolean;
  /** Right column; defaults to the slash command. */
  readonly right?: string;
}

export type PaletteRunMode = 'run' | 'fill';

export interface PaletteSection {
  readonly group: PaletteGroup;
  readonly entries: readonly PaletteEntry[];
}

/** What the palette renderer reads from the palette. */
export interface PaletteView {
  readonly query: string;
  readonly entries: readonly PaletteEntry[];
  sections(): PaletteSection[];
  flat(): PaletteEntry[];
  getSelected(): PaletteEntry | null;
  describe(id: string): string | undefined;
}
