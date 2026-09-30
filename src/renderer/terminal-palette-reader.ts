/**
 * terminal-palette-reader, reads the terminal's colours until it has them.
 *
 * One collection round (TerminalPaletteProbe) at startup is not enough:
 *   - tmux drops a query written while no client is attached (a TUI started
 *     in a detached session, or before the terminal window attached), and
 *     never answers it later;
 *   - a reply slower than the window (ssh, a busy multiplexer) arrives after
 *     the round closed.
 * So when a round ends without a single colour, the reader asks again on the
 * next sign a terminal is there: a timed retry after the first frame, a
 * focus-in report (tmux sends one on attach), a resize (attach usually
 * resizes), or input from the user. Rounds are capped (maxRounds) and spaced
 * (minRoundSpacingMs), so a terminal that never answers costs a few queries,
 * not one per keystroke. A reply that arrives outside any round is still
 * removed from stdin and, when it carries colours, published: the theme is
 * regenerated and repainted when the palette arrives, however late.
 *
 * Nothing here blocks: first paint never waits on the terminal.
 */

import { TerminalPaletteProbe, sweepPaletteReplies, type PaletteProbeResolution, type PaletteReply } from './terminal-palette-probe.ts';
import { emptyTerminalPalette, type TerminalPalette } from './terminal-palette.ts';

/** Timed retry after a round that got no colours (after the first frame). */
const PALETTE_RETRY_DELAY_MS = 1500;
/** Rounds per run, the startup round included. */
const PALETTE_MAX_ROUNDS = 6;
/** Minimum time between two round starts. */
const PALETTE_MIN_ROUND_SPACING_MS = 1000;

export interface TerminalPaletteReaderOptions {
  /** Writes one batch of queries (OSC 11 + OSC 10 + OSC 4;0..15). */
  readonly writeBatch: () => void;
  /** A palette with at least one colour arrived, or the startup round ended. */
  readonly onPalette: (palette: TerminalPalette) => void;
  /** Receives Esc / Alt+] held at a round's close (see TerminalPaletteProbe onFlush). */
  readonly onFlush?: (bytes: string) => void;
  /** Observer for each round's resolution (tests, diagnostics). */
  readonly onRoundResolve?: (result: PaletteProbeResolution, round: number) => void;
  readonly timeoutMs?: number;
  readonly retryDelayMs?: number;
  readonly maxRounds?: number;
  readonly minRoundSpacingMs?: number;
  readonly now?: () => number;
}

function hasColours(palette: TerminalPalette): boolean {
  return palette.background !== undefined || palette.foreground !== undefined || palette.ansi.some((slot) => slot !== undefined);
}

function samePalette(a: TerminalPalette, b: TerminalPalette | null): boolean {
  return b !== null && a.background === b.background && a.foreground === b.foreground
    && a.ansi.every((slot, i) => slot === b.ansi[i]);
}

export class TerminalPaletteReader {
  private probe: TerminalPaletteProbe | null = null;
  private rounds = 0;
  private lastRoundAt = Number.NEGATIVE_INFINITY;
  private settled = false;
  private published: TerminalPalette | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly now: () => number;

  constructor(private readonly options: TerminalPaletteReaderOptions) {
    this.now = options.now ?? Date.now;
  }

  /** True once some round (or late reply) produced at least one colour. */
  get hasPalette(): boolean {
    return this.settled;
  }

  /** Rounds started so far. */
  get roundCount(): number {
    return this.rounds;
  }

  /** Start the startup round. The caller may have written the batch itself (skipWrite). */
  start(skipWrite = false): void {
    this.beginRound(skipWrite);
  }

  /** An OSC 11 body consumed upstream by the background probe (startup round). */
  noteBackgroundSpec(spec: string): void {
    this.probe?.noteBackgroundSpec(spec);
  }

  /** Filter a stdin chunk: strips our replies, returns the rest. */
  feed(chunk: string): string {
    let out: string;
    if (this.probe?.active) {
      out = this.probe.feed(chunk);
    } else {
      const swept = sweepPaletteReplies(chunk);
      out = swept.out;
      if (swept.replies.length > 0) this.acceptLate(swept.replies);
    }
    // Input of any kind (a focus-in on attach, a key) means a terminal is
    // there to answer now.
    if (out.length > 0) this.retry();
    return out;
  }

  /** The terminal resized (a client attached, or the window changed). */
  noteResize(): void {
    this.retry();
  }

  /** Stop timers (tests, teardown). */
  dispose(): void {
    if (this.retryTimer !== null) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  /** Start another round when one is due. Returns true when it started one. */
  retry(): boolean {
    if (this.settled || this.probe?.active) return false;
    if (this.capped()) return false;
    if (this.now() - this.lastRoundAt < (this.options.minRoundSpacingMs ?? PALETTE_MIN_ROUND_SPACING_MS)) return false;
    this.beginRound(false);
    return true;
  }

  private capped(): boolean {
    return this.rounds >= (this.options.maxRounds ?? PALETTE_MAX_ROUNDS);
  }

  private beginRound(skipWrite: boolean): void {
    this.rounds += 1;
    this.lastRoundAt = this.now();
    const round = this.rounds;
    this.probe = new TerminalPaletteProbe({
      timeoutMs: this.options.timeoutMs,
      onFlush: this.options.onFlush,
      onResolve: (result) => this.roundResolved(result, round),
    });
    if (!skipWrite) this.options.writeBatch();
    this.probe.startTimeout();
  }

  private roundResolved(result: PaletteProbeResolution, round: number): void {
    if (hasColours(result.palette)) {
      this.settled = true;
      this.publish(result.palette);
    } else if (this.published === null) {
      // The startup round always publishes, so readers see the probe finished.
      this.publish(result.palette);
    }
    this.options.onRoundResolve?.(result, round);
    if (!this.settled) this.scheduleRetry();
  }

  private scheduleRetry(): void {
    if (this.retryTimer !== null) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      // Spacing can defer the timed retry (a round just ran); the cap ends it.
      if (!this.retry() && !this.settled && !this.probe?.active && !this.capped()) this.scheduleRetry();
    }, this.options.retryDelayMs ?? PALETTE_RETRY_DELAY_MS);
    (this.retryTimer as unknown as { unref?: () => void }).unref?.();
  }

  private acceptLate(replies: readonly PaletteReply[]): void {
    const base = this.published ?? emptyTerminalPalette();
    const next: TerminalPalette = { ...base, ansi: [...base.ansi] };
    for (const reply of replies) {
      if (reply.hex === undefined) continue;
      if (reply.slot === 'background') next.background = reply.hex;
      else if (reply.slot === 'foreground') next.foreground = reply.hex;
      else next.ansi[reply.slot] = reply.hex;
    }
    if (!hasColours(next) || samePalette(next, this.published)) return;
    this.settled = true;
    this.publish(next);
  }

  private publish(palette: TerminalPalette): void {
    this.published = palette;
    this.options.onPalette(palette);
  }
}
