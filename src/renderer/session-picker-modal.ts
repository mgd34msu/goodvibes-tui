/**
 * renderSessionPickerModal — renders the /sessions picker modal as Line[]
 * using ModalFactory.
 *
 * Shows a list of saved sessions with:
 *   - name, timestamp (formatted), message count
 * Footer hints: [Enter] Load  [d] Delete  [Esc] Close
 *
 * When the modal was wired with a cross-surface session union
 * (`modal.crossSurfaceView.mode !== 'local'`), an additional read-only
 * "Cross-surface sessions" section is appended, badged kind/status/project
 * (parity with the webui SessionsView) with one of three honest states —
 * true-empty, offline, or stale — never a silently-collapsed list. In
 * 'local' mode (no sessionBroker wired, e.g. every pre-existing caller/test)
 * this section is entirely absent and the box sizing is unchanged.
 */

import type { Line } from '@pellux/goodvibes-sdk/platform/types';
import type { SharedSessionRecord } from '@pellux/goodvibes-sdk/platform/control-plane';
import { ModalFactory } from './modal-factory.ts';
import { UI_TONES } from './ui-primitives.ts';
import type { SessionPickerModal } from '../input/session-picker-modal.ts';
import { formatTimestamp } from './modal-utils.ts';
import { fitDisplay } from '../utils/terminal-width.ts';
import { getOverlaySurfaceMetrics, getStableOverlayContentRows } from './overlay-viewport.ts';

// ---------------------------------------------------------------------------
// Cross-surface badge helpers (parity with webui's src/lib/sessions-union.ts)
// ---------------------------------------------------------------------------

/** Verbatim for unknown/future kinds — never dropped, never guessed. */
function kindLabel(kind: string): string {
  return kind.trim() || 'unknown';
}

function projectLabel(project: string): string {
  return project.trim() || 'unknown';
}

function isClosedStatus(status: string): boolean {
  return status.trim().toLowerCase() === 'closed';
}

/**
 * Closed sessions carry an optional, honest reason for WHY they
 * closed under `metadata.closeReason` (SDK's `SharedSessionCloseReason`,
 * 'closeReason' key — see `@pellux/goodvibes-sdk` platform/control-plane
 * session-broker-sessions.ts's `readSessionCloseReason`). `metadata` is an
 * open record so old readers and records from a build that predates this
 * field ignore it safely — read it duck-typed here rather than importing the
 * SDK's helper, and tolerate `metadata` itself being absent or malformed.
 */
function readCloseReason(record: SharedSessionRecord): string | undefined {
  const raw = (record.metadata as Record<string, unknown> | undefined)?.['closeReason'];
  return typeof raw === 'string' ? raw : undefined;
}

/**
 * A GC sweep closing an idle session ('idle-reaped') auto-reopens on the next
 * heartbeat — it is NOT the same event as a deliberate user/surface close, so
 * it must never render under the same "closed" badge. Tolerant of
 * records without the field (pre-feature builds, or a deliberate close).
 */
function isReapedRecord(record: SharedSessionRecord): boolean {
  return isClosedStatus(record.status) && readCloseReason(record) === 'idle-reaped';
}

/**
 * UX-lens note: 'reaped' names a mechanism (the idle-session sweep),
 * not a state a first-time reader can guess — the webui pairs its own
 * 'reaped' badge with a tooltip explaining it
 * (SessionsView.tsx: "Closed by the idle-session sweep — reopens
 * automatically on the next activity"). The TUI has no hover/tooltip
 * surface, so the plain-language explanation is rendered as its own short
 * line under the cross-surface list instead — shown ONLY when at least one
 * visible row actually carries the badge, so it never adds noise to a list
 * with no reaped rows.
 */
const REAPED_BADGE_HINT = 'reaped = closed by the idle sweep — reopens on next activity';

