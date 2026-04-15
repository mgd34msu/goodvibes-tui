import type { CommandRegistry } from '../command-registry.ts';
import { classifyIntent } from '@pellux/goodvibes-sdk/platform/core/intent-classifier';
import { requireAdaptivePlanner, requirePlanManager, requireSessionLineageTracker } from './runtime-services.ts';

export function registerPlanningRuntimeCommands(registry: CommandRegistry): void {
  registry.register({
    name: 'plan',
    description: 'Manage execution plans and adaptive execution strategy',
    usage: '[list | show <id> | mode | explain | override <strategy> | status | clear | <task description>]',
    argsHint: '[list|show|mode|explain|override|status|clear|<task>]',
    handler(args, ctx) {
      const planManager = requirePlanManager(ctx);
      const adaptivePlanner = requireAdaptivePlanner(ctx);
      const sessionLineageTracker = requireSessionLineageTracker(ctx);
      const plannerSubs = ['mode', 'explain', 'override', 'status', 'clear'];
      if (args.length > 0 && plannerSubs.includes(args[0].toLowerCase())) {
        const result = ctx.ops.planRuntime
          ? ctx.ops.planRuntime(args[0], args.slice(1))
          : { ok: false, output: 'Plan runtime bridge is not available in this runtime.' };
        ctx.print(result.output);
        return;
      }

      if (args.length === 0) {
        const active = planManager.getActive(ctx.session.runtime.sessionId);
        if (!active) {
          ctx.print('No active plan. Use /plan <task description> to create one.');
          return;
        }
        const summary = planManager.getSummary(active);
        ctx.print(`Active plan: "${active.title}" [${active.status.toUpperCase()}]\n${summary}`);
        return;
      }

      if (args[0] === 'list') {
        const plans = planManager.list();
        if (plans.length === 0) {
          ctx.print('No plans found.');
          return;
        }
        ctx.print(`Plans (${plans.length}):\n${plans.map((plan) => {
          const marker = plan.status === 'active' ? '▶' : ' ';
          return `  ${marker} ${plan.id.slice(0, 8)}  [${plan.status.padEnd(8)}]  ${plan.title}`;
        }).join('\n')}`);
        return;
      }

      if (args[0] === 'show') {
        const id = args[1];
        if (!id) {
          ctx.print('Usage: /plan show <plan-id>');
          return;
        }
        const plans = planManager.list();
        const plan = plans.find((entry) => entry.id === id || entry.id.startsWith(id));
        if (!plan) {
          ctx.print(`Plan not found: ${id}`);
          return;
        }
        ctx.print(planManager.toMarkdown(plan));
        return;
      }

      const taskDescription = args.join(' ');
      const classification = classifyIntent(taskDescription);
      const plan = planManager.create(taskDescription, [], ctx.session.runtime.sessionId);
      plan.awaitingPlan = true;
      planManager.save(plan);
      sessionLineageTracker.setOriginalTask(taskDescription.slice(0, 200));

      ctx.print(
        `Plan created: "${plan.title}" (${plan.id.slice(0, 8)})\n` +
        `Intent: ${classification.intent} (confidence: ${(classification.confidence * 100).toFixed(0)}%)\n` +
        `Signals: ${classification.signals.join(', ') || 'none'}\n` +
        'The model will write the execution plan — agents will be spawned automatically.',
      );

      ctx.session.conversationManager.addSystemMessage(
        `You are creating an execution plan for the following task: "${taskDescription}"\n\n` +
        'Output the plan in EXACTLY this markdown format and nothing else:\n\n' +
        '## Phase 1: [Phase Name] [PENDING]\n' +
        '- [ ] [Task description] — PENDING\n' +
        '- [ ] [Task description] — PENDING (depends: [other task description])\n\n' +
        '## Phase 2: [Phase Name] [PENDING]\n' +
        '- [ ] [Task description] — PENDING (depends: [Phase 1 task description])\n\n' +
        'Rules:\n' +
        '- Each item must be a concrete, independently executable task\n' +
        '- Use (depends: ...) only where execution order truly matters\n' +
        '- Items without dependencies in the same phase can run in parallel\n' +
        '- Keep phases to 2-4 items each, aim for maximum parallelism\n' +
        '- Output ONLY the plan markdown — the system will parse it and spawn agents automatically',
      );

      ctx.activatePlan?.(plan.id, taskDescription);
    },
  });
}
