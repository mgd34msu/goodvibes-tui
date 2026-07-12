/**
 * Shell completion generator for the goodvibes CLI.
 *
 * Data derivation: the internal COMMAND_ALIASES, COMMANDS, OPTIONS, and
 * COMMAND_HELP constants in src/cli/completion.ts and src/cli/help.ts are
 * unexported, so they cannot be imported directly. The GoodVibesCliCommand
 * union type IS exported and is used here to produce a typed completion
 * surface. Flag names are derived from the parser logic visible in
 * src/cli/parser.ts (each `if (name === '--foo')` branch). Subcommands per
 * command are derived from the usage strings documented in help.ts's
 * COMMAND_HELP table (read-only reference; no mutation of existing files).
 *
 * Deferred wiring (one-line changes to existing files — NOT done here):
 *   src/cli/completion.ts: replace renderCompletion() body with
 *     ```
 *     import { generateCompletion } from './completions/generate.ts';
 *     const normalized = (shell === 'zsh' || shell === 'fish') ? shell : 'bash';
 *     return generateCompletion(normalized, binary);
 *     ```
 *   src/cli/entrypoint.ts (or wherever 'completion' command is dispatched):
 *     ensure `completions <shell>` subcommand routes to generateCompletion.
 *   package.json scripts (optional convenience):
 *     `"completions": "bun run src/cli/completions/generate.ts"` to write files.
 */

import type { GoodVibesCliCommand } from '../types.ts';

// ---------------------------------------------------------------------------
// Typed completion data surface
// ---------------------------------------------------------------------------

/** A flag definition for completion purposes. */
export interface CompletionFlag {
  /** Primary flag name, e.g. '--model' */
  readonly name: string;
  /** Short alias if any, e.g. '-m' */
  readonly short?: string;
  /** Additional aliases (long), e.g. '--working-dir' */
  readonly aliases?: readonly string[];
  /** Whether the flag takes a value argument */
  readonly takesValue: boolean;
  /** Enumerated completions for the flag value, if applicable */
  readonly valueEnum?: readonly string[];
  /** Human-readable description */
  readonly description: string;
}

/** Per-command completion metadata. */
export interface CompletionCommand {
  /** The canonical command name (matches GoodVibesCliCommand union) */
  readonly name: GoodVibesCliCommand;
  /** All tokens that map to this command (aliases included) */
  readonly aliases: readonly string[];
  /** One-line description */
  readonly description: string;
  /** Subcommand tokens accepted by this command */
  readonly subcommands: readonly string[];
}

/** Full CLI completion surface. */
export interface CompletionSurface {
  readonly binary: string;
  readonly commands: readonly CompletionCommand[];
  readonly globalFlags: readonly CompletionFlag[];
}

// ---------------------------------------------------------------------------
// Global flags
// Derived from parser.ts branch-by-branch inspection (each `if (name === ...)`).
// ---------------------------------------------------------------------------

export const GLOBAL_FLAGS: readonly CompletionFlag[] = [
  { name: '--help', short: '-h', takesValue: false, description: 'Print help' },
  { name: '--version', short: '-v', takesValue: false, description: 'Print version' },
  {
    name: '--model',
    short: '-m',
    takesValue: true,
    description: 'Override model (provider:model infers --provider)',
  },
  { name: '--provider', takesValue: true, description: 'Override provider' },
  {
    name: '--cd',
    short: '-C',
    aliases: ['--working-dir'],
    takesValue: true,
    description: 'Set working directory for this launch',
  },
  { name: '--daemon-home', takesValue: true, description: 'Override daemon home' },
  {
    name: '--config',
    short: '-c',
    takesValue: true,
    description: 'Override a config value (key=value)',
  },
  { name: '--enable', takesValue: true, description: 'Enable a feature flag for this launch' },
  { name: '--disable', takesValue: true, description: 'Disable a feature flag for this launch' },
  {
    name: '--prompt',
    short: '-p',
    takesValue: true,
    description: 'Run a non-interactive prompt',
  },
  { name: '--print', takesValue: false, description: 'Alias for non-interactive run mode' },
  {
    name: '--output',
    short: '-o',
    aliases: ['--output-format'],
    takesValue: true,
    valueEnum: ['text', 'json', 'stream-json'],
    description: 'Output format: text, json, or stream-json',
  },
  {
    name: '--json',
    takesValue: false,
    description: 'Alias for --output-format json',
  },
  {
    name: '--no-alt-screen',
    takesValue: false,
    description: 'Keep output in normal terminal scrollback',
  },
  { name: '--port', takesValue: true, description: 'Port for server/web commands' },
  { name: '--hostname', aliases: ['--host'], takesValue: true, description: 'Hostname for server/web commands' },
  { name: '--open', takesValue: false, description: 'Open browser when supported' },
  {
    name: '--resume',
    short: '-r',
    takesValue: true,
    description: 'Resume saved session (optional id or "latest")',
  },
  {
    name: '--session',
    short: '-s',
    takesValue: true,
    description: 'Use a specific session',
  },
  { name: '--continue', takesValue: false, description: 'Continue the latest session' },
  { name: '--fork', takesValue: false, description: 'Fork session when supported' },
  { name: '--yes', short: '-y', takesValue: false, description: 'Auto-confirm prompts (non-interactive)' },
  { name: '--non-interactive', takesValue: false, description: 'Disable all interactive prompts (implies --yes)' },
  { name: '--strict', takesValue: false, description: 'doctor: also fail on advisory findings, for CI' },
] as const;

