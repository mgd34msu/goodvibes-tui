import type { ConfigManager } from '@pellux/goodvibes-sdk/platform/config';
import { PermissionManager, createPermissionConfigReader } from '@pellux/goodvibes-sdk/platform/permissions';
import type { PermissionCategory, PermissionCheckResult } from '@pellux/goodvibes-sdk/platform/permissions';
import { PolicyRuntimeState, createFeatureFlagManager, deriveFeatureStates } from '@/runtime/index.ts';
import { getProviderIdFromModel } from '../config/provider-model.ts';
import type { CliCommandOutput } from './types.ts';
import type { GoodVibesCliOutputFormat } from './types.ts';
import { buildHooksValidation } from './hooks-report.ts';

// ---------------------------------------------------------------------------
// `goodvibes doctor <explain|routing|hooks>` — the diagnostician subcommands.
// Each one explains a decision the platform already makes, reading the LIVE
// config and reusing the platform's OWN decision machinery. None of them
// changes config or fires a real action:
//   explain  — walks the real PermissionManager to say why a tool/command
//              would be allowed / asked / denied under the current mode.
//   routing  — prints which model/provider serves which role, from live config.
//   hooks    — lists registered hooks, from where, and their validation status
//              (reuses the hooks-validate core in hooks-report.ts).
// ---------------------------------------------------------------------------

export interface DoctorSubcommandOptions {
  readonly subcommand: string;
  readonly args: readonly string[];
  readonly configManager: ConfigManager;
  readonly workingDirectory: string;
  readonly homeDirectory: string;
  readonly outputFormat?: GoodVibesCliOutputFormat;
}

/** The tool names the platform's PermissionManager recognizes (from its TOOL_CATEGORIES/TOOL_CONFIG_KEYS). */
const KNOWN_TOOLS = new Set([
  'read', 'find', 'fetch', 'analyze', 'inspect', 'state', 'registry', 'goodvibes_context', 'repo_map',
  'write', 'edit', 'goodvibes_settings', 'exec', 'agent', 'delegate', 'workflow', 'mcp',
]);
/** Tools whose primary display/decision argument is a filesystem path rather than a command. */
const PATH_TOOLS = new Set(['read', 'write', 'edit', 'find', 'fetch', 'analyze', 'inspect', 'state', 'registry']);

/** The permission-mode → human label map (matches the doctor/status wording). */
function permissionModeLabel(mode: unknown): string {
  if (mode === 'prompt') return 'Ask before powerful actions';
  if (mode === 'allow-all') return 'Allow everything';
  if (mode === 'plan') return 'Plan only (read-only)';
  if (mode === 'accept-edits') return 'Auto-accept file edits';
  if (mode === 'custom') return 'Custom rules';
  return String(mode ?? 'unknown');
}

/**
 * Turn the `explain` argument list into the tool+args shape the
 * PermissionManager evaluates. A bare recognized tool name is taken as that
 * tool (with any remainder as its path/command arg); anything else is treated
 * as a shell command run through the `exec` tool.
 */
function resolveExplainTarget(args: readonly string[]): { tool: string; args: Record<string, unknown>; interpretation: string } {
  const first = args[0] ?? '';
  if (KNOWN_TOOLS.has(first)) {
    const remainder = args.slice(1).join(' ').trim();
    if (remainder.length === 0) {
      return { tool: first, args: {}, interpretation: `recognized tool "${first}" (no target argument)` };
    }
    if (first === 'exec') {
      return { tool: 'exec', args: { command: remainder }, interpretation: `tool "exec" running command: ${remainder}` };
    }
    if (PATH_TOOLS.has(first)) {
      return { tool: first, args: { path: remainder }, interpretation: `tool "${first}" targeting path: ${remainder}` };
    }
    return { tool: first, args: { command: remainder }, interpretation: `tool "${first}" with argument: ${remainder}` };
  }
  const command = args.join(' ').trim();
  return { tool: 'exec', args: { command }, interpretation: `shell command run through the "exec" tool: ${command}` };
}

/** The ordered permission layers the PermissionManager consults, for the explainer's narrative. */
const LAYER_NAMES: readonly string[] = [
  'Auto-approve override (behavior.autoApprove / --no-worries-just-vibes)',
  'Session permission mode (permissions.mode)',
  'Runtime policy engine (feature flag: permissions-policy-engine)',
  'Per-tool config rule (permissions.tools.<tool>)',
  'Default read auto-approve (prompt mode)',
  'Session approval cache (remembered [A] decisions)',
  'Human approval prompt (Human-in-the-Loop)',
];

