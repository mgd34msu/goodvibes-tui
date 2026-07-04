import type { SubmissionIntent } from '../input/submission-intent.ts';
import { routeSubmissionIntent, type SubmissionRouterInput } from '../input/submission-router.ts';
import type { TurnState } from '@/runtime/index.ts';

export interface ComposerState {
  readonly intent: SubmissionIntent;
  readonly modeLabel: string;
  readonly statusLabel: string;
  readonly pendingRisk: 'none' | 'approval-wait' | 'shell' | 'command' | 'remote';
  readonly flags: readonly string[];
}

export interface ComposerStateInput extends SubmissionRouterInput {
  readonly pendingApproval?: boolean;
  readonly turnState?: TurnState;
}

export function deriveComposerState(input: ComposerStateInput): ComposerState {
  const intent = routeSubmissionIntent(input);
  const flags: string[] = [];
  let pendingRisk: ComposerState['pendingRisk'] = 'none';

  // An approval wait is the dominant composer state and owns the single honest
  // status tag: `risk:approval-wait`. It is therefore NOT also duplicated as a
  // `approval` flag, and (below) it suppresses the competing `state:` turn tag —
  // the turn is blocked on the user, not really streaming. Precedence:
  // approval-wait > live turn state. (UX-B item 4.)
  const approvalWait = input.pendingApproval === true;
  if (approvalWait) {
    pendingRisk = 'approval-wait';
  }
  if (intent.kind === 'shell') {
    flags.push('shell');
    if (pendingRisk === 'none') pendingRisk = 'shell';
  } else if (intent.kind === 'slash-command' || intent.kind === 'plan' || intent.kind === 'review') {
    if (pendingRisk === 'none') pendingRisk = 'command';
  } else if (intent.kind === 'orchestration') {
    flags.push('orchestration');
    if (pendingRisk === 'none') pendingRisk = 'remote';
  }
  if (input.hasAttachments) flags.push('attachments');

  const turnStatus = (() => {
    switch (input.turnState) {
      case 'preflight': return 'preflight';
      case 'streaming': return 'streaming';
      case 'tool_dispatch': return 'tools';
      case 'post_hooks': return 'post-hooks';
      case 'failed': return 'failed';
      case 'cancelled': return 'cancelled';
      case 'completed': return 'completed';
      default: return 'idle';
    }
  })();
  // 'idle' is suppressed by the footer renderer, so an approval wait shows only
  // `risk:approval-wait` — one honest tag, not three spellings of the wait.
  const statusLabel = approvalWait ? 'idle' : turnStatus;

  return {
    intent,
    modeLabel: intent.label,
    statusLabel,
    pendingRisk,
    flags,
  };
}

