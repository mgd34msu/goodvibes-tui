import { DEFAULT_PANEL_PALETTE } from '../polish.ts';
import type { ModalSectionStyle } from '../../renderer/modal-factory.ts';
import type { ConfigModalRow } from '../../input/config-modal-types.ts';

/**
 * Shared formatting helpers for W6.1 config-modal surfaces. Row styling reuses
 * DEFAULT_PANEL_PALETTE (the retired panels' palette) so a migrated modal reads
 * as the same surface it replaced — the goldens stay panel-consistent.
 */
export const PALETTE = DEFAULT_PANEL_PALETTE;

export type Tone = 'good' | 'bad' | 'warn' | 'info' | 'dim' | 'value';

/** Map a semantic tone to a ModalSectionStyle (foreground only). */
export function toneStyle(tone: Tone): ModalSectionStyle {
  return { fg: PALETTE[tone] };
}

/** A single-glyph status dot matching the provider-console convention
 *  (● online · ◐ warming · ✕ error · ○ idle). */
export function statusGlyph(tone: Tone): string {
  switch (tone) {
    case 'good': return '●';
    case 'warn': return '◐';
    case 'bad': return '✕';
    default: return '○';
  }
}

/** Fixed-width left-justify by display columns (plain padEnd is fine for the
 *  ASCII/latin labels these surfaces use; wide glyphs are the status dot only,
 *  which we place at a fixed column). */
export function pad(text: string, width: number): string {
  return text.length >= width ? text : text + ' '.repeat(width - text.length);
}

/** Build a `label value` posture cell for the header line. */
export function kv(label: string, value: string | number): string {
  return `${label} ${value}`;
}

/** Join posture cells into one header line with a consistent separator. */
export function postureLine(cells: string[]): string {
  return cells.join('   ');
}

/**
 * A stable non-selectable informational row (section title, empty-state copy,
 * or a content line the surface renders but the cursor never lands on). `id`
 * must be unique within its tab so the host's live-value overlay keys off it.
 */
export function infoRow(id: string, label: string, style?: ModalSectionStyle): ConfigModalRow {
  return { id, label, selectable: false, ...(style ? { style } : {}) };
}
