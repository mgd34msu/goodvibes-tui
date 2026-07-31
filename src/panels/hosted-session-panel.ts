/**
 * HostedSessionPanel — the conversation the daemon is running, rendered here.
 *
 * A hosted session's turn arrives on the same `turn` and `tools` event domains
 * a local turn does, so what this panel shows is the same thing the transcript
 * shows for a local conversation: what was said, what tool is running, and
 * whether text is still streaming. The difference is where the loop lives, and
 * the header says so plainly — including `effectiveDetachPolicy`, so a person
 * about to quit knows whether that ends the work.
 *
 * The panel renders; it decides nothing. Every fact in the header is a field of
 * the daemon's own record (hosted-session-feed.ts), and the rows are the
 * backfilled history plus the live frames. When there is no stream open the
 * panel says why rather than showing a still conversation that looks finished.
 */
import type { Line } from '@pellux/goodvibes-sdk/platform/types';
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
import {
  getSharedHostedSessionFeed,
  type HostedSessionFeed,
  type HostedSessionFeedState,
  type HostedSessionRow,
} from './hosted-session-feed.ts';

const C = DEFAULT_PANEL_PALETTE;

const INTRO = 'A conversation whose loop runs inside the daemon. Steer it with /hosted say, leave it with /hosted detach — the header says what leaving would do.';

function rowColor(kind: HostedSessionRow['kind']): string {
  switch (kind) {
    case 'user': return C.accent;
    case 'assistant': return C.value;
    case 'tool': return C.info;
    case 'error': return C.bad;
    default: return C.dim;
  }
}

function rowPrefix(kind: HostedSessionRow['kind']): string {
  switch (kind) {
    case 'user': return 'you';
    case 'assistant': return 'hosted';
    case 'tool': return 'tool';
    case 'error': return 'error';
    default: return '·';
  }
}

/** Every line one transcript row needs. Text is wrapped in full, never clipped. */
export function renderHostedRow(row: HostedSessionRow, width: number): Line[] {
  const lines: Line[] = [];
  const fg = rowColor(row.kind);
  const marker = row.streaming ? ' …' : '';
  const body = `${rowPrefix(row.kind)}: ${row.text}${marker}`;
  const wrapWidth = Math.max(1, width - 1);
  for (const [index, wrapped] of wrapText(body, wrapWidth).entries()) {
    lines.push(buildStyledPanelLine(width, [{ text: ` ${wrapped}`, fg, bold: index === 0 && row.kind === 'user' }]));
  }
  return lines;
}

/**
 * The header block: who this session is, what it is doing, and what leaving it
 * would do. Every value comes from the record; nothing is derived locally.
 */
export function buildHostedHeaderLines(state: HostedSessionFeedState, width: number): Line[] {
  const record = state.record;
  if (!record) return [];
  const policyText = record.effectiveDetachPolicy === 'survive'
    ? 'detaching keeps it running (survive)'
    : 'detaching ends it (kill)';
  const policySource = record.detachPolicy === null ? 'from the setting' : 'per-session override';
  const rows: { text: string; fg: string }[] = [
    { text: `${record.title.trim() || record.id} — ${record.status}`, fg: C.header },
    { text: `id ${record.id}`, fg: C.dim },
    { text: `workspace ${record.workspaceRoot}`, fg: C.dim },
    {
      text: `${policyText}, ${policySource}`,
      fg: record.effectiveDetachPolicy === 'survive' ? C.good : C.warn,
    },
    {
      text: `${record.turnCount} turn(s), ${record.messageCount} message(s); attached: ${record.attachedClients.length > 0 ? record.attachedClients.join(', ') : 'nobody'}`,
      fg: C.label,
    },
  ];
  if (record.status === 'terminated') {
    rows.push({ text: `ended — ${record.terminatedReason ?? 'no reason recorded'}`, fg: C.bad });
  }
  if (record.restoredFromDisk) {
    rows.push({ text: 'restored from disk after a daemon restart', fg: C.warn });
  }
  rows.push(state.streaming
    ? { text: 'live event stream open', fg: C.good }
    : { text: `no live stream — ${state.streamNote ?? 'not subscribed'}`, fg: C.warn });
  if (state.runningToolCalls.length > 0) {
    rows.push({
      text: `running: ${state.runningToolCalls.map((call) => `${call.tool} (${call.callId})`).join(', ')}`,
      fg: C.info,
    });
  }
  if (state.droppedRows > 0) {
    rows.push({ text: `${state.droppedRows} earlier row(s) dropped by this panel's buffer — reattach to backfill`, fg: C.dim });
  }
  const lines: Line[] = [];
  for (const row of rows) {
    for (const wrapped of wrapText(row.text, Math.max(1, width - 1))) {
      lines.push(buildStyledPanelLine(width, [{ text: ` ${wrapped}`, fg: row.fg }]));
    }
  }
  return lines;
}

