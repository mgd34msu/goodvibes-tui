/**
 * footer-tips.ts, the persistent discoverability hint shown in the shell
 * footer's tip slot.
 *
 * instead of a single frozen "/help for commands" line, the footer
 * surfaces a rotating set of the highest-value affordances (panels, process
 * monitor, help, quit). Rotation is *contextual, not timed*: when an agent turn
 * is actively running, the process-monitor tip is promoted to the front so the
 * operator can jump to F2 while work is in flight. Selection is a pure function
 * of context so the footer renders deterministically (golden frames stay
 * stable), no wall-clock input.
 */

export interface FooterTipContext {
  /** True while an agent turn is actively running (streaming / tools / hooks). */
  readonly agentActive: boolean;
}

/** Composer status labels that mean an agent turn is actively in flight. */
const ACTIVE_TURN_STATUSES = new Set(['preflight', 'streaming', 'tools', 'post-hooks']);

/** Derive agent-active state from the composer status label passed to the footer. */
export function isAgentActive(composerStatus: string | undefined): boolean {
  return composerStatus !== undefined && ACTIVE_TURN_STATUSES.has(composerStatus);
}

// Ctrl+P is a TOGGLE (open+focus when nothing is open or unfocused,
// hide when the workspace already has focus, see openPanelPicker in
// shell/ui-openers.ts). The bare noun 'panels' undersold that; naming the verb
// keeps the tip honest about what the chord actually does.
const TIP_PANELS = 'Ctrl+P toggle panels';
// F2 now opens the Fleet panel (the process modal was retired), so the
// tip names 'fleet', not 'processes'.
const TIP_PROCESSES = 'F2 fleet';
const TIP_HELP = '? help';
// f: an empty-composer Ctrl+C does NOT quit on the first press, it arms a
// ~1s "press again to exit" confirm, and only a SECOND Ctrl+C within that window
// exits (an intentional accidental-exit guard). The old 'Ctrl+C quit' tip
// implied a single press quits, so two presses seconds apart appeared to do
// nothing. 'Ctrl+C x2 quit' matches the real double-press contract (and the
// help overlay's "Ctrl+C x2  Exit" row).
const TIP_QUIT = 'Ctrl+C x2 quit';

/**
 * Build the footer discoverability tip. Segments join with the shared middle
 * dot. Agent-active state promotes the process-monitor tip to the front.
 */
export function buildFooterTip(ctx: FooterTipContext): string {
  const lead = ctx.agentActive
    ? [TIP_PROCESSES, TIP_PANELS, TIP_HELP]
    : [TIP_PANELS, TIP_PROCESSES, TIP_HELP];
  return [...lead, TIP_QUIT].join(' · ');
}
