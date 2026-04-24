import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const FALLBACK_VERSION = '0.19.24';

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
    ?? process.env.npm_package_version
    ?? FALLBACK_VERSION;
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
    '  status                     Print config, provider, service, and onboarding posture',
    '  doctor                     Print status plus setup warnings',
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
    '  completion <shell>         Generate shell completion script',
    '  help                       Print this help',
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
    '      --hostname <host>          Hostname for server/web commands',
    '      --open                     Open browser when supported',
    '  -r, --resume [id|latest]       Resume saved session when supported',
    '  -s, --session <id>             Use a specific session when supported',
    '      --continue                 Continue the latest session when supported',
    '      --fork                     Fork session when supported',
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
    `  ${binary} listener test`,
    `  ${binary} control-plane status`,
    `  ${binary} subscription providers`,
    `  ${binary} subscription login openai start --open`,
    `  ${binary} serve --hostname 0.0.0.0 --port 3421`,
  ].join('\n');
}

export function renderGoodVibesDaemonHelp(binary = 'goodvibes-daemon'): string {
  return [
    `Usage: ${binary} [OPTIONS]`,
    '',
    'Starts the headless GoodVibes daemon/API host.',
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