export class HostedSessionPanel extends BasePanel {
  private readonly unsubscribe: () => void;
  private scrollOffset = 0;
  /** Off until the user scrolls: a live conversation should follow its own tail. */
  private pinnedToTail = true;

  constructor(private readonly feed: HostedSessionFeed = getSharedHostedSessionFeed()) {
    // '◈' verified free against the registered builtin panel icons.
    super('hosted', 'Hosted Session', '◈', 'session');
    this.unsubscribe = this.feed.subscribe(() => {
      if (this.pinnedToTail) this.scrollOffset = Number.MAX_SAFE_INTEGER;
      this.markDirty();
    });
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
      case 'end': {
        this.pinnedToTail = true;
        this.scrollOffset = Number.MAX_SAFE_INTEGER;
        this.markDirty();
        return true;
      }
      default: return false;
    }
  }

  private scroll(delta: number): boolean {
    const rows = this.feed.getState().rows;
    if (rows.length === 0) return false;
    // Scrolling up unpins; reaching the bottom re-pins, so a reader who catches
    // up starts following again without a second key.
    this.pinnedToTail = false;
    this.scrollOffset = Math.max(0, this.scrollOffset + delta);
    this.markDirty();
    return true;
  }

  render(width: number, height: number): Line[] {
    if (width <= 0 || height <= 0) return [];
    const state = this.feed.getState();
    const hintRow = buildKeyboardHints(width, [
      { keys: 'Up/Down', label: 'scroll' },
      { keys: 'PgUp/PgDn', label: 'page' },
      { keys: 'End', label: 'follow' },
    ], DEFAULT_PANEL_PALETTE);

    if (!state.record) {
      return buildPanelWorkspace(width, height, {
        title: ' Hosted Session',
        intro: INTRO,
        sections: [{
          lines: buildEmptyState(
            width,
            ' Not attached to a hosted session',
            'A hosted session runs inside the daemon instead of this terminal, so it can outlive the window it was started from. Start one with /hosted new, or join one that already exists with /hosted list and /hosted attach <id>. Local sessions are unchanged and remain the default.',
            [],
            DEFAULT_PANEL_PALETTE,
          ),
        }],
        footerLines: [hintRow],
        palette: DEFAULT_PANEL_PALETTE,
      });
    }

    const headerSection = { lines: buildHostedHeaderLines(state, width - 2) };
    const scrollableLines = state.rows.flatMap((row) => renderHostedRow(row, width - 2));
    const section = resolveScrollablePanelSection(width, height, {
      intro: INTRO,
      footerLines: [hintRow],
      palette: DEFAULT_PANEL_PALETTE,
      beforeSections: [headerSection],
      section: {
        title: `Transcript (${state.rows.length})`,
        scrollableLines,
        scrollOffset: this.scrollOffset,
        minRows: 4,
        appendWindowSummary: scrollableLines.length > 0 ? { dimColor: DEFAULT_PANEL_PALETTE.dim } : undefined,
      },
    });
    this.scrollOffset = section.scrollOffset;

    return buildPanelWorkspace(width, height, {
      title: ' Hosted Session',
      intro: INTRO,
      sections: [headerSection, section.section],
      footerLines: [hintRow],
      palette: DEFAULT_PANEL_PALETTE,
    });
  }
}
