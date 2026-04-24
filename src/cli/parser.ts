import type {
  GoodVibesCliCommand,
  GoodVibesCliFlags,
  GoodVibesCliOutputFormat,
  GoodVibesCliParseResult,
} from './types.ts';

const COMMAND_ALIASES: Readonly<Record<string, GoodVibesCliCommand>> = {
  tui: 'tui',
  app: 'tui',
  run: 'run',
  exec: 'run',
  e: 'run',
  serve: 'serve',
  daemon: 'serve',
  server: 'serve',
  web: 'web',
  service: 'service',
  services: 'service',
  status: 'status',
  doctor: 'doctor',
  onboarding: 'onboarding',
  setup: 'onboarding',
  models: 'models',
  model: 'models',
  providers: 'providers',
  provider: 'providers',
  auth: 'auth',
  subscription: 'subscription',
  subscriptions: 'subscription',
  secrets: 'secrets',
  secret: 'secrets',
  sessions: 'sessions',
  session: 'sessions',
  tasks: 'tasks',
  task: 'tasks',
  pair: 'pair',
  qrcode: 'pair',
  qr: 'pair',
  surfaces: 'surfaces',
  surface: 'surfaces',
  listener: 'listener',
  'http-listener': 'listener',
  webhook: 'listener',
  'control-plane': 'control-plane',
  controlplane: 'control-plane',
  cp: 'control-plane',
  bundle: 'bundle',
  bundles: 'bundle',
  remote: 'remote',
  bridge: 'bridge',
  completion: 'completion',
  completions: 'completion',
  help: 'help',
  version: 'version',
};

function createDefaultFlags(): GoodVibesCliFlags {
  return {
    provider: undefined,
    model: undefined,
    daemonHome: undefined,
    workingDir: undefined,
    help: false,
    version: false,
    prompt: undefined,
    print: false,
    outputFormat: 'text',
    configOverrides: [],
    enableFeatures: [],
    disableFeatures: [],
    noAltScreen: false,
    port: undefined,
    hostname: undefined,
    open: false,
    continueLast: false,
    resume: undefined,
    session: undefined,
    fork: false,
    rawOutput: false,
    acceptRawOutputRisk: false,
  };
}

function splitOption(token: string): { readonly name: string; readonly value: string | undefined } {
  const index = token.indexOf('=');
  if (index < 0) return { name: token, value: undefined };
  return {
    name: token.slice(0, index),
    value: token.slice(index + 1),
  };
}

function getValue(
  argv: readonly string[],
  index: number,
  inlineValue: string | undefined,
  optionName: string,
  errors: string[],
): { readonly value: string | undefined; readonly nextIndex: number } {
  if (inlineValue !== undefined) return { value: inlineValue, nextIndex: index };
  const next = argv[index + 1];
  if (next === undefined || (next.startsWith('-') && next !== '-')) {
    errors.push(`${optionName} requires a value.`);
    return { value: undefined, nextIndex: index };
  }
  return { value: next, nextIndex: index + 1 };
}

function getOptionalValue(
  argv: readonly string[],
  index: number,
  inlineValue: string | undefined,
): { readonly value: string | undefined; readonly nextIndex: number } {
  if (inlineValue !== undefined) return { value: inlineValue, nextIndex: index };
  const next = argv[index + 1];
  if (next === undefined || next.startsWith('-')) return { value: undefined, nextIndex: index };
  return { value: next, nextIndex: index + 1 };
}

function parsePort(value: string | undefined, optionName: string, errors: string[]): number | undefined {
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value)) {
    errors.push(`${optionName} must be a port number from 1 to 65535.`);
    return undefined;
  }
  const port = Number.parseInt(value, 10);
  if (port < 1 || port > 65535) {
    errors.push(`${optionName} must be a port number from 1 to 65535.`);
    return undefined;
  }
  return port;
}

function normalizeOutputFormat(value: string | undefined, errors: string[]): GoodVibesCliOutputFormat {
  if (value === 'text' || value === 'json' || value === 'stream-json') return value;
  errors.push('--output-format must be one of: text, json, stream-json.');
  return 'text';
}

function inferProviderFromModel(model: string, currentProvider: string | undefined): string | undefined {
  if (currentProvider !== undefined) return currentProvider;
  if (model.includes(':')) return model.split(':')[0];
  if (model.includes('/')) return model.split('/')[0];
  return undefined;
}

function withFlag<K extends keyof GoodVibesCliFlags>(
  flags: GoodVibesCliFlags,
  key: K,
  value: GoodVibesCliFlags[K],
): GoodVibesCliFlags {
  return { ...flags, [key]: value };
}

function appendFlagArray<K extends 'configOverrides' | 'enableFeatures' | 'disableFeatures'>(
  flags: GoodVibesCliFlags,
  key: K,
  value: string,
): GoodVibesCliFlags {
  return {
    ...flags,
    [key]: [...flags[key], value],
  };
}

