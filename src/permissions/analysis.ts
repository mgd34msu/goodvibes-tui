import { normalizeCommandWithVerdicts } from '../runtime/permissions/normalization/index.ts';
import { classifyHostTrustTier, extractHostname } from '../tools/fetch/trust-tiers.ts';
import type {
  PermissionCategory,
  PermissionRequestAnalysis,
  PermissionRiskLevel,
} from './types.ts';

function truncatePreview(value: string, limit = 120): string {
  return value.length <= limit ? value : `${value.slice(0, limit - 3)}...`;
}

function cleanReasons(values: readonly string[]): string[] {
  const deduped = new Set<string>();
  for (const value of values) {
    const trimmed = value.trim();
    if (trimmed.length > 0) deduped.add(trimmed);
    if (deduped.size >= 3) break;
  }
  return Array.from(deduped);
}

function riskFromClassification(classification: string): PermissionRiskLevel {
  switch (classification) {
    case 'read':
      return 'low';
    case 'write':
    case 'network':
      return 'medium';
    case 'escalation':
      return 'high';
    case 'destructive':
      return 'critical';
    default:
      return 'high';
  }
}

const SECRET_NAME_PATTERN = /\b(api[_-]?key|token|secret|password|passwd|private[_-]?key|authorization)\b/i;
const INLINE_SECRET_PATTERN =
  /\b(Bearer\s+[A-Za-z0-9._-]{12,}|ghp_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9]{12,}|AIza[0-9A-Za-z_-]{16,}|xox[baprs]-[A-Za-z0-9-]{10,})\b/;

