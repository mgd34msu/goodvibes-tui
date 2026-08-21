/**
 * /provider command handler.
 *
 * Implements the Provider Optimizer panel commands:
 *
 *   /provider optimizer on|off  , Enable or disable the provider optimizer
 *   /provider route auto|manual , Set optimizer routing mode
 *   /provider explain-route     , Print current route explanation
 *   /provider pin <provider:model>, Pin routing to a specific provider/model
 *   /provider fallback test     , Simulate the fallback chain
 *
 * When the optimizer is disabled, commands report its status and
 * explain-route still works (reads current model capabilities).
 * Enabling the optimizer persists the change to config so it survives restart.
 */

import type { SlashCommand, CommandContext } from '../command-registry.ts';
import type { RouteExplanation } from '@pellux/goodvibes-sdk/platform/providers';
import type { FallbackTestResult, FallbackTransition } from '@pellux/goodvibes-sdk/platform/providers';
import type { ProviderApiModelRecord } from '@pellux/goodvibes-sdk/platform/providers';
import { requireProviderApi } from './runtime-services.ts';
import { featureEnablementWrite } from '@pellux/goodvibes-terminal-shell';

const PROVIDER_OPTIMIZER_FLAG = 'provider-optimizer';

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function fmtBool(value: boolean): string {
  return value ? 'yes' : 'no';
}

function fmtTs(epochMs: number): string {
  return new Date(epochMs).toISOString().replace('T', ' ').slice(0, 19);
}

function requireProviderOptimizer(context: CommandContext) {
  if (!context.provider.providerOptimizer) {
    context.print('[provider] Provider optimizer is not wired into this runtime.');
    return null;
  }
  return context.provider.providerOptimizer;
}

function fmtExplanation(expl: RouteExplanation, context: CommandContext): void {
  const status = expl.accepted ? '[accepted]' : '[rejected]';
  context.print(`  ${status} ${expl.providerId}/${expl.modelId}`);
  context.print(`    ${expl.summary}`);
  if (!expl.accepted && expl.rejections.length > 0) {
    context.print('    Unmet requirements:');
    for (const r of expl.rejections) {
      context.print(
        `      - ${r.code}: ${r.reason} (actual=${r.actual}, required=${r.required})`,
      );
    }
  }
  if (expl.accepted) {
    const c = expl.capability;
    context.print(
      `    Capabilities: streaming=${fmtBool(c.streaming)}, tools=${fmtBool(c.toolCalling)}, ` +
      `parallel=${fmtBool(c.parallelTools)}, json=${fmtBool(c.jsonMode)}, ` +
      `reasoning=${fmtBool(c.reasoningControls)}`,
    );
    context.print(
      `    Context=${c.maxContextTokens.toLocaleString()} tokens, ` +
      `output=${c.maxOutputTokens.toLocaleString()} tokens, ` +
      `timeout=${c.timeoutMs}ms, caching=${c.caching}`,
    );
  }
}

// ---------------------------------------------------------------------------
// /provider optimizer on|off
// ---------------------------------------------------------------------------

function handleOptimizerToggle(
  args: string[],
  context: CommandContext,
): void {
  const optimizer = requireProviderOptimizer(context);
  if (!optimizer) return;
  const sub = args[0];

  if (sub !== 'on' && sub !== 'off') {
    context.print('[provider] Usage: /provider optimizer on|off');
    context.print(`  Current state: optimizer is ${optimizer.enabled ? 'enabled' : 'disabled'}`);
    context.print('  "on"  — activates intelligent failover and auto-routing');
    context.print('  "off" — disables optimizer; provider selection is manual only');
    return;
  }

  const enable = sub === 'on';
  const wasEnabled = optimizer.enabled;
  optimizer.setEnabled(enable);

  // Persist to config so the setting survives restart: the optimizer is
  // governed by the provider.optimizerMode settings key (off = disabled;
  // manual/auto/pinned = active), and the settings bridge forwards the same
  // write to the runtime gate.
  const write = featureEnablementWrite(PROVIDER_OPTIMIZER_FLAG, enable);
  if (write) context.platform.configManager.setDynamic(write.key, write.value);

  if (enable && !wasEnabled) {
    context.print('[provider] Optimizer enabled.');
    context.print('  Intelligent failover is now active: on a request error the optimizer');
    context.print('  will attempt the next viable provider and surface a transcript notice');
    context.print('  naming the from→to transition and reason before retrying.');
    context.print('  Use "/provider route auto" to enable fully automatic routing.');
  } else if (!enable && wasEnabled) {
    context.print('[provider] Optimizer disabled.');
    context.print('  Provider selection returns to manual-only mode. No automatic failover.');
    context.print('  Pinned targets and fallback log are preserved; re-enable to resume.');
  } else {
    context.print(`[provider] Optimizer already ${enable ? 'enabled' : 'disabled'}; no change.`);
  }
}

