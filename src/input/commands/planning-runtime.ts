import type { CommandRegistry } from '../command-registry.ts';
import { requirePlanManager, requireSessionLineageTracker } from './runtime-services.ts';

export function registerPlanningRuntimeCommands(registry: CommandRegistry): void {
  registry.register({
    name: 'plan',
    description: 'Inspect or seed TUI-owned project planning state',
    usage: '[panel | approve | list | show <id> | mode | explain | override <strategy> | status | clear | <planning goal>]',
    argsHint: '[panel|approve|status|<goal>]',
    async handler(args, ctx) {
      const planManager = requirePlanManager(ctx);
      const sessionLineageTracker = requireSessionLineageTracker(ctx);
      const plannerSubs = ['mode', 'explain', 'override', 'status', 'clear'];
      if (args.length > 0 && plannerSubs.includes(args[0].toLowerCase())) {
        const result = ctx.ops.planRuntime
          ? ctx.ops.planRuntime(args[0], args.slice(1))
          : { ok: false, output: 'Plan runtime bridge is not available in this runtime.' };
        ctx.print(result.output);
        return;
      }

      const projectPlanningService = ctx.workspace.projectPlanningService;
      const projectId = ctx.workspace.projectPlanningProjectId;
      const openProjectPlanningPanel = () => ctx.showPanel?.('project-planning');

      if (args.length === 0) {
        if (projectPlanningService && projectId) {
          const [status, evaluation] = await Promise.all([
            projectPlanningService.status({ projectId }),
            projectPlanningService.evaluate({ projectId }),
          ]);
          openProjectPlanningPanel();
          ctx.print(
            `Project planning: ${evaluation.readiness}\n` +
            `Project: ${status.projectId}\n` +
            `Knowledge space: ${status.knowledgeSpaceId}\n` +
            `Artifacts: ${status.counts.states} state, ${status.counts.decisions} decisions, ${status.counts.languageArtifacts} language\n` +
            (evaluation.nextQuestion ? `Next question: ${evaluation.nextQuestion.prompt}` : 'No next question recorded.'),
          );
          return;
        }
        const active = planManager.getActive(ctx.session.runtime.sessionId);
        if (!active) {
          ctx.print('No active execution plan.');
          return;
        }
        const summary = planManager.getSummary(active);
        ctx.print(`Active plan: "${active.title}" [${active.status.toUpperCase()}]\n${summary}`);
        return;
      }

      if (args[0] === 'panel') {
        openProjectPlanningPanel();
        ctx.print('Opened project planning panel.');
        return;
      }

      if (args[0] === 'approve') {
        if (!projectPlanningService || !projectId) {
          ctx.print('Project planning service is not available in this runtime.');
          return;
        }
        const current = await projectPlanningService.getState({ projectId });
        if (!current.state) {
          ctx.print('No project planning state exists to approve.');
          return;
        }
        const result = await projectPlanningService.upsertState({
          projectId,
          state: {
            ...current.state,
            executionApproved: true,
            metadata: {
              ...(current.state.metadata ?? {}),
              approvedFrom: 'plan-command',
              approvedAt: Date.now(),
            },
          },
        });
        const evaluation = await projectPlanningService.evaluate({ projectId });
        openProjectPlanningPanel();
        ctx.print(`Project planning approved. Readiness: ${evaluation.readiness}. State: ${result.state?.id ?? 'current'}.`);
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
      if (!projectPlanningService || !projectId) {
        ctx.print('Project planning service is not available in this runtime.');
        return;
      }
      const result = await projectPlanningService.upsertState({
        projectId,
        state: {
          goal: taskDescription,
          knownContext: [
            `Workspace planning was seeded from the TUI /plan command.`,
          ],
          metadata: {
            active: true,
            owner: 'tui',
            source: 'plan-command',
            lastPromptAt: Date.now(),
          },
        },
      });
      const evaluation = await projectPlanningService.evaluate({ projectId });
      sessionLineageTracker.setOriginalTask(taskDescription.slice(0, 200));
      openProjectPlanningPanel();

      ctx.print(
        `Project planning seeded: "${result.state?.goal ?? taskDescription}"\n` +
        `Readiness: ${evaluation.readiness}\n` +
        (evaluation.nextQuestion ? `Next question: ${evaluation.nextQuestion.prompt}` : 'No next question recorded.'),
      );
    },
  });
}
