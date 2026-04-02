/**
 * Classifier — assigns a CommandClassification to each command segment
 * and computes the highest-risk classification for a full command.
 *
 * Classification priority (highest → lowest):
 *   destructive > escalation > network > write > read
 *
 * Also detects dangerous shell patterns such as rm -rf, force-push, etc.
 */

import type {
  CommandClassification,
  CommandSegment,
  NormalizedCommand,
} from './types.ts';

// ── Classification sets ────────────────────────────────────────────────────────

/** Commands classified as read-only operations. */
const READ_COMMANDS = new Set([
  'cat', 'head', 'tail', 'less', 'more', 'bat',
  'grep', 'egrep', 'fgrep', 'rg', 'ag',
  'find', 'locate', 'which', 'whereis', 'type',
  'ls', 'dir', 'tree', 'du', 'df', 'stat', 'file',
  'wc', 'sort', 'uniq', 'cut',
  'diff', 'cmp', 'md5sum', 'sha256sum', 'shasum',
  'ps', 'top', 'htop', 'env', 'printenv', 'pwd', 'id', 'whoami',
  'date', 'uname', 'uptime',
]);

/** Git sub-commands that are read-only. */
const GIT_READ_SUBCOMMANDS = new Set([
  'log', 'status', 'diff', 'show', 'branch', 'tag',
  'describe', 'shortlog', 'reflog', 'blame', 'grep',
  'ls-files', 'ls-tree', 'rev-parse', 'cat-file',
]);

/** Commands classified as write operations. */
const WRITE_COMMANDS = new Set([
  'cp', 'mv', 'mkdir', 'touch', 'ln', 'chmod', 'chown', 'chgrp',
  'tee', 'install',
  'zip', 'unzip', 'tar', 'gzip', 'gunzip',
  'patch', 'sed', 'awk',
]);

/** Git sub-commands that are write operations. */
const GIT_WRITE_SUBCOMMANDS = new Set([
  'add', 'commit', 'merge', 'rebase', 'cherry-pick',
  'stash', 'apply', 'am', 'checkout', 'switch', 'restore',
  'init',
]);

/** npm / package manager sub-commands that are write operations. */
const NPM_WRITE_SUBCOMMANDS = new Set(['install', 'i', 'ci', 'update', 'uninstall', 'link', 'pack']);

/** Commands classified as network operations. */
const NETWORK_COMMANDS = new Set([
  'curl', 'wget', 'http', 'httpie', 'nc', 'netcat',
  'ssh', 'scp', 'sftp', 'rsync',
  'ftp', 'ftps', 'telnet',
  'ping', 'traceroute', 'nslookup', 'dig', 'host',
]);

/** Git sub-commands that involve network I/O. */
const GIT_NETWORK_SUBCOMMANDS = new Set(['push', 'fetch', 'pull', 'clone', 'remote']);

/** npm / package manager sub-commands that involve network I/O. */
const NPM_NETWORK_SUBCOMMANDS = new Set(['publish', 'deprecate']);

/** Commands classified as destructive operations. */
const DESTRUCTIVE_COMMANDS = new Set([
  'rm', 'rmdir', 'shred', 'wipe', 'wipefs',
  'mkfs', 'fdisk', 'parted', 'dd',
  'kill', 'killall', 'pkill',
  'truncate',
]);

/** SQL keywords indicating destructive database operations (used in pattern detection). */
const DESTRUCTIVE_SQL_PATTERNS = ['DROP ', 'DELETE ', 'TRUNCATE '];

/** Git sub-commands that are destructive when combined with certain flags. */
const GIT_DESTRUCTIVE_SUBCOMMANDS = new Set([
  'reset', 'clean', 'gc', 'prune', 'reflog',
]);

/** Commands that escalate privileges. */
const ESCALATION_COMMANDS = new Set([
  'sudo', 'su', 'doas', 'pkexec', 'runas',
  'docker', 'kubectl', 'helm', 'oc',
  'nsenter', 'unshare', 'chroot',
  'setuid', 'setgid',
]);

// ── Dangerous pattern detection ────────────────────────────────────────────────