// ---------------------------------------------------------------------------
// /provider route auto|manual
// ---------------------------------------------------------------------------

function handleRoute(
  args: string[],
  context: CommandContext,
): void {
  const optimizer = requireProviderOptimizer(context);
  if (!optimizer) return;
  const sub = args[0];

  if (sub !== 'auto' && sub !== 'manual') {
    context.print('[provider] Usage: /provider route auto|manual');
    context.print(`  Current mode: ${optimizer.mode} (optimizer ${optimizer.enabled ? 'on' : 'off'})`);
    return;
  }

  if (!optimizer.enabled) {
    context.print(
      '[provider] Optimizer is off: routing mode recorded but failover will not fire until optimizer is enabled.',
    );
    context.print('  Enable with: /provider optimizer on');
  }

  optimizer.setMode(sub);
  context.print(`[provider] Routing mode → ${sub}`);

  if (sub === 'auto') {
    context.print(
      '  Auto mode: optimizer selects the best capable provider for each request profile.',
    );
  } else {
    context.print(
      '  Manual mode: optimizer is advisory only; provider selection is caller-driven.',
    );
  }
}

// ---------------------------------------------------------------------------
// /provider explain-route
// ---------------------------------------------------------------------------

async function handleExplainRoute(
  _args: string[],
  context: CommandContext,
): Promise<void> {
  const optimizer = requireProviderOptimizer(context);
  if (!optimizer) return;
  const providerApi = requireProviderApi(context);

  let currentModel: ProviderApiModelRecord;
  try {
    currentModel = await providerApi.getCurrentModel();
  } catch {
    context.print('[provider] No current model selected.');
    return;
  }

  context.print(
    `[provider] Route explanation for current model: ${currentModel.providerId}/${currentModel.modelId}`,
  );

  // Always explain current route regardless of optimizer enabled state
  const expl = optimizer.explainCurrentRoute();
  fmtExplanation(expl, context);

  // Show optimizer status
  context.print(`
  Optimizer: ${optimizer.enabled ? 'enabled' : 'disabled'}, mode=${optimizer.mode}`);
  if (optimizer.pinnedTarget) {
    context.print(
      `  Pinned to: ${optimizer.pinnedTarget.providerId}/${optimizer.pinnedTarget.modelId}`,
    );
  }

  // Show recent fallback transitions
  const log = optimizer.fallbackLog;
  if (log.length > 0) {
    const recent = log.slice(-5); // last 5 transitions
    context.print(`  Fallback log (last ${recent.length} of ${log.length}):`);
    for (const t of recent) {
      context.print(
        `    ${fmtTs(t.ts)}  ${t.from} → ${t.to}  (${t.reason})`,
      );
    }
  } else {
    context.print('  Fallback log: empty');
  }
}

// ---------------------------------------------------------------------------
// /provider pin <provider:model>
// ---------------------------------------------------------------------------

async function handlePin(
  args: string[],
  context: CommandContext,
): Promise<void> {
  const optimizer = requireProviderOptimizer(context);
  if (!optimizer) return;
  const target = args[0];

  if (!target) {
    // Show current pin status
    if (optimizer.pinnedTarget) {
      context.print(
        `[provider] Currently pinned to: ${optimizer.pinnedTarget.providerId}/${optimizer.pinnedTarget.modelId}`,
      );
      context.print('  Use "/provider pin <provider:model>" to change, or "/provider route manual" to unpin.');
    } else {
      context.print('[provider] No pin active. Usage: /provider pin <provider:model>');
      context.print('  Example: /provider pin anthropic:claude-opus-4-5');
    }
    return;
  }

  // Parse provider:model format
  const colonIdx = target.indexOf(':');
  if (colonIdx === -1) {
    context.print(`[provider] Invalid format "${target}". Expected: <provider>:<model>`);
    context.print('  Example: /provider pin anthropic:claude-opus-4-5');
    return;
  }

  const providerId = target.slice(0, colonIdx);
  const modelId = target.slice(colonIdx + 1);

  if (!providerId || !modelId) {
    context.print(`[provider] Invalid format "${target}". Both provider and model must be non-empty.`);
    return;
  }

  // Validate that the model exists in registry
  const providerApi = requireProviderApi(context);
  const models = await providerApi.listModels();
  const currentModel = await providerApi.getCurrentModel();
  const match = models.find(
    (m) => m.providerId === providerId && (m.modelId === modelId || m.registryKey === target),
  ) ?? (
    currentModel.providerId === providerId
      && (currentModel.modelId === modelId || currentModel.registryKey === target)
      ? currentModel
      : undefined
  );

  if (!match) {
    context.print(
      `[provider] Model not found in registry: ${providerId}/${modelId}`,
    );
    context.print('  Use "/model" to see available models, or check the provider and model ID.');
    return;
  }

  // Enable optimizer if it's off
  if (!optimizer.enabled) {
    optimizer.setEnabled(true);
    context.print('⚠ Optimizer was disabled: enabling it for pin to take effect.');
  }

  optimizer.pin(match.providerId, match.modelId);
  context.print(`[provider] Pinned → ${match.providerId}/${match.modelId}`);
  context.print('  All routed requests will target this provider/model.');
  context.print('  Unpin with: /provider route manual');
}

