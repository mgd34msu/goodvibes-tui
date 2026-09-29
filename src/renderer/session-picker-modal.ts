/**
 * renderSessionPickerModal, the /sessions picker drawn with the modal surface kit.
 *
 * Saved sessions grouped by recency (today, yesterday, this week, earlier)
 * with message count and age right-aligned and muted, an always-live search
 * row, and two read-only groups: sessions hosted on the daemon and the
 * cross-surface session union (each with its honest state: never read,
 * offline, stale, empty). Deleting arms the row in red and asks for the same
 * key again, in place.
 */

import type { SharedSessionRecord } from '@pellux/goodvibes-sdk/platform/control-plane';
import { activeTokens } from './theme.ts';
import type { SessionPickerModal } from '../input/session-picker-modal.ts';
import { formatTimestamp } from './modal-utils.ts';
import { beginModal, drawWrapped, finishModal, scrollCountText, searchRow, wrapLines, type KitHint, type SurfaceLayer } from './surface-kit.ts';
import { drawList, drawScrollingList, measureRow, type KitRow } from './surface-kit-list.ts';

// ---------------------------------------------------------------------------
// Cross-surface badge helpers (parity with webui's src/lib/sessions-union.ts)
// ---------------------------------------------------------------------------

/** Verbatim for unknown/future kinds, never dropped, never guessed. */
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
 * 'closeReason' key, see `@pellux/goodvibes-sdk` platform/control-plane
 * session-broker-sessions.ts's `readSessionCloseReason`). `metadata` is an
 * open record so old readers and records from a build that predates this
 * field ignore it safely, read it duck-typed here rather than importing the
 * SDK's helper, and tolerate `metadata` itself being absent or malformed.
 */
function readCloseReason(record: SharedSessionRecord): string | undefined {
  const raw = (record.metadata as Record<string, unknown> | undefined)?.['closeReason'];
  return typeof raw === 'string' ? raw : undefined;
}

/**
 * A GC sweep closing an idle session ('idle-reaped') auto-reopens on the next
 * heartbeat, it is NOT the same event as a deliberate user/surface close, so
 * it must never render under the same "closed" badge. Tolerant of
 * records without the field (pre-feature builds, or a deliberate close).
 */
function isReapedRecord(record: SharedSessionRecord): boolean {
  return isClosedStatus(record.status) && readCloseReason(record) === 'idle-reaped';
}

/**
 * UX-lens note: 'reaped' names a mechanism (the idle-session sweep),
 * not a state a first-time reader can guess, the webui pairs its own
 * 'reaped' badge with a tooltip explaining it
 * (SessionsView.tsx: "Closed by the idle-session sweep, reopens
 * automatically on the next activity"). The TUI has no hover/tooltip
 * surface, so the plain-language explanation is rendered as its own short
 * line under the cross-surface list instead, shown ONLY when at least one
 * visible row actually carries the badge, so it never adds noise to a list
 * with no reaped rows.
 */
const REAPED_BADGE_HINT = 'reaped = closed by the idle sweep; reopens on next activity';

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
 * Whether the hosted section renders at all.
 *
 * Absent when NOTHING is known: no roster was wired (every pre-existing caller
 * and test), so the box size and content are unchanged for them. The moment the
 * roster has an answer, rows, an empty-but-read list, or a reason it could not
 * read, the section appears, because each of those is a fact worth showing.
 */
function hostedSectionVisible(modal: SessionPickerModal): boolean {
  const roster = modal.hostedRoster;
  return roster.sessions.length > 0 || roster.capturedAt !== null || roster.note !== null;
}

/**
 * The exact honest note for the current state, or null when the union view
 * needs no caveat (fresh, with rows). Precedence: offline > stale >
 * true-empty, the three designed states, never collapsed into
 * each other (an offline view never silently renders as "no sessions yet").
 */
