/**
 * approval-alert, fires an unfocused-user alert the moment a tool call
 * becomes a real, user-blocking permission prompt.
 *
 * Anchor: `PERMISSION_REQUESTED` (SDK events/permissions.ts) is the wrong
 * signal, it fires for every policy-evaluation step, including ones
 * auto-resolved by allow-lists/yolo-mode in milliseconds. The only place a
 * request becomes an actual user-facing prompt is where main.ts assigns
 * `permissionPromptRef.requestPermission`. There is no `permissions` feed on
 * UiRuntimeEvents to subscribe to instead, so this wraps the handler at that
 * assignment site.
 *
 * wrapRequestPermissionWithAlert fires the alert synchronously (before the
 * wrapped promise settles) so it reflects "a prompt just appeared", not
 * "a prompt was just resolved".
 *
 * Text (owner ruling 2026-09-29, SDK runtime/turn-notification.ts): the
 * notice names what is waiting, the command for exec, the file for write and
 * edit, the URL for fetch, and the turn that asked for it. When
 * behavior.notificationsMetadataOnly is on (default off) every channel here
 * (OSC 9, desktop, webhook) sends the tool name and permission category only,
 * never a command, a path or the turn's name.
 */
import { notifyCompletion } from '@pellux/goodvibes-sdk/platform/utils';
import { logger } from '@pellux/goodvibes-sdk/platform/utils';
import type { WebhookNotifier } from '@pellux/goodvibes-sdk/platform/integrations';
import type { PermissionRequestHandler, PermissionPromptRequest } from '@pellux/goodvibes-sdk/platform/permissions';
import type { FocusTracker } from '@pellux/goodvibes-sdk/platform/runtime/operations';
import {
  shouldFireAlert,
  FORCE_NOTIFY_DURATION_MS,
  NOTIFICATION_TEXT_LIMITS,
  buildApprovalNotification,
  describeToolTarget,
  formatWebhookText,
  joinNotificationLine,
  readNotificationsMetadataOnly,
  resolveTurnName,
  type ConfigGet,
} from '@pellux/goodvibes-sdk/platform/runtime/operations';
import type { TerminalNotifier } from './terminal-notifier.ts';

export interface ApprovalAlertDeps {
  readonly focusTracker: Pick<FocusTracker, 'shouldAlertWhenUnfocused'>;
  readonly configGet: ConfigGet;
  readonly webhookNotifier?: WebhookNotifier | null;
  /**
   * Optional in-terminal (OSC 9) notifier. When present, a permission prompt
   * appearing also emits an in-terminal notification, gated independently by
   * the notifier's own per-signal config + focus rule (separate from the
   * desktop-alert gate below). Absent in tests/headless.
   */
  readonly terminalNotifier?: TerminalNotifier | null;
  /**
   * The live conversation, read for the name of the turn that is asking: a
   * title the user set, else the message that started this turn (the last
   * user message while a turn runs). Absent means the notice names no turn.
   */
  readonly conversation?: ApprovalTurnSource | null;
  /** Desktop delivery; defaults to the SDK notifyCompletion. Tests pass a spy to read the text. */
  readonly notifyDesktop?: typeof notifyCompletion;
}

/** The conversation surface the approval notice names the turn from. */
export interface ApprovalTurnSource {
  readonly title: string;
  getTitleSource(): string;
  getLastUserMessage(): string | null;
}

/**
 * Wrap a PermissionRequestHandler so every call also fires an unfocused-user
 * alert (subject to the behavior.notifyOnApprovalPending / notifyOnlyWhenUnfocused
 * gates). The wrapped handler's behavior (what it resolves to) is completely
 * unchanged, this only adds a side effect at call time.
 */
export function wrapRequestPermissionWithAlert(
  original: PermissionRequestHandler,
  deps: ApprovalAlertDeps,
): PermissionRequestHandler {
  return (request: PermissionPromptRequest) => {
    fireApprovalAlert(request, deps);
    return original(request);
  };
}

function fireApprovalAlert(request: PermissionPromptRequest, deps: ApprovalAlertDeps): void {
  const metadataOnly = readNotificationsMetadataOnly(deps.configGet);
  const conversation = deps.conversation;
  const titleSource = conversation?.getTitleSource();
  const notice = buildApprovalNotification({
    tool: request.tool,
    category: request.category,
    target: metadataOnly ? null : describeToolTarget(request.args, request.analysis?.target),
    turnName: metadataOnly || !conversation ? null : resolveTurnName({
      title: conversation.title,
      titleSource: titleSource === 'user' || titleSource === 'system' ? titleSource : null,
      turnText: conversation.getLastUserMessage(),
    }),
  }, { metadataOnly });

  // In-terminal (OSC 9) notification fires on its OWN gating (independent of the
  // desktop-alert gate below), so it is emitted before the early return.
  deps.terminalNotifier?.notify('approval-wait', joinNotificationLine(notice, NOTIFICATION_TEXT_LIMITS.terminal));

  if (!shouldFireAlert(deps.focusTracker, deps.configGet, 'behavior.notifyOnApprovalPending')) return;

  try {
    (deps.notifyDesktop ?? notifyCompletion)(notice.title, notice.body, FORCE_NOTIFY_DURATION_MS);
  } catch (err) {
    logger.debug('approval-alert: desktop notify error', { error: String(err) });
  }

  const webhookNotifier = deps.webhookNotifier;
  if (webhookNotifier) {
    const urls = webhookNotifier.getUrls();
    if (urls.length > 0) {
      webhookNotifier.send(formatWebhookText(notice)).catch((err: unknown) => {
        logger.debug('approval-alert: webhook send error', { error: String(err) });
      });
    }
  }
}
