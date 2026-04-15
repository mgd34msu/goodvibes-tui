import type { HookDefinition, HookResult, HookEvent } from '@pellux/goodvibes-sdk/platform/hooks/types';
import { logger } from '@pellux/goodvibes-sdk/platform/utils/logger';
import type { AgentManager } from '@pellux/goodvibes-sdk/platform/tools/agent/index';
import { summarizeError } from '@pellux/goodvibes-sdk/platform/utils/error-display';

/**
 * Agent hook runner — spawns a subagent via AgentManager and waits for
 * completion up to the hook's configured timeout.
 *
 * The hook's `prompt` field (with `$ARGUMENTS` replaced by the event JSON)
 * becomes the agent task description.
 *
 * Since AgentManager currently registers agents synchronously and doesn't
 * execute them in a true background thread, the hook marks the agent as
 * completed immediately and returns a success result.  When real background
 * execution is wired the status polling loop below will take effect.
 */
export async function run(
  hook: HookDefinition,
  event: HookEvent,
  manager: Pick<AgentManager, 'spawn' | 'getStatus' | 'cancel'>,
): Promise<HookResult> {
  const promptTemplate = hook.prompt;
  if (promptTemplate == null) {
    return { ok: false, error: 'agent hook missing "prompt" field' };
  }

  const task = promptTemplate.replaceAll('$ARGUMENTS', JSON.stringify(event));
  const timeoutMs = (hook.timeout ?? 60) * 1000;
  logger.debug('agent hook: spawning agent', {
    event: event.path,
    timeoutMs,
  });

  let record;
  try {
    record = manager.spawn({
      mode: 'spawn',
      task,
      template: 'general',
      model: hook.model,
    });
  } catch (err) {
    const message = summarizeError(err);
    logger.error('agent hook: spawn failed', { event: event.path, error: message });
    return { ok: false, error: `agent spawn failed: ${message}` };
  }

  const agentId = record.id;

  logger.debug('agent hook: agent spawned', { agentId, event: event.path });

  // Poll for agent completion up to timeoutMs.
  // Currently AgentManager doesn't execute agents in the background, so after
  // spawning the agent is in 'pending' state and this loop will time out unless
  // the record is manually advanced.  When real execution is wired, this loop
  // will catch the completion/failure transition.
  const pollInterval = 100; // ms
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const current = manager.getStatus(agentId);
    if (!current) {
      return { ok: false, error: `agent ${agentId} disappeared from registry` };
    }

    if (current.status === 'completed') {
      logger.debug('agent hook: agent completed', { agentId });
      return {
        ok: true,
        additionalContext: current.progress,
      };
    }

    if (current.status === 'failed') {
      logger.error('agent hook: agent failed', { agentId, error: current.error });
      return { ok: false, error: current.error ?? 'agent failed without error message' };
    }

    if (current.status === 'cancelled') {
      return { ok: false, error: `agent ${agentId} was cancelled before completing` };
    }

    // Agent still pending/running — wait a tick
    await new Promise<void>((resolve) => setTimeout(resolve, pollInterval));
  }

  // Timed out — cancel the agent and return error
  manager.cancel(agentId);
  const timeoutSecs = hook.timeout ?? 60;
  logger.error('agent hook: timed out', { agentId, timeoutSecs });
  return { ok: false, error: `agent hook timed out after ${timeoutSecs}s (agentId: ${agentId})` };
}
