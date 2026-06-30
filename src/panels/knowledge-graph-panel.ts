/**
 * KnowledgeGraphPanel — SDK knowledge graph front-door.
 *
 * TASK-040: The 'knowledge' panel id is repointed here (the SDK graph), fixing
 * the naming inversion where the former panel named 'Knowledge' was actually
 * rendering memory records.
 *
 * This panel is a thin information surface that explains the graph's capabilities
 * and routes the user to the /knowledge command suite for ingest/RAG operations.
 * The full graph UI is command-driven (/knowledge ask, ingest-url, list, search…).
 *
 * It is selectable: the operator can move a cursor across the command catalogue
 * so the currently-highlighted command is unambiguous and a one-line "what this
 * does" detail is surfaced for it.
 */

import type { Line } from '../types/grid.ts';
import { createEmptyLine } from '../types/grid.ts';
import { BasePanel } from './base-panel.ts';
import {
  buildBodyText,
  buildDetailBlock,
  buildGuidanceLine,
  buildKeyboardHints,
  buildPanelLine,
  buildPanelWorkspace,
  DEFAULT_PANEL_PALETTE,
} from './polish.ts';

const C = {
  ...DEFAULT_PANEL_PALETTE,
  header: '#94a3b8',
  headerBg: '#1e293b',
} as const;

interface CommandEntry {
  readonly command: string;
  readonly summary: string;
  readonly detail: string;
}

const GRAPH_COMMANDS: readonly CommandEntry[] = [
  { command: '/knowledge status', summary: 'check the graph status and source counts', detail: 'Reports node/edge totals, ingested source count, and embedding-provider readiness.' },
  { command: '/knowledge ask <query>', summary: 'ask a question against the ingested knowledge', detail: 'Runs retrieval-augmented Q&A over ingested sources and returns a cited answer.' },
  { command: '/knowledge ingest-url <url>', summary: 'ingest a URL as a knowledge source', detail: 'Fetches a URL, extracts content, and stores it as graph nodes and edges.' },
  { command: '/knowledge list', summary: 'list ingested sources or graph nodes', detail: 'Enumerates the current sources and top-level nodes in the graph.' },
  { command: '/knowledge search <query>', summary: 'search the graph for nodes and sources', detail: 'Keyword/semantic search across stored nodes without generating an answer.' },
  { command: '/knowledge packet <task>', summary: 'build a compact prompt packet for a task', detail: 'Assembles a token-budgeted context packet of the most relevant facts for a task.' },
];

const MEMORY_COMMANDS: readonly CommandEntry[] = [
  { command: '/recall add <class> <summary>', summary: 'capture a new memory record', detail: 'Stores a durable decision, risk, runbook, incident, or architecture record.' },
  { command: '/recall queue', summary: 'show the operator review queue', detail: 'Lists stale and contradicted records awaiting operator review.' },
  { command: '/project-memory (pmem)', summary: 'project-memory alias for /recall front-door', detail: 'Shorthand entry point to the same durable project-memory surface.' },
];

export class KnowledgeGraphPanel extends BasePanel {
  private selectedIndex = 0;

  constructor() {
    super('knowledge', 'Knowledge', 'K', 'agent');
  }

  private get entries(): readonly CommandEntry[] {
    return [...GRAPH_COMMANDS, ...MEMORY_COMMANDS];
  }

  handleInput(key: string): boolean {
    const count = this.entries.length;
    if (key === 'up' || key === 'k') {
      this.selectedIndex = (this.selectedIndex - 1 + count) % count;
      this.markDirty();
      return true;
    }
    if (key === 'down' || key === 'j') {
      this.selectedIndex = (this.selectedIndex + 1) % count;
      this.markDirty();
      return true;
    }
    if (key === 'home' || key === 'g') {
      this.selectedIndex = 0;
      this.markDirty();
      return true;
    }
    if (key === 'end' || key === 'G') {
      this.selectedIndex = count - 1;
      this.markDirty();
      return true;
    }
    return false;
  }

  private commandLines(width: number, group: readonly CommandEntry[], offset: number): Line[] {
    return group.map((entry, idx) => {
      const absIdx = offset + idx;
      const selected = absIdx === this.selectedIndex;
      if (selected) {
        return buildPanelLine(width, [
          [' ▸ ', C.info, C.headerBg],
          [`${entry.command}  `, C.value, C.headerBg],
          [entry.summary, C.dim, C.headerBg],
        ]);
      }
      return buildGuidanceLine(width, entry.command, entry.summary, C);
    });
  }

  render(width: number, height: number): Line[] {
    this.selectedIndex = Math.max(0, Math.min(this.selectedIndex, this.entries.length - 1));
    const selected = this.entries[this.selectedIndex]!;

    const sections = [
      {
        title: 'SDK Knowledge Graph',
        lines: [
          buildPanelLine(width, [[' Ingest URLs and facts as graph nodes; search and build task-context packets.', C.dim]]),
          ...this.commandLines(width, GRAPH_COMMANDS, 0),
        ],
      },
      {
        title: 'Project Memory',
        lines: [
          buildPanelLine(width, [[' Durable decisions, risks, runbooks, and incidents — a sub-namespace of the graph.', C.dim]]),
          ...this.commandLines(width, MEMORY_COMMANDS, GRAPH_COMMANDS.length),
        ],
      },
      {
        lines: buildDetailBlock(width, selected.command, buildBodyText(width, selected.detail, C, C.value), C),
      },
    ];

    const lines = buildPanelWorkspace(width, height, {
      title: 'Knowledge Graph',
      intro: 'Ingested sources, graph nodes, and the durable memory bridge.',
      sections,
      footerLines: [buildKeyboardHints(width, [
        { keys: '↑/↓', label: 'browse commands' },
        { keys: 'Home/End', label: 'jump' },
        { keys: 'M', label: 'Memory panel' },
      ], C)],
      palette: C,
    });
    while (lines.length < height) lines.push(createEmptyLine(width));
    return lines.slice(0, height);
  }
}
