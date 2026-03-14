/**
 * Cell - The atomic unit of our TUI.
 */
export interface Cell {
  char: string;
  fg: string; // ANSI 256-color code
  bg: string;
  bold: boolean;
  dim: boolean;
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
  dim: false
});

export const createEmptyLine = (width: number): Line => 
  Array.from({ length: width }, createEmptyCell);
