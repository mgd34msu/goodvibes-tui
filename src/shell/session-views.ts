/**
 * session-views.ts, agents and background processes opened full screen.
 *
 * Owns the view state (core/session-focus.ts: which session shows, its
 * parent chain, the chips, the ctrl+x confirm), polls background process
 * output into timestamped lines (core/process-output-log.ts), and hands the
 * frame what changes inside a view:
 *
 *   header    the breadcrumb (main › engineer, the agent in its lane color)
 *             and that session's right side (its model; pid · uptime · port)
 *   chips     one row under the header listing every session, when there is
 *             more than one
 *   body      the agent's transcript as a lane graph, or the process output,
 *             with a thin bar in the session's color (dimmed) down column 0
 *   footer    the composer's bar and placeholder, the status line's keys
 *             (what the next Esc does first), and main kept in sight
 *
 * Main keeps running underneath all of it: a view never interrupts main, and
 * leaving one never stops what it shows. Stopping is ctrl+x twice.
 */

import type { Line } from '@pellux/goodvibes-sdk/platform/types';
import type { ConversationMessageSnapshot } from '@pellux/goodvibes-sdk/platform/core';
import type { AgentManager, ProcessManager } from '@pellux/goodvibes-sdk/platform/tools';
import type { ProcessNode, SteerResult } from '@pellux/goodvibes-sdk/platform/runtime/fleet';
import type { ConversationManager } from '../core/conversation.ts';
import { SessionFocus, sameTarget, type SessionMark, type SessionTarget } from '../core/session-focus.ts';
import { ProcessOutputLog } from '../core/process-output-log.ts';
import { renderAgentView } from '../core/agent-view-render.ts';
import { renderHeaderLine } from '../renderer/header-line.ts';
import { renderSessionChips, type SessionChip } from '../renderer/session-chips.ts';
import { processMatches, processMaxScroll, processRows, renderProcessView, type ProcessRow } from '../renderer/process-view.ts';
import { laneColor } from '../renderer/lane-graph/paint.ts';
import type { ShellFooterView } from '../renderer/shell-surface.ts';
import type { SessionViewControls } from '../input/handler-session-view-route.ts';
import { activeTokens } from '../renderer/theme.ts';
import { formatElapsed } from '../utils/format-elapsed.ts';
import { interpolateColor } from '../utils/terminal-width.ts';
import { copyToClipboard } from '../utils/clipboard.ts';

export interface SessionViewsDeps {
  readonly conversation: Pick<ConversationManager, 'laneColorOf' | 'getWorkTreeSources' | 'getTreeGlyphSet'>;
  readonly agentManager: Pick<AgentManager, 'list' | 'getStatus' | 'getConversationSnapshot'>;
  readonly processManager: Pick<ProcessManager, 'list' | 'getStatus' | 'stop'>;
  readonly fleetNodes: () => readonly ProcessNode[];
  readonly steer: (agentId: string, text: string) => SteerResult;
  /** Stop an agent and the agents it started. */
  readonly killAgent: (agentId: string) => readonly string[];
  readonly mainBusy: () => boolean;
  /** The model main is serving (an agent with no model of its own runs on it). */
  readonly mainModel: () => string;
  /** The composer's text right now (the view's Esc hint depends on it). */
  readonly promptText: () => string;
  readonly requestRender: () => void;
  readonly now?: () => number;
  /** Process output poll interval (ms); 0 disables the timer (tests poll by hand). */
  readonly pollMs?: number;
  readonly copy?: (text: string) => void;
}

/** What the frame draws while a view is open. */
export interface SessionViewFrame {
  readonly header: Line;
  readonly body: (height: number) => Line[];
  readonly footer: ShellFooterView;
}

const NOTICE_MS = 4000;
const STEER_FORGET_MS = 10 * 60_000;
// The input area says only what the input area is; the keys are the status line's.
const NO_STDIN_REASON = 'No input here: GoodVibes cannot write to this process\'s stdin';

type AgentRecord = NonNullable<ReturnType<AgentManager['getStatus']>>;