/**
 * Which layer index (into LAYER_NAMES) actually decided, inferred from the
 * PermissionManager's own sourceLayer + reasonCode. The verdict itself is the
 * platform's; this only positions the marker in the narrative.
 */
function decidedLayerIndex(result: PermissionCheckResult, mode: string, autoApprove: boolean, category: PermissionCategory): number {
  switch (result.sourceLayer) {
    case 'user_prompt': return 6;
    case 'session_override': return 5;
    case 'safety_check':
    case 'managed_policy': return 2;
    case 'runtime_mode': return 1;
    case 'config_policy':
      if (result.reasonCode === 'config_allow') {
        if (autoApprove) return 0;
        if (mode === 'custom') return 3;
        if (category === 'read') return 4;
        return 3;
      }
      return 3; // config_deny → custom per-tool rule
    default: return 6;
  }
}

/** The authoritative ALLOW / ASK / DENY verdict from a PermissionManager result. */
function verdictOf(result: PermissionCheckResult): 'ALLOW' | 'ASK' | 'DENY' {
  if (result.sourceLayer === 'user_prompt') return 'ASK';
  return result.approved ? 'ALLOW' : 'DENY';
}

/** A plain-language "because" line keyed off the platform's own reasonCode. */
function reasonExplanation(result: PermissionCheckResult, mode: string, toolKey: string): string {
  switch (result.reasonCode) {
    case 'config_allow':
      if (mode === 'custom') return `The per-tool rule permissions.tools.${toolKey} is set to "allow".`;
      if (result.sourceLayer === 'config_policy' && result.analysis.classification === 'read') return 'Read-class tools are auto-approved in the default "prompt" mode.';
      return 'Auto-approve is active (behavior.autoApprove), so this call is approved without a prompt.';
    case 'config_deny': return `The per-tool rule permissions.tools.${toolKey} is set to "deny".`;
    case 'mode_allow_all':
      if (mode === 'plan') return 'Plan mode allows read-class tools.';
      if (mode === 'accept-edits') return 'Accept-edits mode allows read-class tools.';
      return 'Permission mode is "allow-all" — every tool call is auto-approved.';
    case 'mode_denied': return 'The active permission mode denies this tool class.';
    case 'plan_mode': return 'Plan mode refuses mutating / execute / delegate tools and steers the model to present a plan instead.';
    case 'mode_accept_edits': return 'Accept-edits mode auto-approves file write/edit tools.';
    case 'managed_policy_allow': return 'A runtime policy rule allowed this call.';
    case 'managed_policy_deny': return 'A runtime policy rule denied this call.';
    case 'safety_guardrail': return 'A safety guardrail blocked this call.';
    case 'session_cached_allow': return 'A remembered session decision ([A] allow-always) approves this call.';
    case 'session_cached_deny': return 'A remembered session decision denies this call.';
    case 'user_approved':
    case 'user_denied': return 'This reaches a Human-in-the-Loop approval prompt — the outcome depends on your response at the prompt.';
    default: return 'Decided by the platform permission machinery.';
  }
}

/** Stable per-tool config key for the explain narrative (mirrors the SDK's TOOL_CONFIG_KEYS defaults). */
function toolConfigKey(tool: string): string {
  const map: Record<string, string> = {
    goodvibes_context: 'state', goodvibes_settings: 'write', repo_map: 'read',
  };
  return map[tool] ?? tool;
}