interface DangerousPattern {
  /** Human-readable description of the pattern. */
  description: string;
  /** Returns true when the segment matches the pattern. */
  match: (seg: CommandSegment) => boolean;
}

const DANGEROUS_PATTERNS: DangerousPattern[] = [
  {
    description: 'rm -rf: recursive forced deletion',
    match: (seg) =>
      seg.command === 'rm' &&
      seg.flags.some((f) => f.includes('r') || f === '-r' || f === '--recursive') &&
      seg.flags.some((f) => f.includes('f') || f === '-f' || f === '--force'),
  },
  {
    description: 'rm -rf /: attempted root filesystem deletion',
    match: (seg) =>
      seg.command === 'rm' &&
      seg.flags.some((f) => f.includes('r')) &&
      seg.flags.some((f) => f.includes('f')) &&
      seg.args.some((a) => a === '/' || a === '/*'),
  },
  {
    description: 'git reset --hard: irreversible history rewrite',
    match: (seg) =>
      seg.command === 'git' &&
      seg.args[0] === 'reset' &&
      seg.flags.includes('--hard'),
  },
  {
    description: 'git clean -fd: removes untracked files and directories',
    match: (seg) =>
      seg.command === 'git' &&
      seg.args[0] === 'clean' &&
      seg.flags.some((f) => f.includes('f')),
  },
  {
    description: 'git push --force: force-pushes, may rewrite remote history',
    match: (seg) =>
      seg.command === 'git' &&
      seg.args[0] === 'push' &&
      (seg.flags.includes('--force') || seg.flags.includes('-f')),
  },
  {
    description: 'SQL DROP/DELETE/TRUNCATE: destructive database operation',
    match: (seg) =>
      DESTRUCTIVE_SQL_PATTERNS.some((pattern) =>
        seg.raw.toUpperCase().includes(pattern),
      ),
  },
  {
    description: 'sudo: command run with elevated privileges',
    match: (seg) => seg.command === 'sudo',
  },
  {
    description: 'docker exec: executing inside a container',
    match: (seg) =>
      seg.command === 'docker' && seg.args[0] === 'exec',
  },
  {
    description: 'kubectl exec: executing inside a Kubernetes pod',
    match: (seg) =>
      seg.command === 'kubectl' && seg.args[0] === 'exec',
  },
  {
    description: 'dd: raw disk write (potentially destructive)',
    match: (seg) => seg.command === 'dd',
  },
];

// ── Classification priority ────────────────────────────────────────────────────

/** Ordered priority: index 0 = highest risk. */
const CLASSIFICATION_PRIORITY: CommandClassification[] = [
  'destructive',
  'escalation',
  'network',
  'write',
  'read',
];

/**
 * Returns the higher-priority classification of two.
 *
 * @param a - First classification.
 * @param b - Second classification.
 * @returns The classification with higher risk priority.
 */
export function higherPriority(
  a: CommandClassification,
  b: CommandClassification,
): CommandClassification {
  const ai = CLASSIFICATION_PRIORITY.indexOf(a);
  const bi = CLASSIFICATION_PRIORITY.indexOf(b);
  return ai <= bi ? a : b;
}

/**
 * Classifies a single CommandSegment into a CommandClassification tier.
 *
 * For compound tools (git, npm, npx, yarn, pnpm, bun), the first positional
 * argument (sub-command) determines the sub-classification.
 *
 * @param seg - The command segment to classify.
 * @returns The CommandClassification for this segment.
 */
