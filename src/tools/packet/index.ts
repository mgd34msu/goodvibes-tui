import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Tool } from '../../types/tools.ts';
import { PACKET_TOOL_SCHEMA, type PacketToolInput } from './schema.ts';

interface PacketRecord {
  readonly id: string;
  readonly title: string;
  readonly summary: string;
  readonly goals: readonly string[];
  readonly constraints: readonly string[];
  readonly risks: readonly string[];
  readonly audience?: string;
  readonly status: 'draft' | 'published';
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly publishedAt?: number;
}

function summarizePacket(record: PacketRecord) {
  return {
    id: record.id,
    title: record.title,
    summary: record.summary,
    goalCount: record.goals.length,
    constraintCount: record.constraints.length,
    riskCount: record.risks.length,
    audience: record.audience,
    status: record.status,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    publishedAt: record.publishedAt,
  };
}

export function createPacketTool(workingDirectory: string): Tool {
  const workspaceRoot = resolve(workingDirectory);
  const packetsDir = join(workspaceRoot, '.goodvibes', 'tui');
  const packetsPath = join(packetsDir, 'packets.json');

  function loadPackets(): PacketRecord[] {
    try {
      return JSON.parse(readFileSync(packetsPath, 'utf-8')) as PacketRecord[];
    } catch {
      return [];
    }
  }

  function savePackets(records: readonly PacketRecord[]): void {
    mkdirSync(packetsDir, { recursive: true });
    writeFileSync(packetsPath, `${JSON.stringify(records, null, 2)}\n`, 'utf-8');
  }

  return {
    definition: {
      name: 'packet',
      description: 'Manage durable implementation packets and published execution packets.',
      parameters: PACKET_TOOL_SCHEMA.parameters,
      sideEffects: ['workflow', 'state'],
      concurrency: 'serial',
    },

    async execute(args: Record<string, unknown>) {
      if (!args || typeof args !== 'object' || typeof args.mode !== 'string') {
        return { success: false, error: 'Invalid args: mode is required.' };
      }
      const input = args as unknown as PacketToolInput;
      const records = loadPackets();
      const view = input.view ?? 'summary';

      if (input.mode === 'create') {
        if (!input.packetId || !input.title || !input.summary) {
          return { success: false, error: 'create requires packetId, title, and summary.' };
        }
        const now = Date.now();
        const record: PacketRecord = {
          id: input.packetId,
          title: input.title,
          summary: input.summary,
          goals: [...(input.goals ?? [])],
          constraints: [...(input.constraints ?? [])],
          risks: [...(input.risks ?? [])],
          ...(input.audience ? { audience: input.audience } : {}),
          status: 'draft',
          createdAt: now,
          updatedAt: now,
        };
        savePackets([...records.filter((entry) => entry.id !== record.id), record]);
        return { success: true, output: JSON.stringify(record) };
      }

      if (input.mode === 'list') {
        return {
          success: true,
          output: JSON.stringify({
            view,
            count: records.length,
            packets: view === 'full' ? records : records.map(summarizePacket),
          }),
        };
      }

      const record = records.find((entry) => entry.id === input.packetId);
      if (!record) return { success: false, error: `Unknown packet: ${input.packetId ?? '(missing)'}` };

      if (input.mode === 'show') {
        return { success: true, output: JSON.stringify(view === 'full' ? record : summarizePacket(record)) };
      }

      if (input.mode === 'revise') {
        const next: PacketRecord = {
          ...record,
          title: input.title ?? record.title,
          summary: input.summary ?? record.summary,
          goals: input.goals ? [...input.goals] : record.goals,
          constraints: input.constraints ? [...input.constraints] : record.constraints,
          risks: input.risks ? [...input.risks] : record.risks,
          audience: input.audience ?? record.audience,
          updatedAt: Date.now(),
        };
        savePackets(records.map((entry) => (entry.id === next.id ? next : entry)));
        return { success: true, output: JSON.stringify(next) };
      }

      if (input.mode === 'publish') {
        const next: PacketRecord = {
          ...record,
          status: 'published',
          publishedAt: Date.now(),
          updatedAt: Date.now(),
        };
        savePackets(records.map((entry) => (entry.id === next.id ? next : entry)));
        return { success: true, output: JSON.stringify(next) };
      }

      return { success: false, error: `Unknown mode: ${input.mode}` };
    },
  };
}