/** True when at least one of the currently-rendered (post-truncation) cross-surface rows carries the 'reaped' badge. */
function hasVisibleReapedRow(modal: SessionPickerModal): boolean {
  if (modal.crossSurfaceView.mode === 'local') return false;
  return modal.crossSurfaceSessions.slice(0, MAX_CROSS_SURFACE_ROWS).some(isReapedRecord);
}

function statusLabel(record: SharedSessionRecord): string {
  const trimmed = record.status.trim();
  if (!trimmed) return 'active';
  if (!isClosedStatus(trimmed)) return trimmed;
  return isReapedRecord(record) ? 'reaped' : 'closed';
}

const MAX_CROSS_SURFACE_ROWS = 5;
const MAX_HOSTED_ROWS = 5;

// ---------------------------------------------------------------------------
// Daemon-hosted sessions
// ---------------------------------------------------------------------------

/**
 * The exact honest state of the hosted section, or null when the rows speak for
 * themselves. "Never read" and "the daemon hosts nothing" are different facts
 * and are never collapsed into each other.
 */
function hostedRosterNote(roster: SessionPickerModal['hostedRoster']): string | null {
  if (roster.note) return roster.note;
  if (roster.capturedAt === null) return 'Not read yet.';
  if (roster.sessions.length === 0) return 'The daemon is hosting no sessions.';
  return null;
}

/**
 * One hosted row: the id first, then what it is doing, what leaving it would
 * do, and finally its title.
 *
 * The id leads because it is the ACTIONABLE part — the row exists so `/hosted
 * attach <id>` can be typed off it — and a narrow terminal clips the tail. What
 * gets clipped must therefore be the descriptive end of the line, never the
 * thing the user has to retype.
 */
function hostedRowLabel(
  record: SessionPickerModal['hostedRoster']['sessions'][number],
  contentWidth: number,
): string {
  const policy = record.effectiveDetachPolicy === 'survive' ? 'survives detach' : 'ends on detach';
  const attached = record.attachedClients.length > 0 ? `${record.attachedClients.length} attached` : 'nobody attached';
  // Fitted to the content width MINUS the list indent modal-factory adds: at
  // the full width the row wraps to a second line, which the section's row
  // accounting does not reserve, and the trailing attach hint is then what the
  // tail clip eats.
  return fitDisplay(
    `${record.id} · ${record.status} · ${policy} · ${attached} · ${record.title || 'untitled'}`,
    Math.max(8, contentWidth - 4),
  );
}

/**
 * Whether the hosted section renders at all.
 *
 * Absent when NOTHING is known: no roster was wired (every pre-existing caller
 * and test), so the box size and content are unchanged for them. The moment the
 * roster has an answer — rows, an empty-but-read list, or a reason it could not
 * read — the section appears, because each of those is a fact worth showing.
 */
function hostedSectionVisible(modal: SessionPickerModal): boolean {
  const roster = modal.hostedRoster;
  return roster.sessions.length > 0 || roster.capturedAt !== null || roster.note !== null;
}

function hostedRowCount(modal: SessionPickerModal): number {
  return Math.min(MAX_HOSTED_ROWS, modal.hostedRoster.sessions.length);
}

/**
 * Extra content rows the hosted section needs: separator + header (+note)
 * + rows (+overflow line + the attach hint). Counted for the same reason the
 * cross-surface section counts its own — an uncounted trailing row is silently
 * eaten by modal-factory's tail clip.
 */
function hostedExtraRows(modal: SessionPickerModal): number {
  if (!hostedSectionVisible(modal)) return 0;
  const rows = hostedRowCount(modal);
  const noteRow = hostedRosterNote(modal.hostedRoster) ? 1 : 0;
  const overflowRow = modal.hostedRoster.sessions.length > MAX_HOSTED_ROWS ? 1 : 0;
  const hintRow = rows > 0 ? 1 : 0;
  return 2 + noteRow + overflowRow + hintRow + rows;
}