export function classifySegment(seg: CommandSegment): CommandClassification {
  const { command, args, flags } = seg;

  // ── Escalation check (highest priority) ─────────────────────────────────────
  // For sudo/doas/su, unwrap the inner command and take the higher-priority classification.
  const SUDO_LIKE = new Set(['sudo', 'doas', 'su']);
  if (SUDO_LIKE.has(command)) {
    const innerArgs = [...args];
    if (innerArgs.length > 0) {
      const innerCommand = innerArgs[0]!;
      const innerSeg: CommandSegment = {
        ...seg,
        command: innerCommand,
        args: innerArgs.slice(1),
      };
      const innerCls = classifySegment(innerSeg);
      return higherPriority(innerCls, 'escalation');
    }
    return 'escalation';
  }
  if (ESCALATION_COMMANDS.has(command)) return 'escalation';

  // ── git sub-command routing ─────────────────────────────────────────────────
  if (command === 'git') {
    const sub = args[0] ?? '';
    if (GIT_DESTRUCTIVE_SUBCOMMANDS.has(sub)) {
      // git reset --hard is always destructive; other git destructive cmds need flags
      if (sub === 'reset' && flags.includes('--hard')) return 'destructive';
      if (sub === 'clean') return 'destructive';
      // git reflog delete etc — treat as destructive
      if (sub === 'gc' || sub === 'prune') return 'destructive';
      // fallthrough to write for other cases (e.g. git reflog alone = read)
      if (sub === 'reflog' && args.length === 1) return 'read';
    }
    if (GIT_NETWORK_SUBCOMMANDS.has(sub)) return 'network';
    if (GIT_WRITE_SUBCOMMANDS.has(sub)) return 'write';
    if (GIT_READ_SUBCOMMANDS.has(sub)) return 'read';
    // Unknown git sub-command: treat as write (conservative)
    return 'write';
  }

  // ── npm / npx / yarn / pnpm / bun routing ───────────────────────────────────
  const isPackageManager = ['npm', 'npx', 'yarn', 'pnpm', 'bun'].includes(command);
  if (isPackageManager) {
    const sub = args[0] ?? '';
    if (NPM_NETWORK_SUBCOMMANDS.has(sub)) return 'network';
    if (NPM_WRITE_SUBCOMMANDS.has(sub)) return 'write';
    // run, exec, x, dlx — treat as write (executes code)
    if (sub === 'run' || sub === 'exec' || sub === 'x' || sub === 'dlx') return 'write';
    // info, view, list, ls, audit, outdated — read
    if (['info', 'view', 'list', 'ls', 'audit', 'outdated'].includes(sub)) return 'read';
    return 'write'; // conservative default
  }

  // ── Destructive commands ─────────────────────────────────────────────────────
  if (DESTRUCTIVE_COMMANDS.has(command)) return 'destructive';

  // ── Network commands ─────────────────────────────────────────────────────────
  if (NETWORK_COMMANDS.has(command)) return 'network';

  // ── Write commands ───────────────────────────────────────────────────────────
  if (WRITE_COMMANDS.has(command)) return 'write';

  // ── Read commands ────────────────────────────────────────────────────────────
  if (READ_COMMANDS.has(command)) return 'read';

  // ── echo/printf: redirect makes it a write, otherwise read ─────────────────────
  if (command === 'echo' || command === 'printf') {
    return seg.tokens.some((t) => t.type === 'redirect') ? 'write' : 'read';
  }

  // Unknown command: conservative default — write
  return 'write';
}

/**
 * Classifies a full normalized command, computing the union of classifications
 * across all segments and the highest-risk tier.
 *
 * @param original - The original command string.
 * @param segments - The command segments to classify.
 * @returns A partial NormalizedCommand (without the original field, for composability).
 */
export function classifyCommand(
  original: string,
  segments: CommandSegment[],
): Omit<NormalizedCommand, 'original' | 'segments'> {
  if (segments.length === 0) {
    return {
      classifications: ['read'],
      highestClassification: 'read',
      hasDangerousPatterns: false,
    };
  }

  const classificationSet = new Set<CommandClassification>();
  let highest: CommandClassification = 'read';

  for (const seg of segments) {
    const cls = classifySegment(seg);
    classificationSet.add(cls);
    highest = higherPriority(highest, cls);
  }

  // ── Dangerous pattern detection ──────────────────────────────────────────────
  const matched: string[] = [];
  for (const seg of segments) {
    for (const pattern of DANGEROUS_PATTERNS) {
      if (pattern.match(seg)) {
        matched.push(pattern.description);
      }
    }
  }

  const hasDangerousPatterns = matched.length > 0;

  return {
    classifications: Array.from(classificationSet),
    highestClassification: highest,
    hasDangerousPatterns,
    ...(hasDangerousPatterns ? { dangerousPatterns: matched } : {}),
  };
}
