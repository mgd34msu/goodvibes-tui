// ---------------------------------------------------------------------------
// Shared CLI flag parsing for TUI shell and daemon entrypoints.
// ---------------------------------------------------------------------------

export type CliFlags = {
  readonly provider: string | undefined;
  readonly model: string | undefined;
  readonly daemonHome: string | undefined;
  readonly workingDir: string | undefined;
};

/**
 * Parse `--provider` / `--model` / `--daemon-home` / `--working-dir` / `--help` flags from an argv slice.
 *
 * @param argv   - argv array (pass `process.argv.slice(2)`)
 * @param binary - binary name shown in the --help usage line (e.g. "goodvibes" or "goodvibes-daemon")
 */
export function parseCliFlags(argv: readonly string[], binary = 'goodvibes'): CliFlags {
  let provider: string | undefined;
  let model: string | undefined;
  let daemonHome: string | undefined;
  let workingDir: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      // eslint-disable-next-line no-console
      console.log([
        `Usage: ${binary} [options]`,
        '',
        'Options:',
        '  --provider <id>          Override the provider from settings.json at startup',
        '  --model <registryKey>    Override the model from settings.json at startup',
        '                           Format: provider:modelId (e.g. inception:mercury-2)',
        '                           If provider:modelId format is used, --provider is inferred',
        '  --daemon-home=<path>     Override daemon home (precedence: flag > GOODVIBES_DAEMON_HOME env > ~/.goodvibes/daemon)',
        '  --working-dir=<path>     Override working directory (precedence: flag > GOODVIBES_WORKING_DIR env > process.cwd())',
        '  --help, -h               Show this help message',
      ].join('\n'));
      process.exit(0);
    }
    if (arg === '--provider' && argv[i + 1] !== undefined) {
      provider = argv[++i];
    } else if (arg === '--model' && argv[i + 1] !== undefined) {
      model = argv[++i];
      // Infer provider from registryKey format (provider:modelId) if --provider not given
      if (typeof model === 'string' && model.includes(':') && provider === undefined) {
        provider = model.split(':')[0];
      }
    } else if (arg.startsWith('--daemon-home=')) {
      daemonHome = arg.slice('--daemon-home='.length);
    } else if (arg.startsWith('--working-dir=')) {
      workingDir = arg.slice('--working-dir='.length);
    }
  }

  return { provider, model, daemonHome, workingDir };
}
