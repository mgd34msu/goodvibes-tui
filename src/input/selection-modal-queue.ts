/**
 * selection-modal-queue.ts, Serializes overlapping InputHandler.openSelection() calls.
 *
 * openSelection (handler.ts) writes into a singleton SelectionModal plus a
 * single callback slot. A second openSelection call while one is already
 * showing used to silently overwrite both, the pre-empted caller's callback
 * was never invoked, not even with null, so any caller that awaits it (see
 * the `ask()` helper in runtime/recovery-prompt.ts, which wraps the callback
 * in a Promise) hung forever. This is reachable in production: the
 * `--continue` liveness-confirm modal (session-resume-liveness-confirm.ts)
 * races the startup recovery offer, which is scheduled on a 0ms macrotask
 * (scheduleRecoveryOffer in runtime/recovery-prompt.ts).
 *
 * Fix: queue overlapping requests FIFO and open each automatically once the
 * previous one resolves, through the SAME callback the caller already
 * supplied, openSelection's public signature never changes.
 *
 * Why the drain is deferred to a microtask instead of running inline inside
 * the resolving callback: both resolution paths, the select/enter path in
 * handler-modal-routes.ts's dispatchSelectionAction, and the Escape path in
 * handler-modal-stack.ts's handleEscape/closeSelection, take a snapshot of
 * the current selectionCallback before dispatch and write some form of that
 * snapshot back into handler/context state AFTER invoking the callback (the
 * select path re-reads via getSelectionCallback; the Escape path threads a
 * local variable back out through handleEscapeForHandler in
 * handler-interactions.ts). If this module opened the next queued request
 * synchronously inside the resolving callback, those post-callback
 * write-backs would immediately clobber the freshly-set callback for the
 * newly-opened modal. Deferring past the end of the synchronous resolution
 * (queueMicrotask) lets all of that settle first, then opens the next
 * request cleanly, the same shape as the production race this fixes, which
 * itself resolves via a deferred (macrotask) call.
 */
import type { SelectionItem, SelectionAction, SelectionResult, SelectionModal } from './selection-modal.ts';

export type SelectionModalCallback = (result: SelectionResult | null) => void;

export interface SelectionOpenOpts {
  preSelectId?: string;
  allowSearch?: boolean;
  customActions?: Map<string, SelectionAction>;
  primaryVerbLabel?: string;
}

export interface PendingSelectionRequest {
  readonly title: string;
  readonly items: SelectionItem[];
  readonly opts: SelectionOpenOpts | undefined;
  readonly callback: SelectionModalCallback;
}

/**
 * Maximum number of openSelection() calls held while one is already showing.
 * In practice at most two calls ever race in production (the liveness-confirm
 * modal vs. the recovery offer's 0ms macrotask), so 8 is generous headroom
 * for any future chained-picker sequence without letting a misbehaving
 * caller queue without bound. Once full, the overflowing call is resolved
 * with `null` immediately, a bounded queue must still give every caller a
 * definite answer, never silently drop one.
 */
export const MAX_QUEUED_SELECTIONS = 8;

/** Dependencies the queue needs from InputHandler, kept minimal and explicit. */
export interface SelectionQueueHost {
  readonly selectionModal: Pick<SelectionModal, 'active' | 'open'>;
  /** Assigns InputHandler.selectionCallback (the live resolution slot). */
  setSelectionCallback(callback: SelectionModalCallback | null): void;
  /** Mirrors the callback into the in-flight feed context, when a feed() call is in progress (no-op otherwise). */
  syncFeedSelectionCallback(callback: SelectionModalCallback | null): void;
  modalOpened(name: string): void;
  requestRender(): void;
}

/** Owns the FIFO of pending openSelection() requests for one InputHandler instance. */
export class SelectionModalQueue {
  private readonly pending: PendingSelectionRequest[] = [];

  constructor(private readonly host: SelectionQueueHost) {}

  /** Number of requests currently queued (excludes whichever modal is actively showing, if any). */
  public get size(): number {
    return this.pending.length;
  }

  /**
   * Open `request` immediately if no selection modal is currently showing;
   * otherwise queue it FIFO. If the queue is already at MAX_QUEUED_SELECTIONS,
   * the request is resolved with `null` right away instead of being queued.
   */
  public request(request: PendingSelectionRequest): void {
    if (this.host.selectionModal.active) {
      if (this.pending.length >= MAX_QUEUED_SELECTIONS) {
        request.callback(null);
        return;
      }
      this.pending.push(request);
      return;
    }
    this.openNow(request);
  }

  /**
   * Resolve every still-queued request with `null`. Called when the handler
   * is torn down (see the exitApp wrap in handler.ts's constructor) so no
   * queued caller is ever left permanently pending.
   */
  public clear(): void {
    while (this.pending.length > 0) {
      const next = this.pending.shift();
      next?.callback(null);
    }
  }

  private openNow(request: PendingSelectionRequest): void {
    const wrapped: SelectionModalCallback = (result) => {
      request.callback(result);
      // Only a terminal resolution (select/cancel/escape) actually closes
      // the modal, dispatchSelectionAction's toggle/increment/decrement
      // branch invokes the callback but leaves the modal open for further
      // interaction, so only drain the queue once the modal has gone
      // inactive, never on every callback invocation.
      if (!this.host.selectionModal.active) {
        queueMicrotask(() => this.drain());
      }
    };
    this.host.modalOpened('selection');
    this.host.selectionModal.open(request.title, request.items, request.opts);
    this.host.setSelectionCallback(wrapped);
    this.host.syncFeedSelectionCallback(wrapped);
    this.host.requestRender();
  }

  private drain(): void {
    // Something else already opened a modal in the meantime (e.g. a
    // synchronously chained openSelection call from inside the resolving
    // callback), leave the queue alone; that modal's own resolution will
    // drain it in turn.
    if (this.host.selectionModal.active) return;
    const next = this.pending.shift();
    if (!next) return;
    this.openNow(next);
  }
}

/** InputHandler's actual field/method shape, satisfies this structurally, no import needed. */
export interface SelectionQueueOwner {
  readonly selectionModal: Pick<SelectionModal, 'active' | 'open'>;
  selectionCallback: SelectionModalCallback | null;
  syncFeedSelectionCallback: ((callback: SelectionModalCallback | null) => void) | null;
  modalOpened(name: string): void;
  requestRender(): void;
  exitApp: () => void;
}

/**
 * Builds the queue for one InputHandler and wires teardown: wraps
 * `owner.exitApp` (the one path guaranteed to run when the handler is torn
 * down) so every still-queued selection request resolves with `null`
 * instead of being left pending. Keeps this bookkeeping out of handler.ts,
 * which only needs `this.selectionQueue = attachSelectionModalQueue(this);`.
 */
export function attachSelectionModalQueue(owner: SelectionQueueOwner): SelectionModalQueue {
  const queue = new SelectionModalQueue({
    selectionModal: owner.selectionModal,
    setSelectionCallback: (callback) => { owner.selectionCallback = callback; },
    syncFeedSelectionCallback: (callback) => { owner.syncFeedSelectionCallback?.(callback); },
    modalOpened: (name) => owner.modalOpened(name),
    requestRender: () => owner.requestRender(),
  });
  const suppliedExitApp = owner.exitApp;
  owner.exitApp = () => {
    queue.clear();
    suppliedExitApp();
  };
  return queue;
}
