import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VERSION } from '../version.ts';

function readJsonVersion(path: string): string | null {
  try {
    if (!existsSync(path)) return null;
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as { version?: unknown };
    return typeof parsed.version === 'string' ? parsed.version : null;
  } catch {
    return null;
  }
}

export function getPackageVersion(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return readJsonVersion(join(here, '..', '..', 'package.json'))
    ?? VERSION;
}

export function renderGoodVibesVersion(binary = 'goodvibes'): string {
  return `${binary} ${getPackageVersion()}`;
}

export function renderGoodVibesHelp(binary = 'goodvibes'): string {
  return [
    `Usage: ${binary} [OPTIONS] [PROMPT]`,
    `       ${binary} [OPTIONS] <COMMAND> [ARGS]`,
    '',
    'Commands:',
    '  tui [path]                 Start the interactive TUI (default)',
    '  run|exec [prompt]          Run non-interactively with text/json/stream-json output',
    '  serve|daemon               Start the daemon/API host',
    '  web                        Show browser surface bind URL and enablement',
    '  service                    Inspect/manage daemon service lifecycle',
    '  status                     Print config, provider, service, and onboarding posture',
    '  doctor                     Print status plus setup warnings',
    '  doctor explain <target>    Explain why a tool/command would be allowed/asked/denied',
    '  doctor routing             Print which model/provider serves which role',
    '  doctor hooks               List registered hooks, their source, and validation status',
    '  onboarding [status]        Open onboarding in the TUI, or print onboarding status',
    '  models [provider]          List/use/pin selectable models and recent model history',
    '  providers                  List/inspect/use provider config/auth posture',
    '  auth                       Inspect and manage local users, sessions, and bootstrap auth',
    '  subscription               Start/finish/logout provider subscription sessions',
    '  secrets                    List, set, link, delete, and test GoodVibes secret refs',
    '  sessions                   List, show, export, or resume saved sessions',
    '  tasks                      List/show in-process tasks or submit a non-interactive task',
    '  pair|qrcode                Print companion pairing payload and QR code',
    '  surfaces                   Inspect/check/enable/disable browser/listener/external surfaces',
    '  listener test              Test HTTP listener/webhook readiness',
    '  control-plane status       Inspect daemon auth, local admin, tokens, and ports',
    '  bundle export|inspect|import',
    '                             Move setup/profile/trust/support bundles',
    '  remote|bridge              Inspect remote runner/node posture',
    '  hooks validate             Validate hooks.json against the hook loader schema',
    '  plugin init|validate       Scaffold a plugin or validate a plugin directory',
    '  plugin bundles ...         Browse/install/list SHA-256-pinned capability bundles',
    '  completion <shell>         Generate shell completion script',
    '  help [command]             Print this help or command-specific help',
    '  version                    Print version',
    '',
    'Options:',
    '  -m, --model <registryKey>       Override model. provider:model infers --provider',
    '      --provider <id>            Override provider',
    '  -C, --cd <dir>                 Set working directory for this launch',
    '      --working-dir <dir>        Alias for --cd',
    '      --daemon-home <dir>        Override daemon home for daemon-backed commands',
    '  -c, --config <key=value>       Override a config value for this launch',
    '      --enable <feature>         Enable a feature flag for this launch',
    '      --disable <feature>        Disable a feature flag for this launch',
    '  -p, --prompt <text>            Run a non-interactive prompt',
    '      --print                    Alias for non-interactive run mode',
    '  -o, --output <format>          text, json, or stream-json',
    '      --output-format <format>   Alias for --output',
    '      --json                     Alias for --output-format json',
    '      --no-alt-screen            Keep output in normal terminal scrollback',
    '      --port <port>              Port for server/web commands',
    '      --hostname <host>          Hostname for server/web commands (--host is an alias)',
    '      --open                     Open browser when supported',
    '  -r, --resume [id|latest]       Resume saved session when supported',
    '  -s, --session <id>             Use a specific session when supported',
    '      --continue                 Continue the latest session when supported',
    '      --fork [id]                Fork session (current or specific id) when supported',
    '  -y, --yes                      Auto-confirm prompts (non-interactive)',
    '      --non-interactive          Disable all interactive prompts (implies --yes)',
    '  -h, --help                     Print help',
    '  -v, --version                  Print version',
    '',
    'Examples:',
    `  ${binary}`,
    `  ${binary} --no-alt-screen`,
    `  ${binary} --cd ~/work/project --model openai:gpt-5.2`,
    `  ${binary} onboarding`,
    `  ${binary} onboarding status`,
    `  ${binary} status`,
    `  ${binary} models current`,
    `  ${binary} models use openai:gpt-5.2`,
    `  ${binary} providers inspect openai`,
    `  ${binary} surfaces`,
    `  ${binary} surfaces check`,
    `  ${binary} surfaces enable web`,
    `  ${binary} service check`,
    `  ${binary} listener test`,
    `  ${binary} control-plane status`,
    `  ${binary} subscription providers`,
    `  ${binary} subscription login openai start --open`,
    `  ${binary} serve --hostname 0.0.0.0 --port 3421`,
  ].join('\n');
}