export function parseGoodVibesCli(
  argv: readonly string[],
  binary = 'goodvibes',
): GoodVibesCliParseResult {
  let flags = createDefaultFlags();
  let command: GoodVibesCliCommand = 'tui';
  let rawCommand: string | undefined;
  const commandArgs: string[] = [];
  const positionals: string[] = [];
  const errors: string[] = [];
  let sawCommand = false;
  let passthrough = false;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;

    if (passthrough) {
      if (sawCommand) commandArgs.push(token);
      else positionals.push(token);
      continue;
    }

    if (token === '--') {
      passthrough = true;
      continue;
    }

    if (!token.startsWith('-') || token === '-') {
      if (!sawCommand) {
        const normalized = COMMAND_ALIASES[token.toLowerCase()];
        if (normalized) {
          command = normalized;
          rawCommand = token;
          sawCommand = true;
          continue;
        }
      }
      positionals.push(token);
      if (sawCommand) commandArgs.push(token);
      continue;
    }

    const { name, value: inlineValue } = splitOption(token);

    if (name === '--help' || name === '-h') {
      flags = withFlag(flags, 'help', true);
      continue;
    }
    if (name === '--version' || name === '-v') {
      flags = withFlag(flags, 'version', true);
      continue;
    }
    if (name === '--print') {
      flags = withFlag(flags, 'print', true);
      if (!sawCommand) command = 'run';
      continue;
    }
    if (name === '--json') {
      flags = withFlag(flags, 'outputFormat', 'json');
      continue;
    }
    if (name === '--no-alt-screen') {
      flags = withFlag(flags, 'noAltScreen', true);
      continue;
    }
    if (name === '--open') {
      flags = withFlag(flags, 'open', true);
      continue;
    }
    if (name === '--continue') {
      flags = withFlag(flags, 'continueLast', true);
      continue;
    }
    if (name === '--fork') {
      flags = withFlag(flags, 'fork', true);
      continue;
    }
    if (name === '--raw-output') {
      flags = withFlag(flags, 'rawOutput', true);
      continue;
    }
    if (name === '--accept-raw-output-risk') {
      flags = withFlag(flags, 'acceptRawOutputRisk', true);
      continue;
    }

    if (name === '--provider') {
      const consumed = getValue(argv, index, inlineValue, name, errors);
      index = consumed.nextIndex;
      if (consumed.value !== undefined) flags = withFlag(flags, 'provider', consumed.value);
      continue;
    }
    if (name === '--model' || name === '-m') {
      const consumed = getValue(argv, index, inlineValue, name, errors);
      index = consumed.nextIndex;
      if (consumed.value !== undefined) {
        flags = withFlag(flags, 'model', consumed.value);
        flags = withFlag(flags, 'provider', inferProviderFromModel(consumed.value, flags.provider));
      }
      continue;
    }
    if (name === '--daemon-home') {
      const consumed = getValue(argv, index, inlineValue, name, errors);
      index = consumed.nextIndex;
      if (consumed.value !== undefined) flags = withFlag(flags, 'daemonHome', consumed.value);
      continue;
    }
    if (name === '--working-dir' || name === '--cd' || name === '-C') {
      const consumed = getValue(argv, index, inlineValue, name, errors);
      index = consumed.nextIndex;
      if (consumed.value !== undefined) flags = withFlag(flags, 'workingDir', consumed.value);
      continue;
    }
    if (name === '--prompt' || name === '-p') {
      const consumed = getValue(argv, index, inlineValue, name, errors);
      index = consumed.nextIndex;
      if (consumed.value !== undefined) {
        flags = withFlag(flags, 'prompt', consumed.value);
        if (!sawCommand) command = 'run';
      }
      continue;
    }
    if (name === '--output-format' || name === '--output' || name === '-o') {
      const consumed = getValue(argv, index, inlineValue, name, errors);
      index = consumed.nextIndex;
      flags = withFlag(flags, 'outputFormat', normalizeOutputFormat(consumed.value, errors));
      continue;
    }
    if (name === '--config') {
      const consumed = getValue(argv, index, inlineValue, name, errors);
      index = consumed.nextIndex;
      if (consumed.value !== undefined) flags = appendFlagArray(flags, 'configOverrides', consumed.value);
      continue;
    }
    if (name === '-c') {
      const consumed = getValue(argv, index, inlineValue, name, errors);
      index = consumed.nextIndex;
      if (consumed.value !== undefined) flags = appendFlagArray(flags, 'configOverrides', consumed.value);
      continue;
    }
    if (name === '--enable') {
      const consumed = getValue(argv, index, inlineValue, name, errors);
      index = consumed.nextIndex;
      if (consumed.value !== undefined) flags = appendFlagArray(flags, 'enableFeatures', consumed.value);
      continue;
    }
    if (name === '--disable') {
      const consumed = getValue(argv, index, inlineValue, name, errors);
      index = consumed.nextIndex;
      if (consumed.value !== undefined) flags = appendFlagArray(flags, 'disableFeatures', consumed.value);
      continue;
    }
    if (name === '--port') {
      const consumed = getValue(argv, index, inlineValue, name, errors);
      index = consumed.nextIndex;
      flags = withFlag(flags, 'port', parsePort(consumed.value, name, errors));
      continue;
    }
    if (name === '--hostname' || name === '--host') {
      const consumed = getValue(argv, index, inlineValue, name, errors);
      index = consumed.nextIndex;
      if (consumed.value !== undefined) flags = withFlag(flags, 'hostname', consumed.value);
      continue;
    }
    if (name === '--resume' || name === '-r') {
      const consumed = getOptionalValue(argv, index, inlineValue);
      index = consumed.nextIndex;
      flags = withFlag(flags, 'resume', consumed.value ?? 'latest');
      continue;
    }
    if (name === '--session' || name === '-s') {
      const consumed = getValue(argv, index, inlineValue, name, errors);
      index = consumed.nextIndex;
      if (consumed.value !== undefined) flags = withFlag(flags, 'session', consumed.value);
      continue;
    }

    if (sawCommand) {
      commandArgs.push(token);
      continue;
    }

    errors.push(`Unknown option: ${name}`);
  }

  if (flags.prompt === undefined && (command === 'run' || flags.print) && positionals.length > 0) {
    flags = withFlag(flags, 'prompt', positionals.join(' '));
  }

  if (rawCommand !== undefined && command === 'unknown') {
    errors.push(`Unknown command: ${rawCommand}`);
  }

  return {
    binary,
    command,
    rawCommand,
    commandArgs,
    positionals,
    flags,
    errors,
  };
}
