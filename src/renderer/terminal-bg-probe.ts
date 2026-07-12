/**
 * terminal-bg-probe — OSC 11 terminal-background detection for `auto` theme mode.
 *
 *. On startup, when appearance is `auto` and stdout is a TTY, we ask
 * the terminal for its background colour with an OSC 11 query and classify the
 * reply as light or dark. Everything about this is best-effort and conservative:
 * any timeout, any unparseable reply, any ambiguity resolves to DARK, which is
 * the historical default and keeps headless/unsupported terminals byte-stable.
 *
 * Timing (Option B — render dark first, repaint once if light wins):
 *   The probe never blocks startup. The splash renders immediately in dark; if a
 *   light reply arrives within the timeout window the caller flips the active mode
 *   to light and repaints ONCE. Rationale vs. blocking the first paint until the
 *   reply/timeout: blocking would tax EVERY non-responding terminal (tmux without
 *   passthrough, CI, old SSH hosts, dumb terminals) with up to `timeoutMs` of blank
 *   screen on every launch — the common failure case. Option B adds zero startup
 *   latency and costs at most a single dark→light repaint on genuinely light
 *   terminals (rare for this audience, one frame).
 *
 * Stream safety (never corrupt the composer):
 *   The reply arrives on the same stdin the keyboard uses. filterInput() sits at
 *   the very front of the stdin handler (before blocking-input / paste / the
 *   tokenizer). It passes every non-OSC-11 byte straight through — interleaved
 *   keystrokes reach the tokenizer untouched — and consumes ONLY a matched OSC 11
 *   reply (whole or split across chunks). On timeout, any buffered reply fragment
 *   is discarded rather than flushed, so partial/garbled response bytes can never
 *   leak into the input pipeline.
 *
 * tmux:
 *   When $TMUX is set the query is wrapped in the tmux DCS passthrough envelope so
 *   the outer terminal sees it. This only elicits a reply if the user has
 *   `allow-passthrough` enabled; otherwise the query is swallowed and the timeout
 *   fallback (dark) covers it silently.
 */

import { setActiveThemeMode, type ThemeMode } from './theme.ts';
import { resolveConfiguredThemeMode } from './theme-mode-config.ts';
import type { ConfigManager } from '@pellux/goodvibes-sdk/platform/config';

/** OSC 11 "query background colour" request, ST-terminated. */
export const OSC11_QUERY = '\x1b]11;?\x1b\\';

/** The response prefix we scan for: ESC ] 1 1 ; */
const OSC11_PREFIX = '\x1b]11;';

/** Default probe window. Cooperating terminals reply in single-digit ms. */
export const DEFAULT_PROBE_TIMEOUT_MS = 150;

/** Luminance split point (normalized 0..1). At/above → light; below → dark. */
export const LUMINANCE_LIGHT_THRESHOLD = 0.5;

