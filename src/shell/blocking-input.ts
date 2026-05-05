import type { ConversationManager } from '../core/conversation';
import type { PermissionRequest } from '@pellux/goodvibes-sdk/platform/permissions';
import type { SessionSnapshot } from '@/runtime/index.ts';
import type { SystemMessageRouter } from '../core/system-message-router.ts';

export type PendingPermissionState = PermissionRequest & {
  resolve: (approved: boolean, remember?: boolean) => void;
};

export type BlockingInputHandlerOptions = {
  data: string;
  pendingPermission: PendingPermissionState | null;
  recoveryPending: boolean;
  abortTurn: () => void;
  conversation: ConversationManager;
  systemMessageRouter: SystemMessageRouter;
  render: () => void;
  loadRecoveryConversation: () => SessionSnapshot | null;
  deleteRecoveryFile: () => void;
};

export type BlockingInputHandlerResult = {
  handled: boolean;
  pendingPermission: PendingPermissionState | null;
  recoveryPending: boolean;
};

export function handleBlockingShellInput(
  options: BlockingInputHandlerOptions,
): BlockingInputHandlerResult {
  const {
    data,
    pendingPermission,
    recoveryPending,
    abortTurn,
    conversation,
    systemMessageRouter,
    render,
    loadRecoveryConversation,
    deleteRecoveryFile,
  } = options;

  if (pendingPermission) {
    const req = pendingPermission;
    const key = data.toLowerCase().trim();

    if (key === 'y') {
      req.resolve(true, false);
      render();
      return { handled: true, pendingPermission: null, recoveryPending };
    }

    if (key === 'a') {
      req.resolve(true, true);
      render();
      return { handled: true, pendingPermission: null, recoveryPending };
    }

    if (key === 'n' || data === '\x1b' || data === '\x03') {
      req.resolve(false, false);
      abortTurn();
      render();
      return { handled: true, pendingPermission: null, recoveryPending };
    }

    render();
    return { handled: true, pendingPermission, recoveryPending };
  }

  if (recoveryPending) {
    const key = data.toLowerCase();
    if (key === 'r') {
      const recovery = loadRecoveryConversation();
      if (recovery) {
        conversation.fromJSON({ messages: recovery.messages as Parameters<typeof conversation.fromJSON>[0]['messages'] });
        systemMessageRouter.high('[Recovery] Session restored.');
      } else {
        systemMessageRouter.high('[Recovery] Failed to restore saved data.');
      }
    } else {
      systemMessageRouter.high('[Recovery] Discarded recovery data.');
    }
    deleteRecoveryFile();
    render();
    return { handled: true, pendingPermission: null, recoveryPending: false };
  }

  return { handled: false, pendingPermission, recoveryPending };
}
