/**
 * startup-typeahead-gate.ts, keeps keys typed before a startup question
 * appeared out of that question.
 *
 * The crash-recovery offer (recovery-prompt.ts) opens a modal at startup whose
 * Enter resumes a snapshot. A user who started typing before that modal was
 * on screen (during boot, or while the first frame was still on its way) is
 * typing into the composer in their head; routing those keys to the modal
 * would drop the text and let their Enter answer a question they never saw.
 *
 * The gate sits in the stdin path after the terminal-reply filters and before
 * the input router. While a startup modal is armed it HOLDS keyboard input
 * that is typeahead, and lets through input that is an answer:
 *   - anything that arrives before the modal's first frame was painted is
 *     typeahead by definition;
 *   - anything within settleMs of that paint is typeahead too (nobody reads a
 *     question and answers it that fast; it is a keystroke already in flight);
 *   - a key within burstGapMs of the previous held key continues the same
 *     burst of typing, and is held with it.
 * The first key after a pause goes to the modal, and from then on the modal
 * gets everything. When the modal flow ends, release() hands the held bytes
 * back and the caller replays them into the normal input path: they land in
 * the composer exactly as typed, nothing lost and nothing misrouted.
 *
 * Mouse reports and focus events are never held: they are not typing, and a
 * click on the modal is an answer.
 */

/** Input this soon after the modal's first frame is typeahead. */
export const TYPEAHEAD_SETTLE_MS = 250;
/** A key this soon after the previous held key continues the same burst. */
export const TYPEAHEAD_BURST_GAP_MS = 500;

/** SGR mouse reports and focus in/out reports: never typing. */
const NON_TYPING = /\x1b\[<\d+;\d+;\d+[Mm]|\x1b\[[IO]/g;

export interface StartupTypeaheadGate {
  /** A startup modal just opened. Holding starts; ignored when already armed. */
  arm(): void;
  /** The render loop painted a frame (only the first one after arm() counts). */
  framePainted(): void;
  /** Route one stdin chunk: returns the bytes to route now ('' when held). */
  filter(chunk: string): string;
  /** The modal flow ended: stop holding and return what was held. */
  release(): string;
  /** True while armed (holding or already passing input to the modal). */
  readonly armed: boolean;
}

export interface StartupTypeaheadGateOptions {
  readonly now?: () => number;
  readonly settleMs?: number;
  readonly burstGapMs?: number;
}

export function createStartupTypeaheadGate(options: StartupTypeaheadGateOptions = {}): StartupTypeaheadGate {
  const now = options.now ?? Date.now;
  const settleMs = options.settleMs ?? TYPEAHEAD_SETTLE_MS;
  const burstGapMs = options.burstGapMs ?? TYPEAHEAD_BURST_GAP_MS;
  let state: 'idle' | 'holding' | 'passing' = 'idle';
  let paintedAt: number | null = null;
  let lastHeldAt: number | null = null;
  let held = '';

  const isTyping = (chunk: string): boolean => chunk.replace(NON_TYPING, '').length > 0;

  return {
    get armed() {
      return state !== 'idle';
    },
    arm() {
      if (state !== 'idle') return;
      state = 'holding';
      paintedAt = null;
      lastHeldAt = null;
    },
    framePainted() {
      if (state === 'holding' && paintedAt === null) paintedAt = now();
    },
    filter(chunk) {
      if (state !== 'holding' || !isTyping(chunk)) return chunk;
      const t = now();
      const typeahead = paintedAt === null
        || t - paintedAt <= settleMs
        || (lastHeldAt !== null && t - lastHeldAt <= burstGapMs);
      if (typeahead) {
        held += chunk;
        lastHeldAt = t;
        return '';
      }
      state = 'passing';
      return chunk;
    },
    release() {
      const out = held;
      held = '';
      state = 'idle';
      paintedAt = null;
      lastHeldAt = null;
      return out;
    },
  };
}