type CommandHelp = {
  readonly usage: readonly string[];
  readonly summary: string;
  readonly subcommands?: readonly string[];
  readonly examples?: readonly string[];
};

const COMMAND_HELP: Record<string, CommandHelp> = {
  tui: {
    usage: ['tui [path]', '[prompt]'],
    summary: 'Start the interactive terminal UI. A prompt starts the TUI with that prompt seeded.',
    examples: ['', 'tui ~/work/project', '"review this repo"'],
  },
  run: {
    usage: ['run [prompt] [--output text|json|stream-json]', 'exec [prompt]'],
    summary: 'Run a single non-interactive agent turn and write the result to stdout.',
    examples: ['run "summarize the current project"', 'run --output json "list risks"', 'exec --output stream-json "fix lint"'],
  },
  onboarding: {
    usage: ['onboarding', 'setup', 'onboarding status'],
    summary: 'Open the setup wizard, or inspect whether onboarding has already been shown for this user.',
    examples: ['onboarding', 'onboarding status'],
  },
  status: {
    usage: ['status', 'status --json'],
    summary: 'Print config, provider, auth, service, surface, and onboarding posture.',
    examples: ['status', 'status --json'],
  },
  doctor: {
    usage: ['doctor', 'doctor --json', 'doctor explain <tool|command>', 'doctor routing', 'doctor hooks'],
    summary: 'Print status plus setup warnings, or explain a platform decision: explain (why a tool/command would be allowed/asked/denied under the current mode), routing (which model/provider serves which role), hooks (registered hooks, their source, and validation status).',
    examples: ['doctor', 'doctor explain "rm -rf build"', 'doctor explain write ./src/app.ts', 'doctor routing', 'doctor hooks --json'],
  },
  providers: {
    usage: ['providers [list]', 'providers current', 'providers inspect <provider>', 'providers use <provider> [modelRegistryKey]'],
    summary: 'Inspect and change provider setup, auth posture, model counts, and setup class.',
    examples: ['providers', 'providers inspect openai-subscriber', 'providers use openai openai:gpt-5.4'],
  },
  models: {
    usage: ['models [provider]', 'models current', 'models use <registryKey>', 'models pin <registryKey>', 'models recent'],
    summary: 'List, inspect, select, pin, and review model choices.',
    examples: ['models current', 'models openai', 'models use openai:gpt-5.4'],
  },
  auth: {
    usage: ['auth status', 'auth users', 'auth sessions', 'auth add-user <username>', 'auth clear-bootstrap'],
    summary: 'Inspect and manage local admin users, bootstrap auth, and local sessions.',
    examples: ['auth', 'auth add-user admin --password-stdin', 'auth clear-bootstrap'],
  },
  subscription: {
    usage: ['subscription list', 'subscription providers', 'subscription inspect <provider>', 'subscription login <provider> start|finish', 'subscription logout <provider>'],
    summary: 'Manage OAuth/subscription-backed provider sessions such as OpenAI subscription access.',
    examples: ['subscription providers', 'subscription login openai start --open', 'subscription inspect openai'],
  },
  secrets: {
    usage: ['secrets list', 'secrets providers', 'secrets test goodvibes://secrets/<source>/...', 'secrets set <KEY> <value>', 'secrets link <KEY> <ref>'],
    summary: 'Manage GoodVibes secret records and secret references. Secret refs never embed secret values.',
    examples: ['secrets providers', 'secrets test goodvibes://secrets/env/OPENAI_API_KEY', 'secrets link OPENAI_API_KEY goodvibes://secrets/env/OPENAI_API_KEY'],
  },
  sessions: {
    usage: ['sessions list', 'sessions show <id|name>', 'sessions export <id|name> [path]', 'sessions resume <id|name>'],
    summary: 'List, inspect, export, or resume saved TUI sessions.',
    examples: ['sessions list', 'sessions show latest-session', 'sessions export abc123 session.json'],
  },
  tasks: {
    usage: ['tasks list', 'tasks show <taskId>', 'tasks submit <prompt>'],
    summary: 'Inspect runtime tasks or submit a non-interactive task.',
    examples: ['tasks list', 'tasks submit "check provider readiness"'],
  },
  surfaces: {
    usage: ['surfaces [list]', 'surfaces check', 'surfaces show <surfaceId>', 'surfaces enable <web|listener|control-plane|surfaceId>', 'surfaces disable <surfaceId>'],
    summary: 'Inspect and configure browser, control-plane, HTTP listener, and external integration surfaces.',
    examples: ['surfaces check', 'surfaces enable web', 'surfaces enable slack'],
  },
  listener: {
    usage: ['listener test'],
    summary: 'Check HTTP listener/webhook readiness, network posture, service posture, auth, and enabled surface requirements.',
    examples: ['listener test', 'listener test --json'],
  },
  'control-plane': {
    usage: ['control-plane status'],
    summary: 'Inspect daemon control-plane bind posture, reachability, local auth, bootstrap credentials, and operator tokens.',
    examples: ['control-plane status', 'control-plane status --json'],
  },
  bundle: {
    usage: ['bundle export [path]', 'bundle inspect <path>', 'bundle import <path>'],
    summary: 'Export, inspect, or import setup/profile/trust/support bundle data.',
    examples: ['bundle export goodvibes-bundle.json', 'bundle inspect goodvibes-bundle.json'],
  },
  pair: {
    usage: ['pair', 'qrcode'],
    summary: 'Print companion pairing connection details and a QR code.',
    examples: ['pair', 'qrcode'],
  },
  web: {
    usage: ['web [--open]'],
    summary: 'Show the configured browser surface URL, bind address, and enablement state.',
    examples: ['web', 'web --open', 'web --hostname 0.0.0.0 --port 3423'],
  },
  service: {
    usage: ['service status', 'service check', 'service install|start|stop|restart|uninstall'],
    summary: 'Inspect and manage the daemon service lifecycle, autostart, restart policy, PID, logs, and endpoint readiness.',
    examples: ['service status', 'service check --json', 'service install'],
  },
  completion: {
    usage: ['completion <bash|zsh|fish>'],
    summary: 'Generate shell completion scripts.',
    examples: ['completion bash', 'completion zsh'],
  },
  serve: {
    usage: ['serve [--hostname <host>] [--port <port>]', 'daemon [--hostname <host>] [--port <port>]'],
    summary: 'Start the headless GoodVibes daemon/API host.',
    examples: ['serve', 'serve --hostname 0.0.0.0 --port 3421'],
  },
  remote: {
    usage: ['remote', 'bridge'],
    summary: 'Inspect remote runner/node posture and bridge readiness.',
    examples: ['remote', 'bridge'],
  },
  hooks: {
    usage: ['hooks validate'],
    summary: 'Validate the configured hooks.json against the hook loader schema — per-hook pass/fail with plain reasons, nonzero exit if any hook is invalid.',
    examples: ['hooks validate', 'hooks validate --json'],
  },
  plugin: {
    usage: ['plugin init <name> [directory]', 'plugin validate <path>', 'plugin bundles browse <index-url-or-file>', 'plugin bundles install <ref> --sha256 <pin>', 'plugin bundles list'],
    summary: 'Scaffold a minimal valid plugin (manifest.json + entry file), validate a plugin directory against the plugin loader checks, or browse/install/list SHA-256-pinned capability bundles from a governed marketplace index. Bundle installs are never unpinned — a missing or mismatched --sha256 is refused, not overridable.',
    examples: ['plugin init my-plugin', 'plugin validate .goodvibes/plugins/my-plugin', 'plugin bundles browse ./marketplace-index.json', 'plugin bundles install ./bundle.json --sha256 <64-hex> --yes'],
  },
};

