/**
 * terminal-palette-probe, reads the terminal's foreground and 16 ANSI colours.
 *
 * The queries (OSC 10 foreground, OSC 4;0..15 palette) go out in the SAME write
 * as the existing OSC 11 background query (see installBackgroundThemeProbe in
 * terminal-bg-probe.ts), so the whole batch costs one write and one round trip.
 * Terminals answer in request order: OSC 11 first, which keeps the background
 * probe's timing exactly as before, then OSC 10, then OSC 4;0..15.
 *
 * Budget:
 *   The collection window is PALETTE_PROBE_TIMEOUT_MS = 175 ms, which is the
 *   background probe's 150 ms (DEFAULT_PROBE_TIMEOUT_MS) plus a 25 ms margin
 *   (PALETTE_PROBE_MARGIN_MS) for the 17 replies queued behind the OSC 11 one.
 *   Both windows start from the same write. Nothing blocks on it: first paint
 *   is not delayed, the only cost is that the stdin filter stays in front of the
 *   input pipeline for at most 25 ms longer than before. A terminal that
 *   answers all 18 queries ends the window early (typically single-digit ms).
 *
 * Stream safety mirrors the background probe: only matched OSC 4 / OSC 10 /
 * OSC 11 replies are consumed, every other byte passes through in order, a
 * reply split across chunks is held until complete, and on timeout any held
 * reply fragment is discarded rather than flushed into the composer.
 *
 * This module deliberately imports nothing from terminal-bg-probe.ts (that file
 * imports this one), so the two never form an import cycle.
 */

import {
  emptyTerminalPalette,
  TERMINAL_PALETTE_ANSI_SLOTS,
  type TerminalPalette,
} from './terminal-palette.ts';

/** OSC 10 "query default foreground colour", ST-terminated. */
const OSC10_QUERY = '\x1b]10;?\x1b\\';

/** OSC 4 "query palette entry N", ST-terminated. */
function osc4Query(index: number): string {
  return `\x1b]4;${index};?\x1b\\`;
}

/** OSC 10 followed by OSC 4;0 .. OSC 4;15, appended after the OSC 11 query. */
export const PALETTE_QUERIES: string = OSC10_QUERY
  + Array.from({ length: TERMINAL_PALETTE_ANSI_SLOTS }, (_, i) => osc4Query(i)).join('');

/** Extra time the palette window stays open past the background probe window. */
const PALETTE_PROBE_MARGIN_MS = 25;

/** Palette collection window: background probe window (150 ms) + margin (25 ms). */
export const PALETTE_PROBE_TIMEOUT_MS = 150 + PALETTE_PROBE_MARGIN_MS;

// ---------------------------------------------------------------------------
// Pure parsing
// ---------------------------------------------------------------------------

/** Scale a 1..4 digit hex channel to 8 bits against its own full scale. */
function channelTo8Bit(hex: string): number | null {
  if (!/^[0-9a-fA-F]{1,4}$/.test(hex)) return null;
  const max = 16 ** hex.length - 1;
  return Math.round((parseInt(hex, 16) / max) * 255);
}

function toHexByte(value: number): string {
  return value.toString(16).padStart(2, '0');
}

/**
 * Parse an OSC colour reply body into `#rrggbb`. Accepts `rgb:R/G/B` with 1 to
 * 4 hex digits per channel (each channel scaled by its own width, so `f`, `ff`,
 * `fff`, `ffff` all give `ff`), `rgba:R/G/B/A` (alpha ignored), and `#rrggbb` /
 * `#rrrrggggbbbb`. Returns null for anything else.
 */
export function parseOscColorToHex(spec: string): string | null {
  const trimmed = spec.trim();
  let channels: string[];

  if (trimmed.startsWith('rgb:') || trimmed.startsWith('rgba:')) {
    const parts = trimmed.slice(trimmed.indexOf(':') + 1).split('/');
    const expected = trimmed.startsWith('rgba:') ? 4 : 3;
    if (parts.length !== expected) return null;
    channels = parts.slice(0, 3);
  } else if (trimmed.startsWith('#')) {
    const hex = trimmed.slice(1);
    if (hex.length !== 6 && hex.length !== 12) return null;
    const per = hex.length / 3;
    channels = [hex.slice(0, per), hex.slice(per, per * 2), hex.slice(per * 2)];
  } else {
    return null;
  }

  const values = channels.map(channelTo8Bit);
  if (values.some((v) => v === null)) return null;
  return `#${(values as number[]).map(toHexByte).join('')}`;
}

/** Start of a reply we own: ESC ] 4 ; N ;  or  ESC ] 10 ;  or  ESC ] 11 ; */
const REPLY_INTRODUCER = /\x1b\](?:4;(\d{1,3});|(1[01]);)/;

/** A buffer tail that could still grow into REPLY_INTRODUCER. */
const PARTIAL_INTRODUCER = /\x1b(?:\](?:4(?:;\d{0,3})?|1[01]?)?)?$/;

/** Length of a trailing partial introducer to hold back, or 0. */
function trailingPartialLen(buffer: string): number {
  const esc = buffer.lastIndexOf('\x1b');
  if (esc === -1) return 0;
  const tail = buffer.slice(esc);
  const m = PARTIAL_INTRODUCER.exec(tail);
  return m !== null && m.index === 0 ? tail.length : 0;
}

/**
 * OSC string terminator at/after `from`: BEL or ST (ESC \). Same rules as the
 * background probe: a lone trailing ESC waits for the next byte; an ESC followed
 * by anything other than `\` ends the body (malformed terminator).
 */
