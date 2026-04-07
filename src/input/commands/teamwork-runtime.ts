import type { CommandRegistry, CommandContext } from '../command-registry.ts';
import { AGENT_TEMPLATES } from '../../tools/agent/manager.ts';

type TeamworkModeId =
  | 'local-engineer'
  | 'local-shell'
  | 'remote-engineer'
  | 'teammate'
  | 'research'
  | 'dream'
  | 'review'
  | 'verifier'
  | 'integration';

interface TeamworkMode {
  readonly id: TeamworkModeId;
  readonly label: string;
  readonly taskKind: 'agent' | 'exec' | 'acp' | 'integration';
  readonly owner: string;
  readonly template?: keyof typeof AGENT_TEMPLATES;
  readonly reviewMode: 'none' | 'wrfc';
  readonly executionProtocol: 'direct' | 'gather-plan-apply';
}

interface TeamworkRecipe {
  readonly id: string;
  readonly summary: string;
  readonly steps: readonly string[];
}

const TEAMWORK_MODES: readonly TeamworkMode[] = [
  { id: 'local-engineer', label: 'Local engineer task', taskKind: 'agent', owner: 'local-engineer', template: 'engineer', reviewMode: 'wrfc', executionProtocol: 'gather-plan-apply' },
  { id: 'local-shell', label: 'Local shell task', taskKind: 'exec', owner: 'local-shell', reviewMode: 'none', executionProtocol: 'direct' },
  { id: 'remote-engineer', label: 'Remote engineer task', taskKind: 'acp', owner: 'remote-engineer', template: 'engineer', reviewMode: 'wrfc', executionProtocol: 'gather-plan-apply' },
  { id: 'teammate', label: 'In-process teammate task', taskKind: 'agent', owner: 'teammate', template: 'general', reviewMode: 'wrfc', executionProtocol: 'gather-plan-apply' },
  { id: 'research', label: 'Research task', taskKind: 'agent', owner: 'research', template: 'researcher', reviewMode: 'none', executionProtocol: 'gather-plan-apply' },
  { id: 'dream', label: 'Speculative dream task', taskKind: 'agent', owner: 'dream', template: 'researcher', reviewMode: 'none', executionProtocol: 'gather-plan-apply' },
  { id: 'review', label: 'Review-only task', taskKind: 'agent', owner: 'review', template: 'reviewer', reviewMode: 'wrfc', executionProtocol: 'gather-plan-apply' },
  { id: 'verifier', label: 'Verifier task', taskKind: 'agent', owner: 'verifier', template: 'reviewer', reviewMode: 'wrfc', executionProtocol: 'gather-plan-apply' },
  { id: 'integration', label: 'Integration task', taskKind: 'integration', owner: 'integration', template: 'engineer', reviewMode: 'wrfc', executionProtocol: 'gather-plan-apply' },
];

const TEAMWORK_RECIPES: readonly TeamworkRecipe[] = [
  {
    id: 'research-implement-review',
    summary: 'Research first, implement second, certify with WRFC review.',
    steps: ['research', 'local-engineer', 'review', 'verifier'],
  },
  {
    id: 'remote-certification',
    summary: 'Remote engineer execution with local review and integration.',
    steps: ['remote-engineer', 'review', 'integration'],
  },
  {
    id: 'triage-delegate-integrate',
    summary: 'Triage locally, delegate focused teammate work, then integrate.',
    steps: ['teammate', 'review', 'integration'],
  },
  {
    id: 'dream-then-certify',
    summary: 'Run a speculative research pass, then ground it through engineer, review, and verifier steps.',
    steps: ['dream', 'local-engineer', 'review', 'verifier'],
  },
];

function formatMode(mode: TeamworkMode): string {
  return `  ${mode.id.padEnd(18)} ${mode.taskKind.padEnd(11)} ${mode.owner.padEnd(16)} ${mode.reviewMode.padEnd(4)} ${mode.executionProtocol}${mode.template ? `  template=${mode.template}` : ''}`;
}

