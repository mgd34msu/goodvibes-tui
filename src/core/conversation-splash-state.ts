/**
 * conversation-splash-state.ts, when the splash owns the conversation area,
 * and what has to happen the moment it stops.
 *
 * Two pieces of state, kept out of ConversationManager (core/conversation.ts,
 * already at its line-count gate) and out of `suppressSplash`, which is a
 * per-frame posture the panel workspace sets both ways on every render:
 *
 *   - `dismissed`, sticky for the run. Owner rule: the splash yields to ANY
 *     submission, a chat message or a slash command alike. A slash command
 *     whose whole output is a modal (or nothing) still means the session has
 *     started, so the splash must not reappear underneath it, and must not
 *     come back in the gap before the first reply arrives.
 *
 *   - the splash→transcript EDGE, latched when a rebuild that would have
 *     drawn the splash draws transcript content instead. The shell consumes
 *     it to repaint the whole viewport for that one frame. Without that, the
 *     differential renderer only rewrites rows it knows changed, so every row
 *     the incoming transcript does not cover keeps showing splash art: rule
 *     lines, the hint line, and half-overwritten rows where a short transcript
 *     line collides with the tail of a longer splash line.
 */
export class SplashGateState {
  private dismissedForRun = false;
  private onScreen = false;
  private yielded = false;

  /** True once the run's first submission has retired the splash. */
  get dismissed(): boolean {
    return this.dismissedForRun;
  }

  /** Retire the splash for the run. Returns true when this call changed anything. */
  dismiss(): boolean {
    if (this.dismissedForRun) return false;
    this.dismissedForRun = true;
    return true;
  }

  /** Record that this rebuild drew the splash. */
  enter(): void {
    this.onScreen = true;
  }

  /** Record that this rebuild drew transcript content; latches the edge. */
  leave(): void {
    if (!this.onScreen) return;
    this.onScreen = false;
    this.yielded = true;
  }

  /** True exactly once per splash→transcript transition. */
  consumeTransition(): boolean {
    const transition = this.yielded;
    this.yielded = false;
    return transition;
  }
}
