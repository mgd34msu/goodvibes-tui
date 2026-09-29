/**
 * surface-frame.ts, test helpers for surfaces drawn with the modal surface kit.
 *
 * A kit renderer returns a SurfaceLayer (a rectangle of cells at a screen
 * position). Tests and golden frames need a whole screen: frameFromLayers
 * composes layers over a blank width x height screen exactly the way the
 * compositor does (dim pass when a layer asks for it, then stamp-over), with
 * a fixed terminal background so frames are deterministic.
 */

import { createEmptyLine, type Line } from '@pellux/goodvibes-sdk/platform/types';
import type { SurfaceLayer } from '../../renderer/surface-kit.ts';
import { composeLayers, type CellGrid } from '../../renderer/surface-compose.ts';

/** Wrap Line[] as a CellGrid. */
function lineGrid(lines: Line[], width: number): CellGrid {
  return {
    width,
    height: lines.length,
    getCell: (x, y) => lines[y]?.[x],
    setCell: (x, y, cell) => {
      const row = lines[y];
      if (row && x >= 0 && x < width) row[x] = cell;
    },
  };
}

/** Compose layers over a blank screen (or over `base` when given) and return the screen lines. */
export function frameFromLayers(layers: readonly SurfaceLayer[], width: number, height: number, base?: Line[]): Line[] {
  const screen: Line[] = Array.from({ length: height }, (_, y) => {
    const row = base?.[y];
    const line = createEmptyLine(width);
    if (row) for (let x = 0; x < width && x < row.length; x++) line[x] = { ...row[x]! };
    return line;
  });
  composeLayers(lineGrid(screen, width), layers);
  return screen;
}

/** One layer composed over a blank screen. */
export function frameFromLayer(layer: SurfaceLayer | null, width: number, height: number, base?: Line[]): Line[] {
  return frameFromLayers(layer ? [layer] : [], width, height, base);
}

/** The text of every row of a frame (continuation cells dropped, trailing spaces kept). */
export function frameText(lines: readonly Line[]): string[] {
  return lines.map((line) => line.map((cell) => cell.char).join(''));
}

/** The text of a layer's own rows. */
export function layerText(layer: SurfaceLayer | null): string[] {
  return layer ? frameText(layer.lines) : [];
}

/** All of a layer's text joined by newlines (for `toContain` assertions). */
export function layerTextBlock(layer: SurfaceLayer | null): string {
  return layerText(layer).join('\n');
}
