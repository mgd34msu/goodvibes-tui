import { TerminalBuffer } from './buffer.ts';
import { type Cell } from '../types/grid.ts';
import {
  type TermColorCaps,
  downsampleColor,
  wrapSynced,
} from './term-caps.ts';

/**
 * DiffEngine - Generates minimal ANSI updates between two buffers.
 *
 * Accepts a TermColorCaps probe result so that color sequences are
 * downsampled to the terminal's actual capability level (truecolor /
 * ansi256 / basic16 / none), and frames are wrapped in DEC 2026
 * synchronized-output markers when supported.
 */
export class DiffEngine {
  private lastFg = '';
  private lastBg = '';
  private lastBold = false;
  private lastDim = false;
  private lastUnderline = false;
  private lastItalic = false;
  private lastStrikethrough = false;
  private lastLink = '';
  private caps: TermColorCaps;
  /**
   * Run-coalescing state: tracks the last cell position emitted.
   * When the next cell is at (lastEmitX+1, lastEmitY) and SGR is unchanged,
   * we skip cursor re-addressing and append the char directly.
   * Reset per diff() call to avoid stale state across frames.
   */
  private lastEmitX = -1;
  private lastEmitY = -1;

  constructor(caps: TermColorCaps = { capability: 'truecolor', syncedOutput: true }) {
    this.caps = caps;
  }

  public reset(): void {
    this.lastFg = '';
    this.lastBg = '';
    this.lastBold = false;
    this.lastDim = false;
    this.lastUnderline = false;
    this.lastItalic = false;
    this.lastStrikethrough = false;
    this.lastLink = '';
  }

  public diff(oldBuffer: TerminalBuffer | null, newBuffer: TerminalBuffer): string {
    let output = '';
    // Reset run-coalescing state per frame: last emitted cursor position.
    this.lastEmitX = -1;
    this.lastEmitY = -1;

    for (let y = 0; y < newBuffer.height; y++) {
      // Skip rows that were not written in either the old or new buffer.
      // If neither side touched the row, both must match the prior frame:
      // old row was never written this frame (clean) and new row is also
      // clean, so the on-screen content is still correct. No diff needed.
      const newDirty = newBuffer.dirtyRows[y] ?? false;
      const oldDirty = oldBuffer ? (oldBuffer.dirtyRows[y] ?? false) : true;
      if (!newDirty && !oldDirty) continue;

      for (let x = 0; x < newBuffer.width; x++) {
        const oldCell = oldBuffer?.getCell(x, y);
        const newCell = newBuffer.cells[y]?.[x];
        if (!newCell || newCell.char === '') continue;

        if (this.isCellDifferent(oldCell, newCell)) {
          const sgrOutput = this.applyStyles(newCell);
          // Run-coalescing: when the previous emitted cell was (x-1, y) and
          // the SGR state did not change, skip cursor re-addressing.
          // Emit a cursor move only on run breaks (new row, gap, or style change).
          if (sgrOutput === '' && this.lastEmitY === y && this.lastEmitX === x - 1) {
            // Contiguous run on same row, same SGR — just append the char.
            output += newCell.char;
          } else {
            output += `\x1b[${y + 1};${x + 1}H`;
            output += sgrOutput;
            output += newCell.char;
          }
          this.lastEmitX = x;
          this.lastEmitY = y;
        }
      }
    }

    // Close any open OSC 8 hyperlink at end of frame
    if (this.lastLink) {
      output += '\x1b]8;;\x1b\\';
      this.lastLink = '';
    }

    return wrapSynced(output, this.caps);
  }

  private isCellDifferent(a: Cell | undefined, b: Cell): boolean {
    if (!a) return true;
    return a.char !== b.char || a.fg !== b.fg || a.bg !== b.bg || a.bold !== b.bold || a.dim !== b.dim ||
      a.underline !== b.underline || a.italic !== b.italic || a.strikethrough !== b.strikethrough ||
      (a.link ?? '') !== (b.link ?? '');
  }

  /**
   * Convert a raw color string (hex or r;g;b) to the "r;g;b" form expected
   * by applyStyles.  For non-RGB palette indices the value is returned as-is.
   * This mirrors the original sanitizeColor contract but is now capability-aware
   * only in the sense of normalizing hex → "r;g;b" — downsampling happens in
   * applyStyles via downsampleColor.
   */
  private sanitizeColor(color: string): string {
    if (color.startsWith('#')) {
      const r = parseInt(color.slice(1, 3), 16);
      const g = parseInt(color.slice(3, 5), 16);
      const b = parseInt(color.slice(5, 7), 16);
      return `${r};${g};${b}`;
    }
    return color;
  }

  private applyStyles(cell: Cell): string {
    // Normalize hex → r;g;b (for change-detection against lastFg/lastBg)
    const fg = this.sanitizeColor(cell.fg);
    const bg = this.sanitizeColor(cell.bg);
    const link = cell.link ?? '';

    const changed = fg !== this.lastFg || bg !== this.lastBg ||
      cell.bold !== this.lastBold || cell.dim !== this.lastDim ||
      cell.underline !== this.lastUnderline || cell.italic !== this.lastItalic ||
      cell.strikethrough !== this.lastStrikethrough;

    let style = '';

    if (changed) {
      // Reset all attributes first
      if (this.caps.capability !== 'none') {
        style += '\x1b[0m';
      }

      // Text attributes are always emitted when capability > none
      if (this.caps.capability !== 'none') {
        if (cell.bold) style += '\x1b[1m';
        if (cell.dim) style += '\x1b[2m';
        if (cell.italic) style += '\x1b[3m';
        if (cell.underline) style += '\x1b[4m';
        if (cell.strikethrough) style += '\x1b[9m';
      }

      // Foreground color — capability-downsampled
      const fgOut = downsampleColor(fg, this.caps, 'fg');
      if (fgOut !== null) {
        if (this.caps.capability === 'basic16') {
          // fgOut is already the numeric SGR code (e.g. "31", "92")
          style += `\x1b[${fgOut}m`;
        } else {
          const isRgb = fgOut.includes(';');
          style += isRgb ? `\x1b[38;2;${fgOut}m` : `\x1b[38;5;${fgOut}m`;
        }
      }

      // Background color — capability-downsampled
      const bgOut = downsampleColor(bg, this.caps, 'bg');
      if (bgOut !== null) {
        if (this.caps.capability === 'basic16') {
          // bgOut is already the numeric SGR code (e.g. "41", "102")
          style += `\x1b[${bgOut}m`;
        } else {
          const isRgb = bgOut.includes(';');
          style += isRgb ? `\x1b[48;2;${bgOut}m` : `\x1b[48;5;${bgOut}m`;
        }
      }

      this.lastFg = fg;
      this.lastBg = bg;
      this.lastBold = cell.bold;
      this.lastDim = cell.dim;
      this.lastUnderline = cell.underline;
      this.lastItalic = cell.italic;
      this.lastStrikethrough = cell.strikethrough;
    }

    // OSC 8 hyperlink: emit open/close/change sequences only when link changes
    // Hyperlinks are suppressed in no-color mode (dumb/no-color terminals
    // cannot render them and the OSC sequence is just noise).
    if (link !== this.lastLink && this.caps.capability !== 'none') {
      if (link) {
        // Open new hyperlink (close previous if any was open)
        style += `\x1b]8;;${link}\x1b\\`;
      } else {
        // Close hyperlink
        style += '\x1b]8;;\x1b\\';
      }
      this.lastLink = link;
    } else if (link !== this.lastLink) {
      // capability === 'none': track state but emit nothing
      this.lastLink = link;
    }

    return style;
  }
}
