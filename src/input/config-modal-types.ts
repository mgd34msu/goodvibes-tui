import type { ModalSectionStyle } from '../renderer/modal-factory.ts';

/**
 * Config-modal host — the shared seam every MIGRATE-TO-MODAL surface
 * (provider-health, services, subscription, remote, local-auth, settings-sync,
 * sandbox, and the ecosystem/governance set) is expressed through.
 *
 * A surface is PURE DATA + ACTIONS: it hands the host a `buildView()` that maps
 * live read-models to a tabbed, list-structured view, plus a declarative action
 * table. The host owns all key routing (tab switch, list nav, Esc, confirm) and
 * the stable-layout liveness contract — the surface never touches the input
 * system directly (the charter's "do not invent a parallel input system").
 *
 * Liveness doctrine (charter: "live data, stable layout"): `buildView()` is
 * called every render tick so values (latency, status, counts) update in place,
 * but the host renders against the row/tab STRUCTURE captured at the last
 * interaction boundary (open, or a key press). Rows never reflow under the
 * cursor mid-interaction; a structural change (a row appears/disappears) is
 * deferred until the next key press. See ConfigModal for the mechanism.
 */

/** A single row within a tab. Identity is `id` (structural); `label` is live. */
export interface ConfigModalRow {
  /**
   * Stable identity across live-refresh ticks. The liveness contract keys
   * structural stability off this: two builds with the same ordered id set are
   * "structurally identical" and repaint values in place; a differing id set is
   * a structural change, deferred to the next interaction boundary.
   */
  readonly id: string;
  /** Display label. MAY embed live value fields (latency, status dot, counts). */
  readonly label: string;
  /** Optional per-row style (e.g. bad/warn tone for an errored row). */
  readonly style?: ModalSectionStyle;
  /**
   * Non-selectable informational row (sub-header, spacer text). Skipped by
   * up/down navigation and never receives an action. Defaults to selectable.
   */
  readonly selectable?: boolean;
}

/** One tab (section) of a surface. Tabs are switched with left/right or Tab. */
export interface ConfigModalTab {
  /** Stable id — preserves the active tab across refresh + re-open. */
  readonly id: string;
  /** Tab-strip label. */
  readonly label: string;
  /** Live status/posture lines rendered above the list (non-selectable). */
  readonly header?: readonly string[];
  /** Selectable/informational rows. */
  readonly rows: readonly ConfigModalRow[];
  /** Honest empty-state text shown when `rows` is empty. */
  readonly emptyText?: string;
  /** Footer hints specific to this tab, appended after the surface hints. */
  readonly hints?: readonly string[];
}

/** The whole surface view for one render tick. */
export interface ConfigModalView {
  /** Live title (may change tick-to-tick; not structural). */
  readonly title: string;
  readonly tabs: readonly ConfigModalTab[];
  /**
   * Non-null when the read-model is unavailable/degraded — the host renders a
   * banner and still shows whatever tabs/rows are present (honest degraded
   * state rather than a blank or a throw).
   */
  readonly degraded?: string;
  /** Base footer hints (Esc close is always appended by the host). */
  readonly hints?: readonly string[];
}

