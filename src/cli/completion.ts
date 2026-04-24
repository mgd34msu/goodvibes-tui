const COMMANDS = [
  'tui',
  'run',
  'exec',
  'serve',
  'web',
  'service',
  'onboarding',
  'setup',
  'doctor',
  'status',
  'models',
  'providers',
  'auth',
  'subscription',
  'secrets',
  'sessions',
  'tasks',
  'pair',
  'qrcode',
  'surfaces',
  'listener',
  'control-plane',
  'bundle',
  'remote',
  'bridge',
  'completion',
  'version',
  'help',
] as const;

const OPTIONS = [
  '--help',
  '--version',
  '--model',
  '--provider',
  '--cd',
  '--working-dir',
  '--daemon-home',
  '--config',
  '--enable',
  '--disable',
  '--prompt',
  '--print',
  '--output',
  '--output-format',
  '--json',
  '--no-alt-screen',
  '--port',
  '--hostname',
  '--open',
  '--resume',
  '--session',
  '--continue',
  '--fork',
  '--password',
  '--password-stdin',
  '--role',
  '--manual',
] as const;

export function renderCompletion(shell: string | undefined, binary = 'goodvibes'): string {
  const normalized = (shell ?? 'bash').toLowerCase();
  const words = [...COMMANDS, ...OPTIONS].join(' ');

  if (normalized === 'zsh') {
    return [
      `#compdef ${binary}`,
      `_${binary}() {`,
      `  compadd -- ${words}`,
      '}',
      `_${binary} "$@"`,
    ].join('\n');
  }

  if (normalized === 'fish') {
    return [...COMMANDS, ...OPTIONS]
      .map((word) => `complete -c ${binary} -a ${JSON.stringify(word)}`)
      .join('\n');
  }

  return [
    `_${binary}() {`,
    '  local cur',
    '  cur="${COMP_WORDS[COMP_CWORD]}"',
    `  COMPREPLY=( $(compgen -W "${words}" -- "$cur") )`,
    '}',
    `complete -F _${binary} ${binary}`,
  ].join('\n');
}
