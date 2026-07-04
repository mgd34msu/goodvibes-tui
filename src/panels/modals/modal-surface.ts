import type { ModalConfig } from '../../renderer/modal-factory.ts';
import type { PanelManager } from '../panel-manager.ts';

// ---------------------------------------------------------------------------
// Ecosystem & Governance modal contract (W6.1 group B — the panel purge).
//
// Every retired ecosystem/governance panel is re-expressed here as a
// `BoundModalSurface`: a stateful-but-thin adapter that (1) owns whatever
// disk/live cache the old panel's refresh() owned, (2) renders a pure
// `ModalConfig` from that cache via ModalFactory, and (3) dispatches keypresses
// through a keyed `actions` map. The WO-A config-modal host builds the frame
// from buildConfig() and routes input through actions — this module never
// touches the modal stack, ui-openers, or builtin-modals.ts itself.
//
// Charter alignment (observability-layer vision): these surfaces are primarily
// read + navigate. Destructive/interactive mutations (install, rollout,
// enable/disable, run) are NOT modal-ized — they route to their existing
// command path via a `runCommand` outcome, so no approval/confirm prompt is
// ever folded into a modal (charter rule: approval REQUESTS stay interrupts).
// ---------------------------------------------------------------------------

/**
 * The slice of interactive modal state a builder reads each render. The WO-A
 * host owns the authoritative modal-stack state; this is the minimal shape a
 * list-with-filter surface needs. Kept deliberately small so adapting to the
 * host's concrete state object at integration is a rename, not a rewrite.
 */
export interface ModalViewState {
  /** Index of the highlighted row within the modal's primary list. */
  readonly selectedIndex: number;
  /** Current filter/search query (empty string when no filter is active). */
  readonly query: string;
  /** Ids of rows whose detail block is expanded (Enter toggles). */
  readonly expanded?: ReadonlySet<string>;
}

/** Convenience default view for first render / tests / goldens. */
export const EMPTY_VIEW: ModalViewState = { selectedIndex: 0, query: '' };

/**
 * What dispatching a modal action asks the host to do next. Everything a
 * migrated surface needs to stay honest without owning the modal lifecycle:
 * re-render, close, print a transcript line, cross-open a sibling modal, or
 * hand a destructive/interactive verb back to its command path.
 */
export type ModalActionOutcome =
  | { readonly kind: 'none' }
  | { readonly kind: 'refresh' }
  | { readonly kind: 'close' }
  | { readonly kind: 'print'; readonly text: string }
  | { readonly kind: 'openModal'; readonly name: string }
  | { readonly kind: 'runCommand'; readonly command: string };

/** An action handler. Reads the current view (selection/query) and acts. */
export type ModalAction = (view: ModalViewState) => ModalActionOutcome;

/**
 * A migrated ecosystem/governance surface, bound to its live deps, expressed
 * as a pure config builder + a keyed action map.
 */
export interface BoundModalSurface {
  /** ctx.openModal(name) dispatch key AND the golden surface stem `<name>`. */
  readonly name: string;
  /** Title-bar text. */
  readonly title: string;
  /**
   * Reload any disk/live-backed cache the old panel refreshed on activate.
   * Called by the host when the modal opens and on the `refresh` action.
   * Read-model-backed surfaces that read getSnapshot() lazily leave this a
   * no-op.
   */
  refresh(): void;
  /** Build the ModalFactory config for the current cache + view. Pure. */
  buildConfig(view: ModalViewState): ModalConfig;
  /**
   * Row ids the current cache exposes, in display order. Lets the host clamp
   * selection and lets actions resolve `selectedIndex` to a stable id.
   */
  rowIds(view: ModalViewState): readonly string[];
  /** Keyed action handlers dispatched by the host on keypress. */
  readonly actions: Readonly<Record<string, ModalAction>>;
}

/**
 * The registrar the WO-A config-modal host exposes. `registerEcosystemModals`
 * calls it once at startup. Kept structurally minimal so the host can satisfy
 * it however its dispatch core is shaped.
 */
export interface EcosystemModalRegistrar {
  /** Register a surface's config + dispatch under its `name`. */
  registerModal(surface: BoundModalSurface): void;
  /** Register a retired panel id → modal-name redirect (PanelManager seam). */
  registerModalRedirect(panelId: string, modalName: string): void;
}

/**
 * Canonical retired-panel-id → modal-name redirect map for group B. Single
 * source of truth for both the runtime redirect wiring
 * (`registerEcosystemModalRedirects`, called from the builtin registrar so
 * `/panel open <id>` and saved layouts never dead-end) and the integrator's
 * host wiring (`registerEcosystemModals`). `sessions` folds into the existing
 * session-picker modal rather than a new surface.
 */
export const ECOSYSTEM_MODAL_REDIRECTS: ReadonlyArray<readonly [panelId: string, modalName: string]> = [
  ['marketplace', 'marketplace'],
  ['plugins', 'plugins'],
  ['skills', 'skills'],
  ['hooks', 'hooks'],
  ['policy', 'policy'],
  ['security', 'security'],
  ['knowledge', 'knowledge'],
  ['memory', 'memory'],
  ['docs', 'keybindings'],
  ['qr-code', 'pairing'],
  ['work-plan', 'work-plan'],
  ['project-planning', 'planning'],
  ['sessions', 'sessionPicker'],
];

/**
 * Register the group-B panel→modal redirects on the PanelManager. Host-
 * independent (needs only the manager + the already-wired openModal callback),
 * so it can be called from the builtin registrar to keep `/panel open <id>`
 * and saved-layout reopen honest on this branch before the WO-A host lands.
 * Idempotent (Map.set) — safe if the integrator's `registerEcosystemModals`
 * later registers the same redirects.
 */
export function registerEcosystemModalRedirects(manager: PanelManager): void {
  for (const [panelId, modalName] of ECOSYSTEM_MODAL_REDIRECTS) {
    manager.registerModalRedirect(panelId, modalName);
  }
}
