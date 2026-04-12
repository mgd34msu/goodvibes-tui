import type { AgentEvent } from '../../events/agents.ts';
import type { CompactionEvent } from '../../events/compaction.ts';
import type { PermissionEvent } from '../../events/permissions.ts';
import type { SessionEvent } from '../../events/session.ts';
import { endAgentSpan, recordAgentPhase, startAgentSpan } from '../spans/agent.ts';
import { endCompactionSpan, recordCompactionPhase, startCompactionSpan } from '../spans/compaction.ts';
import { endPermissionSpan, recordPermissionPhase, startPermissionSpan } from '../spans/permission.ts';
import { endSessionSpan, recordSessionPhase, startSessionSpan } from '../spans/session.ts';
import type { DomainBridgeAttachmentInput, Env, SpanMap } from './domain-bridge-shared.ts';

export function attachAgentDomain(
  { bus, helpers }: DomainBridgeAttachmentInput,
  agentSpans: SpanMap,
): () => void {
  const unsubs: Array<() => void> = [];

  unsubs.push(
    bus.on('AGENT_SPAWNING', (env: Env<Extract<AgentEvent, { type: 'AGENT_SPAWNING' }>>) => {
      helpers.safe(() => {
        const span = startAgentSpan(helpers.tracer, {
          agentId: env.payload.agentId,
          taskId: env.payload.taskId,
          task: env.payload.task,
          traceId: env.traceId,
        });
        agentSpans.set(env.payload.agentId, span);
      });
    }),
  );

  unsubs.push(
    bus.on('AGENT_RUNNING', (env: Env<Extract<AgentEvent, { type: 'AGENT_RUNNING' }>>) => {
      helpers.safe(() => {
        helpers.withSpan(agentSpans, env.payload.agentId, (span) => recordAgentPhase(span, 'running'));
      });
    }),
  );

  unsubs.push(
    bus.on('AGENT_AWAITING_MESSAGE', (env: Env<Extract<AgentEvent, { type: 'AGENT_AWAITING_MESSAGE' }>>) => {
      helpers.safe(() => {
        helpers.withSpan(agentSpans, env.payload.agentId, (span) => recordAgentPhase(span, 'awaiting_message'));
      });
    }),
  );

  unsubs.push(
    bus.on('AGENT_AWAITING_TOOL', (env: Env<Extract<AgentEvent, { type: 'AGENT_AWAITING_TOOL' }>>) => {
      helpers.safe(() => {
        helpers.withSpan(agentSpans, env.payload.agentId, (span) => {
          recordAgentPhase(span, 'awaiting_tool', {
            'agent.tool': env.payload.tool,
            'agent.call_id': env.payload.callId,
          });
        });
      });
    }),
  );

  unsubs.push(
    bus.on('AGENT_FINALIZING', (env: Env<Extract<AgentEvent, { type: 'AGENT_FINALIZING' }>>) => {
      helpers.safe(() => {
        helpers.withSpan(agentSpans, env.payload.agentId, (span) => recordAgentPhase(span, 'finalizing'));
      });
    }),
  );

  unsubs.push(
    bus.on('AGENT_COMPLETED', (env: Env<Extract<AgentEvent, { type: 'AGENT_COMPLETED' }>>) => {
      helpers.safe(() => {
        helpers.closeSpan(agentSpans, env.payload.agentId, (span) => {
          endAgentSpan(span, {
            outcome: 'completed',
            durationMs: env.payload.durationMs,
          });
        });
      });
    }),
  );

  unsubs.push(
    bus.on('AGENT_FAILED', (env: Env<Extract<AgentEvent, { type: 'AGENT_FAILED' }>>) => {
      helpers.safe(() => {
        helpers.closeSpan(agentSpans, env.payload.agentId, (span) => {
          endAgentSpan(span, {
            outcome: 'failed',
            durationMs: env.payload.durationMs,
            error: env.payload.error,
          });
        });
      });
    }),
  );

  unsubs.push(
    bus.on('AGENT_CANCELLED', (env: Env<Extract<AgentEvent, { type: 'AGENT_CANCELLED' }>>) => {
      helpers.safe(() => {
        helpers.closeSpan(agentSpans, env.payload.agentId, (span) => {
          endAgentSpan(span, {
            outcome: 'cancelled',
            durationMs: 0,
            reason: env.payload.reason,
          });
        });
      });
    }),
  );

  return () => unsubs.forEach((unsub) => unsub());
}