/**
 * The exact honest note for the current state, or null when the union view
 * needs no caveat (fresh, with rows). Precedence: offline > stale >
 * true-empty — the three designed states, never collapsed into
 * each other (an offline view never silently renders as "no sessions yet").
 */
function crossSurfaceNote(view: SessionPickerModal['crossSurfaceView'], rowCount: number): string | null {
  if (view.mode === 'local') return null;
  if (view.offlineNote) return `${view.offlineNote} — showing local sessions only`;
  if (view.stale) {
    if (view.lastSyncAt === null) return 'Union view may be stale.';
    const ageSeconds = Math.max(0, Math.round((Date.now() - view.lastSyncAt) / 1000));
    return `Union view may be stale, last synced ${ageSeconds}s ago`;
  }
  if (rowCount === 0) return 'No sessions yet.';
  return null;
}

function crossSurfaceRowCount(modal: SessionPickerModal): number {
  return modal.crossSurfaceView.mode === 'local' ? 0 : Math.min(MAX_CROSS_SURFACE_ROWS, modal.crossSurfaceSessions.length);
}

/**
 * Extra content rows the cross-surface section needs: separator + header
 * (+note) + rows (+the "[showing N of M]" overflow line when the union has
 * more records than MAX_CROSS_SURFACE_ROWS — previously uncounted here, which
 * let modal-factory's tail-clip silently eat that trailing line even though
 * the rest of the budget accounting held; see W3 Finding 1).
 */
function crossSurfaceExtraRows(modal: SessionPickerModal): number {
  if (modal.crossSurfaceView.mode === 'local') return 0;
  const rows = crossSurfaceRowCount(modal);
  const noteRow = crossSurfaceNote(modal.crossSurfaceView, rows) ? 1 : 0;
  const overflowRow = modal.crossSurfaceSessions.length > MAX_CROSS_SURFACE_ROWS ? 1 : 0;
  // W4 UX-lens: the plain-language 'reaped' explainer is its own row —
  // uncounted here it would be silently eaten by modal-factory's tail-clip
  // exactly the way W3 Finding 1 describes above.
  const reapedHintRow = hasVisibleReapedRow(modal) ? 1 : 0;
  return 2 + noteRow + overflowRow + reapedHintRow + Math.max(rows, noteRow === 1 && rows === 0 ? 0 : rows);
}

// ---------------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------------

/**
 * Render the session picker modal as Line[] for overlay in the viewport.
 *
 * @param modal  SessionPickerModal state object.
 * @param width  Terminal width.
 */