// ---------------------------------------------------------------------------
// Command table
// Derived from GoodVibesCliCommand union + COMMAND_ALIASES in parser.ts +
// subcommand usage strings from COMMAND_HELP in help.ts.
// ---------------------------------------------------------------------------

export const COMPLETION_COMMANDS: readonly CompletionCommand[] = [
  {
    name: 'tui',
    aliases: ['tui', 'app'],
    description: 'Start the interactive TUI (default)',
    subcommands: [],
  },
  {
    name: 'run',
    aliases: ['run', 'exec', 'e'],
    description: 'Run non-interactively with text/json/stream-json output',
    subcommands: [],
  },
  {
    name: 'serve',
    aliases: ['serve', 'daemon', 'server'],
    description: 'Start the daemon/API host',
    subcommands: [],
  },
  {
    name: 'web',
    aliases: ['web'],
    description: 'Show browser surface bind URL and enablement',
    subcommands: [],
  },
  {
    name: 'service',
    aliases: ['service', 'services'],
    description: 'Inspect/manage daemon service lifecycle',
    subcommands: ['status', 'check', 'install', 'start', 'stop', 'restart', 'uninstall'],
  },
  {
    name: 'status',
    aliases: ['status'],
    description: 'Print config, provider, service, and onboarding posture',
    subcommands: [],
  },
  {
    name: 'doctor',
    aliases: ['doctor'],
    description: 'Print status plus setup warnings',
    subcommands: [],
  },
  {
    name: 'onboarding',
    aliases: ['onboarding', 'setup'],
    description: 'Open onboarding in the TUI, or print onboarding status',
    subcommands: ['status'],
  },
  {
    name: 'models',
    aliases: ['models', 'model'],
    description: 'List/use/pin selectable models and recent model history',
    subcommands: ['current', 'use', 'pin', 'recent'],
  },
  {
    name: 'providers',
    aliases: ['providers', 'provider'],
    description: 'List/inspect/use provider config/auth posture',
    subcommands: ['list', 'current', 'inspect', 'use'],
  },
  {
    name: 'auth',
    aliases: ['auth'],
    description: 'Inspect and manage local users, sessions, and bootstrap auth',
    subcommands: ['status', 'users', 'sessions', 'add-user', 'clear-bootstrap'],
  },
  {
    name: 'subscription',
    aliases: ['subscription', 'subscriptions'],
    description: 'Start/finish/logout provider subscription sessions',
    subcommands: ['list', 'providers', 'inspect', 'login', 'logout'],
  },
  {
    name: 'secrets',
    aliases: ['secrets', 'secret'],
    description: 'List, set, link, delete, and test GoodVibes secret refs',
    subcommands: ['list', 'providers', 'test', 'set', 'link', 'delete'],
  },
  {
    name: 'sessions',
    aliases: ['sessions', 'session'],
    description: 'List, show, export, or resume saved sessions',
    subcommands: ['list', 'show', 'export', 'resume'],
  },
  {
    name: 'tasks',
    aliases: ['tasks', 'task'],
    description: 'List/show in-process tasks or submit a non-interactive task',
    subcommands: ['list', 'show', 'submit'],
  },
  {
    name: 'pair',
    aliases: ['pair', 'qrcode', 'qr'],
    description: 'Print companion pairing payload and QR code',
    subcommands: [],
  },
  {
    name: 'surfaces',
    aliases: ['surfaces', 'surface'],
    description: 'Inspect/check/enable/disable browser/listener/external surfaces',
    subcommands: ['list', 'check', 'show', 'enable', 'disable'],
  },
  {
    name: 'listener',
    aliases: ['listener', 'http-listener', 'webhook'],
    description: 'Test HTTP listener/webhook readiness',
    subcommands: ['test'],
  },
  {
    name: 'control-plane',
    aliases: ['control-plane', 'controlplane', 'cp'],
    description: 'Inspect daemon auth, local admin, tokens, and ports',
    subcommands: ['status'],
  },
  {
    name: 'support-bundle',
    aliases: ['support-bundle', 'bundle', 'bundles'],
    description: 'Move a support snapshot (config + diagnostics + posture)',
    subcommands: ['export', 'inspect', 'import'],
  },
  {
    name: 'remote',
    aliases: ['remote'],
    description: 'Inspect remote runner/node posture',
    subcommands: [],
  },
  {
    name: 'bridge',
    aliases: ['bridge'],
    description: 'Bridge CLI operations (alias: remote)',
    subcommands: [],
  },
  {
    name: 'hooks',
    aliases: ['hooks', 'hook'],
    description: 'Validate hooks.json against the hook loader schema',
    subcommands: ['validate'],
  },
  {
    name: 'plugin',
    aliases: ['plugin', 'plugins'],
    description: 'Scaffold or validate a plugin directory',
    subcommands: ['init', 'validate'],
  },
  {
    name: 'completion',
    aliases: ['completion', 'completions'],
    description: 'Generate shell completion script',
    subcommands: ['bash', 'zsh', 'fish'],
  },
  {
    name: 'help',
    aliases: ['help'],
    description: 'Print help or command-specific help',
    subcommands: [],
  },
  {
    name: 'version',
    aliases: ['version'],
    description: 'Print version',
    subcommands: [],
  },
] satisfies readonly CompletionCommand[];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Collect every token that can appear as the first positional (all command aliases). */
export function allCommandTokens(commands: readonly CompletionCommand[]): readonly string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const cmd of commands) {
    for (const alias of cmd.aliases) {
      if (!seen.has(alias)) {
        seen.add(alias);
        result.push(alias);
      }
    }
  }
  return result;
}