export function attachPermissionDomain(
  { bus, helpers }: DomainBridgeAttachmentInput,
  permissionSpans: SpanMap,
): () => void {
  const unsubs: Array<() => void> = [];

  unsubs.push(
    bus.on('PERMISSION_REQUESTED', (env: Env<Extract<PermissionEvent, { type: 'PERMISSION_REQUESTED' }>>) => {
      helpers.safe(() => {
        const span = startPermissionSpan(helpers.tracer, {
          callId: env.payload.callId,
          tool: env.payload.tool,
          category: env.payload.category,
          traceId: env.traceId,
        });
        permissionSpans.set(env.payload.callId, span);
      });
    }),
  );

  unsubs.push(
    bus.on('RULES_COLLECTED', (env: Env<Extract<PermissionEvent, { type: 'RULES_COLLECTED' }>>) => {
      helpers.safe(() => {
        helpers.withSpan(permissionSpans, env.payload.callId, (span) => {
          recordPermissionPhase(span, 'rules_collected', {
            'permission.rule_count': env.payload.ruleCount,
          });
        });
      });
    }),
  );

  unsubs.push(
    bus.on('INPUT_NORMALIZED', (env: Env<Extract<PermissionEvent, { type: 'INPUT_NORMALIZED' }>>) => {
      helpers.safe(() => {
        helpers.withSpan(permissionSpans, env.payload.callId, (span) => recordPermissionPhase(span, 'input_normalized'));
      });
    }),
  );

  unsubs.push(
    bus.on('POLICY_EVALUATED', (env: Env<Extract<PermissionEvent, { type: 'POLICY_EVALUATED' }>>) => {
      helpers.safe(() => {
        helpers.withSpan(permissionSpans, env.payload.callId, (span) => {
          recordPermissionPhase(span, 'policy_evaluated', {
            'permission.policy_result': env.payload.result,
          });
        });
      });
    }),
  );

  unsubs.push(
    bus.on('MODE_EVALUATED', (env: Env<Extract<PermissionEvent, { type: 'MODE_EVALUATED' }>>) => {
      helpers.safe(() => {
        helpers.withSpan(permissionSpans, env.payload.callId, (span) => {
          recordPermissionPhase(span, 'mode_evaluated', {
            'permission.mode': env.payload.mode,
            'permission.mode_result': env.payload.result,
          });
        });
      });
    }),
  );

  unsubs.push(
    bus.on('SESSION_OVERRIDE_EVALUATED', (env: Env<Extract<PermissionEvent, { type: 'SESSION_OVERRIDE_EVALUATED' }>>) => {
      helpers.safe(() => {
        helpers.withSpan(permissionSpans, env.payload.callId, (span) => {
          recordPermissionPhase(span, 'session_override_evaluated', {
            'permission.override_applied': env.payload.overrideApplied,
          });
        });
      });
    }),
  );

  unsubs.push(
    bus.on('SAFETY_CHECKED', (env: Env<Extract<PermissionEvent, { type: 'SAFETY_CHECKED' }>>) => {
      helpers.safe(() => {
        helpers.withSpan(permissionSpans, env.payload.callId, (span) => {
          recordPermissionPhase(span, 'safety_checked', {
            'permission.safe': env.payload.safe,
            'permission.warning_count': env.payload.warnings.length,
          });
        });
      });
    }),
  );

  unsubs.push(
    bus.on('DECISION_EMITTED', (env: Env<Extract<PermissionEvent, { type: 'DECISION_EMITTED' }>>) => {
      helpers.safe(() => {
        helpers.closeSpan(permissionSpans, env.payload.callId, (span) => {
          endPermissionSpan(span, {
            approved: env.payload.approved,
            source: env.payload.source,
          });
        });
      });
    }),
  );

  return () => unsubs.forEach((unsub) => unsub());
}