/** An 8-bit-per-channel colour parsed from an OSC 11 reply. */
export interface ProbeRgb {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

// ---------------------------------------------------------------------------
// Pure parsing / classification (exercised directly by the fake-terminal harness)
// ---------------------------------------------------------------------------

/**
 * Parse a single hex channel of `len` digits into an 8-bit value.
 * Scales by the channel's own full-scale (16^len - 1) so `ffff`→255, `ff`→255,
 * `80`→128, `8000`→128. Returns null on non-hex input.
 */
function parseHexChannel(hex: string): number | null {
  if (hex.length === 0 || !/^[0-9a-fA-F]+$/.test(hex)) return null;
  const max = 16 ** hex.length - 1;
  return Math.round((parseInt(hex, 16) / max) * 255);
}

/**
 * Parse an OSC 11 colour spec into 8-bit RGB. Accepts:
 *   - `rgb:RRRR/GGGG/BBBB` and `rgb:RR/GG/BB` (1–4 hex digits per channel)
 *   - `rgba:R/G/B/A` (alpha ignored)
 *   - `#RRGGBB` and `#RRRRGGGGBBBB`
 * Returns null for anything else (→ caller treats as dark).
 */
export function parseColorSpec(spec: string): ProbeRgb | null {
  const trimmed = spec.trim();

  if (trimmed.startsWith('rgb:') || trimmed.startsWith('rgba:')) {
    const body = trimmed.slice(trimmed.indexOf(':') + 1);
    const parts = body.split('/');
    if (parts.length < 3) return null;
    const r = parseHexChannel(parts[0]!);
    const g = parseHexChannel(parts[1]!);
    const b = parseHexChannel(parts[2]!);
    if (r === null || g === null || b === null) return null;
    return { r, g, b };
  }

  if (trimmed.startsWith('#')) {
    const hex = trimmed.slice(1);
    if (hex.length !== 6 && hex.length !== 12) return null;
    if (!/^[0-9a-fA-F]+$/.test(hex)) return null;
    const per = hex.length / 3;
    const r = parseHexChannel(hex.slice(0, per));
    const g = parseHexChannel(hex.slice(per, per * 2));
    const b = parseHexChannel(hex.slice(per * 2));
    if (r === null || g === null || b === null) return null;
    return { r, g, b };
  }

  return null;
}

/**
 * Classify a background colour as 'light' or 'dark' by relative luminance.
 * Uses the Rec. 601 luma weights (0.299/0.587/0.114) normalized to 0..1 and
 * splits at LUMINANCE_LIGHT_THRESHOLD (0.5): a background at least half as
 * luminous as white reads as light. Conservative by construction — the exact
 * threshold only matters for mid-grey backgrounds, which are rare.
 */
export function classifyBackgroundLuminance(rgb: ProbeRgb): ThemeMode {
  const luma = (0.299 * rgb.r + 0.587 * rgb.g + 0.114 * rgb.b) / 255;
  return luma >= LUMINANCE_LIGHT_THRESHOLD ? 'light' : 'dark';
}

/** Where a terminator starts and where the byte after it is, within a buffer. */
interface TerminatorSpan {
  readonly start: number;
  readonly end: number;
}

/**
 * Find the OSC string terminator at/after `from`: BEL (\x07) or ST (ESC \).
 * Returns null if no terminator is present yet (reply still arriving). A lone
 * trailing ESC returns null (wait for the next byte to tell ST from a stray ESC);
 * an ESC followed by a non-'\' byte is treated as the end boundary (malformed
 * terminator — the body before it is still parsed, the stray byte passes through).
 */
function findTerminator(buffer: string, from: number): TerminatorSpan | null {
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

/**
 * Longest suffix of `buffer` that is a PROPER prefix of OSC11_PREFIX, used to
 * hold back a partial reply-prefix split across chunk boundaries (e.g. a chunk
 * ending in a bare ESC that might become `\x1b]11;`). Only consulted when the
 * full prefix is not present in the buffer.
 */
function trailingPrefixLen(buffer: string): number {
  const maxLen = Math.min(OSC11_PREFIX.length - 1, buffer.length);
  for (let len = maxLen; len >= 1; len--) {
    if (buffer.endsWith(OSC11_PREFIX.slice(0, len))) return len;
  }
  return 0;
}

// ---------------------------------------------------------------------------
// TerminalBackgroundProbe — the stateful stream filter + timing
// ---------------------------------------------------------------------------

export interface ProbeResolution {
  readonly mode: ThemeMode;
  readonly reason: 'light-reply' | 'dark-reply' | 'unparseable' | 'timeout';
}

export interface TerminalBackgroundProbeOptions {
  /** Called exactly once with the resolved mode + reason. */
  readonly onResolve: (result: ProbeResolution) => void;
  /** Probe window in ms (default DEFAULT_PROBE_TIMEOUT_MS). */
  readonly timeoutMs?: number;
}

/**
 * Stateful OSC 11 reply filter. feed() takes a raw stdin chunk and returns the
 * bytes that should continue down the input pipeline (everything except a matched
 * OSC 11 reply). Resolves once — on the first complete reply or on timeout.
 */
export class TerminalBackgroundProbe {
  /** True until resolved. filterInput() only calls feed() while active. */
  public active = true;

  private buffer = '';
  private resolved = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly onResolve: (result: ProbeResolution) => void;
  private readonly timeoutMs: number;

  constructor(options: TerminalBackgroundProbeOptions) {
    this.onResolve = options.onResolve;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  }

  /** Arm the timeout fallback. Call after writing the query. */
  startTimeout(): void {
    this.timer = setTimeout(() => this.resolve('dark', 'timeout'), this.timeoutMs);
    // Never keep the event loop alive for the probe timer.
    (this.timer as unknown as { unref?: () => void }).unref?.();
  }

  /**
   * Consume a raw stdin chunk. Returns the passthrough bytes (keystrokes and any
   * non-OSC-11 sequences), having stripped and acted on any OSC 11 reply.
   */
  feed(chunk: string): string {
    if (!this.active) return chunk;
    this.buffer += chunk;
    let out = '';

    for (;;) {
      const prefixIdx = this.buffer.indexOf(OSC11_PREFIX);
      if (prefixIdx === -1) {
        // No full reply prefix. Release everything except a possible partial
        // prefix at the tail (held back to disambiguate next chunk).
        const keep = trailingPrefixLen(this.buffer);
        out += this.buffer.slice(0, this.buffer.length - keep);
        this.buffer = keep > 0 ? this.buffer.slice(this.buffer.length - keep) : '';
        break;
      }

      // Release bytes before the reply (interleaved keystrokes survive).
      out += this.buffer.slice(0, prefixIdx);
      const term = findTerminator(this.buffer, prefixIdx + OSC11_PREFIX.length);
      if (term === null) {
        // Incomplete reply: hold from the prefix onward, await more bytes.
        this.buffer = this.buffer.slice(prefixIdx);
        break;
      }

      // Complete reply. Capture the post-reply remainder BEFORE resolving
      // (resolve() clears the buffer to discard reply residue, so any trailing
      // keystrokes must be preserved here, not read back off this.buffer).
      const spec = this.buffer.slice(prefixIdx + OSC11_PREFIX.length, term.start);
      const remainder = this.buffer.slice(term.end);
      const rgb = parseColorSpec(spec);
      if (rgb === null) {
        this.resolve('dark', 'unparseable');
      } else {
        const mode = classifyBackgroundLuminance(rgb);
        this.resolve(mode, mode === 'light' ? 'light-reply' : 'dark-reply');
      }
      // Resolved (active is now false): forward the post-reply keystrokes and stop.
      out += remainder;
      break;
    }

    return out;
  }

  /** Resolve once; clears the timer and (on timeout) discards reply residue. */
  private resolve(mode: ThemeMode, reason: ProbeResolution['reason']): void {
    if (this.resolved) return;
    this.resolved = true;
    this.active = false;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    // Any bytes still buffered here are an incomplete/garbled reply fragment —
    // discard them so they can never leak into the composer.
    this.buffer = '';
    this.onResolve({ mode, reason });
  }
}

// ---------------------------------------------------------------------------
// tmux passthrough + install entry
// ---------------------------------------------------------------------------

/** Wrap a control sequence in the tmux DCS passthrough envelope (ESC doubled). */
export function wrapForTmuxPassthrough(seq: string): string {
  return `\x1bPtmux;${seq.replace(/\x1b/g, '\x1b\x1b')}\x1b\\`;
}

/** The stdin filter the caller installs at the front of its data handler. */
export interface ThemeProbeHandle {
  /** Filter a raw stdin chunk; returns the bytes to forward downstream. */
  filterInput(chunk: string): string;
}

export interface InstallThemeProbeOptions {
  readonly configManager: Pick<ConfigManager, 'get'>;
  /** Whether stdout is a real TTY (probe only runs on a TTY in auto mode). */
  readonly isTTY: boolean;
  /** Process env (only TMUX is read). */
  readonly env: Record<string, string | undefined>;
  /** Writes the query bytes (caller wraps in its terminal-output guard). */
  readonly writeQuery: (bytes: string) => void;
  /** Called when a light reply wins within the window → repaint once. */
  readonly requestRepaint: () => void;
  /** Optional timeout override (tests). */
  readonly timeoutMs?: number;
  /** Optional resolution observer (tests / diagnostics). */
  readonly onResolve?: (result: ProbeResolution) => void;
}

/**
 * Read the appearance preference and set up the active theme mode:
 *   - dark/light  → force immediately (before first paint); no probe.
 *   - auto + TTY  → leave dark, fire the OSC 11 query, and on a light reply flip
 *                   to light + repaint once (Option B).
 *   - auto + !TTY → stay dark (headless/piped; probe cannot run).
 * Returns a handle whose filterInput() the caller wires at the front of its
 * stdin data handler. For non-auto and non-TTY cases the filter is a passthrough.
 */
export function installBackgroundThemeProbe(options: InstallThemeProbeOptions): ThemeProbeHandle {
  const pref = resolveConfiguredThemeMode(options.configManager);

  if (pref === 'dark' || pref === 'light') {
    setActiveThemeMode(pref);
    return { filterInput: (chunk) => chunk };
  }

  // pref === 'auto'
  if (!options.isTTY) {
    setActiveThemeMode('dark');
    return { filterInput: (chunk) => chunk };
  }

  const probe = new TerminalBackgroundProbe({
    timeoutMs: options.timeoutMs,
    onResolve: (result) => {
      if (result.mode === 'light') {
        setActiveThemeMode('light');
        options.requestRepaint();
      }
      options.onResolve?.(result);
    },
  });

  const query = options.env['TMUX'] ? wrapForTmuxPassthrough(OSC11_QUERY) : OSC11_QUERY;
  options.writeQuery(query);
  probe.startTimeout();

  return { filterInput: (chunk) => (probe.active ? probe.feed(chunk) : chunk) };
}
