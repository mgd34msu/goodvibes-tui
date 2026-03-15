/**
 * Cell - The atomic unit of our TUI.
 */
export interface Cell {
  char: string;
  fg: string; // ANSI 256-color code or RGB hex
  bg: string;
  bold: boolean;
  dim: boolean;
  underline: boolean;
  italic: boolean;
  strikethrough: boolean;
  /** OSC 8 hyperlink URL. If set, the DiffEngine wraps this cell with OSC 8 sequences. */
  link?: string;
}

/**
 * Line - A single horizontal row of Cells.
 */
export type Line = Cell[];

export const createEmptyCell = (): Cell => ({
  char: ' ',
  fg: '',
  bg: '',
  bold: false,
  dim: false,
  underline: false,
  italic: false,
  strikethrough: false
});

export const createEmptyLine = (width: number): Line => 
  Array.from({ length: width }, createEmptyCell);

/**
 * createStyledCell - Create a Cell with all defaults, applying only the provided overrides.
 * Eliminates the need to write out all 8 Cell properties at every call site.
 */
export const createStyledCell = (char: string, overrides: Partial<Omit<Cell, 'char'>> = {}): Cell => ({
  char,
  fg: overrides.fg ?? '',
  bg: overrides.bg ?? '',
  bold: overrides.bold ?? false,
  dim: overrides.dim ?? false,
  underline: overrides.underline ?? false,
  italic: overrides.italic ?? false,
  strikethrough: overrides.strikethrough ?? false,
  link: overrides.link,
});