export function attachSessionDomain(
  { bus, helpers }: DomainBridgeAttachmentInput,
  sessionSpans: SpanMap,
): () => void {
  const unsubs: Array<() => void> = [];

  unsubs.push(
    bus.on('SESSION_STARTED', (env: Env<Extract<SessionEvent, { type: 'SESSION_STARTED' }>>) => {
      helpers.safe(() => {
        const span = startSessionSpan(helpers.tracer, {
          sessionId: env.payload.sessionId,
          traceId: env.traceId,
          profileId: env.payload.profileId,
          workingDir: env.payload.workingDir,
        });
        sessionSpans.set(env.payload.sessionId, span);
      });
    }),
  );

  unsubs.push(
    bus.on('SESSION_LOADING', (env: Env<Extract<SessionEvent, { type: 'SESSION_LOADING' }>>) => {
      helpers.safe(() => {
        if (!sessionSpans.has(env.payload.sessionId)) {
          const span = startSessionSpan(helpers.tracer, {
            sessionId: env.payload.sessionId,
            traceId: env.traceId,
            path: env.payload.path,
          });
          sessionSpans.set(env.payload.sessionId, span);
          return;
        }
        helpers.withSpan(sessionSpans, env.payload.sessionId, (span) => recordSessionPhase(span, 'loading'));
      });
    }),
  );

  unsubs.push(
    bus.on('SESSION_RESUMED', (env: Env<Extract<SessionEvent, { type: 'SESSION_RESUMED' }>>) => {
      helpers.safe(() => {
        helpers.withSpan(sessionSpans, env.payload.sessionId, (span) => {
          recordSessionPhase(span, 'resumed', {
            'session.turn_count': env.payload.turnCount,
          });
        });
      });
    }),
  );

  unsubs.push(
    bus.on('SESSION_REPAIRING', (env: Env<Extract<SessionEvent, { type: 'SESSION_REPAIRING' }>>) => {
      helpers.safe(() => {
        helpers.withSpan(sessionSpans, env.payload.sessionId, (span) => {
          recordSessionPhase(span, 'repairing', {
            'session.repair_reason': env.payload.reason,
          });
        });
      });
    }),
  );

  unsubs.push(
    bus.on('SESSION_RECONCILING', (env: Env<Extract<SessionEvent, { type: 'SESSION_RECONCILING' }>>) => {
      helpers.safe(() => {
        helpers.withSpan(sessionSpans, env.payload.sessionId, (span) => {
          recordSessionPhase(span, 'reconciling', {
            'session.message_count': env.payload.messageCount,
          });
        });
      });
    }),
  );

  unsubs.push(
    bus.on('SESSION_READY', (env: Env<Extract<SessionEvent, { type: 'SESSION_READY' }>>) => {
      helpers.safe(() => {
        helpers.closeSpan(sessionSpans, env.payload.sessionId, (span) => {
          endSessionSpan(span, { outcome: 'ready' });
        });
      });
    }),
  );

  unsubs.push(
    bus.on('SESSION_RECOVERY_FAILED', (env: Env<Extract<SessionEvent, { type: 'SESSION_RECOVERY_FAILED' }>>) => {
      helpers.safe(() => {
        helpers.closeSpan(sessionSpans, env.payload.sessionId, (span) => {
          endSessionSpan(span, {
            outcome: 'recovery_failed',
            error: env.payload.error,
          });
        });
      });
    }),
  );

  return () => unsubs.forEach((unsub) => unsub());
}

