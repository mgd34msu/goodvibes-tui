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

  if (input.pendingApproval) {
    flags.push('approval');
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

  const statusLabel = (() => {
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

  return {
    intent,
    modeLabel: intent.label,
    statusLabel,
    pendingRisk,
    flags,
  };
}