function agentMark(status: AgentRecord['status']): SessionMark {
  switch (status) {
    case 'running': return 'run';
    case 'pending': return 'wait';
    case 'completed': return 'ok';
    case 'failed': return 'err';
    case 'cancelled': return 'cancel';
  }
}

/** A process's mark from whether it ended (never parsed from the status text: a timeout or a kill does not read "done"). */
function processMark(p: { readonly done: boolean; readonly status: string }): SessionMark {
  if (!p.done) return 'run';
  return /^done \(exit 0\)$/.test(p.status) ? 'ok' : 'err';
}

function shortCommand(cmd: string): string {
  const one = cmd.replace(/\s+/g, ' ').trim();
  return one.length > 28 ? `${one.slice(0, 27)}…` : one;
}

export class SessionViews implements SessionViewControls {
  readonly focus: SessionFocus;
  readonly log = new ProcessOutputLog();
  private scrollBy = new Map<string, number>();
  private readonly collapse = new Map<string, Map<string, boolean>>();
  private readonly steers: Array<{ readonly agentId: string; readonly text: string; readonly at: number }> = [];
  private notice: { readonly text: string; readonly tone: 'error' | 'info'; readonly until: number } | null = null;
  private search: { query: string; editing: boolean; current: number } | null = null;
  private rowsCache: { key: string; rows: ProcessRow[] } | null = null;
  private agentCache: { key: string; lines: Line[] } | null = null;
  private lastPage = 10;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly deps: SessionViewsDeps) {
    // A WRFC chain owner is named for what it is, as its lane in main is: its
    // template ("engineer") would read as the chain's own engineer phase.
    const agentName = (r: AgentRecord): string => (r.wrfcRole === 'owner' ? 'WRFC chain' : r.template || 'agent');
    this.focus = new SessionFocus({
      liveAgents: () => deps.agentManager.list()
        .filter((a) => a.status === 'running' || a.status === 'pending')
        .map((a) => ({ id: a.id, name: agentName(a), mark: agentMark(a.status) })),
      liveProcesses: () => deps.processManager.list()
        .filter((p) => !p.done)
        .map((p) => ({ id: p.id, name: shortCommand(p.cmd), mark: 'run' as const })),
      agent: (id) => {
        const r = deps.agentManager.getStatus(id);
        return r ? { name: agentName(r), mark: agentMark(r.status) } : null;
      },
      process: (id) => {
        const p = deps.processManager.list().find((e) => e.id === id);
        return p ? { name: shortCommand(p.cmd), mark: processMark(p) } : null;
      },
      parentAgent: (id) => {
        const parent = deps.fleetNodes().find((n) => n.id === id)?.parentId;
        return parent && deps.agentManager.getStatus(parent) ? parent : null;
      },
      mainBusy: deps.mainBusy,
      now: deps.now,
    });
    this.focus.onChange(() => { this.search = null; this.agentCache = null; });
    const pollMs = deps.pollMs ?? 500;
    if (pollMs > 0) {
      this.timer = setInterval(() => {
        const ended = this.noteEnded();
        // New output repaints the process view; a process ending repaints
        // wherever you are, since the chips and the status line count it.
        if ((this.poll() && this.kind === 'process') || ended) deps.requestRender();
      }, pollMs);
      (this.timer as { unref?: () => void }).unref?.();
    }
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private now(): number { return this.deps.now?.() ?? Date.now(); }

  private readonly endedSeen = new Set<string>();

  /** True when a process ended since the last call (by any means: exit, timeout, kill). */
  noteEnded(): boolean {
    let ended = false;
    const known = new Set<string>();
    for (const p of this.deps.processManager.list()) {
      known.add(p.id);
      if (p.done && !this.endedSeen.has(p.id)) { this.endedSeen.add(p.id); ended = true; }
    }
    for (const id of this.endedSeen) if (!known.has(id)) this.endedSeen.delete(id);
    return ended;
  }

  /** Read new process output; true when anything arrived. */
  poll(): boolean {
    const records = new Map<string, { stdout: readonly string[]; stderr: readonly string[]; done: boolean }>();
    for (const p of this.deps.processManager.list()) {
      const rec = this.deps.processManager.getStatus(p.id);
      if (rec) records.set(p.id, rec);
    }
    return this.log.poll(records, this.now());
  }

  // ── SessionViewControls ────────────────────────────────────────────────────

  get kind(): 'main' | 'agent' | 'process' { return this.focus.current.kind; }
  get active(): boolean { return this.focus.active; }
  get searchEditing(): boolean { return this.search?.editing === true; }

  open(target: SessionTarget): boolean {
    const ok = this.focus.open(target);
    if (ok) this.deps.requestRender();
    return ok;
  }

  chipsVisible(): boolean { return this.focus.chipsVisible(); }
  cycle(delta: 1 | -1): void { this.focus.cycle(delta); }

  escape(): void {
    if (this.search) { this.search = null; return; }
    this.focus.back();
  }

  pressStop(): void {
    const target = this.focus.current;
    if (target.kind === 'main') return;
    const name = this.focus.nameOf(target);
    if (!this.stoppable(target)) { this.say(`${name} is not running: there is nothing to stop.`, 'info'); return; }
    const press = this.focus.pressStop();
    if (press === 'armed') return; // the status line asks for the confirming press
    if (target.kind === 'agent') {
      const stopped = this.deps.killAgent(target.id);
      this.say(stopped.length > 0 ? `Stopped ${name}${stopped.length > 1 ? ` and ${stopped.length - 1} agent${stopped.length === 2 ? '' : 's'} it started` : ''}.` : `${name} could not be stopped.`, stopped.length > 0 ? 'info' : 'error');
    } else {
      this.say(this.deps.processManager.stop(target.id) ? `Stopped ${name}.` : `${name} could not be stopped.`, 'info');
    }
  }

  scroll(rows: number): void {
    const key = this.scrollKey();
    this.scrollBy.set(key, Math.max(0, (this.scrollBy.get(key) ?? 0) + rows));
  }

  pageRows(): number { return Math.max(1, this.lastPage - 2); }
  follow(): void { this.scrollBy.set(this.scrollKey(), 0); }

  steer(text: string): boolean {
    const target = this.focus.current;
    if (target.kind !== 'agent') return false;
    const name = this.focus.nameOf(target);
    const result = this.deps.steer(target.id, text);
    if (!result.queued) {
      this.say(`${name} did not take the message: ${result.reason ?? 'refused'}.`, 'error');
      return false;
    }
    this.steers.push({ agentId: target.id, text, at: this.now() });
    this.follow();
    this.say(`Sent to ${name}: it arrives at its next turn. Main keeps running.`, 'info');
    return true;
  }

  startSearch(): void { this.search = { query: this.search?.query ?? '', editing: true, current: -1 }; }
  searchType(text: string): void { if (this.search) { this.search.query += text; this.search.current = -1; this.searchNext(); } }
  searchBackspace(): void { if (this.search) { this.search.query = this.search.query.slice(0, -1); this.search.current = -1; } }

  searchNext(): void {
    const target = this.focus.current;
    if (!this.search || !this.search.query || target.kind !== 'process') return;
    const matches = processMatches(this.log.lines(target.id), this.search.query);
    if (matches.length === 0) { this.search.current = -1; return; }
    // Newest match first, then each older one, wrapping back to the newest.
    const at = matches.indexOf(this.search.current);
    this.search.current = at > 0 ? matches[at - 1]! : matches[matches.length - 1]!;
    // Bring the match into view, near the middle of the screen.
    const rows = this.rows(target.id, this.lastWidth);
    const rowIdx = rows.findIndex((r) => r.source === this.search!.current);
    if (rowIdx >= 0) this.scrollBy.set(this.scrollKey(), Math.max(0, rows.length - rowIdx - Math.floor(this.lastPage / 2)));
  }

  copyOutput(): void {
    const target = this.focus.current;
    if (target.kind !== 'process') return;
    const text = this.log.lines(target.id).map((l) => l.text).join('\n');
    (this.deps.copy ?? copyToClipboard)(text);
    this.say(`Copied ${this.log.lines(target.id).length} lines of output.`, 'info');
  }

  restart(): void {
    this.say('Restart is not available: the process manager does not keep what it needs to start this process again.', 'info');
  }

  refuseText(): void {
    this.say('No input here: this process\'s stdin is not reachable. / searches, y copies, esc goes back.', 'info');
  }

  // ── Frame ──────────────────────────────────────────────────────────────────

  private lastWidth = 80;

  /** Rows the header takes: the header row, plus the chips row when it shows. */
  headerRows(): number { return this.chipsVisible() ? 2 : 1; }

  /** The chips row, or null when there is only main. */
  chips(width: number): Line | null {
    const sessions = this.focus.sessions();
    if (sessions.length < 2) return null;
    const t = activeTokens();
    const chips: SessionChip[] = sessions.map((s) => {
      const color = this.colorOf(s.target);
      const markFg = s.mark === 'ok' ? t.success : s.mark === 'err' ? t.error : s.mark === 'cancel' || (s.mark === 'idle') ? t.textFaint : s.mark === 'wait' ? t.warning : color;
      const glyph = s.target.kind === 'process' && s.mark === 'run' ? '▶'
        : s.mark === 'run' ? '◐' : s.mark === 'idle' ? '●' : s.mark === 'ok' ? '✓' : s.mark === 'err' ? '✕' : s.mark === 'cancel' ? '○' : '◌';
      return { mark: glyph, markFg, name: s.name, color, current: sameTarget(s.target, this.focus.current) };
    });
    return renderSessionChips(width, chips);
  }

  /** The session's own color: brand for main, the lane color for an agent, success for a process. */
  colorOf(target: SessionTarget): string {
    const t = activeTokens();
    if (target.kind === 'main') return t.brand;
    if (target.kind === 'process') return t.success;
    return laneColor(this.colorIndexOf(target.id));
  }

  private colorIndexOf(agentId: string): number {
    return this.deps.conversation.laneColorOf(agentId) ?? 1;
  }

  /** What the frame draws inside a view, or null in main. */
  frame(width: number, version?: string): SessionViewFrame | null {
    this.lastWidth = width;
    const target = this.focus.current;
    if (target.kind === 'agent') {
      const record = this.deps.agentManager.getStatus(target.id);
      if (!record) { this.focus.back(); return null; }
      return this.agentFrame(width, record, version);
    }
    if (target.kind === 'process') {
      const rec = this.deps.processManager.getStatus(target.id);
      if (!rec) { this.focus.back(); return null; }
      return this.processFrame(width, target.id, rec, version);
    }
    return null;
  }

  private crumbs(): Array<{ text: string; fg: string; bold?: boolean }> {
    const t = activeTokens();
    const path = this.focus.breadcrumb();
    return path.map((p, i) => i === path.length - 1
      ? { text: this.focus.nameOf(p), fg: this.colorOf(p), bold: true }
      : { text: this.focus.nameOf(p), fg: t.textMuted });
  }

  /** The Esc key's action as the status line states it. */
  private escHint(): readonly [string, string] {
    if (this.search) return ['esc', 'close search'];
    if (this.deps.promptText().length > 0) return ['esc', 'clear input'];
    return ['esc', `back to ${this.focus.nameOf(this.focus.parentOf(this.focus.current))}`];
  }

  private footerNotice(name: string): ShellFooterView['notice'] {
    if (this.focus.stopArmed()) return { text: `Press ctrl+x again to stop ${name}`, tone: 'error' };
    if (this.notice && this.notice.until > this.now()) return { text: this.notice.text, tone: this.notice.tone };
    return null;
  }

  private mainTrail(): ShellFooterView['trail'] {
    const t = activeTokens();
    return this.deps.mainBusy() ? { text: '◐ main · working', fg: t.textMuted } : { text: '● main · idle', fg: t.textFaint };
  }

  private stoppable(target: SessionTarget): boolean {
    if (target.kind === 'agent') {
      const s = this.deps.agentManager.getStatus(target.id)?.status;
      return s === 'running' || s === 'pending';
    }
    if (target.kind === 'process') return this.deps.processManager.getStatus(target.id)?.done === false;
    return false;
  }

  private queuedSteers(agentId: string, messages: readonly ConversationMessageSnapshot[], running: boolean): string[] {
    const now = this.now();
    const seen = (text: string): boolean => messages.some((m) => m.role === 'user' && typeof m.content === 'string' && m.content.includes(text));
    for (let i = this.steers.length - 1; i >= 0; i--) {
      const s = this.steers[i]!;
      if (s.agentId !== agentId) continue;
      if (!running || now - s.at > STEER_FORGET_MS || seen(s.text)) this.steers.splice(i, 1);
    }
    return this.steers.filter((s) => s.agentId === agentId).map((s) => s.text);
  }

  private agentFrame(width: number, record: AgentRecord, version?: string): SessionViewFrame {
    const t = activeTokens();
    const name = this.focus.nameOf(this.focus.current);
    const colorIndex = this.colorIndexOf(record.id);
    const color = laneColor(colorIndex);
    const parent = this.focus.nameOf(this.focus.parentOf(this.focus.current));
    const running = record.status === 'running' || record.status === 'pending';
    const header = renderHeaderLine(width, '', undefined, undefined, version, undefined, {
      crumbs: this.crumbs(),
      right: record.model ?? this.deps.mainModel(),
    })[0]!;
    const keys: Array<readonly [string, string]> = [this.escHint()];
    if (running) keys.push(['ctrl+x', 'stop agent']);
    const cost = this.deps.fleetNodes().find((n) => n.id === record.id);
    const footer: ShellFooterView = {
      barColor: color,
      placeholder: running ? `Message ${name}. This steers it; main keeps running.` : `${name} has finished; a message will not reach it.`,
      keys,
      trail: this.mainTrail(),
      notice: this.footerNotice(name),
      cost: cost && cost.costState !== 'unpriced' && typeof cost.costUsd === 'number' ? `${name} $${cost.costUsd.toFixed(2)}` : null,
    };
    const body = (height: number): Line[] => {
      this.lastPage = height;
      const info = this.deps.conversation.getWorkTreeSources().agent?.(record.id);
      const messages = this.deps.agentManager.getConversationSnapshot(record.id);
      const steers = this.queuedSteers(record.id, messages, running);
      const now = this.now();
      const frame = Math.floor(now / 150);
      const key = [width, record.id, record.status, record.toolCallCount, messages.length, messages[messages.length - 1]?.content.length ?? 0, steers.length, running ? frame : 0, running ? Math.floor(now / 1000) : 0, colorIndex].join('|');
      if (!this.agentCache || this.agentCache.key !== key) {
        const collapse = this.collapse.get(record.id) ?? new Map<string, boolean>();
        this.collapse.set(record.id, collapse);
        const lines = renderAgentView({
          width,
          agent: info ?? { id: record.id, name, task: record.task, status: record.status, startedAt: record.startedAt, completedAt: record.completedAt, toolCallCount: record.toolCallCount, error: record.error, messages: [] },
          messages,
          colorIndex,
          parentName: parent,
          sources: this.deps.conversation.getWorkTreeSources(),
          collapse,
          glyphSet: this.deps.conversation.getTreeGlyphSet(),
          frame,
          now,
          queuedSteers: steers,
        });
        this.agentCache = { key, lines };
      }
      return this.window(this.agentCache.lines, height, width, interpolateColor(color, t.background || t.backgroundBase, 0.35));
    };
    return { header, body, footer };
  }

  private rows(id: string, width: number): ProcessRow[] {
    const lines = this.log.lines(id);
    const key = `${id}|${width}|${lines.length}|${this.log.dropped(id)}`;
    if (!this.rowsCache || this.rowsCache.key !== key) this.rowsCache = { key, rows: processRows(lines, width) };
    return this.rowsCache.rows;
  }

  private processFrame(width: number, id: string, rec: NonNullable<ReturnType<ProcessManager['getStatus']>>, version?: string): SessionViewFrame {
    const t = activeTokens();
    const name = this.focus.nameOf(this.focus.current);
    const color = t.success;
    const now = this.now();
    const port = this.log.port(id);
    const up = rec.done ? `ran ${formatElapsed((rec.completedAt ?? now) - rec.startTime)}` : `up ${formatElapsed(now - rec.startTime)}`;
    const header = renderHeaderLine(width, '', undefined, undefined, version, undefined, {
      crumbs: this.crumbs(),
      right: [`pid ${rec.pid}`, up, port !== undefined ? `:${port}` : ''].filter(Boolean).join(' · '),
      rightFg: t.textMuted,
    })[0]!;
    const keys: Array<readonly [string, string]> = [this.escHint()];
    if (!rec.done) keys.push(['ctrl+x', 'stop (asks first)']);
    keys.push(['/', 'search'], ['y', 'copy']);
    const promptEmpty = this.deps.promptText().length === 0;
    const footer: ShellFooterView = {
      barColor: color,
      disabledReason: promptEmpty ? NO_STDIN_REASON : undefined,
      keys,
      trail: null,
      notice: this.footerNotice(name),
      noContext: true,
    };
    const ended = rec.done
      ? {
          text: rec.timedOut ? `stopped at its timeout · ${up}` : rec.signal ? `ended by ${rec.signal} · ${up}` : `exited with code ${rec.exitCode ?? '?'} · ${up}`,
          ok: rec.exitCode === 0,
        }
      : null;
    const body = (height: number): Line[] => {
      this.lastPage = height;
      this.poll();
      const rows = this.rows(id, width);
      const key = this.scrollKey();
      const inner = SessionViews.innerRows(height);
      const scroll = Math.min(this.scrollBy.get(key) ?? 0, processMaxScroll(rows.length, inner));
      this.scrollBy.set(key, scroll);
      const lines = renderProcessView({
        width, height: inner, rows, scrollFromBottom: scroll, color, ended, dropped: this.log.dropped(id),
        search: this.search ? { query: this.search.query, editing: this.search.editing, current: this.search.current } : null,
      });
      return this.window(lines, height, width, interpolateColor(color, t.background || t.backgroundBase, 0.35));
    };
    return { header, body, footer };
  }

  /**
   * Rows the view's own content gets: the body less the blank row under the
   * chips and the blank row above the composer (the concept's agent and
   * process screens leave both empty, with no bar).
   */
  private static innerRows(height: number): number {
    return height >= 3 ? height - 2 : height;
  }

  /**
   * The body: a blank row, then the bottom rows of `all` (less the scroll)
   * with the view's bar down column 0 on every one of them, then a blank row.
   * The bar runs the full height of the block between the two blank rows,
   * the way the concept's agent and process screens draw it.
   */
  private window(all: readonly Line[], height: number, width: number, barColor: string): Line[] {
    const blank = (): Line => Array.from({ length: width }, () => ({ char: ' ', fg: '', bg: '', bold: false, dim: false, underline: false, italic: false, strikethrough: false }));
    const inner = SessionViews.innerRows(height);
    const key = this.scrollKey();
    const maxScroll = Math.max(0, all.length - inner);
    const scroll = Math.min(this.scrollBy.get(key) ?? 0, maxScroll);
    if (this.kind === 'agent') this.scrollBy.set(key, scroll);
    const end = this.kind === 'agent' ? all.length - scroll : all.length;
    const shown = all.slice(Math.max(0, end - inner), end).map((l) => l.slice(0, width));
    while (shown.length < inner) shown.push(blank());
    for (const line of shown) {
      if (line.length > 0) line[0] = { char: '┃', fg: barColor, bg: '', bold: false, dim: false, underline: false, italic: false, strikethrough: false };
    }
    return inner < height ? [blank(), ...shown, blank()] : shown;
  }

  private scrollKey(): string {
    const c = this.focus.current;
    return c.kind === 'main' ? 'main' : `${c.kind}:${c.id}`;
  }

  private say(text: string, tone: 'error' | 'info'): void {
    this.notice = { text, tone, until: this.now() + NOTICE_MS };
  }
}