// ---------------------------------------------------------------------------
// /provider fallback test
// ---------------------------------------------------------------------------

function handleFallbackTest(
  args: string[],
  context: CommandContext,
): void {
  const optimizer = requireProviderOptimizer(context);
  if (!optimizer) return;
  const sub = args[0];

  if (sub !== 'test') {
    context.print('[provider] Usage: /provider fallback test');
    return;
  }

  context.print('[provider] Simulating fallback chain (empty request profile; no requirements)...');

  const result: FallbackTestResult = optimizer.testFallback();

  context.print(
    `[provider] Fallback chain: ${result.viableCount} capable / ${result.totalCount} total providers`,
  );

  // Show first capable then rejected
  const capable = result.chain.filter((n) => n.capable);
  const rejected = result.chain.filter((n) => !n.capable);

  if (capable.length > 0) {
    context.print('  Capable providers (would succeed):');
    for (const node of capable.slice(0, 10)) {
      context.print(`    [${node.position}] ${node.providerId}/${node.modelId}`);
    }
    if (capable.length > 10) {
      context.print(`    ... and ${capable.length - 10} more`);
    }
  } else {
    context.print('  No capable providers found for this profile.');
  }

  if (rejected.length > 0) {
    context.print(`  Rejected providers (${rejected.length}):`);
    for (const node of rejected.slice(0, 5)) {
      const reasons = !node.explanation.accepted
        ? node.explanation.rejections.map((r) => r.code).join(', ')
        : '';
      context.print(
        `    [${node.position}] ${node.providerId}/${node.modelId} — ${reasons || 'unknown'}`,
      );
    }
    if (rejected.length > 5) {
      context.print(`    ... and ${rejected.length - 5} more`);
    }
  }

  // Show fallback log
  const log = optimizer.fallbackLog;
  if (log.length > 0) {
    context.print(`  Logged transitions (${log.length} total):`);
    const recent: readonly FallbackTransition[] = log.slice(-5);
    for (const t of recent) {
      context.print(
        `    ${fmtTs(t.ts)}  ${t.from} → ${t.to}  (${t.reason})`,
      );
    }
  } else {
    context.print('  No fallback transitions logged this session.');
  }

  context.print(`  Test completed at: ${fmtTs(result.testedAt)}`);
}

// ---------------------------------------------------------------------------
// Top-level command definition
// ---------------------------------------------------------------------------

/**
 * providerCommand, The `/provider` slash command.
 *
 * Routes to subcommand handlers based on args[0].
 */
export const providerCommand: SlashCommand = {
  name: 'provider-opt',
  aliases: ['prov-opt'],
  description: 'Manage provider routing optimizer (route, pin, explain, fallback)',
  usage: '<subcommand> [args]',
  argsHint: 'optimizer|route|explain-route|pin|fallback',
  handler: async (args: string[], context: CommandContext): Promise<void> => {
    const [sub, ...rest] = args;

    switch (sub) {
      case 'optimizer':
        handleOptimizerToggle(rest, context);
        break;

      case 'route':
        handleRoute(rest, context);
        break;

      case 'explain-route':
      case 'explain':
        await handleExplainRoute(rest, context);
        break;

      case 'pin':
        await handlePin(rest, context);
        break;

      case 'fallback':
        handleFallbackTest(rest, context);
        break;

      default: {
        const optimizer = requireProviderOptimizer(context);
        if (!optimizer) return;
        const lines = [
          'Usage: /provider <subcommand>',
          '  optimizer on|off               — Enable or disable the provider optimizer',
          '  route auto|manual              — Set optimizer routing mode',
          '  explain-route                  — Show current route explanation',
          '  pin <provider:model>           — Pin routing to specific provider/model',
          '  fallback test                  — Simulate the full fallback chain',
          '',
          `  Optimizer: ${optimizer.enabled ? 'enabled' : 'disabled'}  mode=${optimizer.mode}`,
        ];
        if (optimizer.pinnedTarget) {
          lines.push(`  Pinned: ${optimizer.pinnedTarget.providerId}/${optimizer.pinnedTarget.modelId}`);
        }
        context.print(lines.join('\n'));
        break;
      }
    }
  },
};
