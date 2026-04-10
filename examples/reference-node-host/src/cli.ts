import { readFile } from 'node:fs/promises';
import { ReferenceNodeHostClient, createDefaultReferenceNodeHostConfig, type ReferenceNodeHostConfig } from './index.ts';

async function loadConfig(path: string | undefined): Promise<ReferenceNodeHostConfig> {
  if (!path) return createDefaultReferenceNodeHostConfig();
  const raw = await readFile(path, 'utf-8');
  const parsed = JSON.parse(raw) as Partial<ReferenceNodeHostConfig>;
  return createDefaultReferenceNodeHostConfig(parsed);
}

function parseArgs(argv: string[]): { command: string; configPath?: string } {
  const args = [...argv];
  let command = 'start';
  let configPath: string | undefined;
  for (let i = 0; i < args.length; i += 1) {
    const value = args[i];
    if (!value) continue;
    if (value === '--config') {
      configPath = args[i + 1];
      i += 1;
      continue;
    }
    if (!value.startsWith('-') && command === 'start') {
      command = value;
      continue;
    }
  }
  return { command, configPath };
}

async function main(): Promise<void> {
  const { command, configPath } = parseArgs(process.argv.slice(2));
  const config = await loadConfig(configPath);
  const client = new ReferenceNodeHostClient(config);

  switch (command) {
    case 'contract': {
      await client.fetchContract();
      console.log(JSON.stringify(client.getContract(), null, 2));
      return;
    }
    case 'pair': {
      const pair = await client.requestPairing();
      console.log(JSON.stringify(pair, null, 2));
      return;
    }
    case 'verify': {
      await client.loadState();
      const verified = await client.verifyPairing();
      console.log(JSON.stringify({ verified, state: client.getState() }, null, 2));
      return;
    }
    case 'once': {
      const summary = await client.runOnce();
      console.log(JSON.stringify(summary, null, 2));
      return;
    }
    case 'start':
    default:
      await client.run();
  }
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 1;
  });
}