function createModeTask(mode: TeamworkMode, title: string, ctx: CommandContext): string {
  if (!ctx.taskManager) {
    throw new Error('Task manager is not available for teamwork task creation in this runtime.');
  }
  const task = ctx.taskManager.createTask({
    kind: mode.taskKind,
    owner: mode.owner,
    title,
    description: JSON.stringify({
      title,
      mode: mode.id,
      template: mode.template,
      reviewMode: mode.reviewMode,
      executionProtocol: mode.executionProtocol,
    }),
  });
  return task.id;
}

export function registerTeamworkRuntimeCommands(registry: CommandRegistry): void {
  registry.register({
    name: 'teamwork',
    aliases: ['teammates'],
    description: 'Packaged task modes, teammate templates, and orchestration recipes',
    usage: '[modes|mode <id>|create-mode <id> <title...>|recipes|recipe <id>|templates]',
    handler(args, ctx) {
      const sub = args[0]?.toLowerCase() ?? 'modes';

      if (sub === 'modes') {
        ctx.print([
          'Teamwork Modes',
          ...TEAMWORK_MODES.map(formatMode),
        ].join('\n'));
        return;
      }

      if (sub === 'mode') {
        const modeId = args[1] as TeamworkModeId | undefined;
        const mode = TEAMWORK_MODES.find((entry) => entry.id === modeId);
        if (!mode) {
          ctx.print('Usage: /teamwork mode <local-engineer|local-shell|remote-engineer|teammate|research|dream|review|verifier|integration>');
          return;
        }
        ctx.print([
          `Teamwork Mode ${mode.id}`,
          `  label: ${mode.label}`,
          `  taskKind: ${mode.taskKind}`,
          `  owner: ${mode.owner}`,
          `  template: ${mode.template ?? '(none)'}`,
          `  reviewMode: ${mode.reviewMode}`,
          `  executionProtocol: ${mode.executionProtocol}`,
        ].join('\n'));
        return;
      }

      if (sub === 'create-mode') {
        const modeId = args[1] as TeamworkModeId | undefined;
        const title = args.slice(2).join(' ').trim();
        const mode = TEAMWORK_MODES.find((entry) => entry.id === modeId);
        if (!mode || !title) {
          ctx.print('Usage: /teamwork create-mode <local-engineer|local-shell|remote-engineer|teammate|research|dream|review|verifier|integration> <title...>');
          return;
        }
        try {
          const taskId = createModeTask(mode, title, ctx);
          ctx.print(`Created teamwork task ${taskId} using mode ${mode.id}.`);
        } catch (error) {
          ctx.print(String((error as Error).message ?? error));
        }
        return;
      }

      if (sub === 'recipes') {
        ctx.print([
          'Teamwork Recipes',
          ...TEAMWORK_RECIPES.map((recipe) => `  ${recipe.id.padEnd(26)} ${recipe.summary}`),
        ].join('\n'));
        return;
      }

      if (sub === 'recipe') {
        const recipeId = args[1];
        const recipe = TEAMWORK_RECIPES.find((entry) => entry.id === recipeId);
        if (!recipe) {
          ctx.print('Usage: /teamwork recipe <id>');
          return;
        }
        ctx.print([
          `Teamwork Recipe ${recipe.id}`,
          `  summary: ${recipe.summary}`,
          `  steps: ${recipe.steps.join(' -> ')}`,
        ].join('\n'));
        return;
      }

      if (sub === 'templates') {
        ctx.print([
          'Teamwork Templates',
          ...Object.entries(AGENT_TEMPLATES).map(([name, template]) => (
            `  ${name.padEnd(12)} ${template.description}`
          )),
        ].join('\n'));
        return;
      }

      ctx.print('Usage: /teamwork [modes|mode <id>|create-mode <id> <title...>|recipes|recipe <id>|templates]');
    },
  });
}
