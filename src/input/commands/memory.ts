/**
 * /recall command handler.
 *
 * Implements the Project Memory Substrate commands:
 *
 *   /recall add <class> <summary>          , Add a new memory record
 *   /recall add <class> <summary> --detail <text> --tags <tag,tag>
 *   /recall search [query]                 , Search memory records
 *   /recall search --cls <class>           , Filter by class
 *   /recall link <fromId> <toId> <relation>, Link two records
 *   /recall get <id>                       , Show a single record with provenance
 *   /recall list [class]                   , List all records (optionally by class)
 *   /recall remove <id>                    , Delete a record
 */

import type { SlashCommand, CommandContext } from '../command-registry.ts';
import { handleRecallAdd, handleRecallCapture } from './recall-capture.ts';
import { handleRecallExport, handleRecallHandoffExport, handleRecallHandoffImport, handleRecallHandoffInspect, handleRecallImport } from './recall-bundle.ts';
import { handleRecallGet, handleRecallLink, handleRecallList, handleRecallRemove, handleRecallSearch, handleRecallVector } from './recall-query.ts';
import { handleRecallExplain, handleRecallInjections, handleRecallPromote, handleRecallQueue, handleRecallReview } from './recall-review.ts';
import { VALID_CLASSES, VALID_REVIEW_STATES, VALID_SCOPES } from './recall-shared.ts';
import { handleRecallFilesApply, handleRecallFilesReview, handleRecallFilesSync } from './recall-files.ts';

// ── Top-level command ─────────────────────────────────────────────────────────

/**
 * item 3 divergence note (historical): the work order that shipped
 * this command named its front door "/memory", but at the time `/memory` was
 * already a distinct, unrelated command (session-pinned sticky notes,
 * src/input/commands/session-content.ts) with no modal surface, so that
 * work order deliberately did NOT touch /memory and used /recall instead.
 *
 * Update from the core-verb naming pass (MEMORY fragmentation, worst-class
 * collision #2): the agent's own `/memory` command was a plain alias for its
 * `/recall`-equivalent the whole time, meaning "/memory" meant two unrelated
 * things depending which surface you were on. The session-notes command was
 * renamed to `/note` (session-content.ts) to free the word, and `/memory` is
 * now registered here as a real alias of `/recall`, the word means the same
 * durable Project Memory Substrate on both surfaces. The modal that exists
 * for this data, the Project Memory Substrate, is still `memory-modal.ts`,
 * owned by THIS command, confirmed by the panel-id redirect
 * `registerModalRedirect('memory', 'memory-modal')` in builtin-modals.ts.
 */
function printRecallUsage(context: CommandContext): void {
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
    '  files sync [--dir <path>]                       — Project standing (project/team) records to git-backed markdown files',
    '  files review [--dir <path>]                     — Diff the projection directory against the store; prints proposals, applies nothing',
    '  files apply <id> [<id> ...] | --all [--dir <path>] — Apply only the named proposals from the last review, through the store\'s own update/delete',
    '  explain <task...> [--scope <path> ...]         — Show the knowledge records that would be injected for a task',
    '  injections [agentId]                           — Show per-turn passive knowledge injection records; no id shows the main session, an id shows that spawned agent',
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
}

export const recallCommand: SlashCommand = {
  name: 'recall',
  aliases: ['rc', 'memory', 'mem'],
  description: 'Bare opens the Memory modal; project memory subcommands add decisions, constraints, incidents, and patterns with provenance',
  usage: '[<subcommand> [args]]: bare opens the modal; report prints the subcommand usage text',
  argsHint: 'add|search|link|get|list|remove|report',
  handler: async (args: string[], context: CommandContext): Promise<void> => {
    const [sub, ...rest] = args;

    // item 3: bare `/recall` opens the memory-modal surface, the old
    // bare/unknown-subcommand usage block moved to an explicit `report`
    // subcommand (scriptability preserved: /recall report).
    if (sub === undefined) {
      context.openModal?.('memory-modal');
      return;
    }

    switch (sub) {
      case 'report':
        printRecallUsage(context);
        break;

      case 'add':
        await handleRecallAdd(rest, context);
        break;

      case 'search':
      case 'find':
        await handleRecallSearch(rest, context);
        break;

      case 'vector':
      case 'vectors':
        handleRecallVector(rest, context);
        break;

      case 'capture':
        await handleRecallCapture(rest, context);
        break;

      case 'files': {
        const [filesSub, ...filesRest] = rest;
        switch (filesSub) {
          case 'sync':
            await handleRecallFilesSync(filesRest, context);
            break;
          case 'review':
            await handleRecallFilesReview(filesRest, context);
            break;
          case 'apply':
            await handleRecallFilesApply(filesRest, context);
            break;
          default:
            context.print('[recall] Usage: /recall files <sync|review|apply> ...');
            break;
        }
        break;
      }

      case 'get':
      case 'show':
        await handleRecallGet(rest, context);
        break;

      case 'queue':
        await handleRecallQueue(rest, context);
        break;

      case 'review':
        await handleRecallReview(rest, context);
        break;

      case 'stale':
        await handleRecallReview([rest[0] ?? '', 'stale', '--reason', ...rest.slice(1)], context);
        break;

      case 'contradict':
      case 'contradicted':
        await handleRecallReview([rest[0] ?? '', 'contradicted', '--reason', ...rest.slice(1)], context);
        break;

      case 'explain':
        handleRecallExplain(rest, context);
        break;

      case 'injections':
        handleRecallInjections(rest, context);
        break;

      case 'promote':
        await handleRecallPromote(rest, context);
        break;

      case 'link':
        await handleRecallLink(rest, context);
        break;

      case 'list':
      case 'ls':
        await handleRecallList(rest, context);
        break;

      case 'remove':
      case 'delete':
      case 'rm':
        await handleRecallRemove(rest, context);
        break;

      case 'export':
        await handleRecallExport(rest, context);
        break;

      case 'import':
        await handleRecallImport(rest, context);
        break;

      case 'handoff-export':
      case 'share':
        await handleRecallHandoffExport(rest, context);
        break;

      case 'handoff-inspect':
        handleRecallHandoffInspect(rest, context);
        break;

      case 'handoff-import':
        await handleRecallHandoffImport(rest, context);
        break;

      default:
        printRecallUsage(context);
        break;
    }
  },
};
