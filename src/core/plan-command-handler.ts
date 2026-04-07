/**
 * /plan command handler.
 *
 * Handles the subcommands of the /plan slash command:
 *   /plan mode auto|single|cohort|background|remote
 *   /plan explain
 *   /plan override <strategy>
 *   /plan clear
 *
 * Returns a human-readable result string to display in the conversation.
 */

import { adaptivePlanner } from './adaptive-planner-instance.ts';
import { AdaptivePlanner, VALID_STRATEGIES } from './adaptive-planner.ts';
import type { ExecutionStrategy } from './adaptive-planner.ts';
import { logger } from '../utils/logger.ts';
import type { RuntimeEventBus } from '../runtime/events/index.ts';
import { emitPlanStrategyOverridden } from '../runtime/emitters/index.ts';

let runtimeBus: RuntimeEventBus | null = null;

export function setPlanRuntimeBus(bus: RuntimeEventBus | null): void {
  runtimeBus = bus;
}

function emitStrategyOverride(data: { strategy: ExecutionStrategy | null; clearedBy?: string }): void {
  if (runtimeBus) {
    emitPlanStrategyOverridden(runtimeBus, {
      sessionId: 'system',
      traceId: `planner:override:${data.strategy ?? 'none'}`,
      source: 'plan-command-handler',
    }, data);
  }
}

export interface PlanCommandResult {
  /** Human-readable output to show the user. */
  output: string;
  /** Whether the command succeeded. */
  ok: boolean;
}

/**
 * Dispatch a parsed /plan subcommand.
 *
 * @param subcommand - The first word after /plan (e.g. 'mode', 'explain', 'override').
 * @param args       - Remaining tokens.
 */
export function handlePlanCommand(
  subcommand: string,
  args: string[],
): PlanCommandResult {
  switch (subcommand.toLowerCase()) {
    case 'mode': {
      const value = args[0];
      if (!value) {
        const current = adaptivePlanner.getMode();
        return {
          ok: true,
          output: `Current mode: **${current}**\n\nAvailable modes: auto | single | cohort | background | remote`,
        };
      }
      if (!VALID_STRATEGIES.includes(value as ExecutionStrategy)) {
        return {
          ok: false,
          output: `Unknown mode '${value}'. Valid: auto | single | cohort | background | remote`,
        };
      }
      adaptivePlanner.setMode(value as ExecutionStrategy);
      logger.info('[PlanCommandHandler] mode changed', { mode: value });
      return {
        ok: true,
        output: `Execution mode set to **${value}**.`,
      };
    }

    case 'explain': {
      const explanation = adaptivePlanner.explain();
      return { ok: true, output: explanation };
    }

    case 'override': {
      const strategy = args[0];
      if (!strategy) {
        return {
          ok: false,
          output: 'Usage: /plan override <strategy>\n'
            + 'Strategies: auto | single | cohort | background | remote\n'
            + 'Use /plan override auto to clear the override.',
        };
      }
      const result = adaptivePlanner.override(strategy);
      if (!result.ok) {
        const explanation = AdaptivePlanner.explainReasonCode(result.reasonCode);
        logger.warn('[PlanCommandHandler] override rejected', { strategy, reasonCode: result.reasonCode });
        return {
          ok: false,
          output: `Override rejected: ${explanation}`,
        };
      }
      if (result.strategy === 'auto') {
        // override('auto') already cleared the override internally
        logger.info('[PlanCommandHandler] override cleared via auto');
        emitStrategyOverride({ strategy: 'auto', clearedBy: 'override(auto)' });
        return {
          ok: true,
          output: 'Execution strategy override cleared. Planner will run in auto mode.',
        };
      }
      logger.info('[PlanCommandHandler] override applied', { strategy: result.strategy });
      emitStrategyOverride({ strategy: result.strategy });
      return {
        ok: true,
        output: `Execution strategy overridden to **${result.strategy.toUpperCase()}**.\n`
          + AdaptivePlanner.explainReasonCode('OVERRIDE_IN_EFFECT'),
      };
    }

    case 'clear': {
      adaptivePlanner.clearOverride();
      adaptivePlanner.setMode('auto');
      logger.info('[PlanCommandHandler] mode and override reset to auto');
      emitStrategyOverride({ strategy: 'auto', clearedBy: 'clear' });
      return {
        ok: true,
        output: 'Planner mode and override reset to **auto**.',
      };
    }

    case 'status': {
      const mode     = adaptivePlanner.getMode();
      const override = adaptivePlanner.getOverride();
      const latest   = adaptivePlanner.getLatest();
      const lines = [
        `Mode:     ${mode.toUpperCase()}`,
        `Override: ${override ? override.toUpperCase() + ' [ACTIVE]' : 'none'}`,
      ];
      if (latest) {
        lines.push(
          `Last:     ${latest.selected.toUpperCase()}`,
          `Reason:   ${latest.reasonCode}`,
          `          ${AdaptivePlanner.explainReasonCode(latest.reasonCode)}`,
        );
      }
      return { ok: true, output: lines.join('\n') };
    }

    default: {
      return {
        ok: false,
        output: [
          `Unknown /plan subcommand: '${subcommand}'.`,
          '',
          'Available commands:',
          '  /plan mode [auto|single|cohort|background|remote]  - get or set mode',
          '  /plan override <strategy>                          - force a strategy',
          '  /plan explain                                      - explain last decision',
          '  /plan status                                       - show current state',
          '  /plan clear                                        - reset to auto',
        ].join('\n'),
      };
    }
  }
}
