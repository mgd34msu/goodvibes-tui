/**
 * session-focus.ts, which session the terminal is showing: main, one agent,
 * or one background process.
 *
 * Enter on an agent lane (or its row in the Agents modal) opens that agent
 * full screen; Enter on a ▶ bead (or a process row) opens the process. The
 * session chips under the header list every session there is to switch to,
 * and Tab / Shift+Tab cycle them while the composer is empty.
 *
 * Esc inside an agent or process view goes up exactly one level: a process
 * or a top-level agent returns to main; an agent spawned by another agent
 * returns to that agent. Going up never stops or cancels anything. Stopping
 * is ctrl+x pressed twice: the first press arms, the second (within
 * STOP_CONFIRM_MS) stops.
 *
 * Pure state plus the live facts it is handed (SessionFocusDeps); nothing
 * here renders or talks to the runtime directly.
 */

export type SessionTarget =
  | { readonly kind: 'main' }
  | { readonly kind: 'agent'; readonly id: string }
  | { readonly kind: 'process'; readonly id: string };

/** The status a chip's mark shows. */
export type SessionMark = 'run' | 'idle' | 'ok' | 'err' | 'cancel' | 'wait';

/** One session the chips row lists. */
export interface SessionEntry {
  readonly target: SessionTarget;
  /** "main", the agent's template name, or the process command. */
  readonly name: string;
  readonly mark: SessionMark;
}

export interface SessionFocusDeps {
  /** Agents worth a chip: running or pending (finished ones leave the row). */
  readonly liveAgents: () => ReadonlyArray<{ readonly id: string; readonly name: string; readonly mark: SessionMark }>;
  /** Background processes still running. */
  readonly liveProcesses: () => ReadonlyArray<{ readonly id: string; readonly name: string; readonly mark: SessionMark }>;
  /** Name and mark of any agent (the focused one may have finished), or null when unknown. */
  readonly agent: (id: string) => { readonly name: string; readonly mark: SessionMark } | null;
  /** Name and mark of any process, or null when unknown. */
  readonly process: (id: string) => { readonly name: string; readonly mark: SessionMark } | null;
  /** The agent that spawned this agent, or null when main did (or it is unknown). */
  readonly parentAgent: (id: string) => string | null;
  /** Whether main is working on a turn. */
  readonly mainBusy: () => boolean;
  readonly now?: () => number;
}

export const MAIN: SessionTarget = { kind: 'main' };

/** How long the first ctrl+x stays armed. */
export const STOP_CONFIRM_MS = 3000;

export function sameTarget(a: SessionTarget, b: SessionTarget): boolean {
  if (a.kind !== b.kind) return false;
  return a.kind === 'main' || a.id === (b as { id: string }).id;
}

export class SessionFocus {
  private currentTarget: SessionTarget = MAIN;
  private armed: { readonly target: SessionTarget; readonly at: number } | null = null;
  private listener: (() => void) | null = null;

  constructor(private readonly deps: SessionFocusDeps) {}

  get current(): SessionTarget { return this.currentTarget; }
  /** An agent or process view is showing. */
  get active(): boolean { return this.currentTarget.kind !== 'main'; }

  /** Be told whenever the view changes (the transcript scroll resets, the frame repaints). */
  onChange(listener: (() => void) | null): void { this.listener = listener; }

  /** Show `target`. Opening an unknown agent or process is refused (false). */
  open(target: SessionTarget): boolean {
    if (target.kind === 'agent' && this.deps.agent(target.id) === null) return false;
    if (target.kind === 'process' && this.deps.process(target.id) === null) return false;
    if (sameTarget(target, this.currentTarget)) return true;
    this.currentTarget = target;
    this.armed = null;
    this.listener?.();
    return true;
  }

  /** The level Esc goes back to from `target`. */
  parentOf(target: SessionTarget): SessionTarget {
    if (target.kind !== 'agent') return MAIN;
    const parent = this.deps.parentAgent(target.id);
    return parent !== null && parent !== target.id && this.deps.agent(parent) !== null ? { kind: 'agent', id: parent } : MAIN;
  }