/** Context handed to a surface's action handler when an action key fires. */
export interface ConfigModalActionContext {
  /** The selected row the action targets (null when the active tab has none). */
  readonly row: ConfigModalRow | null;
  /** The active tab's id. */
  readonly tabId: string;
  /** Print a line to the conversation transcript. */
  readonly print: (message: string) => void;
  /**
   * Execute a slash command — the same seam panels used via
   * `PanelIntegrationContext.executeCommand`. This is how a migrated action
   * preserves parity: the mutation still runs through its existing, tested
   * command (e.g. `/settings-sync resolve`, `/local-auth delete-user`).
   */
  readonly executeCommand?: (name: string, args: string[]) => Promise<unknown>;
  /** Open another named modal surface (cross-surface navigation, e.g. the
   *  services surface jumping to the subscription surface). Swaps the active
   *  surface in place — the same seam ctx.openModal uses. */
  readonly openModal?: (name: string) => void;
  /**
   * Submit text to the chat/model as a real user turn — the same composer
   * submission seam `handleUserInput` uses (threaded from CommandContext.submitInput).
   * Generic across surfaces (any modal may hand free-form input to the model).
   *
   * ORDERING GUARD: a turn must never start while a modal owns the keyboard —
   * that is the modal-liveness hazard (a live turn painting under a modal that
   * still captures keys). Callers MUST `close()` the modal BEFORE invoking
   * `submitInput`. The planning modal's free-form submit follows this ordering.
   */
  readonly submitInput?: (text: string) => void;
  /** Request a re-render. */
  readonly requestRender: () => void;
  /** Set the modal's transient status line (e.g. a result or error message). */
  readonly setStatus: (message: string) => void;
  /** Close the modal (focus returns to whatever opened it). */
  readonly close: () => void;
  /**
   * Switch the active tab and select a row within it, by id — the in-surface
   * "jump" affordance (e.g. the Memory modal's Proposals tab jumping to an
   * affected record in the Review Queue tab, rather than opening a second
   * modal). Host-owned, populated by ConfigModal itself (like `close`/
   * `setStatus`) — a surface's `onAction` calls it, never constructs it. A
   * no-op if either id is not present in the surface's current structure; the
   * surface should check reachability itself and print an honest status line
   * when it isn't, rather than relying on a silent no-op.
   */
  readonly jumpToRow?: (tabId: string, rowId: string) => void;
}

/** A declarative action bound to a key. */
export interface ConfigModalAction {
  /**
   * Trigger key: a single printable char ('r', 'd') or a named key ('enter').
   * Must not collide with the host-reserved nav keys (up/down/left/right/tab/
   * j/k/escape/'/') — those are consumed by the host before actions are
   * consulted. '/' arms the host's type-to-filter (item 1); while
   * filtering, EVERY printable key (not just j/k) is captured by the query
   * instead of firing an action — see handleConfigModalToken.
   */
  readonly key: string;
  /** Action id passed to `onAction`. */
  readonly id: string;
  /** Short verb for the footer hint (e.g. "refresh", "delete user"). */
  readonly label: string;
  /**
   * Destructive: require an explicit second press of the same key to fire
   * (the host shows "press <key> again to <label>" between presses). Matches
   * the session-picker delete-confirm precedent.
   */
  readonly confirm?: boolean;
  /**
   * When set, the action is only offered while the selected row's id satisfies
   * this predicate (e.g. sandbox "stop" only on a session row). Rows failing
   * the predicate neither show the hint nor fire the action.
   */
  readonly enabledFor?: (row: ConfigModalRow | null, tabId: string) => boolean;
}

/**
 * A named config-modal surface. Pure seam — the host knows nothing about the
 * surface's data. Built once (closing over its read-models) and registered on
 * PanelManager via `registerModalSurface`; opened by name from a panel-id
 * redirect hit or `ctx.openModal(name)`.
 */
export interface ConfigModalSurface {
  /** Modal name — the key `registerModalRedirect` / `ctx.openModal` use. */
  readonly name: string;
  /** Fallback title (buildView().title wins per tick). */
  readonly title: string;
  /**
   * Build the current view from live read-models. Called on open, on every
   * interaction boundary, AND on every render tick. MUST be pure and cheap —
   * snapshot reads only, no async, no mutation.
   */
  buildView(): ConfigModalView;
  /** Declarative action table (optional — a read-only surface has none). */
  readonly actions?: readonly ConfigModalAction[];
  /** Handle an action fired by its key. */
  onAction?(actionId: string, ctx: ConfigModalActionContext): void;
  /**
   * Optional lifecycle: called when the modal opens this surface and when it
   * closes. A live surface uses `onOpen` to subscribe to its read-model/events
   * (calling the provided `requestRender` on change so live values refresh
   * between key presses) and `onClose` to unsubscribe. The host guarantees
   * `onClose` runs exactly once per `onOpen`.
   */
  onOpen?(requestRender: () => void): void;
  onClose?(): void;
}

/** Read-only registry the host consults to resolve a modal name to a surface. */
export interface ConfigModalSurfaceRegistry {
  getModalSurface(name: string): ConfigModalSurface | undefined;
}