export function renderSessionPickerModal(
  modal: SessionPickerModal,
  width: number,
  viewportHeight = 24,
): Line[] {
  const extraRows = crossSurfaceExtraRows(modal) + hostedExtraRows(modal);
  const metrics = getOverlaySurfaceMetrics(width, viewportHeight, {
    chromeRows: 6,
    minContentRows: 5,
    maxContentRows: 9 + extraRows,
  });
  const boxMargin = metrics.margin;
  const boxW = metrics.boxWidth;
  const contentW = metrics.contentWidth;
  const targetContentRows = getStableOverlayContentRows(metrics.contentRows, 8 + extraRows);

  // W3 Finding 1: when a cross-surface union section is present, cap the
  // LOCAL list's window to what's left after reserving extraRows for the
  // union — otherwise the local list expands to fill metrics.contentRows
  // (which already includes the union's reservation) and modal-factory's
  // single tail-clip (createModal, targetContentRows) silently drops the
  // union section, or its trailing rows, once the box fills up. In local
  // mode (extraRows === 0, every pre-existing caller/test) this reduces to
  // the exact pre-T2 formula, so local-only output is byte-for-byte
  // unaffected.
  let visibleRows: number;
  if (extraRows === 0) {
    visibleRows = metrics.contentRows;
  } else {
    const localBudget = Math.max(0, targetContentRows - extraRows);
    const overhead = 2; // header + separator row, present whenever sessions.length > 0
    const remaining = Math.max(0, localBudget - overhead);
    visibleRows = modal.sessions.length > remaining
      ? Math.max(3, remaining - 2) // reserve 2 more rows for the local "[x-y of N]" overflow line
      : Math.max(3, remaining);
  }
  modal.setVisibleRows(visibleRows);

  const sections: import('./modal-factory.ts').ModalSection[] = [];

  if (modal.sessions.length === 0) {
    sections.push({
      type: 'text',
      content: 'No saved sessions.',
      style: { fg: '244', dim: true },
    });
    sections.push({
      type: 'text',
      content: 'Use /save [name] to save the current session.',
      style: { fg: '240', dim: true },
    });
  } else {
    // Proportional column widths that adapt to the modal's content width:
    // timestamp ~22% (clamped 10..16), messages ~12% (clamped 4..8), and the
    // name column absorbs the remainder so the row always fills contentW.
    const tsW = Math.min(16, Math.max(10, Math.floor(contentW * 0.22)));
    const msgW = Math.min(8, Math.max(4, Math.floor(contentW * 0.12)));
    const nameW = Math.max(8, contentW - tsW - msgW - 4); // 4 = separators/spaces

    // Column header
    const nameHdr = fitDisplay('Name', nameW);
    const tsHdr   = fitDisplay('Saved', tsW);
    const msgHdr  = fitDisplay('Msgs', msgW);
    sections.push({
      type: 'text',
      content: `${nameHdr}  ${tsHdr}  ${msgHdr}`,
      style: { fg: '240', dim: true },
    });
    sections.push({ type: 'separator' });

    const visibleSessions = modal.sessions.slice(modal.scrollOffset, modal.scrollOffset + visibleRows);
    const listItems: import('./modal-factory.ts').ModalListItem[] = visibleSessions.map((sess, idx) => {
      const isSelected = modal.scrollOffset + idx === modal.selectedIndex;

      const nameStr = fitDisplay(sess.name, nameW);

      const tsStr = fitDisplay(formatTimestamp(sess.timestamp), tsW);
      const msgStr = fitDisplay(String(sess.messageCount), msgW);

      const label = `${nameStr}  ${tsStr}  ${msgStr}`;
      return { label, selected: isSelected };
    });

    sections.push({ type: 'list', items: listItems });
    if (modal.sessions.length > visibleRows) {
      sections.push({ type: 'separator' });
      sections.push({
        type: 'text',
        content: `[${modal.scrollOffset + 1}-${Math.min(modal.sessions.length, modal.scrollOffset + visibleRows)} of ${modal.sessions.length}]`,
        style: { fg: '244', dim: true },
      });
    }
  }

  // Cross-surface session union — visible only when a sessionBroker
  // was wired (mode !== 'local'); absent entirely otherwise, so the box size
  // and content of every pre-existing (local-only) caller is unaffected.
  if (modal.crossSurfaceView.mode !== 'local') {
    sections.push({ type: 'separator' });
    sections.push({
      type: 'text',
      content: `Cross-surface sessions (${modal.crossSurfaceView.mode})`,
      style: { fg: '240', dim: true, bold: true },
    });
    const note = crossSurfaceNote(modal.crossSurfaceView, modal.crossSurfaceSessions.length);
    if (note) {
      sections.push({
        type: 'text',
        content: note,
        style: { fg: modal.crossSurfaceView.offlineNote ? UI_TONES.state.warn : '244', dim: !modal.crossSurfaceView.offlineNote },
      });
    }
    if (modal.crossSurfaceSessions.length > 0) {
      const rows = modal.crossSurfaceSessions.slice(0, MAX_CROSS_SURFACE_ROWS);
      const listItems: import('./modal-factory.ts').ModalListItem[] = rows.map((record) => {
        const reaped = isReapedRecord(record);
        const closed = isClosedStatus(record.status);
        const label = fitDisplay(
          `${record.title || record.id} · ${kindLabel(record.kind)} · ${statusLabel(record)} · ${projectLabel(record.project)}`,
          contentW,
        );
        // Reaped rows get their own tone (not plain dim-closed): the session
        // will auto-reopen on the next heartbeat, unlike a deliberate close.
        const style = reaped ? { fg: UI_TONES.state.info } : closed ? { fg: '244', dim: true } : undefined;
        return { label, style };
      });
      sections.push({ type: 'list', items: listItems });
      if (modal.crossSurfaceSessions.length > MAX_CROSS_SURFACE_ROWS) {
        sections.push({
          type: 'text',
          content: `[showing ${MAX_CROSS_SURFACE_ROWS} of ${modal.crossSurfaceSessions.length}]`,
          style: { fg: '244', dim: true },
        });
      }
      // W4 UX-lens: only ever rendered when a visible row actually carries
      // the 'reaped' badge — never speculative noise.
      if (hasVisibleReapedRow(modal)) {
        sections.push({
          type: 'text',
          content: REAPED_BADGE_HINT,
          style: { fg: UI_TONES.state.info, dim: true },
        });
      }
    }
  }

  // Daemon-hosted sessions — conversations whose loop runs in the daemon rather
  // than in this terminal. Read-only here: joining one is `/hosted attach <id>`,
  // which opens a live stream this modal has no business owning, so the full id
  // is rendered for the command to be typed straight off the row.
  if (hostedSectionVisible(modal)) {
    sections.push({ type: 'separator' });
    sections.push({
      type: 'text',
      content: 'Daemon-hosted sessions',
      style: { fg: '240', dim: true, bold: true },
    });
    const note = hostedRosterNote(modal.hostedRoster);
    if (note) {
      sections.push({
        type: 'text',
        content: note,
        style: { fg: modal.hostedRoster.note ? UI_TONES.state.warn : '244', dim: !modal.hostedRoster.note },
      });
    }
    if (modal.hostedRoster.sessions.length > 0) {
      const rows = modal.hostedRoster.sessions.slice(0, MAX_HOSTED_ROWS);
      sections.push({
        type: 'list',
        items: rows.map((record) => ({
          label: hostedRowLabel(record, contentW),
          // A terminated hosted session is kept with its reason until retention
          // retires it; dimming it keeps it readable without looking live.
          style: record.status === 'terminated'
            ? { fg: '244', dim: true }
            : record.status === 'running' ? { fg: UI_TONES.state.good } : undefined,
        })),
      });
      if (modal.hostedRoster.sessions.length > MAX_HOSTED_ROWS) {
        sections.push({
          type: 'text',
          content: `[showing ${MAX_HOSTED_ROWS} of ${modal.hostedRoster.sessions.length}]`,
          style: { fg: '244', dim: true },
        });
      }
      sections.push({
        type: 'text',
        content: 'Join one with /hosted attach <id>',
        style: { fg: '244', dim: true },
      });
    }
  }

  // Status message if present
  if (modal.statusMessage) {
    sections.push({ type: 'separator' });
    sections.push({
      type: 'text',
      content: modal.statusMessage,
      style: { fg: modal.deleteConfirmationTarget ? '#f59e0b' : '#00ffcc' },
    });
  }

  if (modal.deleteConfirmationTarget) {
    sections.push({
      type: 'text',
      content: `Deletion is armed for ${modal.deleteConfirmationTarget}. Move selection or press Esc to cancel.`,
      style: { fg: '244', dim: true },
    });
  }

  return ModalFactory.createModal(
    {
      title: 'Sessions',
      width: boxW,
      margin: boxMargin,
      targetContentRows,
      sections,
      hints: ['[\u2191\u2193] Navigate', '[Enter] Load', '[d] Arm / Delete', '[Esc] Close'],
    },
    width,
  );
}