function findTerminator(buffer: string, from: number): { start: number; end: number } | null {
  for (let k = from; k < buffer.length; k++) {
    const c = buffer[k];
    if (c === '\x07') return { start: k, end: k + 1 };
    if (c === '\x1b') {
      if (k + 1 >= buffer.length) return null;
      return buffer[k + 1] === '\\' ? { start: k, end: k + 2 } : { start: k, end: k + 1 };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// TerminalPaletteProbe, the stateful stream filter
// ---------------------------------------------------------------------------

export interface PaletteProbeResolution {
  /** Collected colours; unanswered or unparseable slots are undefined. */
  readonly palette: TerminalPalette;
  /** 'complete' when all 18 replies arrived, 'timeout' when the window closed. */
  readonly reason: 'complete' | 'timeout';
  /** How many of the 18 queries got a reply (parseable or not). */
  readonly replies: number;
}

export interface TerminalPaletteProbeOptions {
  /** Called exactly once, on completion or timeout. */
  readonly onResolve: (result: PaletteProbeResolution) => void;
  /** Window in ms (default PALETTE_PROBE_TIMEOUT_MS). */
  readonly timeoutMs?: number;
}

/** Total replies expected: background + foreground + 16 ANSI slots. */
const EXPECTED_REPLIES = 2 + TERMINAL_PALETTE_ANSI_SLOTS;

/**
 * Stateful OSC 4 / 10 / 11 reply filter. feed() takes a raw stdin chunk and
 * returns the bytes that continue down the input pipeline. The background
 * probe, when it runs in front of this filter and consumes the OSC 11 reply,
 * hands the reply body over with noteBackgroundSpec().
 */
export class TerminalPaletteProbe {
  /** True until resolved. */
  public active = true;

  private buffer = '';
  private resolved = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly palette: TerminalPalette = emptyTerminalPalette();
  private backgroundAnswered = false;
  private foregroundAnswered = false;
  private readonly ansiAnswered = new Array<boolean>(TERMINAL_PALETTE_ANSI_SLOTS).fill(false);
  private readonly onResolve: (result: PaletteProbeResolution) => void;
  private readonly timeoutMs: number;

  constructor(options: TerminalPaletteProbeOptions) {
    this.onResolve = options.onResolve;
    this.timeoutMs = options.timeoutMs ?? PALETTE_PROBE_TIMEOUT_MS;
  }

  /** Arm the window. Call right after writing the batched query. */
  startTimeout(): void {
    this.timer = setTimeout(() => this.resolve('timeout'), this.timeoutMs);
    (this.timer as unknown as { unref?: () => void }).unref?.();
  }

  /** Record an OSC 11 reply body consumed upstream by the background probe. */
  noteBackgroundSpec(spec: string): void {
    if (!this.active) return;
    this.recordBackground(spec);
    if (this.isComplete()) this.resolve('complete');
  }

  /** Consume a raw stdin chunk; returns the passthrough bytes. */
  feed(chunk: string): string {
    if (!this.active) return chunk;
    this.buffer += chunk;
    let out = '';

    for (;;) {
      const m = REPLY_INTRODUCER.exec(this.buffer);
      if (m === null) {
        const keep = trailingPartialLen(this.buffer);
        out += this.buffer.slice(0, this.buffer.length - keep);
        this.buffer = keep > 0 ? this.buffer.slice(this.buffer.length - keep) : '';
        break;
      }

      out += this.buffer.slice(0, m.index);
      const bodyStart = m.index + m[0].length;
      const term = findTerminator(this.buffer, bodyStart);
      if (term === null) {
        this.buffer = this.buffer.slice(m.index);
        break;
      }

      const spec = this.buffer.slice(bodyStart, term.start);
      if (m[1] !== undefined) this.recordAnsi(Number(m[1]), spec);
      else if (m[2] === '10') this.recordForeground(spec);
      else this.recordBackground(spec);
      this.buffer = this.buffer.slice(term.end);

      if (this.isComplete()) {
        // Keep the post-reply bytes before resolve() clears the buffer.
        const remainder = this.buffer;
        this.resolve('complete');
        out += remainder;
        break;
      }
    }

    return out;
  }

  private recordBackground(spec: string): void {
    this.backgroundAnswered = true;
    this.palette.background = parseOscColorToHex(spec) ?? undefined;
  }

  private recordForeground(spec: string): void {
    this.foregroundAnswered = true;
    this.palette.foreground = parseOscColorToHex(spec) ?? undefined;
  }

  private recordAnsi(index: number, spec: string): void {
    // Replies for slots we never asked about are still consumed, not recorded.
    if (index < 0 || index >= TERMINAL_PALETTE_ANSI_SLOTS) return;
    this.ansiAnswered[index] = true;
    this.palette.ansi[index] = parseOscColorToHex(spec) ?? undefined;
  }

  private replyCount(): number {
    return (this.backgroundAnswered ? 1 : 0)
      + (this.foregroundAnswered ? 1 : 0)
      + this.ansiAnswered.filter(Boolean).length;
  }

  private isComplete(): boolean {
    return this.replyCount() === EXPECTED_REPLIES;
  }

  private resolve(reason: PaletteProbeResolution['reason']): void {
    if (this.resolved) return;
    this.resolved = true;
    this.active = false;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    // Held bytes are an unfinished reply fragment: discard, never flush.
    this.buffer = '';
    this.onResolve({
      palette: { ...this.palette, ansi: [...this.palette.ansi] },
      reason,
      replies: this.replyCount(),
    });
  }
}
