import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Tool } from '../../types/tools.ts';
import { TEAM_TOOL_SCHEMA, type TeamToolInput } from './schema.ts';

interface TeamMember {
  readonly id: string;
  readonly role: string;
  readonly lanes: readonly string[];
}

interface TeamRecord {
  readonly id: string;
  readonly name: string;
  readonly summary: string;
  readonly members: readonly TeamMember[];
  readonly createdAt: number;
  readonly updatedAt: number;
}

interface TeamFile {
  readonly version: 1;
  readonly teams: readonly TeamRecord[];
}

type TeamExecutionInput = TeamToolInput & {
  readonly storageRoot?: string;
};

function summarizeTeam(team: TeamRecord) {
  return {
    id: team.id,
    name: team.name,
    summary: team.summary,
    memberCount: team.members.length,
    lanes: Array.from(new Set(team.members.flatMap((member) => member.lanes))).sort(),
    createdAt: team.createdAt,
    updatedAt: team.updatedAt,
  };
}

function teamsPath(storageRoot: string): string {
  return join(storageRoot, '.goodvibes', 'tui', 'teams.json');
}

function loadTeams(storageRoot: string): TeamRecord[] {
  const path = teamsPath(storageRoot);
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as TeamFile;
    return parsed?.version === 1 && Array.isArray(parsed.teams) ? [...parsed.teams] : [];
  } catch {
    return [];
  }
}

function saveTeams(storageRoot: string, teams: readonly TeamRecord[]): void {
  const path = teamsPath(storageRoot);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ version: 1, teams }, null, 2) + '\n', 'utf-8');
}

export const teamTool: Tool = {
  definition: {
    name: 'team',
    description: 'Manage durable team definitions, roles, and communication lanes.',
    parameters: TEAM_TOOL_SCHEMA as unknown as Record<string, unknown>,
    sideEffects: ['workflow', 'state'],
    concurrency: 'serial',
  },

  async execute(args: Record<string, unknown>) {
    if (!args || typeof args !== 'object' || typeof args.mode !== 'string') {
      return { success: false, error: 'Invalid args: mode is required.' };
    }
    const input = args as TeamExecutionInput;
    if (!input.storageRoot || input.storageRoot.trim().length === 0) {
      return { success: false, error: 'team requires storageRoot.' };
    }
    const teams = loadTeams(input.storageRoot);
    const view = input.view ?? 'summary';

    if (input.mode === 'create') {
      if (!input.teamId || !input.name || !input.summary) {
        return { success: false, error: 'create requires teamId, name, and summary.' };
      }
      if (teams.some((team) => team.id === input.teamId)) {
        return { success: false, error: `Team already exists: ${input.teamId}` };
      }
      const now = Date.now();
      const team: TeamRecord = {
        id: input.teamId,
        name: input.name,
        summary: input.summary,
        members: [],
        createdAt: now,
        updatedAt: now,
      };
      saveTeams(input.storageRoot, [...teams, team]);
      return { success: true, output: JSON.stringify(team) };
    }

    if (input.mode === 'list') {
      return {
        success: true,
        output: JSON.stringify({
          view,
          count: teams.length,
          teams: view === 'full' ? teams : teams.map(summarizeTeam),
        }),
      };
    }

    const index = teams.findIndex((team) => team.id === input.teamId);
    if (index < 0) {
      return { success: false, error: `Unknown team: ${input.teamId ?? '(missing)'}` };
    }
    const current = teams[index]!;

    if (input.mode === 'show') {
      return {
        success: true,
        output: JSON.stringify(view === 'full' ? current : {
          ...summarizeTeam(current),
          members: current.members.map((member) => ({
            id: member.id,
            role: member.role,
            lanes: member.lanes,
          })),
        }),
      };
    }

    if (input.mode === 'delete') {
      saveTeams(input.storageRoot, teams.filter((team) => team.id !== input.teamId));
      return { success: true, output: JSON.stringify({ removed: input.teamId }) };
    }

    if (input.mode === 'add-member') {
      if (!input.memberId || !input.role) {
        return { success: false, error: 'add-member requires memberId and role.' };
      }
      const next: TeamRecord = {
        ...current!,
        members: [
          ...current!.members.filter((member) => member.id !== input.memberId),
          { id: input.memberId, role: input.role, lanes: input.lanes ?? [] },
        ],
        updatedAt: Date.now(),
      };
      teams[index] = next;
      saveTeams(input.storageRoot, teams);
      return { success: true, output: JSON.stringify(next) };
    }

    if (input.mode === 'remove-member') {
      if (!input.memberId) return { success: false, error: 'remove-member requires memberId.' };
      const next: TeamRecord = {
        ...current!,
        members: current!.members.filter((member) => member.id !== input.memberId),
        updatedAt: Date.now(),
      };
      teams[index] = next;
      saveTeams(input.storageRoot, teams);
      return { success: true, output: JSON.stringify(next) };
    }

    if (input.mode === 'set-lanes') {
      if (!input.memberId) return { success: false, error: 'set-lanes requires memberId.' };
      const members = current!.members.map((member) => (
        member.id === input.memberId
          ? { ...member, lanes: input.lanes ?? [] }
          : member
      ));
      const next: TeamRecord = {
        ...current!,
        members,
        updatedAt: Date.now(),
      };
      teams[index] = next;
      saveTeams(input.storageRoot, teams);
      return { success: true, output: JSON.stringify(next) };
    }

    return { success: false, error: `Unknown mode: ${input.mode}` };
  },
};
