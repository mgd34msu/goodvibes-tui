/**
 * footer-tips.ts — the persistent discoverability hint shown in the shell
 * footer's tip slot.
 *
 * WO-151: instead of a single frozen "/help for commands" line, the footer
 * surfaces a rotating set of the highest-value affordances (panels, process
 * monitor, help, quit). Rotation is *contextual, not timed*: when an agent turn
 * is actively running, the process-monitor tip is promoted to the front so the
 * operator can jump to F2 while work is in flight. Selection is a pure function
 * of context so the footer renders deterministically (golden frames stay
 * stable) — no wall-clock input.
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

const TIP_PANELS = 'Ctrl+P panels';
const TIP_PROCESSES = 'F2 processes';
const TIP_HELP = '? help';
const TIP_QUIT = 'Ctrl+C quit';

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