/** Collect all flag names (primary + short + aliases) without duplicates. */
export function allFlagTokens(flags: readonly CompletionFlag[]): readonly string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const flag of flags) {
    for (const token of [
      flag.name,
      ...(flag.short !== undefined ? [flag.short] : []),
      ...(flag.aliases ?? []),
    ]) {
      if (!seen.has(token)) {
        seen.add(token);
        result.push(token);
      }
    }
  }
  return result;
}

/**
 * Return the CompletionSurface for the given binary name.
 * Callers use this to drive all three shell generator functions.
 */
export function buildCompletionSurface(binary = 'goodvibes'): CompletionSurface {
  return {
    binary,
    commands: COMPLETION_COMMANDS,
    globalFlags: GLOBAL_FLAGS,
  };
}

// ---------------------------------------------------------------------------
// Bash generator
// ---------------------------------------------------------------------------

export function generateBash(surface: CompletionSurface): string {
  const { binary, commands, globalFlags } = surface;
  const safeBin = binary.replace(/-/g, '_');
  const cmdTokens = allCommandTokens(commands);
  const flagTokens = allFlagTokens(globalFlags);

  const lines: string[] = [];

  lines.push(`# bash completion for ${binary}`);
  lines.push(`# Source this file or add to /etc/bash_completion.d/${binary}`);
  lines.push(`# Generated by: goodvibes completion bash`);
  lines.push('');

  // Subcommand-specific completion functions
  for (const cmd of commands) {
    if (cmd.subcommands.length === 0) continue;
    const fnName = `_${safeBin}_cmd_${cmd.name.replace(/-/g, '_')}`;
    lines.push(`${fnName}() {`);
    lines.push(`  local cur="\${COMP_WORDS[COMP_CWORD]}";`);
    lines.push(`  local subs="${cmd.subcommands.join(' ')}";`);
    lines.push(`  COMPREPLY=( $(compgen -W "$subs" -- "$cur") );`);
    lines.push(`}`);
    lines.push('');
  }

  // Output-format completion helper
  lines.push(`_${safeBin}_output_formats() {`);
  lines.push(`  local cur="\${COMP_WORDS[COMP_CWORD]}";`);
  lines.push(`  COMPREPLY=( $(compgen -W "text json stream-json" -- "$cur") );`);
  lines.push(`}`);
  lines.push('');

  // Main completion function
  lines.push(`_${safeBin}() {`);
  lines.push(`  local cur prev words cword;`);
  lines.push(`  _init_completion 2>/dev/null || {`);
  lines.push(`    cur="\${COMP_WORDS[COMP_CWORD]}";`);
  lines.push(`    prev="\${COMP_WORDS[COMP_CWORD-1]}";`);
  lines.push(`    words=("\${COMP_WORDS[@]}");`);
  lines.push(`    cword=$COMP_CWORD;`);
  lines.push(`  };`);
  lines.push('');

  // Flag-value completions
  lines.push(`  case "$prev" in`);
  lines.push(`    --output|--output-format|-o)`);
  lines.push(`      COMPREPLY=( $(compgen -W "text json stream-json" -- "$cur") );`);
  lines.push(`      return;;`);
  lines.push(`    --provider)`);
  lines.push(`      return;;`);
  lines.push(`    --model|-m)`);
  lines.push(`      return;;`);
  lines.push(`    --cd|--working-dir|-C|--daemon-home)`);
  lines.push(`      _filedir -d;`);
  lines.push(`      return;;`);
  lines.push(`    --port)`);
  lines.push(`      return;;`);
  lines.push(`    --hostname|--host)`);
  lines.push(`      return;;`);
  lines.push(`    --session|-s|--resume|-r)`);
  lines.push(`      return;;`);
  lines.push(`  esac`);
  lines.push('');

  // Subcommand routing
  lines.push(`  local cmd="";`);
  lines.push(`  local i;`);
  lines.push(`  for i in "\${!words[@]}"; do`);
  lines.push(`    if [[ $i -gt 0 ]] && [[ "\${words[$i]}" != -* ]]; then`);
  lines.push(`      cmd="\${words[$i]}";`);
  lines.push(`      break;`);
  lines.push(`    fi;`);
  lines.push(`  done;`);
  lines.push('');
  lines.push(`  case "$cmd" in`);

  for (const cmd of commands) {
    if (cmd.subcommands.length === 0) continue;
    const pattern = cmd.aliases.join('|');
    const fnName = `_${safeBin}_cmd_${cmd.name.replace(/-/g, '_')}`;
    lines.push(`    ${pattern}) ${fnName}; return;;`);
  }

  lines.push(`  esac`);
  lines.push('');

  // Top-level: commands + flags
  const all = [...cmdTokens, ...flagTokens].join(' ');
  lines.push(`  if [[ "$cur" == -* ]]; then`);
  lines.push(`    COMPREPLY=( $(compgen -W "${flagTokens.join(' ')}" -- "$cur") );`);
  lines.push(`  else`);
  lines.push(`    COMPREPLY=( $(compgen -W "${cmdTokens.join(' ')}" -- "$cur") );`);
  lines.push(`  fi;`);
  lines.push(`  # Allow file path completions to fall through when no match`);
  lines.push(`  [[ "\${#COMPREPLY[@]}" -eq 0 ]] && COMPREPLY=( $(compgen -W "${all}" -- "$cur") );`);
  lines.push(`}`);
  lines.push('');
  lines.push(`complete -F _${safeBin} ${binary}`);

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Zsh generator
// ---------------------------------------------------------------------------

export function generateZsh(surface: CompletionSurface): string {
  const { binary, commands, globalFlags } = surface;
  const safeBin = binary.replace(/-/g, '_');

  const lines: string[] = [];
  lines.push(`#compdef ${binary}`);
  lines.push(`# zsh completion for ${binary}`);
  lines.push(`# Source or symlink to a dir on $fpath, e.g. /usr/local/share/zsh/site-functions/_${binary}`);
  lines.push(`# Generated by: goodvibes completion zsh`);
  lines.push('');

  // Arguments spec
  const cmdArgs = allCommandTokens(commands)
    .map((tok) => {
      const cmd = commands.find((c) => c.aliases.includes(tok));
      const desc = cmd?.description ?? '';
      return `'${tok}:${desc.replace(/'/g, '')}'`;
    })
    .join(' ');

  lines.push(`_${safeBin}() {`);
  lines.push(`  local state;`);
  lines.push('');
  lines.push(`  _arguments \\`);
  lines.push(`    '(-h --help)'{-h,--help}'[Print help]' \\`);
  lines.push(`    '(-v --version)'{-v,--version}'[Print version]' \\`);
  lines.push(`    '(-m --model)'{-m,--model}'[Override model]:model:' \\`);
  lines.push(`    '--provider[Override provider]:provider:' \\`);
  lines.push(`    '(-C --cd --working-dir)'{-C,--cd}'[Set working directory]:dir:_files -/' \\`);
  lines.push(`    '--working-dir[Alias for --cd]:dir:_files -/' \\`);
  lines.push(`    '--daemon-home[Override daemon home]:dir:_files -/' \\`);
  lines.push(`    '(-c --config)'{-c,--config}'[Override config value]:key=value:' \\`);
  lines.push(`    '--enable[Enable feature flag]:feature:' \\`);
  lines.push(`    '--disable[Disable feature flag]:feature:' \\`);
  lines.push(`    '(-p --prompt)'{-p,--prompt}'[Run non-interactive prompt]:text:' \\`);
  lines.push(`    '--print[Non-interactive run mode]' \\`);
  lines.push(`    '(-o --output --output-format)'{-o,--output}'[Output format]:format:(text json stream-json)' \\`);
  lines.push(`    '--output-format[Output format alias]:format:(text json stream-json)' \\`);
  lines.push(`    '--json[Alias for --output-format json]' \\`);
  lines.push(`    '--no-alt-screen[Keep output in normal terminal scrollback]' \\`);
  lines.push(`    '--port[Port for server/web commands]:port:' \\`);
  lines.push(`    '--hostname[Hostname for server/web commands]:host:' \\`);
  lines.push(`    '--host[Hostname alias]:host:' \\`);
  lines.push(`    '--open[Open browser when supported]' \\`);
  lines.push(`    '(-r --resume)'{-r,--resume}'[Resume saved session]:id:' \\`);
  lines.push(`    '(-s --session)'{-s,--session}'[Use a specific session]:id:' \\`);
  lines.push(`    '--continue[Continue the latest session]' \\`);
  lines.push(`    '--fork[Fork session when supported]' \\`);
  lines.push(`    '(-y --yes)'{-y,--yes}'[Auto-confirm prompts]' \\`);
  lines.push(`    '--non-interactive[Disable all interactive prompts]' \\`);
  lines.push(`    '1:command:->cmd' \\`);
  lines.push(`    '*:args:->args';`);
  lines.push('');
  lines.push(`  case $state in`);
  lines.push(`    cmd)`);
  lines.push(`      local cmds;`);
  lines.push(`      cmds=(`);

  for (const cmd of commands) {
    const desc = cmd.description.replace(/'/g, '');
    lines.push(`        '${cmd.name}:${desc}'`);
  }

  lines.push(`      );`);
  lines.push(`      _describe 'command' cmds;`);
  lines.push(`      ;;`);
  lines.push(`    args)`);
  lines.push(`      case $words[2] in`);

  for (const cmd of commands) {
    if (cmd.subcommands.length === 0) continue;
    const pattern = cmd.aliases.join('|');
    const subs = cmd.subcommands.map((s) => `'${s}'`).join(' ');
    lines.push(`        ${pattern})`);
    lines.push(`          local sub_cmds=(${subs});`);
    lines.push(`          _describe 'subcommand' sub_cmds;;`);
  }

  lines.push(`      esac;`);
  lines.push(`      ;;`);
  lines.push(`  esac;`);
  lines.push(`}`);
  lines.push('');
  lines.push(`_${safeBin} "$@"`);

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Fish generator
// ---------------------------------------------------------------------------

export function generateFish(surface: CompletionSurface): string {
  const { binary, commands, globalFlags } = surface;
  const lines: string[] = [];

  lines.push(`# fish completion for ${binary}`);
  lines.push(`# Place in ~/.config/fish/completions/${binary}.fish or the fish data dir`);
  lines.push(`# Generated by: goodvibes completion fish`);
  lines.push('');

  // Disable default file completion
  lines.push(`complete -c ${binary} -f`);
  lines.push('');

  // Top-level commands (no subcommand context guard)
  for (const cmd of commands) {
    const desc = cmd.description.replace(/'/g, '').replace(/"/g, '');
    // Primary name
    lines.push(`complete -c ${binary} -n '__fish_use_subcommand' -a ${JSON.stringify(cmd.name)} -d ${JSON.stringify(desc)}`);
    // Aliases (excluding canonical which was just added)
    for (const alias of cmd.aliases) {
      if (alias === cmd.name) continue;
      lines.push(`complete -c ${binary} -n '__fish_use_subcommand' -a ${JSON.stringify(alias)} -d ${JSON.stringify(`Alias for ${cmd.name}`)}`);
    }
  }

  lines.push('');

  // Global flags
  for (const flag of globalFlags) {
    const longName = flag.name.replace(/^--/, '');
    const shortPart = flag.short !== undefined ? ` -s ${flag.short.replace(/^-/, '')}` : '';
    const valuePart = flag.takesValue ? '' : ' -f';
    // For flags with enumerated values, use -x (exclusive/no-files) and attach
    // -a per value directly on the same declaration line so fish can offer them
    // after the flag. __fish_seen_subcommand_from matches subcommand words, not
    // option flags, so a separate condition-gated line would be inert.
    const enumSuffix =
      flag.valueEnum !== undefined
        ? flag.valueEnum.map((v) => ` -a ${JSON.stringify(v)}`).join('')
        : '';
    const exclusivePart = flag.valueEnum !== undefined ? ' -x' : valuePart;

    lines.push(
      `complete -c ${binary} -l ${longName}${shortPart}${exclusivePart} -d ${JSON.stringify(flag.description)}${enumSuffix}`,
    );
  }

  lines.push('');

  // Subcommand completions
  for (const cmd of commands) {
    if (cmd.subcommands.length === 0) continue;
    const allAliases = cmd.aliases.join(' ');
    for (const sub of cmd.subcommands) {
      lines.push(
        `complete -c ${binary} -n '__fish_seen_subcommand_from ${allAliases}' -a ${JSON.stringify(sub)}`,
      );
    }
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Dispatcher — mirrors the existing renderCompletion(shell) API
// ---------------------------------------------------------------------------

/**
 * Generate a completion script for the given shell.
 * Returns the script text. Throws if shell is not recognized.
 */
export function generateCompletion(
  shell: 'bash' | 'zsh' | 'fish',
  binary = 'goodvibes',
): string {
  const surface = buildCompletionSurface(binary);
  switch (shell) {
    case 'bash': return generateBash(surface);
    case 'zsh': return generateZsh(surface);
    case 'fish': return generateFish(surface);
  }
}

// ---------------------------------------------------------------------------
// CLI entry-point (run via: bun run src/cli/completions/generate.ts [bash|zsh|fish])
// ---------------------------------------------------------------------------

if (import.meta.main) {
  const { mkdirSync, writeFileSync } = await import('node:fs');
  const { join } = await import('node:path');

  const shells = ['bash', 'zsh', 'fish'] as const;
  const outDir = 'completions';
  mkdirSync(outDir, { recursive: true });

  for (const shell of shells) {
    const script = generateCompletion(shell);
    const ext = shell === 'bash' ? 'bash' : shell === 'zsh' ? 'zsh' : 'fish';
    const filename = shell === 'zsh' ? `_goodvibes` : `goodvibes.${ext}`;
    const outPath = join(outDir, filename);
    writeFileSync(outPath, script + '\n', 'utf-8');
    process.stdout.write(`Wrote ${outPath}\n`);
  }
}
