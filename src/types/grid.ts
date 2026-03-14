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
