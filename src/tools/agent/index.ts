import type { Tool } from '../../types/tools.ts';
import type { ConfigManager } from '../../config/manager.ts';
import { AGENT_TOOL_SCHEMA } from './schema.ts';
import type { AgentInput } from './schema.ts';
import { ArchetypeLoader } from '../../agents/archetypes.ts';
import { AgentMessageBus } from '../../agents/message-bus.ts';
import type { WrfcController } from '../../agents/wrfc-controller.ts';
import { AGENT_TEMPLATES, AgentManager } from './manager.ts';
import { evaluateOrchestrationSpawn } from '../../runtime/orchestration/spawn-policy.ts';
export type { AgentRecord } from './manager.ts';
export { AGENT_TEMPLATES, AgentManager } from './manager.ts';

// ---------------------------------------------------------------------------
// Tool implementation
// ---------------------------------------------------------------------------

function summarizeWrfcEvent(event: Record<string, unknown>) {
  return {
    type: event.type,
    timestamp: event.timestamp,
    status: event.status,
    score: event.score,
    gate: event.gate,
    issueCount: Array.isArray(event.issues) ? event.issues.length : undefined,
  };
}

export function createAgentTool(config: {
  manager: AgentManager;
  messageBus: Pick<AgentMessageBus, 'getMessages' | 'send'>;
  wrfcController?: Pick<WrfcController, 'getWorkmap'>;
  archetypeLoader?: Pick<ArchetypeLoader, 'loadArchetype'>;
  configManager: Pick<ConfigManager, 'get'>;
}): Tool {
  const archetypeLoader = config.archetypeLoader ?? new ArchetypeLoader();
  return {
    definition: AGENT_TOOL_SCHEMA,

    async execute(args: Record<string, unknown>): Promise<{ success: boolean; output?: string; error?: string }> {
    // Validate required fields before casting
    if (!args || typeof args !== 'object') {
      return { success: false, error: 'Invalid args: expected an object' };
    }
    if (!('mode' in args) || typeof (args as Record<string, unknown>).mode !== 'string') {
      return { success: false, error: 'Missing required parameter: mode' };
    }
    const input = args as unknown as AgentInput;

    if (!input.mode) {
      return { success: false, error: 'Missing required parameter: mode' };
    }

    const validModes = ['spawn', 'batch-spawn', 'status', 'cancel', 'list', 'templates', 'get', 'budget', 'plan', 'wait', 'message', 'wrfc-chains', 'wrfc-history', 'cohort-status', 'cohort-report'];
    if (!validModes.includes(input.mode)) {
      return { success: false, error: `Invalid mode: '${input.mode}'. Must be one of: ${validModes.join(', ')}` };
    }

    const manager = config.manager;

    switch (input.mode) {
      case 'spawn': {
        if (!input.task || typeof input.task !== 'string' || input.task.trim() === '') {
          return { success: false, error: 'Missing required parameter for spawn: task' };
        }

        if (input.template && !AGENT_TEMPLATES[input.template]) {
          // Also allow custom archetypes loaded from .goodvibes/agents/*.md
          const customArchetype = archetypeLoader.loadArchetype(input.template);
          if (!customArchetype || customArchetype.isCustom === false) {
            return {
              success: false,
              error: `Unknown template: '${input.template}'. Available: ${Object.keys(AGENT_TEMPLATES).join(', ')}`,
            };
          }
        }

        let record;
        try {
          record = manager.spawn(input);
        } catch (error) {
          return {
            success: false,
            error: error instanceof Error ? error.message : String(error),
          };
        }

        return {
          success: true,
          output: JSON.stringify({
            agentId: record.id,
            status: 'spawned',
            template: record.template,
            task: record.task,
            executionIntent: record.executionIntent ?? null,
            tools: record.tools,
            capabilityCeilingTools: record.capabilityCeilingTools ?? record.tools,
            successCriteria: record.successCriteria ?? [],
            requiredEvidence: record.requiredEvidence ?? [],
            writeScope: record.writeScope ?? [],
            executionProtocol: record.executionProtocol,
            reviewMode: record.reviewMode,
            communicationLane: record.communicationLane,
            knowledgeInjections: record.knowledgeInjections ?? [],
            parentAgentId: record.parentAgentId ?? null,
          }),
        };
      }

      case 'status': {
        if (!input.agentId || typeof input.agentId !== 'string' || input.agentId.trim() === '') {
          return { success: false, error: 'Missing required parameter for status: agentId' };
        }

        const record = manager.getStatus(input.agentId);
        if (!record) {
          return { success: false, error: `Unknown agent: '${input.agentId}'` };
        }

        const duration =
          record.completedAt !== undefined
            ? record.completedAt - record.startedAt
            : Date.now() - record.startedAt;

        return {
          success: true,
          output: JSON.stringify({
            id: record.id,
            task: record.task,
            template: record.template,
            status: record.status,
            durationMs: duration,
            toolCallCount: record.toolCallCount,
            progress: record.progress,
            error: record.error,
          }),
        };
      }

      case 'cancel': {
        if (!input.agentId || typeof input.agentId !== 'string' || input.agentId.trim() === '') {
          return { success: false, error: 'Missing required parameter for cancel: agentId' };
        }

        const cancelled = manager.cancel(input.agentId);
        if (!cancelled) {
          return { success: false, error: `Unknown agent: '${input.agentId}'` };
        }

        const record = manager.getStatus(input.agentId);
        if (!record) {
          return { success: true, output: JSON.stringify({ agentId: input.agentId, status: 'deleted', error: 'Agent was removed after cancel' }) };
        }
        return {
          success: true,
          output: JSON.stringify({ agentId: input.agentId, status: record.status }),
        };
      }

      case 'list': {
        const allRecords = manager.list();
        const records = input.cohort
          ? allRecords.filter(r => r.cohort === input.cohort)
          : allRecords;
        return {
          success: true,
          output: JSON.stringify({
            agents: records.map((r) => ({
              id: r.id,
              task: r.task,
              template: r.template,
              status: r.status,
              startedAt: r.startedAt,
              toolCallCount: r.toolCallCount,
              cohort: r.cohort,
            })),
            count: records.length,
            ...(input.cohort ? { cohort: input.cohort } : {}),
          }),
        };
      }

      case 'templates': {
        return {
          success: true,
          output: JSON.stringify({
            templates: Object.entries(AGENT_TEMPLATES).map(([name, def]) => ({
              name,
              description: def.description,
              defaultTools: def.defaultTools,
            })),
          }),
        };
      }

      case 'get': {
        if (!input.agentId || typeof input.agentId !== 'string' || input.agentId.trim() === '') {
          return { success: false, error: 'Missing required parameter for get: agentId' };
        }

        const record = manager.getStatus(input.agentId);
        if (!record) {
          return { success: false, error: `Unknown agent: '${input.agentId}'` };
        }

        const recentMessages = config.messageBus.getMessages(input.agentId).slice(-10);
        const duration =
          record.completedAt !== undefined
            ? record.completedAt - record.startedAt
            : Date.now() - record.startedAt;
        const detail = input.detail ?? 'full';

        const base = {
          id: record.id,
          task: record.task,
          template: record.template,
          model: record.model,
          provider: record.provider,
          executionIntent: record.executionIntent ?? null,
          status: record.status,
          durationMs: duration,
          toolCallCount: record.toolCallCount,
          progress: record.progress,
          error: record.error,
          executionProtocol: record.executionProtocol,
          reviewMode: record.reviewMode,
          communicationLane: record.communicationLane,
          parentAgentId: record.parentAgentId ?? null,
          orchestrationGraphId: record.orchestrationGraphId ?? null,
          orchestrationNodeId: record.orchestrationNodeId ?? null,
        };

        const contract = {
          tools: record.tools,
          capabilityCeilingTools: record.capabilityCeilingTools ?? record.tools,
          successCriteria: record.successCriteria ?? [],
          requiredEvidence: record.requiredEvidence ?? [],
          writeScope: record.writeScope ?? [],
          knowledgeInjections: record.knowledgeInjections ?? [],
        };

        const messages = {
          recentMessages: recentMessages.map((m) => ({
            from: m.from,
            content: m.content,
            timestamp: m.timestamp,
          })),
        };

        return {
          success: true,
          output: JSON.stringify(detail === 'full'
            ? { ...base, ...contract, ...messages }
            : detail === 'contract'
              ? { ...base, ...contract }
              : detail === 'messages'
                ? { ...base, ...messages }
                : base),
        };
      }

      case 'budget': {
        if (!input.agentId || typeof input.agentId !== 'string' || input.agentId.trim() === '') {
          return { success: false, error: 'Missing required parameter for budget: agentId' };
        }

        const record = manager.getStatus(input.agentId);
        if (!record) {
          return { success: false, error: `Unknown agent: '${input.agentId}'` };
        }

        // Estimate tokens: each tool call involves ~200 input + ~300 output tokens on average.
        // Without a live ConversationManager attached to the agent, this is the best estimate
        // available from the AgentRecord alone.
        const AVG_INPUT_PER_CALL = 200;
        const AVG_OUTPUT_PER_CALL = 300;
        const inputTokens = record.toolCallCount * AVG_INPUT_PER_CALL;
        const outputTokens = record.toolCallCount * AVG_OUTPUT_PER_CALL;

        return {
          success: true,
          output: JSON.stringify({
            agentId: record.id,
            inputTokens,
            outputTokens,
            totalTokens: inputTokens + outputTokens,
            toolCallCount: record.toolCallCount,
            note: 'Estimated from tool call count. Attach a ConversationManager for precise tracking.',
          }),
        };
      }

      case 'plan': {
        if (!input.agentId || typeof input.agentId !== 'string' || input.agentId.trim() === '') {
          return { success: false, error: 'Missing required parameter for plan: agentId' };
        }

        const record = manager.getStatus(input.agentId);
        if (!record) {
          return { success: false, error: `Unknown agent: '${input.agentId}'` };
        }

        const templateDef = AGENT_TEMPLATES[record.template];

        return {
          success: true,
          output: JSON.stringify({
            agentId: record.id,
            task: record.task,
            template: record.template,
            templateDescription: templateDef?.description ?? null,
            tools: record.tools,
            capabilityCeilingTools: record.capabilityCeilingTools ?? record.tools,
            model: record.model ?? null,
            provider: record.provider ?? null,
            successCriteria: record.successCriteria ?? [],
            requiredEvidence: record.requiredEvidence ?? [],
            writeScope: record.writeScope ?? [],
            parentAgentId: record.parentAgentId ?? null,
          }),
        };
      }

      case 'wait': {
        if (!input.agentId || typeof input.agentId !== 'string' || input.agentId.trim() === '') {
          return { success: false, error: 'Missing required parameter for wait: agentId' };
        }

        const record = manager.getStatus(input.agentId);
        if (!record) {
          return { success: false, error: `Unknown agent: '${input.agentId}'` };
        }

        // Non-blocking: return current status immediately if already in a terminal state.
        // For short polls (timeoutMs > 0), wait at most that duration — capped at 5000ms
        // to prevent blocking the main conversation loop.
        const terminalStatuses = new Set(['completed', 'failed', 'cancelled']);

        if (terminalStatuses.has(record.status)) {
          return {
            success: true,
            output: JSON.stringify({
              agentId: input.agentId,
              status: record.status,
              timedOut: false,
            }),
          };
        }

        // If a timeoutMs is requested, poll briefly — capped at 5000ms to avoid
        // blocking the main turn loop (sub-agents use small timeouts anyway).
        const requestedTimeout = typeof input.timeoutMs === 'number' ? input.timeoutMs : 0;
        const MAX_BLOCKING_MS = 5_000;
        const timeoutMs = Math.min(requestedTimeout, MAX_BLOCKING_MS);

        if (timeoutMs > 0) {
          const start = Date.now();
          const pollIntervalMs = 50;
          while (true) {
            const current = manager.getStatus(input.agentId);
            if (!current || terminalStatuses.has(current.status)) break;
            if (Date.now() - start >= timeoutMs) break;
            await new Promise<void>(resolve => setTimeout(resolve, pollIntervalMs));
          }
        }

        const finalRecord = manager.getStatus(input.agentId);
        if (!finalRecord) {
          return { success: true, output: JSON.stringify({ agentId: input.agentId, status: 'deleted', error: 'Agent was removed during wait' }) };
        }
        const finalStatus = finalRecord.status;
        return {
          success: true,
          output: JSON.stringify({
            agentId: input.agentId,
            status: finalStatus,
            timedOut: !terminalStatuses.has(finalStatus),
            hint: terminalStatuses.has(finalStatus) ? undefined : 'Agent still running. Use mode=status to poll again.',
          }),
        };
      }

      case 'message': {
        if (!input.agentId || typeof input.agentId !== 'string' || input.agentId.trim() === '') {
          return { success: false, error: 'Missing required parameter for message: agentId' };
        }
        if (!input.message || typeof input.message !== 'string' || input.message.trim() === '') {
          return { success: false, error: 'message cannot be empty or whitespace only' };
        }

        const record = manager.getStatus(input.agentId);
        if (!record) {
          return { success: false, error: `Unknown agent: '${input.agentId}'` };
        }

        const sent = config.messageBus.send('orchestrator', input.agentId, input.message, {
          kind: input.kind ?? 'directive',
        });
        if (!sent) {
          return {
            success: false,
            error: `Communication to agent '${input.agentId}' was blocked by policy.`,
          };
        }

        return {
          success: true,
          output: JSON.stringify({
            agentId: input.agentId,
            sent: true,
            content: input.message,
            kind: input.kind ?? 'directive',
          }),
        };
      }

      case 'batch-spawn': {
        if (!input.tasks || !Array.isArray(input.tasks) || input.tasks.length === 0) {
          return { success: false, error: 'batch-spawn requires a non-empty tasks array.' };
        }
        if (input.tasks.length > 20) {
          return { success: false, error: 'batch-spawn limited to 20 tasks per batch.' };
        }
        const currentCount = manager.list().filter(a => a.status === 'pending' || a.status === 'running').length;
        const spawnDecision = evaluateOrchestrationSpawn({
          configManager: config.configManager,
          mode: 'manual-batch',
          activeAgents: currentCount,
          requestedDepth: 0,
        });
        if (!spawnDecision.allowed || spawnDecision.availableSlots === 0) {
          return {
            success: false,
            error: spawnDecision.reason ?? `Agent limit reached (${currentCount}/${spawnDecision.maxAgents}). No capacity for batch-spawn.`,
          };
        }
        const tasksToSpawn = input.tasks.slice(0, spawnDecision.availableSlots);
        const skipped = input.tasks.length - tasksToSpawn.length;

        const results: Array<{ id: string; task: string; template: string; cohort?: string }> = [];
        for (const taskDef of tasksToSpawn) {
          if (!taskDef.task || typeof taskDef.task !== 'string' || taskDef.task.trim() === '') {
            return { success: false, error: 'Each task in batch-spawn must have a non-empty task string.' };
          }
          // Validate template if provided
          if (taskDef.template && !AGENT_TEMPLATES[taskDef.template]) {
            const customArchetype = archetypeLoader.loadArchetype(taskDef.template);
            if (!customArchetype || customArchetype.isCustom === false) {
              return {
                success: false,
                error: `Unknown template: '${taskDef.template}'. Available: ${Object.keys(AGENT_TEMPLATES).join(', ')}`,
              };
            }
          }
          const spawnInput: AgentInput = {
            mode: 'spawn',
            task: taskDef.task,
            template: taskDef.template ?? input.template ?? 'general',
            model: taskDef.model ?? input.model,
            provider: taskDef.provider ?? input.provider,
            fallbackModels: taskDef.fallbackModels ?? input.fallbackModels,
            routing: taskDef.routing ?? input.routing,
            reasoningEffort: taskDef.reasoningEffort ?? input.reasoningEffort,
            tools: taskDef.tools ?? input.tools,
            restrictTools: taskDef.restrictTools ?? input.restrictTools,
            context: taskDef.context ?? input.context,
            successCriteria: taskDef.successCriteria ?? input.successCriteria,
            requiredEvidence: taskDef.requiredEvidence ?? input.requiredEvidence,
            writeScope: taskDef.writeScope ?? input.writeScope,
            executionProtocol: taskDef.executionProtocol ?? input.executionProtocol,
            reviewMode: taskDef.reviewMode ?? input.reviewMode,
            communicationLane: taskDef.communicationLane ?? input.communicationLane,
            parentAgentId: taskDef.parentAgentId ?? input.parentAgentId,
            orchestrationGraphId: taskDef.orchestrationGraphId ?? input.orchestrationGraphId,
            orchestrationNodeId: taskDef.orchestrationNodeId,
            parentNodeId: taskDef.parentNodeId ?? input.parentNodeId,
            dangerously_disable_wrfc: taskDef.dangerously_disable_wrfc ?? input.dangerously_disable_wrfc,
            cohort: input.cohort,
          };
          let record;
          try {
            record = manager.spawn(spawnInput);
          } catch (error) {
            return {
              success: false,
              error: error instanceof Error ? error.message : String(error),
            };
          }
          results.push({ id: record.id, task: taskDef.task.slice(0, 80), template: record.template, cohort: record.cohort });
        }
        return {
          success: true,
          output: JSON.stringify({
            agents: results,
            count: results.length,
            cohort: input.cohort,
            skipped,
            maxAgents: spawnDecision.maxAgents,
          }),
        };
      }

      case 'cohort-status': {
        if (!input.cohort) {
          return { success: false, error: 'cohort-status requires a cohort name.' };
        }
        const cohortAgents = manager.listByCohort(input.cohort);
        if (cohortAgents.length === 0) {
          return { success: true, output: `No agents found in cohort '${input.cohort}'.` };
        }
        const summary = cohortAgents.map(a => ({
          id: a.id,
          task: a.task?.slice(0, 80),
          status: a.status,
          template: a.template,
          wrfcId: a.wrfcId,
          toolCallCount: a.toolCallCount,
        }));
        return { success: true, output: JSON.stringify({ cohort: input.cohort, count: cohortAgents.length, agents: summary }) };
      }

      case 'cohort-report': {
        if (!input.cohort) {
          return { success: false, error: 'cohort-report requires a cohort name.' };
        }
        const reportAgents = manager.listByCohort(input.cohort);
        if (reportAgents.length === 0) {
          return { success: true, output: `No agents found in cohort '${input.cohort}'.` };
        }
        const lines: string[] = [
          `## Cohort: ${input.cohort} (${reportAgents.length} agents)`,
          '',
          '| Agent | Task | Status | Template | WRFC | Tool Calls |',
          '|-------|------|--------|----------|------|------------|',
        ];
        for (const a of reportAgents) {
          const taskShort = (a.task ?? '').slice(0, 40).replace(/\|/g, '\\|');
          const wrfcStatus = a.wrfcId ?? 'n/a';
          lines.push(`| ${a.id.slice(-8)} | ${taskShort} | ${a.status} | ${a.template ?? 'general'} | ${wrfcStatus} | ${a.toolCallCount ?? 0} |`);
        }
        return { success: true, output: lines.join('\n') };
      }

      case 'wrfc-chains': {
        try {
          const workmap = config.wrfcController?.getWorkmap();
          if (!workmap) {
            return { success: false, error: 'WRFC controller is not configured in this runtime.' };
          }
          const chains = workmap.listChains();
          const detail = input.detail ?? 'summary';
          return {
            success: true,
            output: JSON.stringify({
              mode: 'wrfc-chains',
              detail,
              count: chains.length,
              chains: detail === 'full'
                ? chains
                : chains.map((chain) => ({
                  wrfcId: chain.wrfcId,
                  status: chain.status,
                  lastScore: chain.lastScore,
                  task: chain.task,
                  events: chain.events,
                })),
            }),
          };
        } catch (err) {
          return { success: false, error: `Failed to list WRFC chains: ${err instanceof Error ? err.message : String(err)}` };
        }
      }

      case 'wrfc-history': {
        if (!input.wrfcId) {
          return { success: false, error: 'wrfc-history requires wrfcId' };
        }
        try {
          const workmap = config.wrfcController?.getWorkmap();
          if (!workmap) {
            return { success: false, error: 'WRFC controller is not configured in this runtime.' };
          }
          const events = workmap.read(input.wrfcId);
          const detail = input.detail ?? 'summary';
          return {
            success: true,
            output: JSON.stringify({
              mode: 'wrfc-history',
              detail,
              wrfcId: input.wrfcId,
              events: detail === 'full'
                ? events
                : events.map((event) => summarizeWrfcEvent(event as unknown as Record<string, unknown>)),
              count: events.length,
            }),
          };
        } catch (err) {
          return { success: false, error: `Failed to get WRFC history: ${err instanceof Error ? err.message : String(err)}` };
        }
      }

      default: {
        return { success: false, error: `Unhandled mode: '${input.mode}'` };
      }
    }
    },
  };
}