const HELP_ALIASES: Record<string, string> = {
  app: 'tui',
  exec: 'run',
  setup: 'onboarding',
  provider: 'providers',
  model: 'models',
  subscriptions: 'subscription',
  secret: 'secrets',
  session: 'sessions',
  task: 'tasks',
  surface: 'surfaces',
  webhook: 'listener',
  controlplane: 'control-plane',
  cp: 'control-plane',
  qrcode: 'pair',
  qr: 'pair',
  daemon: 'serve',
  server: 'serve',
  services: 'service',
  bridge: 'remote',
  hook: 'hooks',
  plugins: 'plugin',
};

function normalizeHelpTopic(topic: string): string {
  const normalized = topic.trim().toLowerCase();
  return HELP_ALIASES[normalized] ?? normalized;
}

export function renderGoodVibesCommandHelp(topic: string, binary = 'goodvibes'): string {
  const normalized = normalizeHelpTopic(topic);
  const help = COMMAND_HELP[normalized];
  if (!help) {
    return [
      `No detailed help is available for "${topic}".`,
      '',
      renderGoodVibesHelp(binary),
    ].join('\n');
  }
  return [
    `GoodVibes ${normalized}`,
    '',
    help.summary,
    '',
    'Usage:',
    ...help.usage.map((usage) => `  ${binary} ${usage}`),
    ...(help.subcommands && help.subcommands.length > 0 ? [
      '',
      'Subcommands:',
      ...help.subcommands.map((subcommand) => `  ${subcommand}`),
    ] : []),
    ...(help.examples && help.examples.length > 0 ? [
      '',
      'Examples:',
      ...help.examples.map((example) => `  ${binary}${example ? ` ${example}` : ''}`),
    ] : []),
  ].join('\n');
}

export function renderGoodVibesDaemonHelp(binary = 'goodvibes-daemon'): string {
  return [
    `Usage: ${binary} [COMMAND] [OPTIONS]`,
    '',
    'Starts the headless GoodVibes daemon/API host.',
    '',
    'Commands:',
    '  install-service                Install + enable the daemon as a systemd user service (survives reboots)',
    '  uninstall-service              Disable + remove the daemon systemd user service',
    '  service-status                 Show whether the daemon service is installed / enabled / active',
    '  migrate-service                Guided takeover of a legacy goodvibes-daemon.service unit; prints a plan',
    '                                 unless run with -y/--yes (never auto-migrates)',
    '',
    'Options:',
    '      --daemon-home <dir>        Override daemon home',
    '      --working-dir <dir>        Override working directory',
    '  -C, --cd <dir>                 Alias for --working-dir',
    '      --provider <id>            Override provider',
    '  -m, --model <registryKey>      Override model. provider:model infers --provider',
    '      --hostname <host>          Hostname hint for printed connection info',
    '      --port <port>              Control-plane port override when supported',
    '  -h, --help                     Print help',
    '  -v, --version                  Print version',
  ].join('\n');
}