async function explain(options: DoctorSubcommandOptions): Promise<CliCommandOutput> {
  const json = options.outputFormat === 'json';
  const { args } = options;
  if (args.length === 0) {
    return { output: 'Usage: goodvibes doctor explain <tool-name | shell command>', exitCode: 2 };
  }
  const config = options.configManager;
  const target = resolveExplainTarget(args);
  const mode = String(config.get('permissions.mode') ?? 'prompt');
  const autoApprove = config.get('behavior.autoApprove') === true;

  // Reuse the platform's OWN PermissionManager. A requestPermission handler that
  // returns a denial lets the machinery run to its real terminal layer without
  // actually prompting; sourceLayer 'user_prompt' is then reported as ASK.
  // Feature flags come from live config so the policy engine layer is walked
  // exactly when the running app would walk it.
  const featureFlags = createFeatureFlagManager();
  featureFlags.loadFromConfig({ flags: deriveFeatureStates(config) });
  const policyEngineOn = featureFlags.isEnabled('permissions-policy-engine');
  const policyRuntimeState = new PolicyRuntimeState();
  const manager = new PermissionManager(
    async () => ({ approved: false, remember: false }),
    createPermissionConfigReader(config),
    policyRuntimeState,
    null,
    featureFlags,
  );

  const category = manager.getCategory(target.tool, target.args);
  const result = await manager.checkDetailed(target.tool, target.args);
  const verdict = verdictOf(result);
  const decidedIdx = decidedLayerIndex(result, mode, autoApprove, category);
  const toolKey = toolConfigKey(target.tool);
  const because = reasonExplanation(result, mode, toolKey);

  if (json) {
    return {
      output: JSON.stringify({
        subject: args.join(' '),
        tool: target.tool,
        category,
        args: target.args,
        mode,
        autoApprove,
        policyEngine: policyEngineOn ? 'enabled' : 'disabled',
        verdict,
        decidedLayer: LAYER_NAMES[decidedIdx],
        sourceLayer: result.sourceLayer,
        reasonCode: result.reasonCode,
        because,
        analysis: result.analysis,
      }, null, 2),
      exitCode: 0,
    };
  }

  const a = result.analysis;
  const lines: string[] = [
    'GoodVibes doctor — explain permission decision',
    `  subject     : ${args.join(' ')}`,
    `  resolved as : ${target.interpretation}`,
    `  tool        : ${target.tool}  (category: ${category})`,
    `  args         : ${JSON.stringify(target.args)}`,
    '',
    'Current settings:',
    `  mode        : ${mode} (${permissionModeLabel(mode)})`,
    `  autoApprove : ${autoApprove ? 'yes (behavior.autoApprove)' : 'no'}`,
    `  policyEngine: ${policyEngineOn ? 'enabled' : 'disabled'} (feature flag permissions-policy-engine)`,
    '',
    'Analysis (from the platform analyzer):',
    `  risk        : ${a.riskLevel.toUpperCase()} (${a.classification})`,
    ...(a.surface || a.blastRadius ? [`  surface     : ${a.surface ?? 'generic'}${a.blastRadius ? `  radius=${a.blastRadius}` : ''}`] : []),
    `  summary     : ${a.summary}`,
    ...a.reasons.slice(0, 3).map((r) => `  reason      : ${r}`),
    '',
    'Layers walked (priority order — the platform PermissionManager decides; this shows the order it walks):',
    ...LAYER_NAMES.map((name, i) => `  ${i === decidedIdx ? '▶' : ' '} ${i + 1}. ${name}${i === decidedIdx ? '   ← DECIDED HERE' : ''}`),
    '',
    `Decision: ${verdict}`,
    `  decided by : ${result.sourceLayer} (${result.reasonCode})`,
    `  because    : ${because}`,
  ];
  if (policyEngineOn) {
    lines.push('  note        : the runtime policy engine is enabled, but a one-shot diagnostic loads no promoted policy bundle, so its rule set is empty here.');
  }
  return { output: lines.join('\n'), exitCode: 0 };
}

/** One routed role: which provider+model the live config assigns to it, and the keys that carry it. */
interface RoutingRole {
  readonly role: string;
  readonly enabled: boolean | null;
  readonly provider: string;
  readonly model: string;
  readonly keys: readonly string[];
  readonly note?: string;
}

function buildRoutingRoles(config: ConfigManager): RoutingRole[] {
  const mainModel = String(config.get('provider.model') ?? '');
  const mainProvider = getProviderIdFromModel(mainModel);
  const emptyProvider = (p: string): string => (p.length > 0 ? p : `(inherits main: ${mainProvider})`);

  const toolProvider = String(config.get('tools.llmProvider') ?? '');
  const toolModel = String(config.get('tools.llmModel') ?? '');
  const helperProvider = String(config.get('helper.globalProvider') ?? '');
  const helperModel = String(config.get('helper.globalModel') ?? '');
  const ttsProvider = String(config.get('tts.llmProvider') ?? '');
  const ttsModel = String(config.get('tts.llmModel') ?? '');

  return [
    {
      role: 'Conversation (main model)',
      enabled: null,
      provider: mainProvider,
      model: mainModel || '(unset)',
      keys: ['provider.model', 'provider.reasoningEffort'],
      note: `reasoningEffort=${String(config.get('provider.reasoningEffort') ?? '')}`,
    },
    {
      role: 'Embeddings',
      enabled: null,
      provider: String(config.get('provider.embeddingProvider') ?? '') || `(inherits main: ${mainProvider})`,
      model: '(provider default)',
      keys: ['provider.embeddingProvider'],
    },
    {
      role: 'Tool LLM (grunt tool work)',
      enabled: config.get('tools.llmEnabled') === true,
      provider: emptyProvider(toolProvider),
      model: toolModel || '(unset)',
      keys: ['tools.llmEnabled', 'tools.llmProvider', 'tools.llmModel'],
      ...(config.get('tools.llmEnabled') === true ? {} : { note: 'disabled — no tool-LLM route active' }),
    },
    {
      role: 'Helper (cache/compaction/commit-message/etc.)',
      enabled: config.get('helper.enabled') === true,
      provider: emptyProvider(helperProvider),
      model: helperModel || '(unset)',
      keys: ['helper.enabled', 'helper.globalProvider', 'helper.globalModel'],
      ...(config.get('helper.enabled') === true ? {} : { note: 'disabled — helper tasks stay on the main model' }),
    },
    {
      role: 'Narration LLM (TTS phrasing)',
      enabled: null,
      provider: emptyProvider(ttsProvider),
      model: ttsModel || '(unset)',
      keys: ['tts.llmProvider', 'tts.llmModel'],
      note: `engine=${String(config.get('tts.provider') ?? '(unset)')}`,
    },
  ];
}

