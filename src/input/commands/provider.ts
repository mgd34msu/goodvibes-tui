/**
 * /provider command handler.
 *
 * Implements the Provider Optimizer panel commands:
 *
 *   /provider route auto|manual  — Set optimizer routing mode
 *   /provider explain-route      — Print current route explanation
 *   /provider pin <provider:model> — Pin routing to a specific provider/model
 *   /provider fallback test      — Simulate the fallback chain
 *
 * When the optimizer is disabled, commands report its status and
 * explain-route still works (reads current model capabilities).
 */

import type { SlashCommand, CommandContext } from '../command-registry.ts';
import { getProviderOptimizer } from '../../providers/optimizer.ts';
import type { RouteExplanation } from '../../providers/capabilities.ts';
import type { FallbackTestResult, FallbackTransition } from '../../providers/optimizer.ts';

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function fmtBool(value: boolean): string {
  return value ? 'yes' : 'no';
}

function fmtTs(epochMs: number): string {
  return new Date(epochMs).toISOString().replace('T', ' ').slice(0, 19);
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
// /provider route auto|manual
// ---------------------------------------------------------------------------

function handleRoute(
  args: string[],
  context: CommandContext,
): void {
  const optimizer = getProviderOptimizer();
  const sub = args[0];

  if (sub !== 'auto' && sub !== 'manual') {
    context.print('[provider] Usage: /provider route auto|manual');
    context.print(`  Current mode: ${optimizer.mode} (optimizer ${optimizer.enabled ? 'on' : 'off'})`);
    return;
  }

  if (!optimizer.enabled) {
    context.print(
      '[provider] Optimizer is currently disabled. Enable it with the provider-optimizer feature flag.',
    );
    context.print(`  Routing mode set to: ${sub} (no-op until optimizer is enabled)`);
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

function handleExplainRoute(
  _args: string[],
  context: CommandContext,
): void {
  const optimizer = getProviderOptimizer();
  const provReg = context.providerRegistry;

  let currentModel;
  try {
    currentModel = provReg.getCurrentModel();
  } catch {
    context.print('[provider] No current model selected.');
    return;
  }

  context.print(
    `[provider] Route explanation for current model: ${currentModel.provider}/${currentModel.id}`,
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

function handlePin(
  args: string[],
  context: CommandContext,
): void {
  const optimizer = getProviderOptimizer();
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
  const models = context.providerRegistry.listModels();
  const match = models.find(
    (m) => m.provider === providerId && (m.id === modelId || m.registryKey === target),
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
    context.print('⚠ Optimizer was disabled — enabling it for pin to take effect.');
  }

  optimizer.pin(providerId, modelId);
  context.print(`[provider] Pinned → ${providerId}/${modelId}`);
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
  const optimizer = getProviderOptimizer();
  const sub = args[0];

  if (sub !== 'test') {
    context.print('[provider] Usage: /provider fallback test');
    return;
  }

  context.print('[provider] Simulating fallback chain (empty request profile — no requirements)...');

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
 * providerCommand — The `/provider` slash command.
 *
 * Routes to subcommand handlers based on args[0].
 */
export const providerCommand: SlashCommand = {
  name: 'provider-opt',
  aliases: ['prov-opt'],
  description: 'Manage provider routing optimizer (route, pin, explain, fallback).',
  usage: '<subcommand> [args]',
  argsHint: 'route|explain-route|pin|fallback',
  handler: (args: string[], context: CommandContext): void => {
    const [sub, ...rest] = args;

    switch (sub) {
      case 'route':
        handleRoute(rest, context);
        break;

      case 'explain-route':
      case 'explain':
        handleExplainRoute(rest, context);
        break;

      case 'pin':
        handlePin(rest, context);
        break;

      case 'fallback':
        handleFallbackTest(rest, context);
        break;

      default: {
        const optimizer = getProviderOptimizer();
        const lines = [
          'Usage: /provider <subcommand>',
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