function crossSurfaceNote(view: SessionPickerModal['crossSurfaceView'], rowCount: number): string | null {
  if (view.mode === 'local') return null;
  if (view.offlineNote) return `${view.offlineNote}: showing local sessions only`;
  if (view.stale) {
    if (view.lastSyncAt === null) return 'Union view may be stale.';
    const ageSeconds = Math.max(0, Math.round((Date.now() - view.lastSyncAt) / 1000));
    return `Union view may be stale, last synced ${ageSeconds}s ago`;
  }
  if (rowCount === 0) return 'No sessions yet.';
  return null;
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

const DAY_MS = 86_400_000;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

type RecencyGroup = 'Today' | 'Yesterday' | 'This week' | 'Earlier';

function startOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function recencyGroup(ts: number, now: number): RecencyGroup {
  const today = startOfDay(now);
  if (ts >= today) return 'Today';
  if (ts >= today - DAY_MS) return 'Yesterday';
  if (ts >= today - 6 * DAY_MS) return 'This week';
  return 'Earlier';
}

/** Short age for the right column: HH:MM today, "Mon D" this year, the full date otherwise. */
function shortWhen(ts: number, now: number): string {
  if (!ts) return 'unknown';
  const d = new Date(ts);
  if (ts >= startOfDay(now)) return formatTimestamp(ts).slice(11);
  if (d.getFullYear() === new Date(now).getFullYear()) return `${MONTHS[d.getMonth()]} ${d.getDate()}`;
  return formatTimestamp(ts).slice(0, 10);
}

function hostedRows(modal: SessionPickerModal): KitRow[] {
  if (!hostedSectionVisible(modal)) return [];
  const t = activeTokens();
  const roster = modal.hostedRoster;
  const rows: KitRow[] = [{ header: 'Hosted', headerRight: 'on the daemon' }];
  const note = hostedRosterNote(roster);
  if (note) rows.push({ label: note, labelFg: roster.note ? t.warning : t.textFaint });
  for (const record of roster.sessions.slice(0, MAX_HOSTED_ROWS)) {
    const policy = record.effectiveDetachPolicy === 'survive' ? 'survives detach' : 'ends on detach';
    const attached = record.attachedClients.length > 0 ? `${record.attachedClients.length} attached` : 'nobody attached';
    const running = record.status === 'running';
    const terminated = record.status === 'terminated';
    rows.push({
      label: record.title || 'untitled',
      desc: `${record.id} · ${record.status} · ${policy} · ${attached}`,
      mark: running ? '◐' : terminated ? '○' : '●',
      markFg: running ? t.brand : terminated ? t.textFaint : t.textMuted,
      muted: terminated,
    });
  }
  if (roster.sessions.length > MAX_HOSTED_ROWS) rows.push({ label: `showing ${MAX_HOSTED_ROWS} of ${roster.sessions.length}`, labelFg: t.textFaint });
  if (roster.sessions.length > 0) rows.push({ label: 'Join one with /hosted attach <id>', labelFg: t.textFaint });
  return rows;
}

function crossSurfaceRows(modal: SessionPickerModal): KitRow[] {
  if (modal.crossSurfaceView.mode === 'local') return [];
  const t = activeTokens();
  const rows: KitRow[] = [{ header: 'Other surfaces', headerRight: modal.crossSurfaceView.mode }];
  const note = crossSurfaceNote(modal.crossSurfaceView, modal.crossSurfaceSessions.length);
  if (note) rows.push({ label: note, labelFg: modal.crossSurfaceView.offlineNote ? t.warning : t.textFaint });
  for (const record of modal.crossSurfaceSessions.slice(0, MAX_CROSS_SURFACE_ROWS)) {
    const reaped = isReapedRecord(record);
    const closed = isClosedStatus(record.status);
    rows.push({
      label: record.title || record.id,
      desc: `${kindLabel(record.kind)} · ${statusLabel(record)} · ${projectLabel(record.project)}`,
      // Reaped rows get their own tone: they reopen on the next heartbeat, unlike a deliberate close.
      labelFg: reaped ? t.info : undefined,
      muted: closed && !reaped,
    });
  }
  if (modal.crossSurfaceSessions.length > MAX_CROSS_SURFACE_ROWS) {
    rows.push({ label: `showing ${MAX_CROSS_SURFACE_ROWS} of ${modal.crossSurfaceSessions.length}`, labelFg: t.textFaint });
  }
  if (hasVisibleReapedRow(modal)) rows.push({ label: REAPED_BADGE_HINT, labelFg: t.info });
  return rows;
}

function localRows(modal: SessionPickerModal, now: number): Map<RecencyGroup, KitRow[]> {
  const t = activeTokens();
  const groups = new Map<RecencyGroup, KitRow[]>();
  modal.visibleSessions().forEach((sess, index) => {
    const selected = index === modal.selectedIndex;
    const armed = modal.deleteConfirmationTarget === sess.name && selected;
    const group = recencyGroup(sess.timestamp, now);
    const title = sess.title && sess.title !== sess.name ? sess.title : '';
    const row: KitRow = armed
      ? { label: `Press d again to delete "${sess.name}"`, right: `${sess.messageCount} msgs · ${shortWhen(sess.timestamp, now)}`, danger: true, mark: '✕', markFg: t.error, selected }
      : {
          label: title || sess.name,
          desc: title ? sess.name : undefined,
          right: `${sess.messageCount} msgs · ${shortWhen(sess.timestamp, now)}`,
          selected,
        };
    const list = groups.get(group) ?? [];
    list.push(row);
    groups.set(group, list);
  });
  return groups;
}

// ---------------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------------

/**
 * Render the session picker as a modal layer.
 *
 * @param modal         SessionPickerModal state.
 * @param screenWidth   Terminal width.
 * @param screenHeight  Terminal height.
 * @param now           Clock for the recency groups (tests pass a fixed value).
 */
export function renderSessionPickerModal(
  modal: SessionPickerModal,
  screenWidth: number,
  screenHeight = 24,
  now: number = Date.now(),
): SurfaceLayer {
  const t = activeTokens();
  const armed = modal.deleteConfirmationTarget !== null;
  const hints: KitHint[] = modal.query.length === 0
    ? [['↑↓', 'move'], ['⏎', 'open'], ['d', armed ? 'confirm delete' : 'delete']]
    : [['↑↓', 'move'], ['⏎', 'open'], ['⌫', 'edit search']];
  const f = beginModal(screenWidth, screenHeight, { title: 'Sessions', hints });

  const visible = modal.visibleSessions();
  const count = modal.query.length > 0 ? `${visible.length} of ${modal.sessions.length}` : `${modal.sessions.length} saved`;
  searchRow(f, f.top, modal.query, 'Search sessions', count);

  // Status and the armed-delete note sit at the bottom of the body, wrapped in full.
  const footLines: Array<{ text: string; fg: string }> = [];
  const width = f.r - f.l + 1;
  // While armed, the row itself carries the "press d again" prompt.
  if (modal.statusMessage && !armed) {
    for (const line of wrapLines(modal.statusMessage, width)) footLines.push({ text: line, fg: armed ? t.warning : t.accent });
  }
  if (armed) {
    for (const line of wrapLines(`Deletion is armed for ${modal.deleteConfirmationTarget}. Move selection or press Esc to cancel.`, width)) footLines.push({ text: line, fg: t.textFaint });
  }
  const listBottom = footLines.length > 0 ? f.bottom - footLines.length - 1 : f.bottom;

  const rows: KitRow[] = [];
  const local = localRows(modal, now);
  const pushGroup = (name: RecencyGroup): void => {
    const group = local.get(name);
    if (group && group.length > 0) rows.push({ header: name }, ...group);
  };
  if (modal.sessions.length === 0) {
    rows.push({ label: 'No saved sessions.', labelFg: t.textFaint });
    rows.push({ label: 'Use /save [name] to save the current session.', labelFg: t.textFaint });
  } else if (visible.length === 0) {
    rows.push({ label: `No sessions match "${modal.query}".`, labelFg: t.textFaint });
  }
  pushGroup('Today');
  pushGroup('Yesterday');
  pushGroup('This week');
  pushGroup('Earlier');

  // Hosted and cross-surface sessions are read-only (not selectable), so they
  // are pinned under the saved sessions instead of scrolling with them: a
  // long saved list can never push them out of reach. Past half the body
  // they count what they hide.
  const pinned: KitRow[] = [...hostedRows(modal), ...crossSurfaceRows(modal)];
  const top = f.top + 2;
  let savedBottom = listBottom;
  if (pinned.length > 0) {
    const pinnedNeed = pinned.reduce((sum, row, i) => sum + measureRow(row, f.l, f.r) + (i > 0 && row.header !== undefined ? 1 : 0), 0);
    const pinnedRows = Math.min(pinnedNeed, Math.max(3, Math.floor((listBottom - top + 1) / 2)));
    const pinnedTop = listBottom - pinnedRows + 1;
    drawScrollingList(f.canvas, { rows: pinned, top: pinnedTop, bottom: listBottom, x0: f.l, x1: f.r });
    savedBottom = pinnedTop - 2;
  }

  modal.setVisibleRows(Math.max(3, savedBottom - top + 1));
  const result = drawList(f.canvas, { rows, top, bottom: savedBottom, x0: f.l, x1: f.r, scrollKey: { owner: modal, name: 'sessions' } });
  f.hintRight = scrollCountText(result.above, result.below);

  let y = listBottom + 2;
  for (const line of footLines) {
    drawWrapped(f.canvas, f.l, y, width, line.text, { fg: line.fg }, f.bottom);
    y++;
  }
  return finishModal(f);
}
