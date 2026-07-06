/**
 * renderSessionPickerModal — renders the /sessions picker modal as Line[]
 * using ModalFactory.
 *
 * Shows a list of saved sessions with:
 *   - name, timestamp (formatted), message count
 * Footer hints: [Enter] Load  [d] Delete  [Esc] Close
 *
 * W3-T2: when the modal was wired with a cross-surface session union
 * (`modal.crossSurfaceView.mode !== 'local'`), an additional read-only
 * "Cross-surface sessions" section is appended, badged kind/status/project
 * (parity with the webui SessionsView) with one of three honest states —
 * true-empty, offline, or stale — never a silently-collapsed list. In
 * 'local' mode (no sessionBroker wired, e.g. every pre-existing caller/test)
 * this section is entirely absent and the box sizing is unchanged.
 */

import type { Line } from '../types/grid.ts';
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

function statusLabel(status: string): string {
  const trimmed = status.trim();
  return trimmed ? (isClosedStatus(trimmed) ? 'closed' : trimmed) : 'active';
}

const MAX_CROSS_SURFACE_ROWS = 5;

/**
 * The exact honest note for the current state, or null when the union view
 * needs no caveat (fresh/embedded with rows). Precedence: offline > stale >
 * true-empty — the three states from the W3-T2 brief, never collapsed into
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
  return 2 + noteRow + overflowRow + Math.max(rows, noteRow === 1 && rows === 0 ? 0 : rows);
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
  const extraRows = crossSurfaceExtraRows(modal);
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

  // W3-T2: cross-surface session union — visible only when a sessionBroker
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
        const closed = isClosedStatus(record.status);
        const label = fitDisplay(
          `${record.title || record.id} · ${kindLabel(record.kind)} · ${statusLabel(record.status)} · ${projectLabel(record.project)}`,
          contentW,
        );
        return { label, style: closed ? { fg: '244', dim: true } : undefined };
      });
      sections.push({ type: 'list', items: listItems });
      if (modal.crossSurfaceSessions.length > MAX_CROSS_SURFACE_ROWS) {
        sections.push({
          type: 'text',
          content: `[showing ${MAX_CROSS_SURFACE_ROWS} of ${modal.crossSurfaceSessions.length}]`,
          style: { fg: '244', dim: true },
        });
      }
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
