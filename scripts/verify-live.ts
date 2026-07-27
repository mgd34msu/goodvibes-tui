#!/usr/bin/env bun
import {
  buildLiveVerificationReport,
  renderLiveVerificationReportMarkdown,
  writeLiveVerificationReportFiles,
} from '../src/verification/live-verifier.ts';
import { join, resolve } from 'node:path';
import { resolveGoodVibesTreeDirectory } from '../src/config/goodvibes-home.ts';

function readArgValue(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index === -1) return undefined;
  return args[index + 1];
}

const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  console.log([
    'Usage: bun run scripts/verify-live.ts [options]',
    '',
    'Options:',
    '  --home <path>        The .goodvibes directory. Defaults to the tree under',
    '                       GOODVIBES_HOME, or ~/.goodvibes when that is unset.',
    '  --binary <path>      Compiled goodvibes binary. Defaults to dist/goodvibes.',
    '  --daemon-url <url>   Daemon base URL. Defaults to configured control-plane port on 127.0.0.1.',
    '  --strict            Treat warnings as failures.',
    '  --json              Print JSON instead of Markdown.',
    '  --out <dir>         Write live-verification.{json,md} to a directory.',
    '  --help              Show this help.',
  ].join('\n'));
  process.exit(0);
}

const report = await buildLiveVerificationReport({
  // Derived from the tree root, the same way the runtime derives it. Reading
  // GOODVIBES_HOME as the .goodvibes directory here meant this verifier and the
  // binary it drives disagreed about which tree the run belonged to.
  homeDir: readArgValue(args, '--home') ?? resolveGoodVibesTreeDirectory(),
  binaryPath: readArgValue(args, '--binary') ?? join(resolve(join(import.meta.dir, '..')), 'dist', 'goodvibes'),
  projectRoot: resolve(join(import.meta.dir, '..')),
  daemonBaseUrl: readArgValue(args, '--daemon-url'),
  strict: args.includes('--strict'),
});

const outputDir = readArgValue(args, '--out');
if (outputDir) {
  writeLiveVerificationReportFiles(report, outputDir);
}

console.log(args.includes('--json')
  ? JSON.stringify(report, null, 2)
  : renderLiveVerificationReportMarkdown(report));

process.exit(report.ok ? 0 : 1);