function routing(options: DoctorSubcommandOptions): CliCommandOutput {
  const config = options.configManager;
  const roles = buildRoutingRoles(config);
  if (options.outputFormat === 'json') {
    return { output: JSON.stringify({ roles }, null, 2), exitCode: 0 };
  }
  const lines: string[] = [
    'GoodVibes doctor — model / provider routing (live config)',
    '',
  ];
  for (const role of roles) {
    const state = role.enabled === null ? '' : role.enabled ? ' [on]' : ' [off]';
    lines.push(`  ${role.role}${state}`);
    lines.push(`    provider : ${role.provider}`);
    lines.push(`    model    : ${role.model}`);
    if (role.note) lines.push(`    note     : ${role.note}`);
    lines.push(`    from     : ${role.keys.join(', ')}`);
    lines.push('');
  }
  return { output: lines.join('\n').replace(/\n+$/, ''), exitCode: 0 };
}

function hooks(options: DoctorSubcommandOptions): CliCommandOutput {
  const report = buildHooksValidation(options.configManager);
  if (options.outputFormat === 'json') {
    return {
      output: JSON.stringify({
        path: report.path,
        present: report.present,
        valid: report.valid,
        reason: report.reason ?? null,
        topLevelIssues: report.topLevelIssues,
        hooks: report.checks.map((c) => ({ pattern: c.pattern, index: c.index, name: c.name, type: c.type, source: report.path, ok: c.ok, reason: c.reason ?? null, contract: c.contract ? { authority: c.contract.authority, executionMode: c.contract.executionMode } : null })),
        chains: report.chains,
      }, null, 2),
      exitCode: report.valid ? 0 : 1,
    };
  }

  const lines: string[] = [
    'GoodVibes doctor — registered hooks',
    `  source file : ${report.path}`,
  ];
  if (!report.present) {
    lines.push('  no hooks file present — nothing registered.');
    return { output: lines.join('\n'), exitCode: 0 };
  }
  if (report.reason && report.checks.length === 0 && report.topLevelIssues.length === 0) {
    lines.push(`  FAIL: ${report.reason}`);
    return { output: lines.join('\n'), exitCode: 1 };
  }
  lines.push(`  registered  : ${report.checks.length} hook(s), ${report.chains.accepted} chain(s) accepted`);
  lines.push(`  validation  : ${report.passCount} pass, ${report.failCount} problem(s)`);
  lines.push('');
  for (const issue of report.topLevelIssues) lines.push(`  FAIL (file): ${issue}`);
  for (const check of report.checks) {
    const status = check.ok ? 'PASS' : 'FAIL';
    lines.push(`  [${status}] ${check.pattern} #${check.index} ${check.name} (type: ${check.type})`);
    lines.push(`         from: ${report.path}`);
    if (check.ok && check.contract) {
      lines.push(`         contract: ${check.contract.authority}/${check.contract.executionMode} (deny=${check.contract.canDeny ? 'yes' : 'no'})`);
    } else if (!check.ok) {
      lines.push(`         reason: ${check.reason}`);
    }
  }
  if (report.chains.declared > 0 || report.chains.accepted > 0) {
    lines.push('');
    lines.push(`  chains: ${report.chains.declared} declared, ${report.chains.accepted} accepted by the loader`);
  }
  lines.push('');
  lines.push(report.valid ? '  result: all registered hooks are valid.' : `  result: ${report.failCount} problem(s) found.`);
  return { output: lines.join('\n'), exitCode: report.valid ? 0 : 1 };
}

/** Route a `doctor <sub>` invocation. Returns null when <sub> is not a doctor subcommand (caller renders the classic doctor report). */
export async function handleDoctorSubcommand(options: DoctorSubcommandOptions): Promise<CliCommandOutput | null> {
  switch (options.subcommand) {
    case 'explain': return explain(options);
    case 'routing': return routing(options);
    case 'hooks': return hooks(options);
    default: return null;
  }
}
