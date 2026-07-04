/**
 * /recall command handler.
 *
 * Implements the Project Memory Substrate commands:
 *
 *   /recall add <class> <summary>           — Add a new memory record
 *   /recall add <class> <summary> --detail <text> --tags <tag,tag>
 *   /recall search [query]                  — Search memory records
 *   /recall search --cls <class>            — Filter by class
 *   /recall link <fromId> <toId> <relation> — Link two records
 *   /recall get <id>                        — Show a single record with provenance
 *   /recall list [class]                    — List all records (optionally by class)
 *   /recall remove <id>                     — Delete a record
 */

import type { SlashCommand, CommandContext } from '../command-registry.ts';
import { handleRecallAdd, handleRecallCapture } from './recall-capture.ts';
import { handleRecallExport, handleRecallHandoffExport, handleRecallHandoffImport, handleRecallHandoffInspect, handleRecallImport } from './recall-bundle.ts';
import { handleRecallGet, handleRecallLink, handleRecallList, handleRecallRemove, handleRecallSearch, handleRecallVector } from './recall-query.ts';
import { handleRecallExplain, handleRecallInjections, handleRecallPromote, handleRecallQueue, handleRecallReview } from './recall-review.ts';
import { VALID_CLASSES, VALID_REVIEW_STATES, VALID_SCOPES } from './recall-shared.ts';

// ── Top-level command ─────────────────────────────────────────────────────────

export const recallCommand: SlashCommand = {
  name: 'recall',
  aliases: ['rc'],
  description: 'Project memory: add decisions, constraints, incidents, and patterns with provenance',
  usage: '<subcommand> [args]',
  argsHint: 'add|search|link|get|list|remove',
  handler: async (args: string[], context: CommandContext): Promise<void> => {
    const [sub, ...rest] = args;

    switch (sub) {
      case 'add':
        await handleRecallAdd(rest, context);
        break;

      case 'search':
      case 'find':
        handleRecallSearch(rest, context);
        break;

      case 'vector':
      case 'vectors':
        handleRecallVector(rest, context);
        break;

      case 'capture':
        await handleRecallCapture(rest, context);
        break;

      case 'get':
      case 'show':
        handleRecallGet(rest, context);
        break;

      case 'queue':
        handleRecallQueue(rest, context);
        break;

      case 'review':
        handleRecallReview(rest, context);
        break;

      case 'stale':
        handleRecallReview([rest[0] ?? '', 'stale', '--reason', ...rest.slice(1)], context);
        break;

      case 'contradict':
      case 'contradicted':
        handleRecallReview([rest[0] ?? '', 'contradicted', '--reason', ...rest.slice(1)], context);
        break;

      case 'explain':
        handleRecallExplain(rest, context);
        break;

      case 'injections':
        handleRecallInjections(rest, context);
        break;

      case 'promote':
        handleRecallPromote(rest, context);
        break;

      case 'link':
        await handleRecallLink(rest, context);
        break;

      case 'list':
      case 'ls':
        handleRecallList(rest, context);
        break;

      case 'remove':
      case 'delete':
      case 'rm':
        handleRecallRemove(rest, context);
        break;

      case 'export':
        handleRecallExport(rest, context);
        break;

      case 'import':
        await handleRecallImport(rest, context);
        break;

      case 'handoff-export':
      case 'share':
        handleRecallHandoffExport(rest, context);
        break;

      case 'handoff-inspect':
        handleRecallHandoffInspect(rest, context);
        break;

      case 'handoff-import':
        await handleRecallHandoffImport(rest, context);
        break;

      default: {
        const usage = [
          'Usage: /recall <subcommand>',
          '  add <class> <summary> [--scope <session|project|team>] [--detail <text>] [--tags <t,t>] [--session <id>] [--task <id>] [--file <path>]',
          `       classes: ${VALID_CLASSES.join(', ')}`,
          '  capture incident <id|latest>                    — Capture a forensics incident as durable memory',
          '  capture policy                                  — Capture the latest policy preflight review as durable memory',
          '  capture mcp <server>                            — Capture MCP trust/quarantine posture as durable memory',
          '  capture plugin <name>                           — Capture plugin trust/quarantine posture as durable memory',
          '  search [query] [--semantic] [--cls <class>] [--scope <scope>] [--limit <n>]  — Full-text or sqlite-vec semantic search',
          '  vector [status|doctor|rebuild]                  — Inspect or rebuild the sqlite-vec memory index',
          '  get <id>                                       — Show record with provenance + links',
          '  link <fromId> <toId> <relation>               — Create a directed relation between records',
          '  queue [limit]                                  — Show the operator review queue',
          '  review <id> <state> [--confidence <n>] [--by <name>] [--reason <text>]',
          '  stale <id> [reason...]                          — Mark a record stale with an operator reason',
          '  contradict <id> [reason...]                     — Mark a record contradicted with an operator reason',
          '  explain <task...> [--scope <path> ...]         — Show the knowledge records that would be injected for a task',
          '  injections <agentId>                           — Show per-turn passive knowledge injection records for a spawned agent (Wave-5)',
          '  promote <id> <scope>                           — Promote a memory record into session|project|team scope',
          '  export <path> [--scope <scope>] [--cls <class>] — Export a durable knowledge bundle',
          '  import <path>                                  — Import a durable knowledge bundle',
          '  handoff-export <path> [--scope <scope>]        — Export a reviewable handoff bundle for team/shared use',
          '  handoff-inspect <path>                         — Inspect a handoff bundle before import',
          '  handoff-import <path>                          — Import a handoff bundle into durable memory',
          '  list [class] [--scope <scope>]                 — List all records grouped by class',
          '  remove <id>                                    — Delete a record',
        ].join('\n');
        context.print(usage);
        break;
      }
    }
  },
};
