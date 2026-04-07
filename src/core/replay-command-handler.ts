/**
 * /replay command handler.
 *
 * Handles the subcommands of the /replay slash command:
 *   /replay load <runId>     — load a recorded run by ID
 *   /replay step [n]         — advance n steps (default 1)
 *   /replay seek <rev>       — jump to a specific revision
 *   /replay diff             — run diff mode and report mismatches
 *   /replay export <path>    — export replay report to a JSON file
 *
 * The handler delegates to the `DeterministicReplayEngine` singleton
 * and the `LocalLedgerExporter` instance for ledger access.
 *
 * Returns a human-readable result string to display in the conversation.
 */

import { getReplayEngine } from './deterministic-replay.ts';
import { logger } from '../utils/logger.ts';

export interface ReplayCommandResult {
  /** Human-readable output to show the user. */
  output: string;
  /** Whether the command succeeded. */
  ok: boolean;
}

/**
 * Dispatch a parsed /replay subcommand.
 *
 * @param subcommand - The first word after /replay (e.g. 'load', 'step').
 * @param args       - Remaining tokens.
 * @param ledger     - Optional ledger reader for 'load'. When omitted, the
 *                     handler reports that no ledger is configured.
 */
export function handleReplayCommand(
  subcommand: string,
  args: string[],
  ledger?: {
    readRunEntries: (runId: string) => import('../runtime/telemetry/exporters/local-ledger.ts').LedgerEntry[];
    listRunIds: () => string[];
  },
): ReplayCommandResult {
  const engine = getReplayEngine();

  switch (subcommand.toLowerCase()) {
    case 'load': {
      const runId = args[0];
      if (!runId) {
        // List available runs if no ledger argument.
        if (!ledger) {
          return {
            ok: false,
            output: 'Usage: /replay load <runId>\n\nNo ledger configured - cannot list runs.',
          };
        }
        const ids = ledger.listRunIds();
        if (ids.length === 0) {
          return {
            ok: true,
            output: 'No recorded runs found in the ledger.\n\nRuns are recorded automatically when telemetry is enabled.',
          };
        }
        const list = ids.map((id, i) => `  ${i + 1}. ${id}`).join('\n');
        return {
          ok: true,
          output: `Available runs (${ids.length}):\n${list}\n\nUse /replay load <runId> to load a run.`,
        };
      }

      if (!ledger) {
        return {
          ok: false,
          output: `Cannot load run "${runId}": no ledger is configured.\n\nEnable telemetry and set a ledger file path to record runs.`,
        };
      }

      const entries = ledger.readRunEntries(runId);
      if (entries.length === 0) {
        return {
          ok: false,
          output: `No ledger entries found for run "${runId}".\n\nVerify the run ID is correct with /replay load (no arguments).`,
        };
      }

      // Build a minimal snapshot from the first event's timestamp.
      // In a fully wired setup the snapshot would be retrieved from a snapshot store.
      // Here we use an empty-domain snapshot as the baseline; domain state will be
      // populated incrementally as events are replayed.
      const syntheticSnapshot: import('../runtime/diagnostics/types.ts').RuntimeStateSnapshot = {
        capturedAt: entries[0].ts,
        domains: [],
      };

      engine.load(runId, syntheticSnapshot, entries);
      logger.info('[ReplayCommandHandler] run loaded', { runId, events: entries.length });

      return {
        ok: true,
        output: [
          `Run "${runId}" loaded.`,
          `  Events: ${entries.length}`,
          `  First: ${new Date(entries[0].ts).toISOString()}`,
          `  Last:  ${new Date(entries[entries.length - 1].ts).toISOString()}`,
          '',
          'Use /replay step to advance, /replay seek <rev> to jump, /replay diff to compare.',
        ].join('\n'),
      };
    }

    case 'step': {
      const snap = engine.getSnapshot();
      if (snap.status === 'idle') {
        return {
          ok: false,
          output: 'No run loaded. Use /replay load <runId> first.',
        };
      }
      if (snap.status === 'exhausted') {
        return {
          ok: true,
          output: `Replay exhausted at rev ${snap.currentRev} / ${snap.totalRevisions}. Use /replay seek to reposition.`,
        };
      }

      const n = args[0] ? parseInt(args[0], 10) : 1;
      if (isNaN(n) || n < 1) {
        return {
          ok: false,
          output: `Invalid step count "${args[0]}". Must be a positive integer.`,
        };
      }

      const stepped = engine.step(n);
      const after = engine.getSnapshot();

      if (stepped.length === 0) {
        return {
          ok: true,
          output: `No steps taken. Already at rev ${after.currentRev} / ${after.totalRevisions}.`,
        };
      }

      const lines: string[] = [
        `Stepped ${stepped.length} event${stepped.length === 1 ? '' : 's'} (rev ${after.currentRev} / ${after.totalRevisions}).`,
      ];
      for (const frame of stepped) {
        const eventName = frame.entry?.eventName ?? 'snapshot';
        lines.push(`  [rev ${frame.rev}] ${eventName}`);
      }
      if (after.status === 'exhausted') {
        lines.push('\nReplay exhausted - all events have been replayed.');
      }

      return { ok: true, output: lines.join('\n') };
    }

    case 'seek': {
      const snap = engine.getSnapshot();
      if (snap.status === 'idle') {
        return {
          ok: false,
          output: 'No run loaded. Use /replay load <runId> first.',
        };
      }

      const rev = args[0] ? parseInt(args[0], 10) : NaN;
      if (isNaN(rev) || rev < 0) {
        return {
          ok: false,
          output: `Usage: /replay seek <rev>\nValid range: 0 - ${snap.totalRevisions}.`,
        };
      }

      engine.seek(rev);
      const after = engine.getSnapshot();
      const frame = after.currentFrame;
      const eventLabel = frame?.entry?.eventName ? `event "${frame.entry.eventName}"` : 'initial snapshot';

      return {
        ok: true,
        output: `Seeked to rev ${after.currentRev} / ${after.totalRevisions} (${eventLabel}).`,
      };
    }

    case 'diff': {
      const snap = engine.getSnapshot();
      if (snap.status === 'idle') {
        return {
          ok: false,
          output: 'No run loaded. Use /replay load <runId> first.',
        };
      }

      const mismatches = engine.diff();

      if (mismatches.length === 0) {
        return {
          ok: true,
          output: `Diff complete for run "${snap.runId}": no mismatches found across ${snap.totalRevisions} revision${snap.totalRevisions === 1 ? '' : 's'}. Replay is deterministic.`,
        };
      }

      const lines: string[] = [
        `Diff complete for run "${snap.runId}": ${mismatches.length} mismatch${mismatches.length === 1 ? '' : 'es'} found.`,
        '',
      ];
      for (const m of mismatches) {
        const tagParts = [m.kind, m.failureMode, m.ownerDomain].filter(Boolean);
        const tag = `[${tagParts.join('/')}]`.padEnd(40);
        lines.push(`  ${tag} ${m.description}`);
      }
      lines.push('');
      lines.push('Use /replay export <path> to write the full report.');

      return { ok: true, output: lines.join('\n') };
    }

    case 'export': {
      const snap = engine.getSnapshot();
      if (snap.status === 'idle') {
        return {
          ok: false,
          output: 'No run loaded. Use /replay load <runId> first.',
        };
      }

      const filePath = args[0];
      if (!filePath) {
        return {
          ok: false,
          output: 'Usage: /replay export <path>\n\nExample: /replay export /tmp/replay-report.json',
        };
      }

      // engine.export() is async and validates the path before writing.
      // We fire-and-forget here and report optimistically; errors are logged
      // by the engine. Callers that need the result can await the returned promise.
      engine.export(filePath).catch((err: unknown) => {
        logger.warn('[ReplayCommandHandler] export failed', { filePath, err: String(err) });
      });
      logger.info('[ReplayCommandHandler] export triggered', { filePath, runId: snap.runId });

      return {
        ok: true,
        output: `Report export started: ${filePath}\n  Run: ${snap.runId}\n  Revisions: ${snap.totalRevisions}\n  Mismatches: ${snap.mismatches.length}`,
      };
    }

    default: {
      const snap = engine.getSnapshot();
      const statusLine = snap.status === 'idle'
        ? 'No run loaded.'
        : `Current run: ${snap.runId} | rev ${snap.currentRev} / ${snap.totalRevisions} | status: ${snap.status}`;

      return {
        ok: false,
        output: [
          `Unknown /replay subcommand: '${subcommand}'.`,
          '',
          'Available commands:',
          '  /replay load [runId]      - load a recorded run (omit runId to list)',
          '  /replay step [n]          - advance n steps (default 1)',
          '  /replay seek <rev>        - jump to a specific revision',
          '  /replay diff              - compare replayed vs recorded (mismatch report)',
          '  /replay export <path>     - export report to JSON file',
          '',
          statusLine,
        ].join('\n'),
      };
    }
  }
}