function detectSecretExposure(command: string): string[] {
  const warnings: string[] = [];
  if (SECRET_NAME_PATTERN.test(command)) {
    warnings.push('Command references secret or credential material.');
  }
  if (INLINE_SECRET_PATTERN.test(command)) {
    warnings.push('Command appears to contain an inline credential or token value.');
  }
  if (/curl\s+.*authorization[:=]/i.test(command) || /-H\s+["']?Authorization:/i.test(command)) {
    warnings.push('Command includes an explicit Authorization header.');
  }
  if (/echo\s+.*(api[_-]?key|token|secret|password)/i.test(command)) {
    warnings.push('Command may print secret material into logs or terminal output.');
  }
  return warnings;
}

function pathLooksSensitive(path: string): boolean {
  return /(^|\/)(\.env(\..+)?)$|(^|\/)(id_rsa|id_ed25519|known_hosts|authorized_keys)$|\.pem$|\.p12$|credentials|secrets?/i.test(path);
}

function analyzeExec(args: Record<string, unknown>): PermissionRequestAnalysis {
  const command =
    typeof args['command'] === 'string'
      ? args['command']
      : typeof args['cmd'] === 'string'
        ? args['cmd']
        : '';

  if (command.length === 0) {
    return {
      classification: 'write',
      riskLevel: 'high',
      summary: 'Execute shell command',
      reasons: ['Shell execution can mutate files, spawn processes, or access the network.'],
      target: '',
      targetKind: 'command',
      surface: 'shell',
      blastRadius: 'project',
      sideEffects: ['process execution', 'filesystem mutation', 'possible network access'],
    };
  }

  const verdict = normalizeCommandWithVerdicts(command);
  const classification = verdict.highestClassification;
  const reasons = cleanReasons([
    verdict.denialExplanation ?? '',
    ...verdict.segments.filter((segment) => !segment.allowed || segment.hasObfuscation).map((segment) => segment.reason),
    ...verdict.segments.flatMap((segment) => segment.obfuscationPatterns),
    ...detectSecretExposure(command),
  ]);

  const secretWarnings = detectSecretExposure(command);
  const riskLevel = secretWarnings.length > 0
    ? 'critical'
    : verdict.allowed && !verdict.hasObfuscation
      ? riskFromClassification(classification)
      : classification === 'destructive'
        ? 'critical'
        : 'high';

  return {
    classification,
    riskLevel,
    summary:
      classification === 'destructive'
        ? 'Execute destructive shell command'
        : classification === 'escalation'
          ? 'Execute privileged or delegated shell command'
          : classification === 'network'
            ? 'Execute networked shell command'
            : classification === 'write'
              ? 'Execute shell command with write-capable effects'
              : 'Execute read-only shell command',
    reasons:
      reasons.length > 0
        ? reasons
        : [`Highest detected shell risk: ${classification}.`],
    target: truncatePreview(command),
    targetKind: 'command',
    surface: 'shell',
    blastRadius:
      secretWarnings.length > 0 || classification === 'destructive'
        ? 'platform'
        : classification === 'network'
          ? 'external'
          : 'project',
    sideEffects: cleanReasons([
      classification === 'network' ? 'outbound network access' : '',
      classification === 'write' || classification === 'destructive' ? 'filesystem mutation' : '',
      classification === 'escalation' || classification === 'destructive' ? 'privileged or chained execution' : '',
      'process execution',
    ]),
  };
}

function analyzeFetch(args: Record<string, unknown>): PermissionRequestAnalysis {
  const rawUrl =
    typeof args['url'] === 'string'
      ? args['url']
      : typeof args['endpoint'] === 'string'
        ? args['endpoint']
        : '';
  const host = rawUrl.length > 0 ? extractHostname(rawUrl) : null;
  const trust = host ? classifyHostTrustTier(host) : null;

  const reasons = cleanReasons([
    host ? `Target host: ${host}` : '',
    trust ? `Host trust tier: ${trust.tier} (${trust.reason})` : '',
  ]);

  return {
    classification: 'network',
    riskLevel:
      trust?.tier === 'blocked'
        ? 'critical'
        : trust?.tier === 'unknown'
          ? 'medium'
          : 'low',
    summary: host ? `Fetch remote resource from ${host}` : 'Fetch remote resource',
    reasons:
      reasons.length > 0
        ? reasons
        : ['Outbound network access can disclose local context and pull remote content into the session.'],
    target: truncatePreview(rawUrl),
    targetKind: 'url',
    surface: 'network',
    blastRadius: 'external',
    sideEffects: cleanReasons([
      'outbound network access',
      'remote content ingestion',
      trust?.tier === 'unknown' || trust?.tier === 'blocked' ? 'untrusted host interaction' : '',
    ]),
    host: host ?? undefined,
  };
}

function analyzePathTool(
  toolName: string,
  args: Record<string, unknown>,
  category: PermissionCategory,
): PermissionRequestAnalysis {
  const path =
    typeof args['path'] === 'string'
      ? args['path']
      : typeof args['file'] === 'string'
        ? args['file']
        : '';

  return {
    classification: category === 'write' ? 'write' : 'read',
    riskLevel: category === 'write' ? (pathLooksSensitive(path) ? 'high' : 'medium') : 'low',
    summary:
      category === 'write'
        ? `Modify local file or project state via ${toolName}`
        : `Read local project state via ${toolName}`,
    reasons: cleanReasons([
      category === 'write'
        ? 'This action can modify files or other local project state.'
        : 'This action is read-oriented and does not directly mutate project state.',
      pathLooksSensitive(path) ? 'Target path looks like a secret or credential file.' : '',
    ]),
    target: path,
    targetKind: 'path',
    surface: 'filesystem',
    blastRadius: pathLooksSensitive(path) ? 'platform' : 'project',
    sideEffects: cleanReasons([
      category === 'write' ? 'filesystem mutation' : 'filesystem read',
      pathLooksSensitive(path) ? 'possible secret exposure' : '',
    ]),
  };
}

function analyzeDelegate(
  toolName: string,
  args: Record<string, unknown>,
): PermissionRequestAnalysis {
  const task =
    typeof args['task'] === 'string'
      ? args['task']
      : typeof args['name'] === 'string'
        ? args['name']
        : typeof args['prompt'] === 'string'
          ? args['prompt']
          : '';

  return {
    classification: 'escalation',
    riskLevel: 'high',
    summary: `Delegate work through ${toolName}`,
    reasons: ['Delegated execution can fan out work, tools, and side effects beyond the current step.'],
    target: truncatePreview(task),
    targetKind: 'task',
    surface: 'orchestration',
    blastRadius: 'delegated',
    sideEffects: ['delegated execution', 'task fan-out', 'tool-capability inheritance'],
  };
}

export function analyzePermissionRequest(
  toolName: string,
  args: Record<string, unknown>,
  category: PermissionCategory,
): PermissionRequestAnalysis {
  if (toolName === 'exec') return analyzeExec(args);
  if (toolName === 'fetch') return analyzeFetch(args);
  if (category === 'write' || category === 'read') return analyzePathTool(toolName, args, category);
  if (category === 'delegate') return analyzeDelegate(toolName, args);

  return {
    classification: category,
    riskLevel: 'high',
    summary: `Request permission for ${toolName}`,
    reasons: ['Review the target and intent before approving this action.'],
    targetKind: 'generic',
    surface: 'shell',
    blastRadius: 'project',
  };
}
