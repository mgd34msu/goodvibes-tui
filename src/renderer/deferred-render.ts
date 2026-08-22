/**
 * A render function usable before the renderer exists.
 *
 * main() captures `render` in dozens of closures declared long before the
 * render scheduler is built (the scheduler needs the compositor and lifecycle
 * constructed below them). A direct `const render` declared at the scheduler
 * put every one of those closures in its temporal dead zone, and every
 * session start crashed with "Cannot access 'render' before initialization"
 * surfacing as an unhandled rejection that killed whatever bootstrap step was
 * mid-flight. The firing path has to be a callback some installer in that
 * window invokes synchronously with the rejection crossing a promise boundary
 * on the way out — the window contains no await, so no timer or scan callback
 * can interleave into it — and this indirection removes the entire class
 * rather than the one caller: a closure that fires before {@link
 * DeferredRender.set} runs gets a no-op, and main()'s unconditional first
 * paint after wiring covers everything deferred.
 */
export interface DeferredRender {
  /** Safe to call at any time; a no-op until {@link set} provides the real renderer. */
  readonly render: () => void;
  /** Install the real renderer; every later render() call goes to it. */
  readonly set: (impl: () => void) => void;
}

export function createDeferredRender(): DeferredRender {
  let impl: () => void = () => {};
  return {
    render: () => impl(),
    set: (next) => { impl = next; },
  };
}
