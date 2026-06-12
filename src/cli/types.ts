import type { ConfigManager } from '../config/index.ts';

export type GoodVibesCliCommand =
  | 'tui'
  | 'run'
  | 'serve'
  | 'web'
  | 'service'
  | 'status'
  | 'doctor'
  | 'onboarding'
  | 'models'
  | 'providers'
  | 'auth'
  | 'subscription'
  | 'secrets'
  | 'sessions'
  | 'tasks'
  | 'pair'
  | 'surfaces'
  | 'listener'
  | 'control-plane'
  | 'bundle'
  | 'remote'
  | 'bridge'
  | 'completion'
  | 'help'
  | 'version'
  | 'unknown';

export type GoodVibesCliOutputFormat = 'text' | 'json' | 'stream-json';

export interface CliCommandOutput {
  readonly output: string;
  readonly exitCode: number;
}

export interface GoodVibesCliFlags {
  readonly provider: string | undefined;
  readonly model: string | undefined;
  readonly daemonHome: string | undefined;
  readonly workingDir: string | undefined;
  readonly help: boolean;
  readonly version: boolean;
  readonly prompt: string | undefined;
  readonly print: boolean;
  readonly outputFormat: GoodVibesCliOutputFormat;
  readonly configOverrides: readonly string[];
  readonly enableFeatures: readonly string[];
  readonly disableFeatures: readonly string[];
  readonly noAltScreen: boolean;
  readonly port: number | undefined;
  readonly hostname: string | undefined;
  readonly open: boolean;
  readonly continueLast: boolean;
  readonly resume: string | undefined;
  readonly session: string | undefined;
  readonly fork: boolean;
  readonly rawOutput: boolean;
  readonly acceptRawOutputRisk: boolean;
}

export interface GoodVibesCliParseResult {
  readonly binary: string;
  readonly command: GoodVibesCliCommand;
  readonly rawCommand: string | undefined;
  readonly commandArgs: readonly string[];
  readonly positionals: readonly string[];
  readonly flags: GoodVibesCliFlags;
  readonly errors: readonly string[];
}

export interface CliCommandRuntime {
  readonly cli: GoodVibesCliParseResult;
  readonly configManager: ConfigManager;
  readonly workingDirectory: string;
  readonly homeDirectory: string;
}
