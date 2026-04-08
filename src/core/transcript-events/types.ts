export type TranscriptEventKind =
  | 'user_input'
  | 'assistant_output'
  | 'tool_call'
  | 'tool_result'
  | 'approval_request'
  | 'approval_resolution'
  | 'task_transition'
  | 'remote_status'
  | 'policy_warning'
  | 'artifact_preview'
  | 'review_state'
  | 'session_restore'
  | 'diagnostic_notice'
  | 'system_notice';

export interface TranscriptEvent {
  readonly id: string;
  readonly kind: TranscriptEventKind;
  readonly messageIndex: number;
  readonly groupKey: string;
  readonly title: string;
  readonly detail: string;
  readonly relatedCallId?: string;
}

