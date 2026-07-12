/**
 * NotificationsPanel — the visible home for notifications routed to the
 * `panel_only` target (see notifications-feed.ts for why this exists).
 *
 * Renders every entry the feed has accumulated: standalone panel-routed
 * notifications, and collapsed burst/batch groups shown honestly with their
 * real running count and the plain-language reason they were held back from
 * the conversation. Descriptive text (titles, bodies, reason descriptions)
 * is always wrapped in full — never clipped to a column width.
 */
import type { Line } from '../types/grid.ts';
import type { RoutingDecision } from '@/runtime/index.ts';
import { BasePanel } from './base-panel.ts';
import {
  buildEmptyState,
  buildKeyboardHints,
  buildPanelWorkspace,
  buildStyledPanelLine,
  DEFAULT_PANEL_PALETTE,
  resolveScrollablePanelSection,
} from './polish.ts';
import { wrapText } from '../utils/terminal-width.ts';
import { getSharedNotificationFeed, type PanelFeedEntry, type PanelNotificationFeed } from './notifications-feed.ts';

// Reuses the shared, mode-aware (dark/light) panel palette's existing
// bad/warn/info/dim tokens rather than minting new hex literals — this
// panel has no color needs the shared palette doesn't already name.
const C = DEFAULT_PANEL_PALETTE;

/** Plain-language description of why a notification never reached the conversation or status bar. Every reason code is covered so a new one fails visibly (a TypeScript error on this object) rather than silently. */
const REASON_DESCRIPTIONS: Record<RoutingDecision['reasonCode'], string> = {
  allowed: 'routed here by domain verbosity',
  quiet_while_typing: 'held while you were typing',
  mode_context_minimal: 'held back by quiet mode',
  mode_context_normal: 'held back by balanced mode',
  burst_collapsed: 'rapid repeats collapsed',
  batch_window_collapsed: 'repeated within a few seconds, collapsed',
  domain_verbosity_low: "below this domain's verbosity setting",
};

function levelColor(level: PanelFeedEntry['level']): string {
  switch (level) {
    case 'critical': return C.bad;
    case 'warning': return C.warn;
    case 'debug': return C.dim;
    default: return C.info;
  }
}

function levelTag(level: PanelFeedEntry['level']): string {
  return `[${level}]`;
}

/** Build every Line an entry needs — title/meta row, then the full body and reason text wrapped with no line cap (descriptive text is never clipped). */
function renderEntry(entry: PanelFeedEntry, width: number): Line[] {
  const lines: Line[] = [];
  const fg = levelColor(entry.level);
  const countSuffix = entry.collapsedCount > 1 ? ` ×${entry.collapsedCount}` : '';
  const headerText = `${levelTag(entry.level)} ${entry.domain} — ${entry.title}${countSuffix}`;
  for (const wrapped of wrapText(headerText, Math.max(1, width - 1))) {
    lines.push(buildStyledPanelLine(width, [{ text: ` ${wrapped}`, fg, bold: true }]));
  }
  const reasonText = entry.collapsedCount > 1
    ? `  ${entry.collapsedCount} notifications collapsed — ${REASON_DESCRIPTIONS[entry.reasonCode]}`
    : `  ${REASON_DESCRIPTIONS[entry.reasonCode]}`;
  for (const wrapped of wrapText(reasonText, Math.max(1, width - 1))) {
    lines.push(buildStyledPanelLine(width, [{ text: ` ${wrapped}`, fg: C.dim }]));
  }
  if (entry.body) {
    for (const wrapped of wrapText(`  ${entry.body}`, Math.max(1, width - 1))) {
      lines.push(buildStyledPanelLine(width, [{ text: ` ${wrapped}`, fg: C.value }]));
    }
  }
  return lines;
}

export class NotificationsPanel extends BasePanel {
  private readonly unsubscribe: () => void;
  private scrollOffset = 0;

  constructor(private readonly feed: PanelNotificationFeed = getSharedNotificationFeed()) {
    super('notifications', 'Notifications', 'N', 'runtime-ops');
    this.unsubscribe = this.feed.subscribe(() => this.markDirty());
  }

  override onDestroy(): void {
    this.unsubscribe();
    super.onDestroy();
  }

  handleInput(key: string): boolean {
    switch (key) {
      case 'up': return this.scroll(-1);
      case 'down': return this.scroll(1);
      case 'pageup': return this.scroll(-10);
      case 'pagedown': return this.scroll(10);
      default: return false;
    }
  }

  private scroll(delta: number): boolean {
    const entries = this.feed.list();
    if (entries.length <= 1) return false;
    const maxOffset = Math.max(0, entries.length - 1);
    const prev = this.scrollOffset;
    this.scrollOffset = Math.max(0, Math.min(maxOffset, this.scrollOffset + delta));
    if (this.scrollOffset !== prev) this.markDirty();
    return true;
  }

  render(width: number, height: number): Line[] {
    if (width <= 0 || height <= 0) return [];
    const entries = this.feed.list();
    const hintRow = buildKeyboardHints(width, [
      { keys: 'Up/Down', label: 'scroll' },
      { keys: 'PgUp/PgDn', label: 'page' },
    ], DEFAULT_PANEL_PALETTE);

    if (entries.length === 0) {
      return buildPanelWorkspace(width, height, {
        title: ' Notifications',
        intro: 'Notifications held back from the conversation or status bar (panel_only) land here, including their real collapsed counts.',
        sections: [{
          lines: buildEmptyState(
            width,
            ' No panel-routed notifications yet',
            'Nothing has been routed here this session. Quiet/balanced-mode operational chatter and collapsed bursts will appear here honestly, with their real counts, once something routes to this target.',
            [],
            DEFAULT_PANEL_PALETTE,
          ),
        }],
        footerLines: [hintRow],
        palette: DEFAULT_PANEL_PALETTE,
      });
    }

    const scrollableLines = entries.flatMap((entry) => renderEntry(entry, width - 2));
    const section = resolveScrollablePanelSection(width, height, {
      intro: 'Notifications held back from the conversation or status bar (panel_only) land here, including their real collapsed counts.',
      footerLines: [hintRow],
      palette: DEFAULT_PANEL_PALETTE,
      section: {
        title: `Notifications (${entries.length})`,
        scrollableLines,
        scrollOffset: this.scrollOffset,
        minRows: 4,
        appendWindowSummary: scrollableLines.length > 0 ? { dimColor: DEFAULT_PANEL_PALETTE.dim } : undefined,
      },
    });
    this.scrollOffset = section.scrollOffset;

    return buildPanelWorkspace(width, height, {
      title: ' Notifications',
      intro: 'Notifications held back from the conversation or status bar (panel_only) land here, including their real collapsed counts.',
      sections: [section.section],
      footerLines: [hintRow],
      palette: DEFAULT_PANEL_PALETTE,
    });
  }
}