export function attachCompactionDomain(
  { bus, helpers }: DomainBridgeAttachmentInput,
  compactionSpans: SpanMap,
): () => void {
  const unsubs: Array<() => void> = [];

  unsubs.push(
    bus.on('COMPACTION_CHECK', (env: Env<Extract<CompactionEvent, { type: 'COMPACTION_CHECK' }>>) => {
      helpers.safe(() => {
        if (compactionSpans.has(env.payload.sessionId)) return;
        const span = startCompactionSpan(helpers.tracer, {
          sessionId: env.payload.sessionId,
          strategy: 'check',
          tokenCount: env.payload.tokenCount,
          threshold: env.payload.threshold,
          traceId: env.traceId,
        });
        compactionSpans.set(env.payload.sessionId, span);
      });
    }),
  );

  unsubs.push(
    bus.on('COMPACTION_AUTOCOMPACT', (env: Env<Extract<CompactionEvent, { type: 'COMPACTION_AUTOCOMPACT' }>>) => {
      helpers.safe(() => {
        if (compactionSpans.has(env.payload.sessionId)) return;
        const span = startCompactionSpan(helpers.tracer, {
          sessionId: env.payload.sessionId,
          strategy: env.payload.strategy,
          tokenCount: env.payload.tokensBefore,
          traceId: env.traceId,
        });
        compactionSpans.set(env.payload.sessionId, span);
      });
    }),
  );

  unsubs.push(
    bus.on('COMPACTION_REACTIVE', (env: Env<Extract<CompactionEvent, { type: 'COMPACTION_REACTIVE' }>>) => {
      helpers.safe(() => {
        if (compactionSpans.has(env.payload.sessionId)) return;
        const span = startCompactionSpan(helpers.tracer, {
          sessionId: env.payload.sessionId,
          strategy: 'reactive',
          tokenCount: env.payload.tokenCount,
          limit: env.payload.limit,
          traceId: env.traceId,
        });
        compactionSpans.set(env.payload.sessionId, span);
      });
    }),
  );

  unsubs.push(
    bus.on('COMPACTION_MICROCOMPACT', (env: Env<Extract<CompactionEvent, { type: 'COMPACTION_MICROCOMPACT' }>>) => {
      helpers.safe(() => {
        helpers.withSpan(compactionSpans, env.payload.sessionId, (span) => {
          recordCompactionPhase(span, 'microcompact', {
            'compaction.turn_count': env.payload.turnCount,
            'compaction.tokens_before': env.payload.tokensBefore,
            'compaction.tokens_after': env.payload.tokensAfter,
          });
        });
      });
    }),
  );

  unsubs.push(
    bus.on('COMPACTION_COLLAPSE', (env: Env<Extract<CompactionEvent, { type: 'COMPACTION_COLLAPSE' }>>) => {
      helpers.safe(() => {
        helpers.withSpan(compactionSpans, env.payload.sessionId, (span) => {
          recordCompactionPhase(span, 'collapse', {
            'compaction.message_count': env.payload.messageCount,
            'compaction.tokens_before': env.payload.tokensBefore,
            'compaction.tokens_after': env.payload.tokensAfter,
          });
        });
      });
    }),
  );

  unsubs.push(
    bus.on('COMPACTION_BOUNDARY_COMMIT', (env: Env<Extract<CompactionEvent, { type: 'COMPACTION_BOUNDARY_COMMIT' }>>) => {
      helpers.safe(() => {
        helpers.withSpan(compactionSpans, env.payload.sessionId, (span) => {
          recordCompactionPhase(span, 'boundary_commit', {
            'compaction.checkpoint_id': env.payload.checkpointId,
          });
        });
      });
    }),
  );

  unsubs.push(
    bus.on('COMPACTION_DONE', (env: Env<Extract<CompactionEvent, { type: 'COMPACTION_DONE' }>>) => {
      helpers.safe(() => {
        helpers.closeSpan(compactionSpans, env.payload.sessionId, (span) => {
          endCompactionSpan(span, {
            outcome: 'done',
            tokensBefore: env.payload.tokensBefore,
            tokensAfter: env.payload.tokensAfter,
            durationMs: env.payload.durationMs,
          });
        });
      });
    }),
  );

  unsubs.push(
    bus.on('COMPACTION_FAILED', (env: Env<Extract<CompactionEvent, { type: 'COMPACTION_FAILED' }>>) => {
      helpers.safe(() => {
        helpers.closeSpan(compactionSpans, env.payload.sessionId, (span) => {
          endCompactionSpan(span, {
            outcome: 'failed',
            tokensBefore: 0,
            error: env.payload.error,
          });
        });
      });
    }),
  );

  return () => unsubs.forEach((unsub) => unsub());
}
