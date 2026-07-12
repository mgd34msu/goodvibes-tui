import type {
  ProjectPlanningEvaluation,
  ProjectPlanningQuestion,
  ProjectPlanningService,
  ProjectPlanningState,
} from '@pellux/goodvibes-sdk/platform/knowledge';
import type { CommandRegistry } from '../command-registry.ts';
import { openModalCommand, requirePlanManager, requireSessionLineageTracker } from './runtime-services.ts';
import { togglePlanMode, permissionModeLabel, type PermissionModeValue } from '../../core/permission-mode.ts';

/**
 * Single-token verbs that look like a `/plan` subcommand but are not real ones.
 * A lone one of these is refused rather than seeded as a goal, so a stray verb
 * can never overwrite the project goal with itself.
 *
 * `dismiss` and `answer` are now REAL subcommands (handled above this
 * guard), so they were removed from the refuse-list. `pause`/`stop`/`cancel`
 * remain here — they still have no backing verb and must not seed a goal.
 */
const PSEUDO_SUBCOMMAND_VERBS = new Set(['pause', 'stop', 'cancel']);

function recordNextQuestion(
  state: Partial<ProjectPlanningState>,
  question: ProjectPlanningQuestion | undefined,
): Partial<ProjectPlanningState> {
  if (!question) return state;
  const answered = new Set((state.answeredQuestions ?? []).map((entry) => entry.id));
  if (answered.has(question.id)) return state;
  const openQuestions = [...(state.openQuestions ?? [])];
  const existingIndex = openQuestions.findIndex((entry) => entry.id === question.id);
  const normalized = { ...question, status: question.status ?? 'open' } satisfies ProjectPlanningQuestion;
  if (existingIndex >= 0) openQuestions[existingIndex] = normalized;
  else openQuestions.unshift(normalized);
  return { ...state, openQuestions };
}

async function persistEvaluatedNextQuestion(
  service: ProjectPlanningService,
  projectId: string,
  state: ProjectPlanningState,
  evaluation: ProjectPlanningEvaluation,
): Promise<{ state: ProjectPlanningState; evaluation: ProjectPlanningEvaluation }> {
  if (!evaluation.nextQuestion) return { state, evaluation };
  if (state.openQuestions.some((question) => question.id === evaluation.nextQuestion?.id)) {
    return { state, evaluation };
  }
  const withQuestion = recordNextQuestion(evaluation.state ?? state, evaluation.nextQuestion);
  const saved = await service.upsertState({ projectId, state: withQuestion });
  const nextState = saved.state ?? state;
  const nextEvaluation = await service.evaluate({ projectId, state: nextState });
  return { state: nextState, evaluation: nextEvaluation };
}

function formatNextQuestion(question: ProjectPlanningQuestion | undefined): string {
  if (!question) return 'No next question recorded.';
  const lines = [`Next question: ${question.prompt}`];
  if (question.recommendedAnswer) lines.push(`Recommended answer: ${question.recommendedAnswer}`);
  lines.push('Answer in the prompt, or open the Planning modal to choose/type an answer.');
  return lines.join('\n');
}

