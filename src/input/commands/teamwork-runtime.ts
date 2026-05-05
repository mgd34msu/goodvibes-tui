import type { CommandRegistry, CommandContext } from '../command-registry.ts';
import { join } from 'node:path';
import { AGENT_TEMPLATES } from '@pellux/goodvibes-sdk/platform/tools';
import { ArchetypeLoader, type AgentArchetype } from '@pellux/goodvibes-sdk/platform/agents';
import { requireOpsApi, requireReadModels, requireShellPaths } from './runtime-services.ts';
import { summarizeError } from '@pellux/goodvibes-sdk/platform/utils';

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

interface ResolvedArchetypeMode {
  readonly id: string;
  readonly label: string;
  readonly owner: string;
  readonly taskKind: 'agent' | 'exec' | 'acp' | 'integration';
  readonly template?: string;
  readonly reviewMode: 'none' | 'wrfc';
  readonly executionProtocol: 'direct' | 'gather-plan-apply';
  readonly source: 'builtin' | 'custom';
  readonly family: 'implement' | 'review' | 'test' | 'research' | 'general';
  readonly sourcePath?: string;
  readonly validationIssues: readonly string[];
  readonly tools: readonly string[];
}

interface TeamworkReviewSnapshot {
  readonly builtinArchetypes: number;
  readonly customArchetypes: number;
  readonly archetypesWithIssues: number;
  readonly implementArchetypes: number;
  readonly reviewArchetypes: number;
  readonly researchArchetypes: number;
  readonly activeTaskCount: number;
  readonly blockedTaskCount: number;
  readonly reviewTaskCount: number;
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

function classifyArchetype(archetype: AgentArchetype): ResolvedArchetypeMode['family'] {
  const haystack = `${archetype.name} ${archetype.description}`.toLowerCase();
  const tools = new Set(archetype.tools.map((tool) => tool.toLowerCase()));
  if (haystack.includes('review') || haystack.includes('audit')) return 'review';
  if (haystack.includes('test') || tools.has('exec') && tools.has('write') && !tools.has('edit')) return 'test';
  if (haystack.includes('research') || haystack.includes('analysis') || (tools.has('find') && tools.has('analyze') && !tools.has('write') && !tools.has('edit'))) return 'research';
  if (tools.has('write') || tools.has('edit')) return 'implement';
  return 'general';
}

function buildArchetypeMode(archetype: AgentArchetype): ResolvedArchetypeMode {
  const family = classifyArchetype(archetype);
  const source = archetype.isCustom ? 'custom' : 'builtin';
  return {
    id: archetype.name,
    label: archetype.description || `${archetype.name} archetype`,
    owner: source === 'custom' ? `custom:${archetype.name}` : archetype.name,
    taskKind: 'agent',
    template: archetype.name,
    reviewMode: family === 'review' ? 'wrfc' : 'none',
    executionProtocol: family === 'research' ? 'gather-plan-apply' : family === 'implement' ? 'gather-plan-apply' : 'direct',
    source,
    family,
    sourcePath: archetype.sourcePath,
    validationIssues: archetype.validationIssues ?? [],
    tools: archetype.tools,
  };
}

function listArchetypeModes(projectRoot: string): ResolvedArchetypeMode[] {
  const loader = new ArchetypeLoader(join(projectRoot, '.goodvibes', 'agents'));
  return loader.listArchetypes()
    .map(buildArchetypeMode)
    .sort((a, b) => a.id.localeCompare(b.id));
}

function buildTeamworkReviewSnapshot(ctx: CommandContext): TeamworkReviewSnapshot {
  const projectRoot = requireShellPaths(ctx).workingDirectory;
  const archetypes = listArchetypeModes(projectRoot);
  const tasks = [...requireReadModels(ctx).tasks.getSnapshot().tasks];
  return {
    builtinArchetypes: archetypes.filter((entry) => entry.source === 'builtin').length,
    customArchetypes: archetypes.filter((entry) => entry.source === 'custom').length,
    archetypesWithIssues: archetypes.filter((entry) => entry.validationIssues.length > 0).length,
    implementArchetypes: archetypes.filter((entry) => entry.family === 'implement').length,
    reviewArchetypes: archetypes.filter((entry) => entry.family === 'review').length,
    researchArchetypes: archetypes.filter((entry) => entry.family === 'research').length,
    activeTaskCount: tasks.filter((task) => task.status === 'running' || task.status === 'queued').length,
    blockedTaskCount: tasks.filter((task) => task.status === 'blocked').length,
    reviewTaskCount: tasks.filter((task) => task.owner === 'review' || task.owner === 'verifier').length,
  };
}

function createModeTask(mode: TeamworkMode, title: string, ctx: CommandContext): string {
  const task = requireOpsApi(ctx).tasks.create({
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

function createResolvedModeTask(mode: ResolvedArchetypeMode, title: string, ctx: CommandContext): string {
  const task = requireOpsApi(ctx).tasks.create({
    kind: mode.taskKind,
    owner: mode.owner,
    title,
    description: JSON.stringify({
      title,
      mode: mode.id,
      template: mode.template,
      reviewMode: mode.reviewMode,
      executionProtocol: mode.executionProtocol,
      source: mode.source,
      family: mode.family,
    }),
  });
  return task.id;
}

export function registerTeamworkRuntimeCommands(registry: CommandRegistry): void {
  registry.register({
    name: 'teamwork',
    aliases: ['teammates'],
    description: 'Packaged task modes, teammate templates, and orchestration recipes',
    usage: '[review|modes|mode <id>|create-mode <id> <title...>|recipes|recipe <id>|templates|archetypes|validate|archetype <name>|create-archetype <name> <title...>]',
    handler(args, ctx) {
      const sub = args[0]?.toLowerCase() ?? 'review';

      if (sub === 'review') {
        const snapshot = buildTeamworkReviewSnapshot(ctx);
        ctx.print([
          'Teamwork Review',
          `  modes: ${TEAMWORK_MODES.length}`,
          `  recipes: ${TEAMWORK_RECIPES.length}`,
          `  builtin archetypes: ${snapshot.builtinArchetypes}`,
          `  custom archetypes: ${snapshot.customArchetypes}`,
          `  archetypes with issues: ${snapshot.archetypesWithIssues}`,
          `  implement/review/research: ${snapshot.implementArchetypes}/${snapshot.reviewArchetypes}/${snapshot.researchArchetypes}`,
          `  active tasks: ${snapshot.activeTaskCount}`,
          `  blocked tasks: ${snapshot.blockedTaskCount}`,
          `  review tasks: ${snapshot.reviewTaskCount}`,
          '  next: /teamwork archetypes',
          '  next: /teamwork validate',
          '  next: /tasks',
        ].join('\n'));
        return;
      }

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
          ctx.print(String(summarizeError(error) ?? error));
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
        const archetypes = listArchetypeModes(requireShellPaths(ctx).workingDirectory);
        ctx.print([
          'Teamwork Templates',
          ...Object.entries(AGENT_TEMPLATES).map(([name, template]) => (
            `  ${name.padEnd(12)} ${template.description}`
          )),
          '',
          'Discovered Archetypes',
          ...archetypes.map((entry) => `  ${entry.id.padEnd(12)} ${entry.family.padEnd(10)} ${entry.source.padEnd(7)} ${entry.label}`),
        ].join('\n'));
        return;
      }

      if (sub === 'archetypes') {
        const archetypes = listArchetypeModes(requireShellPaths(ctx).workingDirectory);
        ctx.print([
          'Teamwork Archetypes',
          ...archetypes.map((entry) => `  ${entry.id.padEnd(18)} ${entry.family.padEnd(10)} ${entry.source.padEnd(7)} ${entry.reviewMode.padEnd(4)} ${entry.executionProtocol}${entry.validationIssues.length > 0 ? '  issues' : ''}`),
        ].join('\n'));
        return;
      }

      if (sub === 'validate') {
        const archetypes = listArchetypeModes(requireShellPaths(ctx).workingDirectory);
        const invalid = archetypes.filter((entry) => entry.validationIssues.length > 0);
        ctx.print(invalid.length > 0
          ? [
              'Teamwork Archetype Validation',
              ...invalid.flatMap((entry) => [
                `  ${entry.id} (${entry.source})`,
                ...entry.validationIssues.map((issue) => `    issue: ${issue}`),
              ]),
            ].join('\n')
          : 'Teamwork Archetype Validation\n  All discovered archetypes are currently valid.');
        return;
      }

      if (sub === 'archetype') {
        const archetypeName = args[1];
        if (!archetypeName) {
          ctx.print('Usage: /teamwork archetype <name>');
          return;
        }
        const mode = listArchetypeModes(requireShellPaths(ctx).workingDirectory).find((entry) => entry.id === archetypeName);
        if (!mode) {
          ctx.print(`Unknown archetype: ${archetypeName}`);
          return;
        }
        ctx.print([
          `Teamwork Archetype ${mode.id}`,
          `  label: ${mode.label}`,
          `  family: ${mode.family}`,
          `  source: ${mode.source}`,
          `  owner: ${mode.owner}`,
          `  reviewMode: ${mode.reviewMode}`,
          `  executionProtocol: ${mode.executionProtocol}`,
          `  tools: ${mode.tools.join(', ') || '(none)'}`,
          `  sourcePath: ${mode.sourcePath ?? '(builtin)'}`,
          ...(mode.validationIssues.length > 0
            ? mode.validationIssues.map((issue) => `  issue: ${issue}`)
            : ['  validation: clean']),
        ].join('\n'));
        return;
      }

      if (sub === 'create-archetype') {
        const archetypeName = args[1];
        const title = args.slice(2).join(' ').trim();
        if (!archetypeName || !title) {
          ctx.print('Usage: /teamwork create-archetype <name> <title...>');
          return;
        }
        const mode = listArchetypeModes(requireShellPaths(ctx).workingDirectory).find((entry) => entry.id === archetypeName);
        if (!mode) {
          ctx.print(`Unknown archetype: ${archetypeName}`);
          return;
        }
        try {
          const taskId = createResolvedModeTask(mode, title, ctx);
          ctx.print(`Created teamwork task ${taskId} using archetype ${mode.id}.`);
        } catch (error) {
          ctx.print(String(summarizeError(error) ?? error));
        }
        return;
      }

      ctx.print('Usage: /teamwork [review|modes|mode <id>|create-mode <id> <title...>|recipes|recipe <id>|templates|archetypes|validate|archetype <name>|create-archetype <name> <title...>]');
    },
  });
}
