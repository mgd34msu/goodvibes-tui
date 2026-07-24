/**
 * session-resume-liveness-confirm.ts — the "this session is open somewhere
 * else" check for the session-browser / panel resume seam.
 *
 * `/session resume <id>` already refuses to resume a session whose liveness
 * marker points at another running process, and tells the operator to re-run
 * with `--force`. The panel seam had no such check at all: picking a session
 * from the browser forked another terminal's live state with no warning. That
 * seam has no argv to carry a `--force`, so it asks the same question as a
 * modal instead.
 *
 * Semantics are unchanged from the text-command check and stay best-effort: a
 * missing, stale, or unreadable marker means "we can't tell", and the resume
 * proceeds exactly as it always did. The marker belonging to THIS process is
 * ignored too — re-resuming the session already open here is not a fork.
 */
import { checkSessionLiveness } from './session-liveness-marker.ts';
import type { SessionSurface } from '@/runtime/index.ts';
import type { SelectionItem, SelectionResult } from '../input/selection-modal.ts';

export type LiveResumeSelectionOpener = (
  title: string,
  items: SelectionItem[],
  opts: { preSelectId?: string; allowSearch?: boolean; primaryVerbLabel?: string } | undefined,
  callback: (result: SelectionResult | null) => void,
) => void;

/**
 * The confirm modal's title. Short by necessity: the selection overlay
 * truncates its title to the box width (selection-modal-overlay.ts), so
 * anything the operator must actually read — the pid, and what resuming would
 * do — belongs in a row's `detail`, which that overlay wraps instead.
 */
export const LIVE_RESUME_CONFIRM_TITLE = 'Session open elsewhere';

export function buildLiveResumeConfirmItems(pid: number): SelectionItem[] {
  return [
    {
      id: 'resume',
      label: 'Resume anyway',
      detail: `This session appears open in another terminal (pid ${pid}); resuming will fork its live state. Both terminals would hold their own copy of the conversation from this point on.`,
      primaryAction: 'select',
    },
    {
      id: 'cancel',
      label: 'Cancel',
      detail: 'Leave the session to the terminal that already has it open.',
      primaryAction: 'select',
    },
  ];
}

export interface ConfirmLiveResumeDeps {
  readonly surface: SessionSurface;
  /** Late-bound: the shell builds its selection opener after the resume handler exists. */
  readonly openSelection: () => LiveResumeSelectionOpener | undefined;
  /** Injectable for tests; defaults to this process's own pid. */
  readonly selfPid?: number;
}

/**
 * Resolve true when the resume should proceed. Proceeds without asking
 * whenever the liveness signal says there is nothing to warn about, or when
 * no selection surface exists to ask through (headless hosts keep the
 * pre-existing behavior rather than silently refusing).
 *
 * A dismissed modal resolves false: the safe answer to an unanswered "should
 * I fork another terminal's state?" is no.
 */
export async function confirmLiveResume(sessionId: string, deps: ConfirmLiveResumeDeps): Promise<boolean> {
  const selfPid = deps.selfPid ?? process.pid;
  const liveness = checkSessionLiveness(deps.surface, sessionId);
  if (!liveness.live || liveness.pid === null || liveness.pid === selfPid) return true;
  const open = deps.openSelection();
  if (!open) return true;
  return new Promise<boolean>((resolve) => {
    open(
      LIVE_RESUME_CONFIRM_TITLE,
      buildLiveResumeConfirmItems(liveness.pid!),
      { allowSearch: false, primaryVerbLabel: 'Choose' },
      (result) => resolve(result?.item.id === 'resume'),
    );
  });
}
