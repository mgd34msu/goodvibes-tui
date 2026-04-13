import { createHttpTransport } from '../../src/runtime/transports/http.ts';

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export async function runReferenceHttpClientExample(): Promise<void> {
  const transport = createHttpTransport({
    baseUrl: requireEnv('GOODVIBES_BASE_URL'),
    authToken: requireEnv('GOODVIBES_TOKEN'),
  });

  const [providers, controlPlane, nodeHostContract] = await Promise.all([
    transport.operator.providers.snapshot(),
    transport.operator.controlPlane.snapshot(),
    transport.peer.getNodeHostContract(),
  ]);

  console.log(JSON.stringify({
    kind: transport.kind,
    providerCount: providers.providerIds.length,
    activeClients: controlPlane.activeClientIds.length,
    peerContractBasePath: nodeHostContract.basePath,
    peerContractTransport: nodeHostContract.transport,
  }, null, 2));
}

if (import.meta.main) {
  runReferenceHttpClientExample().catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 1;
  });
}