  /** Esc in a view: go up one level. Returns false in main (nothing to go back from). Never stops anything. */
  back(): boolean {
    if (!this.active) return false;
    this.currentTarget = this.parentOf(this.currentTarget);
    this.armed = null;
    this.listener?.();
    return true;
  }

  /** The display name of a target. */
  nameOf(target: SessionTarget): string {
    if (target.kind === 'main') return 'main';
    const known = target.kind === 'agent' ? this.deps.agent(target.id) : this.deps.process(target.id);
    return known?.name ?? target.id;
  }

  /** "main › engineer › tester": the path from main down to the current view. */
  breadcrumb(): SessionTarget[] {
    const path: SessionTarget[] = [];
    let at: SessionTarget = this.currentTarget;
    for (let guard = 0; at.kind !== 'main' && guard < 16; guard++) {
      path.unshift(at);
      at = this.parentOf(at);
    }
    return [MAIN, ...path];
  }

  /**
   * Every session there is to switch to: main, then running agents, then
   * running processes. The session being shown is always listed, even after
   * it finished.
   */
  sessions(): SessionEntry[] {
    const entries: SessionEntry[] = [{ target: MAIN, name: 'main', mark: this.deps.mainBusy() ? 'run' : 'idle' }];
    const agents = this.deps.liveAgents();
    const processes = this.deps.liveProcesses();
    const cur = this.currentTarget;
    const names = new Map<string, number>();
    const label = (name: string): string => {
      const n = (names.get(name) ?? 0) + 1;
      names.set(name, n);
      return n > 1 ? `${name} ${n}` : name;
    };
    const pushAgent = (id: string, name: string, mark: SessionMark): void => { entries.push({ target: { kind: 'agent', id }, name: label(name), mark }); };
    const pushProcess = (id: string, name: string, mark: SessionMark): void => { entries.push({ target: { kind: 'process', id }, name: label(name), mark }); };
    for (const a of agents) pushAgent(a.id, a.name, a.mark);
    if (cur.kind === 'agent' && !agents.some((a) => a.id === cur.id)) {
      const known = this.deps.agent(cur.id);
      if (known) pushAgent(cur.id, known.name, known.mark);
    }
    for (const p of processes) pushProcess(p.id, p.name, p.mark);
    if (cur.kind === 'process' && !processes.some((p) => p.id === cur.id)) {
      const known = this.deps.process(cur.id);
      if (known) pushProcess(cur.id, known.name, known.mark);
    }
    return entries;
  }

  /** The chips row shows only when there is more than one session to switch to. */
  chipsVisible(): boolean {
    return this.sessions().length > 1;
  }

  /** Tab (+1) / Shift+Tab (-1): show the next or previous session. False when there is nothing to cycle to. */
  cycle(delta: 1 | -1): boolean {
    const list = this.sessions();
    if (list.length < 2) return false;
    const at = Math.max(0, list.findIndex((e) => sameTarget(e.target, this.currentTarget)));
    const next = list[(at + delta + list.length) % list.length]!;
    return this.open(next.target);
  }

  /**
   * ctrl+x in a view. The first press arms and returns 'armed'; a second
   * press within STOP_CONFIRM_MS returns 'confirmed' (the caller stops the
   * work). In main it returns 'none'.
   */
  pressStop(): 'armed' | 'confirmed' | 'none' {
    if (!this.active) return 'none';
    const now = this.deps.now?.() ?? Date.now();
    if (this.armed && sameTarget(this.armed.target, this.currentTarget) && now - this.armed.at <= STOP_CONFIRM_MS) {
      this.armed = null;
      return 'confirmed';
    }
    this.armed = { target: this.currentTarget, at: now };
    return 'armed';
  }

  /** Whether a first ctrl+x is waiting for its confirming press. */
  stopArmed(): boolean {
    if (!this.armed || !sameTarget(this.armed.target, this.currentTarget)) return false;
    const now = this.deps.now?.() ?? Date.now();
    return now - this.armed.at <= STOP_CONFIRM_MS;
  }

  disarm(): void { this.armed = null; }
}
