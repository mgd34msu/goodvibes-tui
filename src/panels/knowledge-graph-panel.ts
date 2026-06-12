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
 */

import type { Line } from '../types/grid.ts';
import { BasePanel } from './base-panel.ts';
import {
  buildBodyText,
  buildGuidanceLine,
  buildPanelLine,
  buildPanelWorkspace,
  DEFAULT_PANEL_PALETTE,
} from './polish.ts';

const C = {
  ...DEFAULT_PANEL_PALETTE,
  header: '#94a3b8',
  headerBg: '#1e293b',
} as const;

export class KnowledgeGraphPanel extends BasePanel {
  constructor() {
    super('knowledge', 'Knowledge', 'K', 'agent');
  }

  handleInput(_key: string): boolean {
    return false;
  }

  render(width: number, height: number): Line[] {
    const sections = [
      {
        title: 'SDK Knowledge Graph',
        lines: [
          ...buildBodyText(
            width,
            'The knowledge graph stores ingested URLs, bookmarks, and structured facts as nodes and edges. ' +
            'Use /knowledge commands to ingest sources, search the graph, and build task-context packets.',
            C,
            C.value,
          ),
          buildPanelLine(width, [['', C.dim]]),
          buildGuidanceLine(width, '/knowledge status', 'check the graph status and source counts', C),
          buildGuidanceLine(width, '/knowledge ask <query>', 'ask a question against the ingested knowledge', C),
          buildGuidanceLine(width, '/knowledge ingest-url <url>', 'ingest a URL as a knowledge source', C),
          buildGuidanceLine(width, '/knowledge list', 'list ingested sources or graph nodes', C),
          buildGuidanceLine(width, '/knowledge search <query>', 'search the graph for nodes and sources', C),
          buildGuidanceLine(width, '/knowledge packet <task>', 'build a compact prompt packet for a task', C),
        ],
      },
      {
        title: 'Project Memory',
        lines: [
          ...buildBodyText(
            width,
            'For durable decisions, risks, runbooks, incidents, and architecture records, use the Memory panel ' +
            'or the /recall command surface. Durable memory is a sub-namespace of the knowledge graph.',
            C,
            C.dim,
          ),
          buildPanelLine(width, [['', C.dim]]),
          buildGuidanceLine(width, '/recall add <class> <summary>', 'capture a new memory record', C),
          buildGuidanceLine(width, '/recall queue', 'show the operator review queue', C),
          buildGuidanceLine(width, '/project-memory (pmem)', 'project-memory alias for /recall front-door', C),
        ],
      },
    ];

    return buildPanelWorkspace(width, height, {
      title: 'Knowledge Graph',
      intro: 'Ingested sources, graph nodes, and the durable memory bridge.',
      sections,
      palette: C,
    });
  }
}