export function registerPlanningRuntimeCommands(registry: CommandRegistry): void {
  registry.register({
    name: 'project-plan',
    aliases: ['planning'],
    description: 'Inspect or seed TUI-owned project planning state',
    usage: '[panel | approve | dismiss | answer <n> <text> | list | show <id> | mode | explain | override <strategy> | status | clear | <planning goal>]',
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
      const openProjectPlanningPanel = () => openModalCommand(ctx, 'planning-modal');

      if (args.length === 0) {
        if (projectPlanningService && projectId) {
          const [status, stateResult] = await Promise.all([
            projectPlanningService.status({ projectId }),
            projectPlanningService.getState({ projectId }),
          ]);
          const initialEvaluation = await projectPlanningService.evaluate({
            projectId,
            ...(stateResult.state ? { state: stateResult.state } : {}),
          });
          const { evaluation } = stateResult.state
            ? await persistEvaluatedNextQuestion(projectPlanningService, projectId, stateResult.state, initialEvaluation)
            : { evaluation: initialEvaluation };
          openProjectPlanningPanel();
          ctx.print(
            `Project planning: ${evaluation.readiness}\n` +
            `Project: ${status.projectId}\n` +
            `Knowledge space: ${status.knowledgeSpaceId}\n` +
            `Artifacts: ${status.counts.states} state, ${status.counts.decisions} decisions, ${status.counts.languageArtifacts} language\n` +
            formatNextQuestion(evaluation.nextQuestion),
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

      // /plan dismiss — archive the current plan. Dismisses the active
      // execution plan (ExecutionPlanManager.dismiss, honest per-state) AND
      // deactivates the project-planning interview state shown in the modal so a
      // later /plan <goal> starts fresh. Mid-execution is refused outright.
      if (args[0] === 'dismiss') {
        const dismissal = planManager.dismiss(ctx.session.runtime.sessionId);
        if (dismissal.outcome === 'requires-cancel') {
          ctx.print(
            `Plan "${dismissal.blockedBy?.title ?? 'active plan'}" is mid-execution and was not dismissed. ` +
            `Run /workstream cancel to stop it first, then /plan dismiss.`,
          );
          return;
        }
        let planningNote = '';
        if (projectPlanningService && projectId) {
          const current = await projectPlanningService.getState({ projectId });
          if (current.state && current.state.metadata?.['active'] === true) {
            await projectPlanningService.upsertState({
              projectId,
              state: {
                ...current.state,
                metadata: {
                  ...(current.state.metadata ?? {}),
                  active: false,
                  dismissedAt: Date.now(),
                  dismissedFrom: 'plan-command',
                },
              },
            });
            planningNote = ' Project planning interview marked inactive.';
          }
        }
        if (dismissal.outcome === 'dismissed') {
          ctx.print(
            `Dismissed plan "${dismissal.plan?.title ?? 'active plan'}" ` +
            `(archived as dismissed; retained in /plan list; /plan <goal> starts fresh).${planningNote}`,
          );
        } else if (planningNote) {
          ctx.print(`No active execution plan to dismiss.${planningNote}`);
        } else {
          ctx.print('No active plan or planning state to dismiss.');
        }
        return;
      }

      // /plan answer <n|question-id> <text> — record a real answer to an
      // open planning question (moves open → answered, consumed on next refine).
      if (args[0] === 'answer') {
        if (!projectPlanningService || !projectId) {
          ctx.print('Project planning service is not available in this runtime.');
          return;
        }
        const ref = args[1];
        const answerText = args.slice(2).join(' ').trim();
        if (!ref || !answerText) {
          ctx.print('Usage: /plan answer <question-number|question-id> <your answer>');
          return;
        }
        const asNum = Number(ref);
        const selector = Number.isInteger(asNum) && asNum >= 1
          ? { questionIndex: asNum - 1 }
          : { questionId: ref };
        const answerResult = await projectPlanningService.answerQuestion({ projectId, ...selector, answer: answerText });
        if (!answerResult.answered) {
          if (answerResult.reason === 'no-state') {
            ctx.print('No project planning state exists yet. Seed it with /plan <goal>.');
          } else if (answerResult.reason === 'question-not-found') {
            const open = answerResult.openQuestions;
            const listing = open.length > 0
              ? open.map((question, index) => `  ${index + 1}. ${question.prompt} (${question.id})`).join('\n')
              : '  (no open questions)';
            ctx.print(`No open question matched "${ref}". Open questions:\n${listing}`);
          } else {
            ctx.print('Usage: /plan answer <question-number|question-id> <your answer>');
          }
          return;
        }
        openProjectPlanningPanel();
        ctx.print(
          `Recorded answer to: ${answerResult.question?.prompt ?? 'question'}\n` +
          `Readiness: ${answerResult.evaluation.readiness}\n` +
          formatNextQuestion(answerResult.evaluation.nextQuestion),
        );
        return;
      }

      // Defense (review finding): a single verb-looking token is almost never a
      // real planning goal — it is a mistyped or removed subcommand. The
      // Planning modal used to dispatch `/plan dismiss`, which has no
      // subcommand and silently fell through to this free-form branch, seeding
      // the goal with the literal "dismiss". Refuse to seed on a lone
      // known-or-formerly-planned verb and point at the real usage instead of
      // corrupting the goal.
      if (args.length === 1 && PSEUDO_SUBCOMMAND_VERBS.has(args[0].toLowerCase())) {
        ctx.print(
          `Unknown /plan subcommand "${args[0]}" — did you mean panel, approve, list, show, or status? ` +
          `To seed a planning goal, use /plan <a real sentence describing the change>.`,
        );
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
      const initialEvaluation = await projectPlanningService.evaluate({
        projectId,
        ...(result.state ? { state: result.state } : {}),
      });
      const { state, evaluation } = result.state
        ? await persistEvaluatedNextQuestion(projectPlanningService, projectId, result.state, initialEvaluation)
        : { state: result.state, evaluation: initialEvaluation };
      sessionLineageTracker.setOriginalTask(taskDescription.slice(0, 200));
      openProjectPlanningPanel();

      ctx.print(
        `Project planning seeded: "${state?.goal ?? taskDescription}"\n` +
        `Readiness: ${evaluation.readiness}\n` +
        formatNextQuestion(evaluation.nextQuestion),
      );
    },
  });

  // /plan now enters/toggles the SESSION PERMISSION plan mode (read-only
  // planning posture) — distinct from the project-planning manager above, which
  // moved to /project-plan (alias /planning). The change goes through the SDK
  // config surface (permissions.mode), the same value the PermissionManager
  // reads and Shift+Tab cycles, so plan mode is one concept across surfaces.
  registry.register({
    name: 'plan',
    description: 'Enter or exit plan mode — a read-only planning posture where writes, commands, and network calls are blocked',
    usage: '[on | off | toggle]',
    argsHint: '[on|off]',
    handler(args, ctx) {
      const configManager = ctx.platform.configManager;
      const current = configManager.get('permissions.mode') as PermissionModeValue | undefined;
      const sub = (args[0] ?? 'toggle').toLowerCase();
      const next: PermissionModeValue =
        sub === 'on' || sub === 'enter' ? 'plan'
        : sub === 'off' || sub === 'exit' ? 'prompt'
        : togglePlanMode(current);
      configManager.set('permissions.mode', next);
      ctx.print(next === 'plan'
        ? '[Permissions] Plan mode ON — read-only: writes, commands, and network calls are blocked until you exit (/plan off or Shift+Tab).'
        : `[Permissions] Plan mode OFF — mode: ${permissionModeLabel(next)}.`);
    },
  });
}
